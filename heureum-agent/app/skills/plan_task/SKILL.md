---
name: plan_task
description: Hierarchical task planning and parallel execution via sub-agents
tools: manage_todo, sessions_spawn, sessions_spawn_status, ask_question
depends_on:
subagent_access: orchestrator
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

### Step 0: Query Analysis (BEFORE creating a plan)

Before creating tasks, analyze the user's request systematically:
1. **Identify information categories**: What types of information are needed? (e.g. facts, opinions, comparisons, statistics)
2. **Classify task types**:
   - `research`: Information gathering — web searches, data collection
   - `analysis`: Data processing — comparing, evaluating, reasoning
   - `synthesis`: Combining results — writing summaries, creating reports
   - `verification`: Fact-checking — cross-referencing, validating claims
3. **Determine parallelism**: Which tasks are independent? Which depend on others?
4. **Size tasks correctly**: Each task should be a single search/analysis unit. If a task requires multiple searches, split it.

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
- `todo_items` is optional — use it for checklists within a task.
- **Always include a final synthesis task** that depends on all research/analysis tasks.
- Keep tasks atomic — each should be completable by a single sub-agent with a single tool focus.
- Limit tasks to 5-7 for most queries. Avoid over-decomposition.
- After create, the plan is in `awaiting_pre_thinking` phase — sub-agents are NOT spawned yet.

### Step 2: Review and approve execution (pre-plan checkpoint).

Review your plan for completeness, then call the thinking checkpoint:

```
manage_todo(action="thinking_checkpoint", phase="pre_plan", note="Plan looks complete. Tasks cover all aspects of the request.")
```

This transitions the plan to `executing` phase and spawns sub-agents for all ready tasks.

### Step 3: Sub-agents execute tasks automatically.

As tasks complete, dependent tasks are spawned in cascade. You do NOT need to call `sessions_spawn` manually — the plan orchestrator handles it. Use `sessions_spawn` directly only for ad-hoc tasks outside of a plan.

### Step 4: Monitor and wait.

Use `sessions_spawn_status()` to check progress of running sub-agents:

```
sessions_spawn_status()                          # all sub-agents
sessions_spawn_status(child_session_id="...")     # specific sub-agent
```

### Step 5: Update tasks manually if needed.

```
manage_todo(action="update_task", task_id="research", status="completed", result="Found 3 key insights")
manage_todo(action="update_task", task_id="analyze", status="failed", result="Insufficient data")
```

### Step 6: Add tasks to an existing plan.

```
manage_todo(action="add_tasks", tasks=[
  {"id": "extra", "description": "Additional analysis", "depends_on": ["research"]}
])
```

### Step 7: Verify results (post-plan checkpoint).

Once all tasks are completed or failed, verify the results before summarizing:

```
manage_todo(action="thinking_checkpoint", phase="post_plan", note="All tasks completed successfully. Results are consistent and comprehensive.")
```

### Step 8: Provide a final summary.

After the post-plan checkpoint, synthesize results into a final answer for the user.

## Tool reference

`manage_todo(action, goal, tasks, task_id, status, result, phase, note)`

- `action`: `"create"`, `"update_task"`, `"add_tasks"`, or `"thinking_checkpoint"` (required)
- `goal`: overall goal description (required for `create`)
- `tasks`: array of task objects (required for `create` and `add_tasks`)
- `task_id`: ID of task to update (required for `update_task`)
- `status`: `"in_progress"`, `"completed"`, or `"failed"` (for `update_task`)
- `result`: brief result description (for `update_task`)
- `phase`: `"pre_plan"` or `"post_plan"` (required for `thinking_checkpoint`)
- `note`: reflection note for the checkpoint (for `thinking_checkpoint`)

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
- **Always call both checkpoints.** After creating a plan, call `thinking_checkpoint(pre_plan)` before execution begins. After all tasks complete, call `thinking_checkpoint(post_plan)` before the final summary.
- If a task fails, mark it as `"failed"` with a reason, then continue with remaining tasks or summarize.
- The plan must always end with every task in `"completed"` or `"failed"` — never leave tasks as `"in_progress"` or `"pending"`.
- Circular dependencies are rejected — ensure the dependency graph is a DAG.
- Maximum spawn depth is 2 (sub-agents cannot spawn their own sub-agents).
- Maximum concurrent sub-agents per session is 5.
