---
name: activate_task
description: Skill activation for progressive tool loading
tools: activate_skill
subagent_access: never
---

Activate skills to make their tools available. Review the <available_skills> section
in your prompt to see which skills can be activated.

## When to use

- Before using any client-side skill tools (coding, web, documents, etc.)
- You can activate multiple skills at once by passing multiple names

## When NOT to use

- For simple text responses that don't require any tools
- Server tools (manage_todo, activate_skill) are always available — no activation needed
