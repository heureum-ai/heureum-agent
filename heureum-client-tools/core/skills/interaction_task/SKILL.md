---
name: interaction_task
description: Gather missing user decisions before continuing multi-step work.
tools: ask_question, select_cwd
---
Use this skill when the task cannot proceed without explicit user input.

Workflow:
1. If intent/choice is ambiguous, call `ask_question` with clear options.
2. If local file/system tools are needed but no working directory is set, call `select_cwd`.
3. Resume execution only after required user input is obtained.

Rules:
- Ask only one focused question at a time.
- Prefer predefined choices over open text when possible.
- Do not fabricate user decisions.

