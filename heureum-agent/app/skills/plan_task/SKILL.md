---
name: plan_task
description: Hierarchical task planning and parallel execution via sub-agents
server_tools: manage_todo, sessions_spawn, sessions_spawn_status
client_tools: ask_question
depends_on:
---

You have `manage_todo`, `sessions_spawn`, `sessions_spawn_status`, and `ask_question` tools for hierarchical task planning with parallel sub-agent execution.

## When to use

- The user's request requires 2 or more distinct tasks that can be structured with dependencies.
- Tasks have clear dependency relationships (e.g. "research" must finish before "summarize").
- Tasks can benefit from parallel execution via sub-agents.

## When NOT to use

- Simple questions that need only a text response.
- Single-step tasks (one tool call and done).
- Sequential tasks with no parallelism benefit — use a flat approach instead.

## When to use ask_question

- Only when the user's request is ambiguous and you cannot proceed without clarification.
- When there are multiple valid approaches and the user should choose.
- Analyze the request first — if you can reasonably infer the user's intent, proceed without asking.
- When you do ask, provide 2–5 clear, distinct choices and set `allow_user_input` to `true` when a custom answer is possible.
- Use this tool instead of asking questions in plain text.

## Workflow — follow strictly

### Step 1: Create a plan with tasks and dependencies.

```
manage_todo(action="create", goal="Overall goal description", tasks=[
  {"id": "research", "description": "Research topic X", "todo_items": ["Find sources", "Extract key points"]},
  {"id": "analyze", "description": "Analyze findings", "depends_on": ["research"]},
  {"id": "report", "description": "Write final report", "depends_on": ["analyze"]}
])
```

- Every task must have a unique `id` and `description`.
- Use `depends_on` to declare dependencies — tasks wait until predecessors complete.
- Tasks without dependencies start immediately via sub-agents.
- `todo_items` is optional — use it for checklists within a task.

### Step 2: Sub-agents execute tasks automatically.

When you create a plan, the system automatically spawns sub-agents for all ready tasks (those with no unmet dependencies). As tasks complete, dependent tasks are spawned in cascade.

You do NOT need to call `sessions_spawn` manually — the plan orchestrator handles it. Use `sessions_spawn` directly only for ad-hoc tasks outside of a plan.

### Step 3: Monitor and wait.

Use `sessions_spawn_status()` to check progress of running sub-agents:

```
sessions_spawn_status()                          # all sub-agents
sessions_spawn_status(child_session_id="...")     # specific sub-agent
```

### Step 4: Update tasks manually if needed.

```
manage_todo(action="update_task", task_id="research", status="completed", result="Found 3 key insights")
manage_todo(action="update_task", task_id="analyze", status="failed", result="Insufficient data")
```

### Step 5: Add tasks to an existing plan.

```
manage_todo(action="add_tasks", tasks=[
  {"id": "extra", "description": "Additional analysis", "depends_on": ["research"]}
])
```

### Step 6: Provide a final summary.

Once all tasks are completed or failed, synthesize results into a final answer for the user.

## Tool reference

`manage_todo(action, goal, tasks, task_id, status, result)`

- `action`: `"create"`, `"update_task"`, or `"add_tasks"` (required)
- `goal`: overall goal description (required for `create`)
- `tasks`: array of task objects (required for `create` and `add_tasks`)
- `task_id`: ID of task to update (required for `update_task`)
- `status`: `"in_progress"`, `"completed"`, or `"failed"` (for `update_task`)
- `result`: brief result description (for `update_task`)

`sessions_spawn(task, tools, cleanup)`
Spawn an ad-hoc sub-agent outside of a plan.

- `task`: clear, self-contained task description (required)
- `tools`: optional list of tool names to restrict the sub-agent's tools
- `cleanup`: `"keep"` or `"delete"` (default: `"delete"`) — whether to keep the sub-agent session after completion

`sessions_spawn_status(child_session_id)`
Check sub-agent status.

- `child_session_id`: optional — omit to list all sub-agents for this session

## CRITICAL RULES

- **Never abandon a plan.** You MUST NOT respond to the user while tasks are still running. Wait for all sub-agents to complete.
- If a task fails, mark it as `"failed"` with a reason, then continue with remaining tasks or summarize.
- The plan must always end with every task in `"completed"` or `"failed"` — never leave tasks as `"in_progress"` or `"pending"`.
- Circular dependencies are rejected — ensure the dependency graph is a DAG.
- Maximum spawn depth is 2 (sub-agents cannot spawn their own sub-agents).
- Maximum concurrent sub-agents per session is 5.
