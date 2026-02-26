// Copyright (c) 2026 Heureum AI. All rights reserved.

import { create } from 'zustand';
import type { TodoState } from '../types';
import type { PlanState, PlanToolCall, PlanSubagentProgress } from '../types/plan';

interface PlanStoreState {
  /** Completed plans from earlier in the conversation. */
  history: PlanState[];
  /** Currently active (or most recently finalized) plan. */
  plan: PlanState | null;
  /** Tool calls received before plan/activeTask exists — flushed on next applyTodoUpdate. */
  _pendingToolCalls: PlanToolCall[];

  applyTodoUpdate: (todo: TodoState) => void;
  recordToolCall: (
    callId: string,
    toolName: string,
    displayName: string,
    args?: Record<string, unknown>,
    cost?: number,
  ) => void;
  completeToolCall: (callId: string, status: 'completed' | 'failed', output?: string) => void;
  mergeSubagentProgress: (progress: PlanSubagentProgress) => void;
  finalize: () => void;
  reset: () => void;
}

export const usePlanStore = create<PlanStoreState>((set) => ({
  history: [],
  plan: null,
  _pendingToolCalls: [],

  applyTodoUpdate: (todo) => {
    set((state) => {
      // Detect new plan: current plan is finalized and incoming tasks are all new IDs
      const isNewPlan =
        state.plan?.finalized &&
        !todo.tasks.some((t) => state.plan!.tasks.some((e) => e.id === t.id));

      const base = isNewPlan ? null : state.plan;
      const historyAddition =
        isNewPlan && state.plan ? [state.plan] : [];

      const existingMap = new Map(
        base?.tasks.map((t) => [t.id, t]) ?? [],
      );
      const newTasks = todo.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        status: t.status,
        result: t.result,
        dependsOn: t.depends_on,
        childSessionId: t.child_session_id,
        toolCalls: existingMap.get(t.id)?.toolCalls ?? [],
        subagent: existingMap.get(t.id)?.subagent ?? null,
      }));

      const activeTaskId =
        todo.tasks.find((t) => t.status === 'in_progress')?.id ?? null;

      // Flush buffered tool calls into the active task
      if (activeTaskId && state._pendingToolCalls.length > 0) {
        const target = newTasks.find((t) => t.id === activeTaskId);
        if (target) {
          const existingIds = new Set(target.toolCalls.map((tc) => tc.callId));
          const toFlush = state._pendingToolCalls.filter(
            (tc) => !existingIds.has(tc.callId),
          );
          if (toFlush.length > 0) {
            target.toolCalls = [...target.toolCalls, ...toFlush];
          }
        }
      }

      return {
        history: [...state.history, ...historyAddition],
        plan: {
          team: todo.team,
          phase: todo.phase,
          tasks: newTasks,
          activeTaskId,
          finalized: todo.phase === 'finalized',
        },
        _pendingToolCalls: [],
      };
    });
  },

  recordToolCall: (callId, toolName, displayName, args, cost) => {
    set((state) => {
      const newToolCall: PlanToolCall = {
        callId,
        toolName,
        displayName,
        args,
        status: 'running',
        cost,
      };

      // Buffer if plan or activeTask doesn't exist yet
      if (!state.plan || !state.plan.activeTaskId) {
        if (state._pendingToolCalls.some((tc) => tc.callId === callId)) return state;
        return { _pendingToolCalls: [...state._pendingToolCalls, newToolCall] };
      }

      const taskId = state.plan.activeTaskId;
      const tasks = state.plan.tasks.map((t) => {
        if (t.id !== taskId) return t;
        if (t.toolCalls.some((tc) => tc.callId === callId)) return t;
        return { ...t, toolCalls: [...t.toolCalls, newToolCall] };
      });

      return { plan: { ...state.plan, tasks } };
    });
  },

  completeToolCall: (callId, status, output) => {
    set((state) => {
      // Also update buffered tool calls that haven't been flushed yet
      const pendingIdx = state._pendingToolCalls.findIndex((tc) => tc.callId === callId);
      let pendingUpdate: Partial<PlanStoreState> = {};
      if (pendingIdx >= 0) {
        const updated = [...state._pendingToolCalls];
        updated[pendingIdx] = {
          ...updated[pendingIdx],
          status,
          ...(output != null ? { output } : {}),
        };
        pendingUpdate = { _pendingToolCalls: updated };
      }

      if (!state.plan) return pendingUpdate as any;

      const tasks = state.plan.tasks.map((t) => {
        const idx = t.toolCalls.findIndex((tc) => tc.callId === callId);
        if (idx < 0) return t;
        const updated = [...t.toolCalls];
        updated[idx] = {
          ...updated[idx],
          status,
          ...(output != null ? { output } : {}),
        };
        return { ...t, toolCalls: updated };
      });

      return { plan: { ...state.plan, tasks }, ...pendingUpdate };
    });
  },

  mergeSubagentProgress: (progress) => {
    set((state) => {
      if (!state.plan) return state;

      const tasks = state.plan.tasks.map((t) => {
        if (t.childSessionId !== progress.childSessionId) return t;
        return { ...t, subagent: progress };
      });

      return { plan: { ...state.plan, tasks } };
    });
  },

  finalize: () => {
    set((state) => {
      if (!state.plan) return { plan: null };
      const tasks = state.plan.tasks.map((t) => {
        const hasRunning = t.toolCalls.some((tc) => tc.status === 'running');
        if (!hasRunning) return t;
        return {
          ...t,
          toolCalls: t.toolCalls.map((tc) =>
            tc.status === 'running' ? { ...tc, status: 'completed' as const } : tc
          ),
        };
      });
      return { plan: { ...state.plan, tasks, finalized: true } };
    });
  },

  reset: () => {
    set({ history: [], plan: null, _pendingToolCalls: [] });
  },
}));
