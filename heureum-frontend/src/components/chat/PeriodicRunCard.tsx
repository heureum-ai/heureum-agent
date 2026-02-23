// Copyright (c) 2026 Heureum AI. All rights reserved.

import type { PeriodicRunInfo } from '../../types';
import { ClockIcon } from './icons';

export default function PeriodicRunCard({ run }: { run: PeriodicRunInfo }) {
  const executedAt = run.executedAt
    ? new Date(run.executedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
    : '';
  return (
    <div className="ac-periodic-run-card">
      <div className="ac-periodic-run-icon">
        <ClockIcon />
      </div>
      <div className="ac-periodic-run-info">
        <span className="ac-periodic-run-title">{run.taskTitle}</span>
        {executedAt && <span className="ac-periodic-run-time">{executedAt}</span>}
      </div>
    </div>
  );
}
