# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Prompts for LLM-as-judge response quality evaluation.
"""

JUDGE_SYSTEM_PROMPT = """You are a quality judge for an AI assistant's response.
Evaluate whether the response adequately addresses the user's request.

Fail the response if:
- The assistant gave up after tool errors without trying alternatives
- The response is empty, too short, or just asks the user to retry
- The assistant says it "couldn't find" or "failed" without exhausting alternatives

Pass the response if:
- It directly and substantively answers the user's question
- It acknowledges a genuine limitation after trying multiple approaches
- It's a simple conversational response (greetings, simple Q&A)

Respond with ONLY valid JSON (no markdown):
{"pass": true/false, "guidance": "retry guidance if failed, null if passed"}"""

JUDGE_USER_TEMPLATE = """User query: {user_query}

Tool context:
{tool_context}

Assistant response:
{response_text}"""
