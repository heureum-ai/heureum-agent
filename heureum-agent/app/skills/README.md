# Heureum Agent — Skill Developer Guide

## Overview

A **skill** is a self-contained plugin that adds tools, prompt guides, or lifecycle hooks to the agent. Drop a new directory under `app/skills/` and the framework discovers it automatically at startup.

This guide is written for coding agents and human developers who want to **create a new skill from scratch** without reading framework internals.

---

## Existing Skills

```
app/skills/
├── activate_task/       # Progressive skill activation (subagent_access: never)
├── evaluate_task/       # LLM-as-judge quality evaluation (hook-only, no tools)
├── notification_task/   # Push notifications via Platform API (subagent_access: never)
├── periodic_task/       # Scheduled task registration/management
├── plan_task/           # Hierarchical task plan + sub-agent orchestration
└── web_search_task/     # Web search workflow guide (no server tools)
```

---

## Skill Types

| Type | server tools | `service.py` | `execute()` | Example |
|------|-------------|--------------|-------------|---------|
| **Tool skill** | Yes | Required | Required | `notification_task`, `periodic_task`, `plan_task` |
| **Guide skill** | No (`tool_schemas=[]`) | Not needed | N/A | `web_search_task` |
| **Hook skill** | No | Required (hook methods) | N/A | `evaluate_task` |

### File structure by type

**Tool skill** (most common):
```
my_skill/
├── __init__.py    # Exports `skill` variable (REQUIRED)
├── SKILL.md       # Frontmatter + agent guide (REQUIRED)
└── service.py     # Class with name, tool_schemas, execute()
```

**Guide skill** (prompt injection only, no custom server tools):
```
my_skill/
├── __init__.py    # Exports `skill` variable with tool_schemas=[]
└── SKILL.md       # Guide body injected into system prompt
```

**Hook skill** (lifecycle hooks like `evaluate_response`):
```
my_skill/
├── __init__.py    # Exports `skill` variable
├── SKILL.md       # Metadata only
└── service.py     # Class with hook methods (e.g. evaluate_response)
```

---

## Auto-Discovery Requirements

The framework function `discover_skills()` (`app/services/skills/discovery.py`) scans `app/skills/` at startup. A package is registered as a skill when **all** of these conditions are met:

| # | Condition | What happens if missing |
|---|-----------|------------------------|
| 1 | Directory exists under `app/skills/` and does **not** start with `_` or `.` | Skipped entirely |
| 2 | `__init__.py` exists in the directory | Skipped entirely |
| 3 | Module-level `skill` variable is exported from `__init__.py` | Skipped with no warning |
| 4 | `skill` object has a `name` attribute (str) | Skipped with warning log |
| 5 | `skill` object has a `tool_schemas` attribute (list) | Skipped with warning log |

After discovery, the framework also:
- Loads and parses `SKILL.md` → `SkillMeta` dataclass
- Builds a `tool_name → skill` mapping from `tool_schemas[*].function.name`
- Extracts `display_name` from each schema's top-level `display_name` field

**Reference:** `app/services/skills/discovery.py`

```python
# Core discovery logic (simplified)
skill = getattr(module, "skill", None)
if skill is None:
    continue
if not hasattr(skill, "name") or not hasattr(skill, "tool_schemas"):
    logger.warning("Skill in %s missing 'name' or 'tool_schemas', skipping", module_name)
    continue
```

---

## Step-by-Step: Creating a New Skill

### Step 1. Create Directory

```bash
mkdir app/skills/my_skill/
```

### Step 2. Write `SKILL.md`

The SKILL.md file has two parts: YAML frontmatter and a markdown body.

**Frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier (should match directory name) |
| `description` | Yes | One-line description (shown in skill catalog UI) |
| `tools` | No | Comma-separated tool names this skill uses (server + client) |
| `depends_on` | No | Other skill names this skill depends on (comma-separated) |
| `subagent_access` | No | `always` (default) / `orchestrator` / `never` |

**`subagent_access` values:**
- `always` — Available in all sub-agents
- `orchestrator` — Available only at orchestrator depth (depth < max), excluded from leaf sub-agents
- `never` — Root session only, never passed to sub-agents

**Frontmatter parsing rules** (from `app/services/skills/metadata.py`):
- Delimited by `---` markers (standard YAML frontmatter)
- Each line is parsed as `key: value` (simple colon-separated, not full YAML)
- List fields (`tools`, `depends_on`) are comma-separated strings
- The body (everything after the closing `---`) is injected into the system prompt as a tool guide

**Real example — `notification_task/SKILL.md`:**

```markdown
---
name: notification_task
description: Push notifications to user devices
tools: notify_user
depends_on:
subagent_access: never
---
You have a `notify_user` tool to send push notifications directly to the user's devices.

When to use:
- When a periodic task completes and needs to report results to the user.
- When the user explicitly asks to be notified about something.
- When a long-running task finishes and the user should be alerted.

When NOT to use:
- For normal conversational responses — just reply in text.
- When the user is actively reading the chat — notifications are for async delivery.

Usage:
`​`​`
notify_user(title="Short descriptive title", body="Detailed message with results")
`​`​`

Guidelines:
- Keep the `title` short and descriptive (under 50 characters).
- Put the detailed information in the `body` field.
- Periodic tasks MUST call `notify_user` at the end to report their results.
- If a periodic task uses `notify_user` for result delivery, set `notify_on_success=false`
  when registering the task to avoid duplicate notifications.
```

**Real example — `web_search_task/SKILL.md`** (guide-only skill):

```markdown
---
name: web_search_task
description: Web search and content retrieval workflow
tools: mcp_web__search, web_fetch, read
depends_on:
---
You have `mcp_web__search`, `web_fetch` and `read` tools for web research.

## Workflow — always follow this sequence:

1. `mcp_web__search(query="...")` — returns snippets and URLs.
2. `web_fetch(url="...")` — fetches the page and saves content as a local .md file.
3. `read(path="<md_path>")` — read the saved .md file.

## Key rules
- After search, you must call `web_fetch` before answering.
- Call multiple `web_fetch` in parallel on different URLs in a single turn.
```

### Step 3. Write `service.py` (Tool Skills)

Define a class with `name`, `tool_schemas`, and `execute()`.

**Real example — `notification_task/service.py`** (complete, minimal tool skill):

```python
"""Notification skill — sends notifications to users via Platform API."""

import logging
from typing import Any, Dict

import httpx
from app.config import settings

logger = logging.getLogger(__name__)

NOTIFY_USER_TOOL_SCHEMA = {
    "type": "function",
    "display_name": "Notify",                        # UI display label
    "function": {
        "name": "notify_user",                       # Unique tool name
        "description": (
            "Send a push notification to the user. Use this to deliver results, "
            "alerts, or updates directly to the user's devices. "
            "Periodic tasks MUST call this at the end to report their results."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Notification title (short, descriptive)",
                },
                "body": {
                    "type": "string",
                    "description": "Notification body with the detailed message or results",
                },
            },
            "required": ["title", "body"],
        },
    },
}


class NotificationSkill:
    """Sends notifications via Platform API internal endpoint."""

    name = "notification_task"
    tool_schemas = [NOTIFY_USER_TOOL_SCHEMA]

    async def execute(self, name: str, arguments: Dict[str, Any], session_id: str) -> str:
        title = arguments.get("title", "")
        body = arguments.get("body", "")

        if not title:
            return "Error: title is required"
        if not body:
            return "Error: body is required"

        payload = {
            "session_id": session_id,
            "title": title,
            "body": body,
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{settings.PLATFORM_API_URL}/api/v1/notifications/internal/send/",
                    json=payload,
                )
                if resp.status_code in (200, 201):
                    return f"Notification sent: {title}"
                return f"Error sending notification: {resp.text}"
        except Exception as e:
            logger.warning("Failed to send notification: %s", e)
            return f"Error sending notification: {e}"
```

### Step 4. Write `__init__.py`

**Tool skill:**

```python
from app.skills.my_skill.service import MySkill

skill = MySkill()
```

**Guide-only skill** (no `service.py` needed):

```python
class _MyGuideSkill:
    name = "my_skill"
    tool_schemas: list = []

skill = _MyGuideSkill()
```

> **Critical:** The module-level `skill` variable is the only entry point for auto-discovery. Without it, the skill is silently ignored.

### Step 5. Lifecycle Methods

Add optional methods to your skill class for deeper framework integration.

```python
class MySkill:
    name = "my_skill"
    tool_schemas = [...]

    async def on_init(self, **kwargs) -> None:
        """Called once at startup. Receive injected dependencies."""
        ...

    def get_state_prompt(self, session_id: str) -> str | None:
        """Called every prompt build. Return runtime state for <session_state>."""
        return None

    def clear_session(self, session_id: str) -> None:
        """Called on session end. Clean up per-session state."""
        pass

    def is_all_complete(self, session_id: str) -> bool:
        """Check if all work for this skill is done."""
        return True

    def has_unfinished_steps(self, session_id: str) -> bool:
        """Check if background tasks are still running."""
        return False

    async def await_pending(self, session_id: str, timeout: float) -> None:
        """Wait for background tasks to complete."""
        pass

    def build_retry_guidance(self, session_id: str, abandoned_text: str) -> str | None:
        """Return retry guidance when the agent abandons a task."""
        return None
```

#### `on_init` kwargs

The `on_init(**kwargs)` method receives these keyword arguments from `SkillController.startup()`:

| Key | Type | Description |
|-----|------|-------------|
| `skill_controller` | `SkillController` | Always injected by `startup()` itself. Access other skills, execute tools. |
| `create_subagent_task_fn` | `Callable` | Async function to spawn a sub-agent. Used by `plan_task`. |
| `get_skills_prompt` | `Callable[[], str]` | Returns the current `<available_skills>` prompt block. |
| `subagent_config` | `dict` | Sub-agent limits: `{"max_spawn_depth": int, "max_children": int}` |

These are passed from `AgentLoopController._initialize()` → `SkillController.startup()`. See `app/services/agent_loop/controller.py:207`.

#### `get_state_prompt` injection

The string returned by `get_state_prompt(session_id)` is collected by `SkillController.get_state_prompts()` and injected into the `<session_state>` XML block of the system prompt. This is called on **every LLM turn**, making it suitable for dynamic runtime context (e.g., current plan progress, active task status).

### Step 6. Write Tests

```python
# tests/test_my_skill.py
import pytest
from app.skills.my_skill.service import MySkill


class TestMySkill:
    @pytest.mark.asyncio
    async def test_execute_returns_result(self):
        skill = MySkill()
        result = await skill.execute("my_tool_a", {"param1": "hello"}, "sess_1")
        assert "hello" in result
```

---

## Prompt Injection Structure

The SKILL.md body and lifecycle prompts are injected into the system prompt via XML tags. Here is the full layout (from `SystemPromptBuilder` in `app/services/prompts/base.py`):

```
<identity>…</identity>
<safety>…</safety>
<response_style>…</response_style>
<tool_usage>…</tool_usage>
<conversation>…</conversation>
<language>…</language>

<tool_guides>                              ← SKILL.md bodies go here
  <tool_guide name="notification_task">
    …SKILL.md body…
  </tool_guide>
  <tool_guide name="web_search_task">
    …SKILL.md body…
  </tool_guide>
</tool_guides>

<session_state>                            ← get_state_prompt() outputs go here
  …runtime state from skills…
</session_state>

<instructions>…</instructions>
<current_date>YYYY-MM-DD</current_date>
```

**How it works:**
1. `SkillController.get_all_guide_prompts()` wraps each SKILL.md body in `<tool_guide name="...">` tags
2. `SystemPromptBuilder.add_tool_guides()` collects them inside `<tool_guides>`
3. `SkillController.get_state_prompts()` calls `get_state_prompt(session_id)` on every skill
4. `SystemPromptBuilder.add_state_prompts()` collects them inside `<session_state>`

---

## Tool Execution Path

When the LLM generates a tool call, it flows through these layers:

```
Agent Loop (runner.py)
  → ToolExecutionController.execute_tool()          # app/services/agent_loop/execution.py:59
    → skill_controller.get_skill_for_tool(name)      # Check if it's a skill tool
    → SkillController.execute_tool(name, args, sid)  # app/services/skills/controller.py:452
      → skill.execute(name, arguments, session_id)   # Your skill's execute() method
```

**Detailed dispatch** (from `ToolExecutionController.execute_tool`):

1. Check `skill_controller.get_skill_for_tool(name)` — if a skill owns this tool name, dispatch to `skill_controller.execute_tool()`
2. Otherwise check `mcp_client.is_server_tool(name)` — dispatch to MCP server
3. Otherwise return an "unavailable" error

The middleware pipeline (`MiddlewareRunner`) wraps each dispatch with `before`/`after` hooks for blocking, argument modification, and logging.

**Reference files:**

| Component | File |
|-----------|------|
| `ToolExecutionController` | `app/services/agent_loop/execution.py` |
| `SkillController.execute_tool()` | `app/services/skills/controller.py:452` |
| Middleware events | `app/services/middleware/types.py` (`SkillExecuteEvent`) |

---

## Platform API Integration Pattern

Skills that need to communicate with the Heureum Platform use `httpx` with `settings.PLATFORM_API_URL`. This is the standard pattern used by `notification_task` and `periodic_task`:

```python
import httpx
from app.config import settings

async def _call_platform(self, session_id: str, payload: dict) -> str:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{settings.PLATFORM_API_URL}/api/v1/your-endpoint/internal/action/",
                json=payload,
            )
            if resp.status_code in (200, 201):
                return resp.json()  # or format as string
            return f"Error: {resp.text}"
    except Exception as e:
        logger.warning("Platform API call failed: %s", e)
        return f"Error: {e}"
```

**Key conventions:**
- Use `httpx.AsyncClient` (not `requests`) — all skill execution is async
- Set an explicit `timeout` (typically 10s)
- Platform internal endpoints follow the pattern: `/api/v1/{resource}/internal/{action}/`
- Always pass `session_id` in the payload for user scoping
- Handle both success codes (`200`, `201`) and errors gracefully
- Log failures at `warning` level

---

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Missing `skill` variable in `__init__.py` | Skill silently not registered | Add `skill = MySkill()` at module level |
| Missing `name` or `tool_schemas` attribute | Warning log, skill skipped | Both are required even for guide skills (`tool_schemas=[]`) |
| Tool name collision with existing tools | Unpredictable dispatch — first registered wins | Use unique prefixes; check `SkillController._tool_to_skill` keys |
| SKILL.md missing `---` frontmatter delimiters | Entire file treated as body, no metadata parsed | Wrap frontmatter between two `---` lines |
| `on_init` defined as sync instead of async | `startup()` calls it with `await`; `TypeError` at startup | Always define as `async def on_init(self, **kwargs)` |
| `execute()` defined as sync | `SkillController.execute_tool()` calls with `await`; `TypeError` | Always define as `async def execute(...)` |
| `subagent_access` typo or wrong case | Defaults to `"always"`, tool appears in all sub-agents | Use exact values: `always`, `orchestrator`, `never` |
| Returning non-string from `execute()` | Agent receives garbled output | Always return `str` from `execute()` |
| Not handling `session_id` in stateful skills | State leaks across sessions | Key all per-session state dictionaries by `session_id` |

---

## Framework File Reference

| Component | File Path | Key Responsibilities |
|-----------|-----------|---------------------|
| **Skill auto-discovery** | `app/services/skills/discovery.py` | Scan `app/skills/`, import modules, validate `skill` objects |
| **Skill controller** | `app/services/skills/controller.py` | Registry, schema aggregation, tool dispatch, lifecycle orchestration |
| **SKILL.md parser** | `app/services/skills/metadata.py` | `parse_skill_md()`, `load_skill_meta()`, `load_guide_prompt()` |
| **SkillMeta dataclass** | `app/services/skills/types.py` | `SkillMeta(name, description, body, tools, depends_on, subagent_access)` |
| **Tool execution pipeline** | `app/services/agent_loop/execution.py` | `ToolExecutionController` — dispatches to skills, MCP, or client tools |
| **System prompt builder** | `app/services/prompts/base.py` | `SystemPromptBuilder` — assembles `<tool_guides>`, `<session_state>` |
| **Prompt controller** | `app/services/prompts/controller.py` | `PromptController` — orchestrates prompt + tool schema resolution |
| **Agent loop controller** | `app/services/agent_loop/controller.py` | Calls `skill_controller.startup()` with kwargs |
| **App config** | `app/config.py` | `settings.PLATFORM_API_URL` and other configuration |

---

## Execution Flow Summary

```
App Startup
  → SkillController.__init__()
    → discover_skills()  — scan app/skills/, import __init__.py, load `skill` var
    → load_skill_meta()  — parse each SKILL.md into SkillMeta
    → build tool_name → skill mapping
  → SkillController.startup(**kwargs)
    → call on_init(**kwargs) on each skill (async, parallel via gather)
    → kwargs includes: skill_controller, create_subagent_task_fn,
      get_skills_prompt, subagent_config

Agent Loop (every turn)
  → Prompt build
    → get_all_guide_prompts() → SKILL.md body → <tool_guides> tag
    → get_state_prompts()     → get_state_prompt() → <session_state> tag
    → get_all_tool_schemas()  → tool schemas for LLM binding
  → LLM response → tool call
    → ToolExecutionController.execute_tool(name, args, session_id)
      → SkillController.execute_tool() → skill.execute()

Session End
  → SkillController.clear_session(session_id)
    → call clear_session() on each skill
```

---

## Checklist

When adding a new skill, verify:

- [ ] `app/skills/<name>/` directory created
- [ ] `SKILL.md` — valid frontmatter (`---` delimited) + guide body
- [ ] `__init__.py` — exports `skill = MySkill()` at module level
- [ ] `service.py` — `execute()` implemented (tool skills only)
- [ ] `skill.name` matches `SKILL.md` `name` field
- [ ] `tool_schemas` present (empty list `[]` for guide/hook skills)
- [ ] Tool names are globally unique (no collision with existing skills or MCP tools)
- [ ] `subagent_access` set appropriately
- [ ] `on_init` and `execute` are `async def`
- [ ] `execute()` always returns `str`
- [ ] Tests written in `tests/test_<name>.py`

---

## Quick Reference: Existing Skill Patterns

| Pattern | Reference Skill | Key Takeaway |
|---------|----------------|--------------|
| Minimal tool skill | `notification_task` | Single tool, Platform API call, ~70 lines |
| Guide-only skill | `web_search_task` | No `service.py`, `tool_schemas=[]`, body teaches LLM workflow |
| Complex stateful skill | `plan_task` | `get_state_prompt`, `await_pending`, sub-agent spawning |
| Platform API + scheduling | `periodic_task` | `depends_on` usage, CRUD via Platform API |
| Progressive activation | `activate_task` | `on_init` with `skill_controller`, cross-skill interaction |
| Hook skill | `evaluate_task` | `evaluate_response` hook, no tools |
