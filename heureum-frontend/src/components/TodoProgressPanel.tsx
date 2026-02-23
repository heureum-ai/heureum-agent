// Copyright (c) 2026 Heureum AI. All rights reserved.

import { usePlanStore } from '../store/planStore';
import TodoProgress from './TodoProgress';

export default function TodoProgressPanel() {
  const history = usePlanStore((state) => state.history);
  const plan = usePlanStore((state) => state.plan);

  if (history.length === 0 && !plan) return null;

  return (
    <>
      {history.map((p, i) => (
        <TodoProgress key={`plan-${i}`} plan={p} collapsed />
      ))}
      {plan && <TodoProgress plan={plan} />}
    </>
  );
}
