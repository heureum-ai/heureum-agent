# Copyright (c) 2026 Heureum AI. All rights reserved.

"""AgentLoopRunner — single-request loop runner with minimal state transitions."""

import asyncio
import json
import logging
import uuid
from enum import Enum
from typing import Any, Dict

from app.config import settings
from app.models import LLMResult, LLMResultType, ToolCallInfo
from app.schemas.open_responses import (
    ErrorObject,
    ErrorType,
    FunctionToolCall,
    FunctionToolResult,
    ItemStatus,
    ResponseObject,
    ResponseStatus,
    Usage,
)
from langchain_core.messages import BaseMessage, HumanMessage, ToolMessage

from app.services.agent_loop.context import LoopContext, _LoopStateBuilder, is_tool_error
from app.services.middleware import MiddlewareBlocked, MiddlewareContext, PromptBuildEvent

logger = logging.getLogger(__name__)


class _IterAction(Enum):
    """Action returned by shared iteration helpers."""

    CONTINUE = "continue"  # continue to next iteration
    FALLTHROUGH = "fallthrough"  # fall through to normal text handling
    NONE = "none"  # no action needed


class AgentLoopRunner:
    """Single-request loop runner with minimal state transitions."""

    def __init__(self, ctx: LoopContext) -> None:
        self.ctx = ctx
        self._controller = ctx.ctrl
        self._service = ctx.ctrl.agent_service
        self._persist_controller = ctx.ctrl.persist_controller
        self._skill_controller = ctx.ctrl.skill_controller
        self._mcp_client = ctx.ctrl.mcp_client
        self._tool_execution = ctx.ctrl.tool_exec
        self._messages = ctx.ctrl.messages
        self._original_instructions = ctx.request.instructions
        self._persist_tasks: list[asyncio.Task] = []
        self._pending_events: list[dict] = []

    # -- pending events helpers ---------------------------------------------

    def _drain_events(self) -> list[dict]:
        """Flush and return accumulated SSE events."""
        events = self._pending_events
        self._pending_events = []
        return events

    # -- persist helpers (fire-and-forget) ----------------------------------

    def _persist_message(
        self,
        msg_type: str,
        role: str,
        content: Any,
        **kwargs: Any,
    ) -> None:
        """Fire-and-forget persist a single message to Platform DB."""
        if not self._persist_controller or not self.ctx.response_id:
            return
        seq = self.ctx.msg_seq
        self.ctx.msg_seq += 1
        task = asyncio.create_task(
            self._persist_controller.save_message(
                session_id=self.ctx.session_id,
                response_id=self.ctx.response_id,
                seq=seq,
                msg_type=msg_type,
                role=role,
                content=content,
                **kwargs,
            )
        )
        self._persist_tasks.append(task)

    def _persist_assistant_message(self, text: str, reasoning: str | None = None) -> None:
        """Persist assistant message with optional reasoning to Platform DB."""
        if reasoning:
            content = [
                {"type": "reasoning", "text": reasoning},
                {"type": "output_text", "text": text},
            ]
        else:
            content = text
        self._persist_message("message", "assistant", content)

    def _persist_complete(self, status: str) -> None:
        """Fire-and-forget persist response completion."""
        if not self._persist_controller or not self.ctx.response_id:
            return
        task = asyncio.create_task(
            self._persist_controller.complete_response(
                response_id=self.ctx.response_id,
                status=status,
                usage=self.ctx.total_usage.model_dump() if self.ctx.total_usage else None,
                model=self.ctx.model,
            )
        )
        self._persist_tasks.append(task)

    async def _flush_persists(self) -> None:
        """Await all pending persist tasks so DB writes land before response ends."""
        if self._persist_tasks:
            await asyncio.gather(*self._persist_tasks, return_exceptions=True)
            self._persist_tasks.clear()

    # -- shared iteration helpers (DRY) ------------------------------------

    async def _handle_skill_unfinished(
        self,
        text: str,
        usage: Usage | None,
        raw_message: Any = None,
    ) -> _IterAction:
        """Shared logic for skill unfinished work check.

        Returns CONTINUE if iteration should continue (skill retry),
        FALLTHROUGH if sub-agents completed and re-synthesis is needed,
        NONE if no unfinished work.

        Accumulates SSE events in self._pending_events for streaming caller.
        """
        if not self._skill_controller.has_unfinished_work(self.ctx.session_id):
            return _IterAction.NONE

        self._pending_events.append(
            {"type": "response.output_text.abandoned", "reason": "awaiting_subagents"}
        )
        await self._skill_controller.await_pending(self.ctx.session_id)

        if self._skill_controller.has_unfinished_work(self.ctx.session_id):
            # Still unfinished (e.g. plan steps) — inject guidance
            self.ctx.plan_retry_count += 1
            self._service.append_to_history(
                self.ctx.session_id,
                self.ctx.messages,
                text,
                usage=usage.model_dump() if usage else {},
                **({"assistant_lc_message": raw_message} if raw_message else {}),
            )
            self._persist_message("message", "assistant", text)

            if self.ctx.plan_retry_count > settings.MAX_PLAN_RETRIES:
                await self._skill_controller.finalize_abandoned(self.ctx.session_id)
                return _IterAction.NONE  # fall through to normal text handling
            else:
                guidance = self._skill_controller.build_retry_guidance(
                    self.ctx.session_id,
                    text,
                )
                fallback = self._messages.get_default("loop.plan_retry_fallback")
                content, blocked = await self._messages.resolve(
                    "loop.plan_retry",
                    session_id=self.ctx.session_id,
                    guidance=guidance or fallback,
                )
                if not blocked:
                    self.ctx.messages = [HumanMessage(content=content)]
                self._pending_events.append(
                    {"type": "response.output_text.abandoned", "reason": "unfinished_skill"}
                )
                return _IterAction.CONTINUE

        # Sub-agents completed — results are now in history.
        # Re-run LLM so it can synthesize the sub-agent results.
        self._service.append_to_history(
            self.ctx.session_id,
            self.ctx.messages,
            text,
            usage=usage.model_dump() if usage else {},
            **({"assistant_lc_message": raw_message} if raw_message else {}),
        )
        self._persist_message("message", "assistant", text)
        synthesis_content, _ = await self._messages.resolve(
            "loop.subagent_synthesis",
            session_id=self.ctx.session_id,
        )
        self.ctx.messages = [HumanMessage(content=synthesis_content)]
        return _IterAction.CONTINUE

    async def _handle_judge_gate(
        self,
        text: str,
        usage: Usage | None,
        raw_message: Any = None,
    ) -> _IterAction:
        """Shared logic for LLM-as-judge quality gate.

        Returns CONTINUE if the judge rejects and a retry should happen,
        NONE if the judge passes or is not applicable.
        """
        if not (
            settings.ENABLE_SELF_EVALUATION
            and self.ctx.tool_call_count > 0
            and self.ctx.eval_retry_count < settings.MAX_EVAL_RETRIES
        ):
            return _IterAction.NONE

        judge_result = await self._tool_execution.judge_current_response(
            session_id=self.ctx.session_id,
            response_text=text,
            output_items=self.ctx.output_items,
        )
        if judge_result.passed:
            return _IterAction.NONE

        self.ctx.eval_retry_count += 1
        self._service.append_to_history(
            self.ctx.session_id,
            self.ctx.messages,
            text,
            usage=usage.model_dump() if usage else {},
            **({"assistant_lc_message": raw_message} if raw_message else {}),
        )
        self._persist_message("message", "assistant", text)

        user_query = self._service.history.extract_last_user_query(
            self._service.get_history(self.ctx.session_id)
        )
        guidance = judge_result.guidance or self._messages.get_default(
            "loop.judge_default_guidance"
        )
        retry_content, blocked = await self._messages.resolve(
            "loop.judge_retry",
            session_id=self.ctx.session_id,
            user_query=user_query,
            text=text[:500],
            guidance=guidance,
        )
        if not blocked:
            self.ctx.messages = [HumanMessage(content=retry_content)]
        self._pending_events.append(
            {"type": "response.output_text.abandoned", "reason": "judge_failed"}
        )
        return _IterAction.CONTINUE

    def _handle_force_text_only(
        self,
        result_text: str,
        usage: Usage | None,
        iteration: int,
    ) -> ResponseObject | None:
        """Shared logic for force-text-only completion.

        Returns a ResponseObject if the skill signals completion, else None.
        """
        if iteration <= 1 or not self._skill_controller.should_force_text_only(self.ctx.session_id):
            return None

        text = result_text or "Task completed."
        self._service.append_to_history(
            self.ctx.session_id,
            self.ctx.messages,
            text,
            usage=usage.model_dump() if usage else {},
        )
        self._persist_assistant_message(text)
        self._persist_complete("completed")

        return self._service.responses.build_response(
            [self._service.responses.text_output(text)],
            ResponseStatus.COMPLETED,
            self.ctx.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
            iterations=iteration,
            tool_call_count=self.ctx.tool_call_count,
            tool_history=self.ctx.output_items or None,
        )

    async def _build_max_iterations_response(self) -> ResponseObject:
        """Build the response when max iterations are reached."""
        self._persist_complete("incomplete")
        text, _ = await self._messages.resolve(
            "loop.max_iterations",
            session_id=self.ctx.session_id,
            max_iterations=settings.MAX_AGENT_ITERATIONS,
        )
        return self._service.responses.build_response(
            [
                self._service.responses.text_output(
                    text,
                    status=ItemStatus.INCOMPLETE,
                )
            ],
            ResponseStatus.INCOMPLETE,
            self.ctx.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
            iterations=settings.MAX_AGENT_ITERATIONS,
            tool_call_count=self.ctx.tool_call_count,
            tool_history=self.ctx.output_items or None,
        )

    # -- public API --------------------------------------------------------

    async def run(self) -> ResponseObject:
        if not self.ctx.tool_names:
            response = await self._run_text_only()
        else:
            async with self._controller.get_loop_lock(self.ctx.session_id):
                approval_response = await self._resume_pending_approval()
                if approval_response:
                    response = approval_response
                else:
                    response = await self._run_tool_iterations()
        await self._flush_persists()
        return response

    async def _run_text_only(self) -> ResponseObject:
        resp = await self._service.process_messages(
            messages=self.ctx.messages,
            session_id=self.ctx.session_id,
            instructions=self.ctx.request.instructions,
        )
        if resp.usage:
            self.ctx.total_usage = self.ctx.total_usage.add(resp.usage)

        # Persist: assistant text response (with reasoning if present)
        self._persist_assistant_message(resp.message or "", resp.reasoning)
        self._persist_complete("completed")

        return self._service.responses.build_response(
            [self._service.responses.text_output(resp.message)],
            ResponseStatus.COMPLETED,
            resp.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
        )

    async def _resume_pending_approval(self) -> ResponseObject | None:
        (
            resp,
            messages,
            tool_call_count,
            total_usage,
        ) = await self._tool_execution.handle_approval_continuation(
            self.ctx.session_id,
            self.ctx.messages,
            self.ctx.output_items,
            self.ctx.created_at,
            self.ctx.model,
            self.ctx.total_usage,
            self.ctx.tool_call_count,
            self.ctx.display_names,
        )
        self.ctx.messages = messages
        self.ctx.tool_call_count = tool_call_count
        self.ctx.total_usage = total_usage
        return resp

    def _get_instructions(self) -> str | None:
        """Return user-provided instructions (without runtime state)."""
        return self._original_instructions or None

    def _get_state_prompts(self, iteration: int = 1) -> list[str] | None:
        """Return per-turn runtime state prompts from active skills + loop state."""
        prompts = self._skill_controller.get_state_prompts(self.ctx.session_id)
        if prompts is None:
            prompts = []
        prompts.append(
            _LoopStateBuilder.build(
                iteration=iteration,
                max_iterations=settings.MAX_AGENT_ITERATIONS,
                tool_call_count=self.ctx.tool_call_count,
                output_items=self.ctx.output_items,
                total_usage=self.ctx.total_usage,
            )
        )
        return prompts or None

    # -- prompt middleware helpers ------------------------------------------

    @staticmethod
    def _apply_prompt_middleware_args(before_result, instructions, state_prompts, skills_prompt):
        """Apply BeforeResult.modified_args to prompt arguments."""
        if not before_result.modified_args:
            return instructions, state_prompts, skills_prompt
        m = before_result.modified_args
        return (
            m.get("instructions", instructions),
            m.get("state_prompts", state_prompts),
            m.get("skills_prompt", skills_prompt),
        )

    async def _run_prompt_before_middleware(self, instructions, state_prompts, skills_prompt):
        """Run prompt-domain before middleware. Returns (instructions, state_prompts, skills_prompt, event)."""
        mw = getattr(self._controller, "middleware", None)
        if not mw:
            return instructions, state_prompts, skills_prompt, None

        ctx = MiddlewareContext(
            session_id=self.ctx.session_id,
            extras={"display_names": self.ctx.display_names},
        )
        event = PromptBuildEvent(
            context=ctx,
            instructions=instructions,
            client_tool_prompts=self.ctx.client_tool_prompts,
            client_tool_schemas=self.ctx.client_tool_schemas,
            state_prompts=state_prompts,
            skills_prompt=skills_prompt,
        )
        before = await mw.run_before(event)
        if before.blocked:
            raise MiddlewareBlocked(before.reason)
        instructions, state_prompts, skills_prompt = self._apply_prompt_middleware_args(
            before, instructions, state_prompts, skills_prompt
        )
        return instructions, state_prompts, skills_prompt, event

    async def _run_prompt_after_middleware(self, event):
        """Fire prompt-domain after middleware if event was created."""
        if event is None:
            return
        mw = getattr(self._controller, "middleware", None)
        if mw:
            await mw.run_after(event)

    # -- non-streaming tool loop -------------------------------------------

    async def _run_tool_iterations(self) -> ResponseObject:
        self._skill_controller.clear_completed_plans(self.ctx.session_id)
        for iteration in range(1, settings.MAX_AGENT_ITERATIONS + 1):
            instructions = self._get_instructions()
            state_prompts = self._get_state_prompts(iteration=iteration)
            skills_prompt = self.ctx.skills_prompt

            (
                instructions,
                state_prompts,
                skills_prompt,
                prompt_event,
            ) = await self._run_prompt_before_middleware(instructions, state_prompts, skills_prompt)

            result = await self._service.process_messages_with_tools(
                messages=self.ctx.messages,
                session_id=self.ctx.session_id,
                instructions=instructions,
                client_tool_schemas=self.ctx.client_tool_schemas,
                client_tool_prompts=self.ctx.client_tool_prompts,
                state_prompts=state_prompts,
                skills_prompt=skills_prompt,
            )

            await self._run_prompt_after_middleware(prompt_event)
            self.ctx.session_id = result.session_id
            if result.usage:
                self.ctx.total_usage = self.ctx.total_usage.add(result.usage)

            if result.type == LLMResultType.TEXT:
                # Priority 1: Skill unfinished work
                action = await self._handle_skill_unfinished(result.text or "", result.usage)
                self._drain_events()  # discard SSE events in non-streaming
                if action == _IterAction.CONTINUE:
                    continue

                # Priority 2: LLM-as-judge quality gate
                action = await self._handle_judge_gate(result.text or "", result.usage)
                self._drain_events()
                if action == _IterAction.CONTINUE:
                    continue

                # Persist: assistant text response (with reasoning if present)
                self._persist_assistant_message(result.text or "", result.reasoning)
                self._persist_complete("completed")

                return self._service.responses.build_response(
                    [self._service.responses.text_output(result.text)],
                    ResponseStatus.COMPLETED,
                    self.ctx.session_id,
                    self.ctx.created_at,
                    self.ctx.model,
                    usage=self.ctx.total_usage,
                    iterations=iteration,
                    tool_call_count=self.ctx.tool_call_count,
                    tool_history=self.ctx.output_items or None,
                )

            # Skills signal all work done — drop extra tool calls.
            text = ""
            if result.assistant_lc_message:
                text = self._service.extract_lc_text(result.assistant_lc_message.content)
            force_resp = self._handle_force_text_only(text, result.usage, iteration)
            if force_resp:
                return force_resp

            response = await self._handle_tool_call_iteration(result, iteration)
            if response:
                return response

            # Tool calls executed successfully — reset plan retry counter
            # Only reset if no unfinished skill work remains (defense-in-depth
            # against infinite retry loops when sub-agents are still running).
            if not self._skill_controller.has_unfinished_work(self.ctx.session_id):
                self.ctx.plan_retry_count = 0
            self.ctx.messages = []

        return await self._build_max_iterations_response()

    async def _handle_tool_call_iteration(
        self, result: Any, iteration: int
    ) -> ResponseObject | None:
        all_tool_calls = result.tool_calls or []
        client_calls, server_calls = self._mcp_client.classify_tool_calls(
            all_tool_calls,
            client_tool_names=self.ctx.client_tool_names,
        )

        skill_tool_names = self._skill_controller.get_all_tool_names()
        unsupported = [
            tc
            for tc in server_calls
            if not self._mcp_client.is_server_tool(tc.name)
            and tc.name not in skill_tool_names
            and not self._mcp_client.needs_approval(tc.name, self.ctx.session_id)
        ]
        if unsupported:
            # Return error results for unsupported tools so the LLM can
            # recover and try an available tool on the next iteration.
            error_results: list[BaseMessage] = []
            for tc in unsupported:
                error_msg, _ = await self._messages.resolve(
                    "tool.error_unsupported",
                    session_id=self.ctx.session_id,
                    name=tc.name,
                )
                error_result = self._service.responses.make_tool_result_message(
                    tool_name=tc.name,
                    tool_call_id=tc.id,
                    result=error_msg,
                )
                error_results.append(error_result)
                self.ctx.messages.append(error_result)
                self._service.responses.append_tool_output_items(
                    tool_name=tc.name,
                    display_name=tc.name,
                    arguments=tc.args,
                    tool_call_id=tc.id,
                    result=error_msg,
                    output_items=self.ctx.output_items,
                )
                # Persist: unsupported tool error
                self._persist_message(
                    "function_call_output",
                    "tool",
                    error_msg,
                    metadata={"tool_call_id": tc.id, "tool_name": tc.name},
                )
            server_calls = [tc for tc in server_calls if tc not in unsupported]
            if not server_calls and not client_calls:
                # Persist the failed interaction to session history so the
                # LLM sees the error on the next iteration and can recover
                # (e.g. suggest setting CWD or use a different approach).
                await self._service.append_tool_interaction(
                    self.ctx.session_id,
                    self.ctx.messages,
                    [tc.model_dump() for tc in all_tool_calls],
                    error_results,
                    usage=result.usage.model_dump() if result.usage else {},
                    assistant_lc_message=result.assistant_lc_message,
                    snapshot_tools=self._tool_execution._snapshot_tools_for(self.ctx.session_id),
                )
                self.ctx.messages = []
                return None

        if any(
            self._mcp_client.needs_approval(tc.name, self.ctx.session_id) for tc in server_calls
        ):
            info = self._mcp_client.request_approval(
                server_calls,
                self.ctx.session_id,
                result.usage,
                self.ctx.messages,
                assistant_lc_message=result.assistant_lc_message,
            )
            # Persist: approval request causes incomplete status
            self._persist_complete("incomplete")
            return self._service.responses.build_response(
                [
                    self._service.responses.tool_call_output(
                        "tool_approval",
                        info["question"],
                        info["approval_call_id"],
                        display_name=info["display_name"],
                    )
                ],
                ResponseStatus.INCOMPLETE,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                usage=self.ctx.total_usage,
                iterations=iteration,
                tool_call_count=self.ctx.tool_call_count,
                tool_history=self.ctx.output_items or None,
            )

        # Persist: function_call items
        for tc in all_tool_calls:
            self._persist_message(
                "function_call",
                "assistant",
                "",
                metadata={"name": tc.name, "arguments": tc.args, "call_id": tc.id},
            )

        # Pipelined execution: run server tools and follow chain steps
        # as results arrive (FIRST_COMPLETED), instead of waiting for all.
        (
            pipeline_results,
            deferred_approval,
        ) = await self._tool_execution.execute_tool_calls_pipelined(
            server_calls,
            self.ctx.output_items,
            self.ctx.display_names,
            session_id=self.ctx.session_id,
        )
        self.ctx.tool_call_count += len(pipeline_results) + len(client_calls)

        # Persist: function_call_output items
        for tr in pipeline_results:
            self._persist_message(
                "function_call_output",
                "tool",
                tr.content,
                metadata={"tool_call_id": tr.tool_call_id or "", "tool_name": tr.name or ""},
            )

        # Append client-side tool placeholders for the LLM history
        for tc in client_calls:
            pipeline_results.append(
                ToolMessage(
                    content=json.dumps(tc.args),
                    tool_call_id=tc.id,
                    name=tc.name,
                )
            )

        # Record the original LLM tool-call turn (client + server together)
        await self._service.append_tool_interaction(
            self.ctx.session_id,
            self.ctx.messages,
            [tc.model_dump() for tc in all_tool_calls],
            pipeline_results,
            usage=result.usage.model_dump(),
            assistant_lc_message=result.assistant_lc_message,
            snapshot_tools=self._tool_execution._snapshot_tools_for(self.ctx.session_id),
        )

        # Handle any chained calls that need user approval
        if deferred_approval:
            chain_resp = await self._tool_execution.handle_chained_calls(
                deferred_approval,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                self.ctx.total_usage,
                self.ctx.tool_call_count,
                self.ctx.output_items,
                self.ctx.display_names,
                iteration=iteration,
            )
            if chain_resp:
                return chain_resp

        if client_calls:
            client_output = [
                self._service.responses.tool_call_output(
                    tc.name, tc.args, tc.id, display_name=self.ctx.display_names[tc.name]
                )
                for tc in client_calls
            ]
            return self._service.responses.build_response(
                client_output,
                ResponseStatus.INCOMPLETE,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                usage=self.ctx.total_usage,
                iterations=iteration,
                tool_call_count=self.ctx.tool_call_count,
                tool_history=self.ctx.output_items or None,
            )

        return None

    # -- streaming ---------------------------------------------------------

    async def stream(self):
        """Async generator yielding SSE-formatted event strings."""
        response_id = f"resp_{uuid.uuid4().hex}"

        yield self._service.responses.sse_event(
            {
                "type": "response.created",
                "response": {
                    "id": response_id,
                    "status": "in_progress",
                    "model": self.ctx.model,
                    "created_at": self.ctx.created_at,
                    "metadata": {"session_id": self.ctx.session_id},
                },
            }
        )

        try:
            if not self.ctx.tool_names:
                async for event in self._stream_text_only():
                    yield event
            else:
                async with self._controller.get_loop_lock(self.ctx.session_id):
                    items_before = len(self.ctx.output_items)
                    approval_response = await self._resume_pending_approval()

                    # Emit SSE events for tools executed during approval
                    for item in self.ctx.output_items[items_before:]:
                        if isinstance(item, FunctionToolCall) and item.name != "tool_approval":
                            item_data: Dict[str, Any] = {
                                "call_id": item.call_id,
                                "name": item.name,
                                "arguments": (
                                    item.arguments
                                    if isinstance(item.arguments, str)
                                    else json.dumps(item.arguments)
                                ),
                            }
                            item_data["display_name"] = self.ctx.display_names[item.name]
                            yield self._service.responses.sse_event(
                                {
                                    "type": "response.function_call.done",
                                    "item": item_data,
                                }
                            )
                        elif isinstance(item, FunctionToolResult):
                            yield self._service.responses.sse_event(
                                {
                                    "type": "response.tool_result.done",
                                    "call_id": item.call_id,
                                    "output": item.output,
                                    "status": (
                                        "failed"
                                        if is_tool_error(item.output or "")
                                        else "completed"
                                    ),
                                }
                            )

                    if approval_response:
                        evt = (
                            "response.completed"
                            if approval_response.status == ResponseStatus.COMPLETED
                            else "response.incomplete"
                        )
                        yield self._service.responses.sse_event(
                            {
                                "type": evt,
                                "response": approval_response.model_dump(mode="json"),
                            }
                        )
                    else:
                        async for event in self._stream_tool_iterations():
                            yield event
        except asyncio.CancelledError:
            logger.debug("SSE stream cancelled (client disconnected) for session %s", self.ctx.session_id)
        except Exception as e:
            logger.exception("Streaming agent loop error")
            error_response = self._service.responses.build_response(
                [],
                ResponseStatus.FAILED,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                error=ErrorObject(type=ErrorType.SERVER_ERROR, message=str(e)),
            )
            yield self._service.responses.sse_event(
                {
                    "type": "response.failed",
                    "response": error_response.model_dump(mode="json"),
                }
            )

        await self._flush_persists()
        yield self._service.responses.sse_done()

    async def _stream_llm_and_accumulate(self, use_tools: bool = True, iteration: int = 1):
        """Stream LLM chunks, yielding text deltas, reasoning deltas, and returning accumulated result."""
        accumulated = None

        instructions = self.ctx.request.instructions
        state_prompts = self._get_state_prompts(iteration=iteration)
        skills_prompt = self.ctx.skills_prompt

        if use_tools:
            (
                instructions,
                state_prompts,
                skills_prompt,
                prompt_event,
            ) = await self._run_prompt_before_middleware(instructions, state_prompts, skills_prompt)
        else:
            prompt_event = None

        async for chunk in self._service.stream_messages_with_tools(
            messages=self.ctx.messages,
            session_id=self.ctx.session_id,
            instructions=instructions,
            client_tool_schemas=self.ctx.client_tool_schemas if use_tools else None,
            client_tool_prompts=self.ctx.client_tool_prompts if use_tools else None,
            state_prompts=state_prompts,
            skills_prompt=skills_prompt,
        ):
            reasoning_delta = (
                self._service._normalize._extract_reasoning(chunk.content) if chunk.content else ""
            )
            if reasoning_delta:
                yield ("reasoning_delta", reasoning_delta)
            delta = self._service.extract_lc_text(chunk.content) if chunk.content else ""
            if delta:
                yield ("delta", delta)
            accumulated = chunk if accumulated is None else accumulated + chunk

        await self._run_prompt_after_middleware(prompt_event)
        yield ("done", accumulated)

    async def _stream_text_only(self):
        """Stream a text-only LLM response (no tools)."""
        accumulated = None

        async for tag, value in self._stream_llm_and_accumulate(use_tools=False):
            if tag == "reasoning_delta":
                yield self._service.responses.sse_event(
                    {"type": "response.reasoning.delta", "delta": value}
                )
            elif tag == "delta":
                yield self._service.responses.sse_event(
                    {"type": "response.output_text.delta", "delta": value}
                )
            elif tag == "done":
                accumulated = value

        if accumulated:
            normalized = self._service._normalize.normalize_llm_response(accumulated)
            full_text = normalized.text
            reasoning = normalized.reasoning
            usage = normalized.usage
        else:
            full_text = ""
            reasoning = ""
            usage = Usage.zero()

        if accumulated:
            self.ctx.total_usage = self.ctx.total_usage.add(usage)
            self._service.append_to_history(
                self.ctx.session_id,
                self.ctx.messages,
                full_text,
                usage=usage.model_dump(),
                assistant_lc_message=normalized.raw_message,
            )

        # Emit reasoning done event if reasoning was present
        if reasoning:
            yield self._service.responses.sse_event(
                {"type": "response.reasoning.done", "text": reasoning}
            )

        # Persist: assistant text response (with reasoning if present)
        self._persist_assistant_message(full_text, reasoning or None)
        self._persist_complete("completed")

        yield self._service.responses.sse_event(
            {
                "type": "response.output_text.done",
                "text": full_text,
                "usage": usage.model_dump(),
            }
        )

        response = self._service.responses.build_response(
            [self._service.responses.text_output(full_text)],
            ResponseStatus.COMPLETED,
            self.ctx.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
        )
        yield self._service.responses.sse_event(
            {
                "type": "response.completed",
                "response": response.model_dump(mode="json"),
            }
        )

    async def _stream_tool_iterations(self):
        """Stream the tool iteration loop, yielding SSE events."""
        self._skill_controller.clear_completed_plans(self.ctx.session_id)
        for iteration in range(1, settings.MAX_AGENT_ITERATIONS + 1):
            # Inject current TODO state into instructions for this iteration
            self.ctx.request.instructions = self._get_instructions()

            accumulated = None

            async for tag, value in self._stream_llm_and_accumulate(
                use_tools=True, iteration=iteration
            ):
                if tag == "reasoning_delta":
                    yield self._service.responses.sse_event(
                        {"type": "response.reasoning.delta", "delta": value}
                    )
                elif tag == "delta":
                    yield self._service.responses.sse_event(
                        {"type": "response.output_text.delta", "delta": value}
                    )
                elif tag == "done":
                    accumulated = value

            if not accumulated:
                break

            normalized = self._service._normalize.normalize_llm_response(accumulated)
            usage = normalized.usage
            self.ctx.total_usage = self.ctx.total_usage.add(usage)

            if not normalized.tool_calls:
                # TEXT result — check shared helpers
                action = await self._handle_skill_unfinished(
                    normalized.text, usage, raw_message=normalized.raw_message
                )
                for evt in self._drain_events():
                    yield self._service.responses.sse_event(evt)
                if action == _IterAction.CONTINUE:
                    continue

                # Priority 2: LLM-as-judge quality gate
                full_text = normalized.text
                action = await self._handle_judge_gate(
                    full_text, usage, raw_message=normalized.raw_message
                )
                for evt in self._drain_events():
                    yield self._service.responses.sse_event(evt)
                if action == _IterAction.CONTINUE:
                    continue

                self._service.append_to_history(
                    self.ctx.session_id,
                    self.ctx.messages,
                    full_text,
                    usage=usage.model_dump(),
                    assistant_lc_message=normalized.raw_message,
                )

                # Emit reasoning done event if reasoning was present
                if normalized.reasoning:
                    yield self._service.responses.sse_event(
                        {"type": "response.reasoning.done", "text": normalized.reasoning}
                    )

                # Persist: assistant text response (with reasoning if present)
                self._persist_assistant_message(full_text, normalized.reasoning or None)
                self._persist_complete("completed")

                yield self._service.responses.sse_event(
                    {
                        "type": "response.output_text.done",
                        "text": full_text,
                        "usage": usage.model_dump(),
                    }
                )
                response = self._service.responses.build_response(
                    [self._service.responses.text_output(full_text)],
                    ResponseStatus.COMPLETED,
                    self.ctx.session_id,
                    self.ctx.created_at,
                    self.ctx.model,
                    usage=self.ctx.total_usage,
                    iterations=iteration,
                    tool_call_count=self.ctx.tool_call_count,
                    tool_history=self.ctx.output_items or None,
                )
                yield self._service.responses.sse_event(
                    {
                        "type": "response.completed",
                        "response": response.model_dump(mode="json"),
                    }
                )
                return

            # TOOL_CALL: discard narration text that was streamed alongside
            # tool_calls (e.g. "mcp_web__search를 사용하여...").
            yield self._service.responses.sse_event(
                {"type": "response.output_text.abandoned", "reason": "tool_call"}
            )

            # Force-text-only check
            force_resp = self._handle_force_text_only(normalized.text, usage, iteration)
            if force_resp:
                yield self._service.responses.sse_event(
                    {
                        "type": "response.output_text.done",
                        "text": normalized.text or "Task completed.",
                        "usage": usage.model_dump(),
                    }
                )
                yield self._service.responses.sse_event(
                    {
                        "type": "response.completed",
                        "response": force_resp.model_dump(mode="json"),
                    }
                )
                return

            tool_calls_info = [
                ToolCallInfo(name=tc["name"], args=tc["args"], id=tc["id"])
                for tc in accumulated.tool_calls
            ]

            usage_dump = usage.model_dump()
            for tc in tool_calls_info:
                item_data: Dict[str, Any] = {
                    "call_id": tc.id,
                    "name": tc.name,
                    "arguments": (
                        json.dumps(tc.args) if isinstance(tc.args, dict) else str(tc.args)
                    ),
                }
                item_data["display_name"] = self.ctx.display_names[tc.name]
                yield self._service.responses.sse_event(
                    {
                        "type": "response.function_call.done",
                        "item": item_data,
                        "usage": usage_dump,
                    }
                )

            # Build LLMResult for _handle_tool_call_iteration
            result_obj = LLMResult(
                type=LLMResultType.TOOL_CALL,
                tool_calls=tool_calls_info,
                usage=usage,
                assistant_lc_message=accumulated,
                session_id=self.ctx.session_id,
            )

            # Track original LLM call IDs to avoid duplicate SSE events
            # (LLM calls already emitted above).
            original_call_ids = {tc.id for tc in tool_calls_info}

            items_before = len(self.ctx.output_items)
            response = await self._handle_tool_call_iteration(result_obj, iteration)

            # Emit SSE events for newly executed server tools.
            # Skip original LLM function_call events (already emitted above)
            # but always emit tool_result events so the frontend can update
            # tool call status from "running" to "completed".
            for item in self.ctx.output_items[items_before:]:
                if isinstance(item, FunctionToolCall) and item.name != "tool_approval":
                    if item.call_id in original_call_ids:
                        continue
                    item_data: Dict[str, Any] = {
                        "call_id": item.call_id,
                        "name": item.name,
                        "arguments": (
                            item.arguments
                            if isinstance(item.arguments, str)
                            else json.dumps(item.arguments)
                        ),
                    }
                    item_data["display_name"] = self.ctx.display_names[item.name]
                    yield self._service.responses.sse_event(
                        {
                            "type": "response.function_call.done",
                            "item": item_data,
                        }
                    )
                elif isinstance(item, FunctionToolResult):
                    yield self._service.responses.sse_event(
                        {
                            "type": "response.tool_result.done",
                            "call_id": item.call_id,
                            "output": item.output,
                            "status": (
                                "failed" if is_tool_error(item.output or "") else "completed"
                            ),
                        }
                    )

            # Emit live skill state only when manage_todo was executed
            # this iteration (avoids re-emitting stale TODO from previous turns).
            _todo_updated = any(
                isinstance(item, FunctionToolCall) and item.name == "manage_todo"
                for item in self.ctx.output_items[items_before:]
            )
            if _todo_updated:
                _live_state = self._skill_controller.get_live_state(self.ctx.session_id)
                if _live_state:
                    yield self._service.responses.sse_event(
                        {
                            "type": "response.todo.updated",
                            "todo": _live_state,
                        }
                    )

            if response:
                evt = (
                    "response.completed"
                    if response.status == ResponseStatus.COMPLETED
                    else "response.incomplete"
                )
                yield self._service.responses.sse_event(
                    {
                        "type": evt,
                        "response": response.model_dump(mode="json"),
                    }
                )
                return

            # Tool calls executed successfully — reset plan retry counter
            # Only reset if no unfinished skill work remains (defense-in-depth
            # against infinite retry loops when sub-agents are still running).
            if not self._skill_controller.has_unfinished_work(self.ctx.session_id):
                self.ctx.plan_retry_count = 0
            self.ctx.messages = []

        # Max iterations reached
        response = await self._build_max_iterations_response()
        yield self._service.responses.sse_event(
            {
                "type": "response.incomplete",
                "response": response.model_dump(mode="json"),
            }
        )
