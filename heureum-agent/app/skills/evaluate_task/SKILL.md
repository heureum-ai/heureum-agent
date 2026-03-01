---
name: evaluate_task
description: Internal quality gatekeeper — auto-evaluates responses before delivery. No direct invocation needed.
allowed-tools:
catalog: false
---

# Evaluate Skill

This is an internal system skill that operates as a quality gatekeeper. It does not expose any direct tools to the agent.
It intercepts responses before they are returned to the user and evaluates whether the agent has made a sufficient attempt to solve the user's task, particularly focusing on preventing infinite loops and ensuring exhaustive tool trials before giving up.
