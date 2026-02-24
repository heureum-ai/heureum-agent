// Copyright (c) 2026 Heureum AI. All rights reserved.

import { usePlanStore } from '../store/planStore';
import type { StreamEvent, Message } from '../types';

/**
 * Route an SSE event into the plan store.
 * Stateless — safe to call for every event; no-ops when irrelevant.
 */
export function processPlanEvent(event: StreamEvent): void {
  const store = usePlanStore.getState();

  switch (event.type) {
    case 'response.todo.updated':
      store.applyTodoUpdate(event.todo);
      break;

    case 'response.function_call.done': {
      const tc = event.item;
      if (['manage_todo', 'ask_question', 'sessions_spawn'].includes(tc.name)) break;
      if (!store.plan) break;

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments);
      } catch {
        /* ignore */
      }

      store.recordToolCall(
        tc.call_id,
        tc.name,
        tc.display_name,
        args,
        event.usage?.total_cost,
      );
      break;
    }

    case 'response.tool_result.done': {
      if (!store.plan) break;
      const status =
        event.status === 'completed'
          ? ('completed' as const)
          : ('failed' as const);
      store.completeToolCall(
        event.call_id,
        status,
        event.output ? String(event.output) : undefined,
      );
      break;
    }
  }
}

/** Finalize plan on stream completion — mark non-failed tasks as completed. */
export function finalizePlan(): void {
  const store = usePlanStore.getState();
  if (store.plan) {
    store.finalize();
  }
}

/** Restore plans from loaded session messages. Handles multiple plans (history). */
export function restorePlanFromMessages(msgs: Message[]): void {
  const todoMsgs = msgs.filter((m) => m.todo);
  if (todoMsgs.length === 0) return;
  const store = usePlanStore.getState();
  store.reset();
  for (let i = 0; i < todoMsgs.length; i++) {
    store.applyTodoUpdate(todoMsgs[i].todo!);
    if (i < todoMsgs.length - 1) {
      store.finalize();
    }
  }
}
