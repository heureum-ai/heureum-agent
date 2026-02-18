---
name: sessions_spawn
description: Spawn sub-agent tasks for parallel execution
server_tools: sessions_spawn
client_tools:
depends_on:
---
## Sub-Agent Spawning

Use `sessions_spawn` to delegate self-contained tasks to a sub-agent
that runs in parallel. Progress is tracked automatically by the frontend
via polling — you do NOT need to check status manually.

### Tools

- **sessions_spawn** — Spawn a new sub-agent with a task description

### When to use
- Tasks that are independent and don't need back-and-forth interaction
- Research or information gathering that can run in background
- File operations that don't depend on the current conversation context

### When NOT to use
- Tasks that require user interaction or approval
- Tasks that depend on the current conversation's context heavily
- Simple operations that are faster to do directly

### CRITICAL: Spawn ALL sub-agents in a SINGLE tool call batch
When delegating multiple tasks, you MUST call `sessions_spawn` multiple times
in the **same** response (parallel tool calls). Do NOT spawn one, wait for it,
then spawn the next — this defeats the purpose of parallel execution.

**Correct** (all in one response):
```
[sessions_spawn(task="Research topic A"), sessions_spawn(task="Research topic B"), sessions_spawn(task="Research topic C")]
```

**Wrong** (sequential, one per response):
```
sessions_spawn(task="Research topic A")
→ wait for result
sessions_spawn(task="Research topic B")
→ wait for result
```

### How it works
1. Spawn ALL sub-agents in a single response → each gets a `child_session_id`
2. Sub-agents run independently and in parallel
3. The system automatically waits for all sub-agents to complete
4. Their results are appended to the conversation as system messages
5. You then provide a comprehensive synthesis of all results

### After spawning
- Do NOT call `sessions_spawn_status` to check progress — the system handles waiting automatically
- Do NOT generate a text response immediately after spawning — wait for the system to signal completion
- Once all sub-agents complete, their results will appear in the conversation history
- Then provide a comprehensive synthesis combining all sub-agent results

### Constraints
- Maximum spawn depth: 1 (sub-agents cannot spawn their own sub-agents)
- Maximum concurrent children per session: 5
- Sub-agent timeout: 5 minutes
- Sub-agents report results back to the parent session when done
