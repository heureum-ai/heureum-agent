// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState } from 'react';
import type { SubagentProgress } from '../types';
import { formatToolName } from '../lib/tools';
import './SubagentProgressCard.css';

interface SubagentProgressCardProps {
  progress: SubagentProgress;
}

const STEP_ICONS: Record<string, string> = {
  running: '\u2733',    // ✳
  completed: '\u2611',  // ☑
  failed: '\u2612',     // ☒
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  timeout: 'Timed out',
};

export default function SubagentProgressCard({ progress }: SubagentProgressCardProps) {
  const isTerminal = progress.status !== 'running';
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`ac-subagent ac-subagent-${progress.status}`}>
      <div className="ac-subagent-dot" />
      <div className="ac-subagent-content">
        <div className="ac-subagent-header" onClick={() => setExpanded(!expanded)}>
          <span className="ac-subagent-label">Sub-Agent</span>
          <span className="ac-subagent-task">{progress.task}</span>
          <span className="ac-subagent-status-label">
            {STATUS_LABELS[progress.status] || progress.status}
          </span>
          <span className={`ac-subagent-chevron ${expanded ? 'expanded' : ''}`}>
            &#x25B6;
          </span>
        </div>
        {expanded && (
          <div className="ac-subagent-body">
            {progress.steps.length > 0 && (
              <div className="ac-subagent-steps">
                {progress.steps.map((step, i) => (
                  <div key={i} className={`ac-subagent-step ac-subagent-step-${step.status}`}>
                    <span className="ac-subagent-step-icon">
                      {STEP_ICONS[step.status] || STEP_ICONS.running}
                    </span>
                    <span className="ac-subagent-step-name">{formatToolName(step.toolName)}</span>
                    {step.detail && <span className="ac-subagent-step-detail">{step.detail}</span>}
                  </div>
                ))}
              </div>
            )}
            {isTerminal && progress.resultSummary && (
              <div className="ac-subagent-result">{progress.resultSummary}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
