// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState } from 'react';
import {
  CircleCheck,
  LoaderCircle,
  Circle,
  CircleX,
  ChevronRight,
  ListTree,
} from 'lucide-react';
import type { PlanState } from '../types/plan';
import { getToolDisplay } from '../lib/tools';
import type { ToolCallInfo } from '../types';
import './TodoProgress.css';

interface TodoProgressProps {
  plan: PlanState;
  /** When true, the entire plan starts collapsed (used for history plans). */
  collapsed?: boolean;
}

/** Task status → Lucide icon */
function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CircleCheck size={14} className="tp-icon tp-icon-completed" />;
    case 'in_progress':
      return <LoaderCircle size={14} className="tp-icon tp-icon-running" />;
    case 'failed':
      return <CircleX size={14} className="tp-icon tp-icon-failed" />;
    default: // pending, blocked
      return <Circle size={14} className="tp-icon tp-icon-pending" />;
  }
}

/** Step status → Lucide icon (smaller) */
function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CircleCheck size={12} className="tp-icon tp-icon-completed" />;
    case 'running':
      return <LoaderCircle size={12} className="tp-icon tp-icon-running" />;
    case 'failed':
      return <CircleX size={12} className="tp-icon tp-icon-failed" />;
    default:
      return <Circle size={12} className="tp-icon tp-icon-pending" />;
  }
}

export default function TodoProgress({ plan, collapsed = false }: TodoProgressProps) {
  const [isCollapsed, setIsCollapsed] = useState(collapsed);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const toggleTask = (taskId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleStep = (stepKey: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepKey)) next.delete(stepKey);
      else next.add(stepKey);
      return next;
    });
  };

  const { tasks } = plan;

  return (
    <div className="tp-tree">
      {/* Plan node */}
      <div
        className={`tp-plan ${collapsed ? 'clickable' : ''}`}
        onClick={() => collapsed && setIsCollapsed((v) => !v)}
      >
        <ListTree size={15} className="tp-plan-icon" />
        <span className="tp-label">Plan</span>
        <span className="tp-plan-goal">({plan.team})</span>
        {plan.phase && plan.phase !== 'finalized' && (
          <span className={`tp-phase tp-phase-${plan.phase}`}>
            {plan.phase === 'awaiting_pre_thinking' ? 'reviewing'
              : plan.phase === 'executing' ? 'executing'
              : plan.phase === 'ready_for_final' ? 'verifying'
              : plan.phase}
          </span>
        )}
        {collapsed && (
          <ChevronRight size={13} className={`tp-chevron-icon ${!isCollapsed ? 'expanded' : ''}`} />
        )}
      </div>

      {/* Task branches */}
      {!isCollapsed && <div className="tp-branches">
        {tasks.map((task, idx) => {
          const isLast = idx === tasks.length - 1;

          // Steps from subagent (priority) or local tool calls
          const subagentSteps = task.subagent?.steps ?? [];
          const toolSteps = task.toolCalls.map((tc) => {
            // Build a minimal ToolCallInfo for getToolDisplay
            const info: ToolCallInfo = {
              callId: tc.callId,
              command: tc.toolName,
              toolName: tc.toolName,
              toolArgs: tc.args,
              displayName: tc.displayName,
              status: tc.status,
            };
            const { action, detail } = getToolDisplay(info);
            return {
              displayName: action,
              detail: detail || '',
              status: tc.status as 'running' | 'completed' | 'failed',
              toolName: tc.toolName,
            };
          });
          const steps = subagentSteps.length > 0 ? subagentSteps : toolSteps;

          const hasContent = steps.length > 0 || (task.status === 'completed' && !!task.result);
          const isExpanded = expandedTasks.has(task.id);

          return (
            <div key={task.id} className="tp-branch">
              <div className="tp-connector">
                <span className="tp-gutter">{isLast ? '└─' : '├─'}</span>
              </div>

              <div className="tp-task-node">
                <div
                  className={`tp-task-header ${hasContent ? 'clickable' : ''}`}
                  onClick={() => hasContent && toggleTask(task.id)}
                >
                  <TaskStatusIcon status={task.status} />
                  <span className="tp-task-desc">{task.description}</span>
                  {hasContent && (
                    <ChevronRight size={13} className={`tp-chevron-icon ${isExpanded ? 'expanded' : ''}`} />
                  )}
                </div>

                {/* blocked deps */}
                {task.dependsOn.length > 0 && task.status === 'blocked' && (
                  <div className="tp-task-deps">
                    <span className="tp-gutter-pad">{isLast ? '\u00A0\u00A0' : '│'}</span>
                    <span className="tp-deps-text">
                      waiting: {task.dependsOn.join(', ')}
                    </span>
                  </div>
                )}

                {/* expanded: steps + result */}
                {isExpanded && (
                  <div className="tp-todo-list">
                    {steps.map((step, i) => {
                      const stepKey = `${task.id}-${i}`;
                      const stepExpanded = expandedSteps.has(stepKey);
                      return (
                        <div
                          key={i}
                          className={`tp-todo ${step.detail ? 'tp-todo-clickable' : ''}`}
                          onClick={() => step.detail && toggleStep(stepKey)}
                        >
                          <span className="tp-gutter-pad">{isLast ? '\u00A0\u00A0' : '│'}</span>
                          <StepStatusIcon status={step.status} />
                          <span className="tp-todo-name">{step.displayName}</span>
                          {step.detail && (
                            <span className={`tp-todo-detail ${stepExpanded ? 'tp-todo-detail-expanded' : ''}`}>
                              ({step.detail})
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {task.status === 'completed' && task.result && (
                      <div className="tp-todo-result">
                        <span className="tp-gutter-pad">{isLast ? '\u00A0\u00A0' : '│'}</span>
                        <span className="tp-result-text">{task.result}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* collapsed: step count hint */}
                {!isExpanded && steps.length > 0 && (
                  <div
                    className="tp-todo-hint"
                    onClick={() => toggleTask(task.id)}
                  >
                    <span className="tp-gutter-pad">{isLast ? '\u00A0\u00A0' : '│'}</span>
                    <span className="tp-hint-text">
                      +{steps.length} tool use{steps.length > 1 ? 's' : ''}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}
