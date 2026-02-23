// Copyright (c) 2026 Heureum AI. All rights reserved.

export function pathBasename(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function canExecuteTools(): boolean {
  return typeof window !== 'undefined' && window.api?.canExecuteTools === true;
}

export function formatCost(cost: number | string): string {
  const n = typeof cost === 'string' ? parseFloat(cost) : cost;
  if (!n || isNaN(n)) return '';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
