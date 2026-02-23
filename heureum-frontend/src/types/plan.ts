// Copyright (c) 2026 Heureum AI. All rights reserved.

export type PlanTaskStatus = 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed';

export interface PlanToolCall {
  callId: string;
  toolName: string;
  displayName: string;
  detail?: string;
  args?: Record<string, unknown>;
  output?: string;
  status: 'running' | 'completed' | 'failed';
  cost?: number;
}

export interface PlanSubagentStep {
  toolName: string;
  displayName: string;
  detail: string;
  status: 'running' | 'completed' | 'failed';
}

export interface PlanSubagentProgress {
  childSessionId: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  elapsedSeconds: number;
  currentIteration?: number;
  resultSummary?: string | null;
  steps: PlanSubagentStep[];
}

export interface PlanTask {
  id: string;
  description: string;
  status: PlanTaskStatus;
  result?: string | null;
  dependsOn: string[];
  childSessionId?: string | null;
  toolCalls: PlanToolCall[];
  subagent?: PlanSubagentProgress | null;
}

export interface PlanState {
  team: string;
  tasks: PlanTask[];
  activeTaskId: string | null;
  finalized: boolean;
}
