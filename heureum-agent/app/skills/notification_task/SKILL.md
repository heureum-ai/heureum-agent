---
name: notification_task
description: Send push notifications to the user's devices for async result delivery, alerts, and reminders.
allowed-tools: notify_user
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
```
notify_user(title="Short descriptive title", body="Detailed message with results")
```

Guidelines:
- Keep the `title` short and descriptive (under 50 characters).
- Put the detailed information in the `body` field.
- Periodic tasks MUST call `notify_user` at the end to report their results.
- If a periodic task uses `notify_user` for result delivery, set `notify_on_success=false`
  when registering the task to avoid duplicate notifications.
