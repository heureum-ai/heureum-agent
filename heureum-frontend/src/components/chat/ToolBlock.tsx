// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState } from 'react';
import type { ToolCallInfo } from '../../types';
import { getToolDisplay } from '../../lib/tools';

/* ── Periodic task result parser ── */

interface ParsedTaskData {
  type: 'single';
  task: { id: string; title: string; description?: string; schedule_display: string; timezone_name: string; next_run_at?: string; status: string };
}

interface ParsedTaskListData {
  type: 'list';
  tasks: { id: string; title: string; status: string; schedule_display: string; next_run_at?: string }[];
}

type ParsedPeriodicResult = ParsedTaskData | ParsedTaskListData | null;

function parsePeriodicTaskOutput(output: string): ParsedPeriodicResult {
  try {
    const data = JSON.parse(output);
    if (!data.success) return null;
    if (data.task) return { type: 'single', task: data.task };
    if (data.tasks) return { type: 'list', tasks: data.tasks };
    return null;
  } catch {
    return null;
  }
}

function PeriodicTaskResult({ output }: { output: string }) {
  const parsed = parsePeriodicTaskOutput(output);
  if (!parsed) return <pre className="ac-tool-output">{output}</pre>;

  if (parsed.type === 'single') {
    const t = parsed.task;
    return (
      <div className="ac-tool-task-card">
        <div className="ac-tool-task-row"><span className="ac-tool-task-label">ID</span><span>{t.id}</span></div>
        <div className="ac-tool-task-row"><span className="ac-tool-task-label">Title</span><span>{t.title}</span></div>
        {t.description && <div className="ac-tool-task-row"><span className="ac-tool-task-label">Description</span><span>{t.description}</span></div>}
        <div className="ac-tool-task-row"><span className="ac-tool-task-label">Schedule</span><span>{t.schedule_display}</span></div>
        <div className="ac-tool-task-row"><span className="ac-tool-task-label">Timezone</span><span>{t.timezone_name}</span></div>
        {t.next_run_at && <div className="ac-tool-task-row"><span className="ac-tool-task-label">Next Run</span><span>{new Date(t.next_run_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}</span></div>}
        <div className="ac-tool-task-row"><span className="ac-tool-task-label">Status</span><span>{t.status}</span></div>
      </div>
    );
  }

  if (parsed.tasks.length === 0) {
    return <div className="ac-tool-task-card"><span style={{ color: 'var(--h-text-muted)' }}>No tasks registered</span></div>;
  }

  return (
    <div className="ac-tool-task-card">
      {parsed.tasks.map((t) => (
        <div key={t.id} className="ac-tool-task-list-item">
          <span className="ac-tool-task-list-title">{t.title}</span>
          <span className={`ac-tool-task-list-status ac-tool-task-list-status-${t.status}`}>{t.status}</span>
          <span className="ac-tool-task-list-schedule">{t.schedule_display}</span>
          {t.next_run_at && <span className="ac-tool-task-list-next">{new Date(t.next_run_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      ))}
    </div>
  );
}

/* ── write_todos result renderer ── */

function WriteTodosResult({ output, args }: { output: string; args?: Record<string, unknown> }) {
  // Try to show the todos list from args first, then fall back to raw output.
  const todos = args?.todos ?? args?.steps ?? args?.tasks;
  if (Array.isArray(todos) && todos.length > 0) {
    return (
      <div className="ac-tool-task-card">
        {todos.map((t: unknown, i: number) => {
          const obj = t as Record<string, unknown>;
          const label = typeof t === 'string' ? t : obj?.task ?? obj?.content ?? obj?.title ?? JSON.stringify(t);
          return (
            <div key={i} className="ac-tool-task-list-item">
              <span className="ac-tool-task-list-title">{String(label)}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return <pre className="ac-tool-output">{output}</pre>;
}

/* ── ToolBlock component ── */

export default function ToolBlock({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = !!toolCall.output;
  const isPeriodicTask = toolCall.toolName === 'manage_periodic_task';
  const isWriteTodos = toolCall.toolName === 'write_todos';
  const { action, detail } = getToolDisplay(toolCall);

  // write_todos renders its todo list from toolArgs even without a server output string
  const writeTodosArgs = isWriteTodos
    ? (toolCall.toolArgs?.todos ?? toolCall.toolArgs?.steps ?? toolCall.toolArgs?.tasks)
    : null;
  const writeTodosHasContent = Array.isArray(writeTodosArgs) && writeTodosArgs.length > 0;

  // "has something to show" — output text OR write_todos args
  const hasContent = hasOutput || writeTodosHasContent;

  const showExpanded = isPeriodicTask && toolCall.status === 'completed' && hasOutput;

  return (
    <div className={`ac-tool ac-tool-${toolCall.status}`}>
      <div className="ac-tool-dot" />
      <div className="ac-tool-content">
        <div className="ac-tool-header" onClick={() => hasContent && setExpanded(!expanded)}>
          <span className="ac-tool-action">{action}</span>
          {detail && <span className="ac-tool-detail">{detail}</span>}
          {hasContent && !showExpanded && <span className={`ac-tool-chevron ${expanded ? 'expanded' : ''}`}>&#x25B6;</span>}
        </div>
        {(showExpanded || expanded) && (hasOutput || writeTodosHasContent) && (
          isPeriodicTask
            ? <PeriodicTaskResult output={toolCall.output!} />
            : isWriteTodos
            ? <WriteTodosResult output={toolCall.output ?? ''} args={toolCall.toolArgs} />
            : <pre className="ac-tool-output">{toolCall.output}</pre>
        )}
      </div>
    </div>
  );
}
