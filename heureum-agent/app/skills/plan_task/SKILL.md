---
name: plan_task
description: Task planning and execution tracking
server_tools: manage_todo
client_tools:
---
You have a `manage_todo` tool for structured task planning and execution tracking.

When to use:
- When the user's request requires 2 or more distinct steps or tool calls.
- When a task involves gathering data, processing it, and producing output.

When NOT to use:
- Simple questions that need only a text response.
- Single-step tasks (one tool call and done).

Workflow — follow this strictly for every multi-step task:

Step 1: Create the plan.
```
manage_todo(action="create", task="...", steps=["step1", "step2", ...])
```

Step 2: For EACH step, you must call `update_step` TWICE — once before and once after:
```
a. manage_todo(action="update_step", step_index=N, status="in_progress")
b. Execute the step (call the relevant tool).
c. manage_todo(action="update_step", step_index=N, status="completed", result="brief result")
   Or if the step failed: status="failed", result="error description"
```

Step 3: After all steps are completed, provide a summary to the user.

You may call `manage_todo(action="add_steps")` if you discover additional steps during execution.

CRITICAL RULE — Never abandon a plan:
- You MUST NOT respond with text while any step has status `"in_progress"`.
- If a step encounters an error or produces no useful result, mark it as `"failed"` with a reason, then move to the next step or summarize.
- If all remaining steps become impossible, mark them as `"failed"` one by one, then provide a summary with what you accomplished.
- The plan must always end with every step in `"completed"` or `"failed"` status — never leave a step as `"in_progress"` or `"pending"`.

Example — "fetch Yahoo Finance headlines and save them":

Turn 1:
```
manage_todo(action="create", task="Fetch Yahoo Finance headlines and save", steps=["Fetch yahoo finance page", "Extract headlines from content", "Save headlines to file"])
manage_todo(action="update_step", step_index=0, status="in_progress")
fetch(url="https://finance.yahoo.com")
```

Turn 2:
```
manage_todo(action="update_step", step_index=0, status="completed", result="Fetched page successfully")
manage_todo(action="update_step", step_index=1, status="in_progress")
```

Turn 3:
```
manage_todo(action="update_step", step_index=1, status="completed", result="Extracted 5 headlines")
manage_todo(action="update_step", step_index=2, status="in_progress")
write(path="today_headlines.md", content="...")
```

Turn 4:
```
manage_todo(action="update_step", step_index=2, status="completed", result="Saved to today_headlines.md")
```
(final summary text response)
