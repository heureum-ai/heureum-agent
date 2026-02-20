// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState } from 'react';
import type { TodoState, TodoStep, SubagentProgress } from '../types';
import './TodoProgress.css';

interface TodoProgressProps {
  todo: TodoState;
  subagentProgressMap?: Map<string, SubagentProgress>;
}

/** Maximum tool calls to show per agent inline. */
const MAX_INLINE_TOOLS = 5;

/** Map step status to ToolBlock status class. */
function toolStatus(step: TodoStep): string {
  if (step.status === 'in_progress') return 'running';
  return step.status; // completed | failed | pending
}

/** Build display label from step. */
function stepLabel(step: TodoStep): { action: string; detail: string } {
  const agent = step.assigned_agent || 'Agent';
  const taskText = step.description.replace(/^\[[^\]]+\]\s*/, '');
  return { action: agent, detail: taskText };
}

/** Render inline tool call progress for a running agent. */
function AgentToolCalls({ progress }: { progress: SubagentProgress }) {
  const recent = progress.steps.slice(-MAX_INLINE_TOOLS);
  if (recent.length === 0 && progress.status === 'running') {
    return (
      <div className="ac-wf-tool">
        <span className="ac-wf-tool-prefix">{'\u2514'} </span>
        <span className="ac-wf-tool-text">Initializing...</span>
      </div>
    );
  }
  return (
    <>
      {recent.map((s, i) => (
        <div key={i} className={`ac-wf-tool ac-wf-tool-${s.status}`}>
          <span className="ac-wf-tool-prefix">{'\u2514'} </span>
          <span className="ac-wf-tool-text">{s.toolName}: {s.detail || '...'}</span>
        </div>
      ))}
    </>
  );
}

/** A single step rendered in ToolBlock style. */
function StepBlock({
  step,
  progress,
}: {
  step: TodoStep;
  progress?: SubagentProgress;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = toolStatus(step);
  const { action, detail } = stepLabel(step);
  const hasResult = !!(step.result && (step.status === 'completed' || step.status === 'failed'));

  return (
    <div className={`ac-tool ac-tool-${status}`}>
      <div className="ac-tool-dot" />
      <div className="ac-tool-content">
        <div className="ac-tool-header" onClick={() => hasResult && setExpanded(!expanded)}>
          <span className="ac-tool-action">{action}</span>
          <span className="ac-tool-detail">{detail}</span>
          {hasResult && (
            <span className={`ac-tool-chevron ${expanded ? 'expanded' : ''}`}>&#x25B6;</span>
          )}
        </div>
        {expanded && step.result && (
          <pre className="ac-tool-output">{step.result}</pre>
        )}
        {progress && step.status === 'in_progress' && (
          <div className="ac-wf-tool-list">
            <AgentToolCalls progress={progress} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function TodoProgress({ todo, subagentProgressMap }: TodoProgressProps) {
  const progressMap = subagentProgressMap || new Map<string, SubagentProgress>();

  return (
    <div className="ac-todo-block">
      <div className="ac-todo-task">{todo.task}</div>
      {todo.steps.map((step, i) => (
        <StepBlock
          key={step.step_name || i}
          step={step}
          progress={step.step_name ? progressMap.get(step.step_name) : undefined}
        />
      ))}
    </div>
  );
}
