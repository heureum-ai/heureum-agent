---
name: periodic_task
description: Create and manage scheduled recurring tasks. Use when user mentions time-based recurrence (every day, every morning, 매일, 매주, etc.).
tools: manage_periodic_task
depends_on: web_search_task, notification_task
subagent_access: never
---
You have a `manage_periodic_task` tool for creating and managing scheduled recurring tasks.
You also have a `notify_user` tool to send push notifications to the user's devices.

When to recognize a periodic task request:
- User mentions time-based recurrence: "every day", "매일", "every morning", "매주 월요일",
  "every hour", "at 9 AM", "오전 9시마다", etc.
- User wants automated, unattended execution of a task on a schedule.

Workflow for creating a periodic task — follow STRICTLY in order:

Step 1: Acknowledge and plan.
  Tell the user you will: (1) do a dry run, (2) build a recipe, (3) register.
  Create a TODO plan with `manage_todo` tracking these steps.

Step 2: Execute a MANDATORY dry run.
  You MUST actually perform the task once RIGHT NOW using real tools.
  - For information tasks (news, weather, etc.): follow the web_search_task tool guide
    (search → fetch → read workflow).
  - For notification tasks (reminders, greetings): compose the actual notification text
    and send it using `notify_user`.
  - For file tasks: create the actual file using `mcp_filesystem__bash` (e.g. `cat > path << 'EOF'`).
  Track every tool you use and every result you get. The dry run MUST produce
  real output — not just acknowledge the request.

Step 3: Synthesize a DETAILED execution recipe from the dry run.
  The recipe is what a headless agent will follow later WITHOUT any user interaction.
  Every instruction must be specific and actionable. Structure as JSON:

  ```json
  {
    "version": 1,
    "original_request": "the user's exact message",
    "objective": "one-line summary of the task",
    "instructions": [
      "Step 1: Use mcp_web__search to search for '...'",
      "Step 2: Use mcp_web__fetch on the top result URLs",
      "Step 3: Use mcp_filesystem__bash to read the fetched session_file content (e.g. cat <path>)",
      "Step 4: Extract the key information from the content",
      "Step 5: Use notify_user with title '...' and body containing the extracted info"
    ],
    "tools_required": ["mcp_web__search", "mcp_web__fetch", "mcp_filesystem__bash", "notify_user"],
    "output_spec": {
      "file_pattern": "path/to/output_{date}.md (or empty if notification-only)",
      "summary_template": "Description of what the notification/output looks like",
      "notification": {
        "title_template": "Template for notification title",
        "body_template": "Template for notification body with {placeholders}"
      }
    },
    "dry_run_result": {
      "success": true,
      "sample_output_path": "path if a file was created",
      "sample_summary": "Actual text of the notification/output from the dry run"
    },
    "constraints": {
      "max_iterations": 30
    }
  }
  ```

  IMPORTANT recipe quality rules:
  - Each instruction MUST name the specific tool to use (`notify_user`, `mcp_web__search`, etc.)
  - Instructions must be detailed enough for an agent with NO context to follow
  - BAD: "사용자에게 안부를 묻는다" (vague, no tool specified)
  - GOOD: `"Use notify_user with title '안부 인사' and body '안녕하세요! 오늘 하루는 어떠셨나요? 좋은 하루 보내세요 😊'"`
  - The last instruction MUST always be: "Use `notify_user` to send the results to the user"
  - `dry_run_result.sample_summary` MUST contain the actual output from Step 2

Step 4: Parse the user's schedule into cron format.
  Convert natural language to:
  ```json
  {"type": "cron", "cron": {"minute": M, "hour": H, "day_of_month": "*", "month": "*", "day_of_week": "*"}}
  ```

  Common patterns:
  - "every day at 9 AM" → `minute=0, hour=9, dow="*"`
  - "every weekday at 9 AM" → `minute=0, hour=9, dow="1-5"`
  - "every Monday at 10 AM" → `minute=0, hour=10, dow="1"`
  - "every hour" → `minute=0, hour="*", dow="*"`

Step 5: Register via tool call.
  ```
  manage_periodic_task(action="register", title="...", description="...",
    recipe={...}, schedule={...}, timezone="Asia/Seoul")
  ```

Step 6: Confirm registration to the user.
  The registration result (task ID, schedule, next run time, etc.) is automatically
  displayed to the user in the UI. You only need to write a brief confirmation
  message — do NOT repeat the task details. Keep your response short to save tokens.

If the dry run fails, do NOT register. Inform the user and ask if they want to retry.

## Managing existing periodic tasks

Besides `register`, the `manage_periodic_task` tool supports these actions:

List all tasks:
```
manage_periodic_task(action="list")
```

Cancel a task:
```
manage_periodic_task(action="cancel", task_id="<task_id>")
```

Pause a task (stops execution but keeps the task):
```
manage_periodic_task(action="pause", task_id="<task_id>")
```

Resume a paused task:
```
manage_periodic_task(action="resume", task_id="<task_id>")
```

## Tool reference

`manage_periodic_task(action, title?, description?, recipe?, schedule?, timezone?, task_id?, notify_on_success?)`
  - `action`: `"register"`, `"list"`, `"cancel"`, `"pause"`, or `"resume"` (required)
  - `title`: short title for the task (required for `register`)
  - `description`: longer description (optional, for `register`)
  - `recipe`: execution recipe JSON (required for `register`)
  - `schedule`: cron schedule object (required for `register`)
  - `timezone`: IANA timezone string (default: `"Asia/Seoul"`, for `register`)
  - `task_id`: task ID (required for `cancel`, `pause`, `resume`)
  - `notify_on_success`: send system notification on success (default: `true`). Set to `false` if the recipe already calls `notify_user` to avoid duplicate notifications.
