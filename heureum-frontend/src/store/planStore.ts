// Copyright (c) 2026 Heureum AI. All rights reserved.

import { create } from 'zustand';
import type { TodoState } from '../types';
import type { PlanState, PlanToolCall, PlanSubagentProgress } from '../types/plan';

interface PlanStoreState {
  /** Completed plans from earlier in the conversation. */
  history: PlanState[];
  /** Currently active (or most recently finalized) plan. */
  plan: PlanState | null;

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

      return {
        history: [...state.history, ...historyAddition],
        plan: {
          team: todo.team,
          phase: todo.phase,
          tasks: newTasks,
          activeTaskId:
            todo.tasks.find((t) => t.status === 'in_progress')?.id ?? null,
          finalized: todo.phase === 'finalized',
        },
      };
    });
  },

  recordToolCall: (callId, toolName, displayName, args, cost) => {
    set((state) => {
      if (!state.plan) return state;
      const taskId = state.plan.activeTaskId;
      if (!taskId) return state;

      const newToolCall: PlanToolCall = {
        callId,
        toolName,
        displayName,
        args,
        status: 'running',
        cost,
      };

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
      if (!state.plan) return state;

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

      return { plan: { ...state.plan, tasks } };
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
    set({ history: [], plan: null });
  },
}));
