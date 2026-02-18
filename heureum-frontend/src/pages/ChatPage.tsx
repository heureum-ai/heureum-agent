// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../store/chatStore';
import { useAuthStore } from '../store/authStore';
import {
  chatAPI,
  getSessionCwd,
  setSessionCwd,
  updateSessionCwd,
  generateSessionTitle,
  fetchSessions,
  deleteSession,
  fetchSessionMessagesPage,
  storeToolResults,
  checkPermission,
  setPermission,
  logPermissionDecision,
  isMobileApp,
  MOBILE_TOOL_NAMES,
  fetchSuggestedQuestions,
  setExtensionConnected as setApiExtensionConnected,
  checkSessionUpdates,
  fetchSubagentStatus,
} from '../lib/api';
import type { SuggestedQuestion } from '../lib/api';
import type {
  ChatRequest,
  Message,
  ToolCallInfo,
  PermissionRequest,
  PermissionDecision,
  QuestionRequest,
  QuestionAnswer,
  SessionListItem,
  StreamEvent,
  FunctionToolCall,
  FunctionToolResult,
  InputItem,
  PeriodicRunInfo,
} from '../types';
import { extractTextFromItem, isToolCall, isMessageItem } from '../types';
import HeureumIcon from '../components/HeureumIcon';
import ThemeToggle from '../components/ThemeToggle';
import PermissionPrompt from '../components/PermissionPrompt';
import QuestionPrompt from '../components/QuestionPrompt';
import CwdPrompt from '../components/CwdPrompt';
import MarkdownMessage from '../components/MarkdownMessage';
import TodoProgress from '../components/TodoProgress';
import SubagentProgressCard from '../components/SubagentProgressCard';
import FilePanel from '../components/FilePanel';
import { useFileStore } from '../store/fileStore';
import { fetchSessionFiles } from '../lib/api';
import { getToolDisplay, FILE_MUTATION_TOOLS } from '../lib/tools';
import './ChatPage.css';

/* ── Helpers ── */

function pathBasename(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function canExecuteTools(): boolean {
  return typeof window !== 'undefined' && window.api?.canExecuteTools === true;
}

function formatCost(cost: number | string): string {
  const n = typeof cost === 'string' ? parseFloat(cost) : cost;
  if (!n || isNaN(n)) return '';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(dateStr: string): string {
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

/* ── SVG Icons ── */

function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

/* ── Tool call block ── */

// TOOL_DISPLAY_NAMES, getToolDisplay, FILE_MUTATION_TOOLS → imported from lib/tools

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

function ToolBlock({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = !!toolCall.output;
  const isPeriodicTask = toolCall.toolName === 'manage_periodic_task';
  const { action, detail } = getToolDisplay(toolCall);

  // Auto-expand periodic task results when completed
  const showExpanded = isPeriodicTask && toolCall.status === 'completed' && hasOutput;

  return (
    <div className={`ac-tool ac-tool-${toolCall.status}`}>
      <div className="ac-tool-dot" />
      <div className="ac-tool-content">
        <div className="ac-tool-header" onClick={() => hasOutput && setExpanded(!expanded)}>
          <span className="ac-tool-action">{action}</span>
          {detail && <span className="ac-tool-detail">{detail}</span>}
          {hasOutput && !showExpanded && <span className={`ac-tool-chevron ${expanded ? 'expanded' : ''}`}>&#x25B6;</span>}
        </div>
        {(showExpanded || expanded) && toolCall.output && (
          isPeriodicTask ? <PeriodicTaskResult output={toolCall.output} /> : <pre className="ac-tool-output">{toolCall.output}</pre>
        )}
      </div>
    </div>
  );
}

function PeriodicRunCard({ run }: { run: PeriodicRunInfo }) {
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

/* ── Main ── */

export default function ChatPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { messages, sessionId, isLoading, cwd, streamingText, addMessage, setSessionId, setLoading, setCwd, appendStreamDelta, clearStreamingText, clearMessages, loadSession, hasOlderMessages, isLoadingOlder, oldestLoadedPage, prependMessages, setHasOlderMessages, setLoadingOlder, setOldestLoadedPage, updateOrAddSubagentProgress } =
    useChatStore();
  const { isFilePanelOpen, toggleFilePanel } = useFileStore();

  // UI state
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Tool / prompt state
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const permissionResolveRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const questionResolveRef = useRef<((answer: QuestionAnswer) => void) | null>(null);
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [pendingCwdSelect, setPendingCwdSelect] = useState(false);
  const cwdSelectResolveRef = useRef<((proceed: boolean) => void) | null>(null);

  const [suggestions, setSuggestions] = useState<SuggestedQuestion[]>([]);
  const [randomSuggestions, setRandomSuggestions] = useState<SuggestedQuestion[]>([]);
  const [subagentPollingSessionId, setSubagentPollingSessionId] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  // Stable ref to handleStreamingSend for use in polling useEffect
  const handleStreamingSendRef = useRef<(allMessages: Message[], currentSessionId: string | null, extraInput?: InputItem[]) => Promise<void>>(async () => {});

  const hasPrompt = !!(pendingPermission || pendingQuestion || pendingCwdSelect);

  /* ── Close user menu on outside click ── */
  useEffect(() => {
    if (!showUserMenu) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUserMenu]);

  /* ── Auto-resize textarea ── */
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  /* ── Track scroll position ── */
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }, []);

  /* ── Load older messages on scroll up ── */
  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || isLoadingOlder || !hasOlderMessages) return;
    setLoadingOlder(true);
    try {
      const nextPage = oldestLoadedPage + 1;
      const { messages: older, hasMore } = await fetchSessionMessagesPage(sessionId, nextPage);
      if (older.length > 0) {
        const el = messagesContainerRef.current;
        const prevScrollHeight = el?.scrollHeight ?? 0;
        prependMessages(older);
        // Restore scroll position after React renders the prepended messages
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop = el.scrollHeight - prevScrollHeight;
          }
        });
      }
      setOldestLoadedPage(nextPage);
      setHasOlderMessages(hasMore);
    } finally {
      setLoadingOlder(false);
    }
  }, [sessionId, isLoadingOlder, hasOlderMessages, oldestLoadedPage, prependMessages, setLoadingOlder, setOldestLoadedPage, setHasOlderMessages]);

  const handleScrollUp = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (el.scrollTop < el.scrollHeight * 0.1 && hasOlderMessages && !isLoadingOlder) {
      loadOlderMessages();
    }
  }, [hasOlderMessages, isLoadingOlder, loadOlderMessages]);

  /* ── Auto-scroll (only when near bottom) ── */
  useEffect(() => {
    if (isNearBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, activeToolCalls, streamingText, pendingPermission, pendingQuestion, pendingCwdSelect]);

  /* ── Extension connection check ── */
  useEffect(() => {
    if (!window.api?.isBrowserExtensionConnected) return;
    const check = () => {
      window.api!.isBrowserExtensionConnected().then((connected) => {
        setExtensionConnected(connected);
        setApiExtensionConnected(connected);
      });
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  /* ── Load sessions ── */
  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const data = await fetchSessions();
      setSessions(data);
    } catch {
      // silently fail
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();

  }, [loadSessions]);

  /* ── Load suggested questions ── */
  useEffect(() => {
    fetchSuggestedQuestions().then(setSuggestions).catch(() => {});
  }, []);

  /* ── Poll for session updates (periodic task execution) ── */
  const lastUpdatedAtRef = useRef<string | null>(null);
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  useEffect(() => {
    if (!sessionId) {
      lastUpdatedAtRef.current = null;
      return;
    }

    // Initialize baseline from current session state
    checkSessionUpdates(sessionId)
      .then((data) => { lastUpdatedAtRef.current = data.updated_at; })
      .catch(() => {});

    const interval = setInterval(async () => {
      if (isLoadingRef.current) return;
      try {
        const data = await checkSessionUpdates(sessionId);
        if (!lastUpdatedAtRef.current) {
          // First successful poll — set baseline without reloading
          lastUpdatedAtRef.current = data.updated_at;
          return;
        }
        if (data.updated_at !== lastUpdatedAtRef.current) {
          lastUpdatedAtRef.current = data.updated_at;
          // Session was updated externally — reload messages
          const { messages: msgs, hasMore } = await fetchSessionMessagesPage(sessionId, 1);
          loadSession(sessionId, msgs, cwd, hasMore);
          // Also refresh session list so sidebar reflects the update
          loadSessions();
          requestAnimationFrame(() => {
            endRef.current?.scrollIntoView({ behavior: 'smooth' });
          });
        }
      } catch { /* ignore */ }
    }, 10000);
    return () => clearInterval(interval);
  }, [sessionId, cwd, loadSession, loadSessions]);

  // Re-baseline after user finishes chatting (so own messages don't trigger a reload)
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading && sessionId) {
      checkSessionUpdates(sessionId)
        .then((data) => { lastUpdatedAtRef.current = data.updated_at; })
        .catch(() => {});
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, sessionId]);

  /* ── Poll sub-agent progress (fire-and-forget tasks) ── */
  useEffect(() => {
    if (!subagentPollingSessionId) return;
    let cancelled = false;
    let failCount = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;
    const sid = subagentPollingSessionId;

    const poll = async () => {
      try {
        const data = await fetchSubagentStatus(sid);
        if (cancelled) return;
        failCount = 0; // reset on success

        let hasRunning = false;
        for (const child of data.children || []) {
          if (child.status === 'running') hasRunning = true;
          updateOrAddSubagentProgress({
            childSessionId: child.child_session_id,
            task: child.task,
            status: (child.status as 'running' | 'completed' | 'failed' | 'timeout') || 'running',
            elapsedSeconds: child.elapsed_seconds,
            currentIteration: child.current_iteration,
            resultSummary: child.result_summary,
            steps: (child.progress || []).map((s) => ({
              toolName: s.tool_name,
              detail: s.detail,
              status: s.status,
            })),
          });
        }

        if (!hasRunning) {
          setSubagentPollingSessionId((prev) => (prev === sid ? null : prev));
          // Synthesis is handled server-side (agent.py:1304-1319)
        }
      } catch {
        failCount++;
        if (failCount >= MAX_CONSECUTIVE_FAILURES) {
          setSubagentPollingSessionId((prev) => (prev === sid ? null : prev));
        }
      }
    };

    void poll();
    const interval = setInterval(() => { void poll(); }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [subagentPollingSessionId, updateOrAddSubagentProgress, addMessage]);

  /* ── Re-randomize suggestions on new chat ── */
  useEffect(() => {
    if (messages.length === 0 && suggestions.length > 0) {
      const shuffled = [...suggestions].sort(() => Math.random() - 0.5);
      setRandomSuggestions(shuffled.slice(0, 4));
    }
  }, [messages.length, suggestions]);

  /* ── Permission handlers ── */
  const handlePermissionRequired = useCallback(
    (req: PermissionRequest): Promise<PermissionDecision> => {
      return new Promise((resolve) => {
        permissionResolveRef.current = resolve;
        setPendingPermission(req);
      });
    },
    [],
  );

  const handlePermissionDecision = useCallback((decision: PermissionDecision) => {
    if (permissionResolveRef.current) {
      permissionResolveRef.current(decision);
      permissionResolveRef.current = null;
    }
    setPendingPermission(null);
  }, []);

  const handlePermissionCancel = useCallback(() => {
    if (permissionResolveRef.current) {
      permissionResolveRef.current('deny');
      permissionResolveRef.current = null;
    }
    if (pendingPermission) {
      addMessage({ role: 'assistant', content: '', cancelled: 'permission', cancelledPermission: pendingPermission });
    }
    setPendingPermission(null);
  }, [pendingPermission, addMessage]);

  /* ── Question handlers ── */
  const handleQuestionRequired = useCallback(
    (req: QuestionRequest): Promise<QuestionAnswer> => {
      return new Promise((resolve) => {
        questionResolveRef.current = resolve;
        setPendingQuestion(req);
      });
    },
    [],
  );

  const handleQuestionAnswer = useCallback((answer: QuestionAnswer) => {
    if (questionResolveRef.current) {
      questionResolveRef.current(answer);
      questionResolveRef.current = null;
    }
    if (pendingQuestion) {
      addMessage({ role: 'assistant', content: '', question: pendingQuestion, questionAnswer: answer });
    }
    setPendingQuestion(null);
  }, [pendingQuestion, addMessage]);

  const handleQuestionCancel = useCallback(() => {
    if (questionResolveRef.current) {
      questionResolveRef.current({ type: 'cancelled' });
      questionResolveRef.current = null;
    }
    if (pendingQuestion) {
      addMessage({ role: 'assistant', content: '', cancelled: 'question', question: pendingQuestion });
    }
    setPendingQuestion(null);
  }, [pendingQuestion, addMessage]);

  /* ── CWD handlers ── */
  const handleCwdSelectRequired = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      cwdSelectResolveRef.current = resolve;
      setPendingCwdSelect(true);
    });
  }, []);

  const handleCwdSelectDecision = useCallback((proceed: boolean) => {
    if (cwdSelectResolveRef.current) {
      cwdSelectResolveRef.current(proceed);
      cwdSelectResolveRef.current = null;
    }
    setPendingCwdSelect(false);
  }, []);

  const handleManualCwdSelect = useCallback(async () => {
    if (!canExecuteTools()) return;
    const result = await window.api!.selectCwd();
    if (result.path) {
      setSessionCwd(result.path);
      setCwd(result.path);
      if (sessionId) {
        await updateSessionCwd(sessionId, result.path);
      }
    }
  }, [sessionId, setCwd]);

  /* ── Unified permission gate ── */
  const checkAndLogPermission = useCallback(async (
    clientId: string,
    toolName: string,
    command: string,
    baseCommand: string,
    callId: string,
    currentSessionId: string,
  ): Promise<PermissionDecision | 'auto_approved'> => {
    const stored = await checkPermission(clientId, toolName, baseCommand);
    let decision: PermissionDecision | 'auto_approved';

    if (stored === true) {
      decision = 'auto_approved';
    } else if (stored === false) {
      decision = 'deny';
    } else {
      decision = await handlePermissionRequired({ toolName, command, callId });
    }

    if (decision === 'always_allow') {
      await setPermission(clientId, toolName, baseCommand, true);
    }

    logPermissionDecision(currentSessionId, clientId, toolName, command, baseCommand, decision, callId).catch(() => {});

    return decision;
  }, [handlePermissionRequired]);

  /* ── Send message (streaming) ── */
  const handleStreamingSend = useCallback(async (allMessages: Message[], currentSessionId: string | null, extraInput?: InputItem[]) => {
    setLoading(true);
    setError(null);
    setActiveToolCalls([]);
    clearStreamingText();

    const req: ChatRequest = { messages: allMessages, session_id: currentSessionId || undefined, extraInput };
    // Local array to track tool calls synchronously (React state updates are batched)
    const collectedToolCalls: ToolCallInfo[] = [];
    const spawnCallIds = new Set<string>();
    let streamSessionId = currentSessionId || '';

    try {
      const finalResponse = await chatAPI.sendMessageStream(req, (event: StreamEvent) => {
        switch (event.type) {
          case 'response.created':
            streamSessionId = event.response.metadata?.session_id || streamSessionId;
            break;
          case 'response.output_text.delta':
            appendStreamDelta(event.delta);
            break;
          case 'response.function_call.done': {
            // When tool calls arrive after streamed text, persist text and clear.
            // Flush previous iteration's tool calls to messages first so they
            // render in the correct position relative to streamed text.
            const currentText = useChatStore.getState().streamingText;
            if (currentText && collectedToolCalls.length > 0) {
              for (const prevTc of collectedToolCalls) {
                if (prevTc.status === 'running') prevTc.status = 'completed';
                addMessage({ role: 'assistant', content: '', toolCall: prevTc });
              }
              collectedToolCalls.length = 0;
            }
            if (currentText) {
              addMessage({ role: 'assistant', content: currentText });
              clearStreamingText();
            }

            const tc = event.item;
            // Skip manage_todo — shown via TodoProgress instead
            if (tc.name === 'manage_todo') break;
            // Skip ask_question — shown via QuestionPrompt instead
            if (tc.name === 'ask_question') break;
            // Skip sessions_spawn — shown via SubagentProgressCard instead
            if (tc.name === 'sessions_spawn') {
              spawnCallIds.add(tc.call_id);
              break;
            }
            // Skip if this tool call already exists in messages (approval resume
            // re-emits function_call.done for tools that were already persisted
            // before the user approved them).
            const existingMsgs = useChatStore.getState().messages;
            if (existingMsgs.some(m => m.toolCall?.callId === tc.call_id)) break;
            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(tc.arguments); } catch { /* ignore */ }
            const displayCmd = tc.name === 'bash' && parsedArgs.command
              ? String(parsedArgs.command)
              : tc.name;
            const tcCost = event.usage?.total_cost;
            const toolCallInfo: ToolCallInfo = { callId: tc.call_id, command: displayCmd, toolName: tc.name, toolArgs: parsedArgs, displayName: tc.display_name, status: 'running', cost: tcCost };
            collectedToolCalls.push(toolCallInfo);
            setActiveToolCalls([...collectedToolCalls]);
            break;
          }
          case 'response.tool_result.done': {
            // Match by call_id to update the correct tool call
            const match = collectedToolCalls.find((tc) => tc.callId === event.call_id);
            const resultStatus = event.status === 'completed' ? 'completed' as const : 'failed' as const;
            const resultOutput = event.output ? String(event.output) : undefined;
            if (match) {
              match.status = resultStatus;
              if (resultOutput) match.output = resultOutput;
              // Auto-refresh file panel when file tools complete
              if (event.status === 'completed' && match.toolName && FILE_MUTATION_TOOLS.has(match.toolName)) {
                const sid = req.session_id;
                if (sid) fetchSessionFiles(sid).then((files) => useFileStore.getState().setFiles(files)).catch(() => {});
              }
            } else {
              // Approval resume: tool was already persisted in messages — update it
              useChatStore.getState().updateToolCallStatus(event.call_id, resultStatus, resultOutput);
              if (event.status === 'completed') {
                const msgs = useChatStore.getState().messages;
                const tcMsg = msgs.find(m => m.toolCall?.callId === event.call_id);
                if (tcMsg?.toolCall?.toolName && FILE_MUTATION_TOOLS.has(tcMsg.toolCall.toolName)) {
                  const sid = req.session_id;
                  if (sid) fetchSessionFiles(sid).then((files) => useFileStore.getState().setFiles(files)).catch(() => {});
                }
              }
            }

            if (spawnCallIds.has(event.call_id) && resultOutput) {
              try {
                const parsed = JSON.parse(resultOutput);
                const pollingSid = streamSessionId || req.session_id || useChatStore.getState().sessionId || '';
                if (parsed?.status === 'accepted' && pollingSid) {
                  setSubagentPollingSessionId((prev) => (prev === pollingSid ? prev : pollingSid));
                }
              } catch {
                // ignore non-JSON outputs
              }
            }

            setActiveToolCalls([...collectedToolCalls]);
            break;
          }
          case 'response.todo.updated':
            useChatStore.getState().updateOrAddTodo(event.todo);
            break;
          case 'response.output_text.abandoned': {
            // Server is retrying (skill unfinished / judge failed).
            // Only show the abandoned text to the user for unfinished skills;
            // judge-rejected text is low quality and should be silently discarded.
            const abandonedText = useChatStore.getState().streamingText;
            if (abandonedText && event.reason === 'unfinished_skill') {
              addMessage({ role: 'assistant', content: abandonedText });
            }
            clearStreamingText();
            break;
          }
        }
      });

      clearStreamingText();
      const newSessionId = finalResponse.metadata?.session_id || currentSessionId || '';
      const isNewSession = !currentSessionId && !!newSessionId;

      // Handle incomplete response — client-side tool execution needed
      if (finalResponse.status === 'incomplete') {
        const toolCalls = (finalResponse.output ?? []).filter(isToolCall);
        if (toolCalls.length > 0) {
          // Persist any streamed text before tool calls
          const assistantText = (finalResponse.output ?? [])
            .filter(isMessageItem)
            .filter((m) => m.role === 'assistant')
            .map(extractTextFromItem)
            .join('');
          if (assistantText) {
            addMessage({ role: 'assistant', content: assistantText });
          }

          // Process tool calls and collect results
          const toolResults = await processClientToolCalls(
            toolCalls,
            allMessages,
            newSessionId,
            collectedToolCalls,
          );

          // Add tool call messages to UI
          for (const tc of collectedToolCalls) {
            addMessage({ role: 'assistant', content: '', toolCall: tc });
          }

          if (toolResults === null) {
            // Tool execution was aborted (e.g., permission denied for select_cwd)
            setSessionId(newSessionId);
            setCwd(getSessionCwd());
            setLoading(false);
            loadSessions();
            if (isNewSession) {
              generateSessionTitle(newSessionId)
                .then((title) => {
                  setSessions(prev => prev.map(s =>
                    s.session_id === newSessionId ? { ...s, title } : s
                  ));
                })
                .catch(() => {});
            }
            return;
          }

          // Store tool results directly in DB (ensures they persist for session reload)
          storeToolResults(newSessionId, toolResults).catch(() => {});

          // Build follow-up input with tool results and recurse
          const followUpMessages: Message[] = [...allMessages];
          if (assistantText) {
            followUpMessages.push({ role: 'assistant', content: assistantText });
          }

          setActiveToolCalls([]);
          setSessionId(newSessionId);
          setCwd(getSessionCwd());

          // Recurse for follow-up streaming request, including tool calls + results
          await handleStreamingSend(followUpMessages, newSessionId, [...toolCalls, ...toolResults]);
          loadSessions();
          if (isNewSession) {
            generateSessionTitle(newSessionId)
              .then((title) => {
                setSessions(prev => prev.map(s =>
                  s.session_id === newSessionId ? { ...s, title } : s
                ));
              })
              .catch(() => {});
          }
          return;
        }
      }

      // Persist tool calls as messages before clearing
      for (const tc of collectedToolCalls) {
        addMessage({ role: 'assistant', content: '', toolCall: tc });
      }
      setActiveToolCalls([]);
      setCwd(getSessionCwd());

      // Failed — show error, don't add empty assistant message
      if (finalResponse.status === 'failed') {
        const errMsg = finalResponse.error?.message || 'The request failed. Please try again.';
        setError(errMsg);
        setSessionId(newSessionId);
        setLoading(false);
        return;
      }

      const assistantOutput = (finalResponse.output ?? [])
        .filter(isMessageItem)
        .filter((m) => m.role === 'assistant')
        .map(extractTextFromItem)
        .join('');
      addMessage({
        role: 'assistant',
        content: assistantOutput,
        cost: finalResponse.usage?.total_cost,
      });
      setSessionId(newSessionId);
      setLoading(false);

      loadSessions();
      if (isNewSession) {
        generateSessionTitle(newSessionId)
          .then((title) => {
            setSessions(prev => prev.map(s =>
              s.session_id === newSessionId ? { ...s, title } : s
            ));
          })
          .catch(() => {});
      }
    } catch (err: any) {
      clearStreamingText();
      setError(err.message || 'Failed to send message');
      setLoading(false);
      setActiveToolCalls([]);
    }
  }, [addMessage, appendStreamDelta, clearStreamingText, setLoading, setSessionId, setCwd, sessionId, loadSessions]);
  handleStreamingSendRef.current = handleStreamingSend;


  /** Execute client-side tool calls, returning FunctionToolResult[] or null if aborted. */
  const processClientToolCalls = useCallback(async (
    toolCalls: FunctionToolCall[],
    _allMessages: Message[],
    currentSessionId: string,
    collectedToolCalls: ToolCallInfo[],
  ): Promise<FunctionToolResult[] | null> => {
    const clientId = canExecuteTools() ? await window.api!.getClientId() : '';
    const results: FunctionToolResult[] = [];

    for (const tc of toolCalls) {
      // tool_approval — reuse existing PermissionPrompt + checkAndLogPermission
      if (tc.name === 'tool_approval') {
        const approvalArgs = JSON.parse(tc.arguments);
        const toolName = approvalArgs.tool_name || 'tool';
        const decision = await checkAndLogPermission(clientId, toolName, toolName, toolName, tc.call_id, currentSessionId);
        if (decision === 'deny') {
          const denyMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (denyMatch) { denyMatch.status = 'failed'; denyMatch.output = 'Permission denied'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'User chose: Deny' });
          continue;
        }
        const label = decision === 'always_allow' || decision === 'auto_approved' ? 'Always Allow' : 'Allow Once';
        results.push({ type: 'function_call_output', call_id: tc.call_id, output: `User chose: ${label}` });
        const aMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
        if (aMatch) { aMatch.status = 'completed'; }
        setActiveToolCalls([...collectedToolCalls]);
        continue;
      }

      // ask_question — no permission needed
      if (tc.name === 'ask_question') {
        const qArgs = JSON.parse(tc.arguments);
        const questionReq: QuestionRequest = {
          callId: tc.call_id,
          question: qArgs.question,
          choices: qArgs.choices,
          allowUserInput: qArgs.allow_user_input ?? false,
        };
        const answer = await handleQuestionRequired(questionReq);
        const outputText =
          answer.type === 'cancelled' ? 'User cancelled the question.'
          : answer.type === 'choice' ? `User chose: ${answer.value}`
          : `User input: ${answer.value}`;
        results.push({ type: 'function_call_output', call_id: tc.call_id, output: outputText });
        const qMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
        if (qMatch) { qMatch.status = answer.type === 'cancelled' ? 'failed' : 'completed'; }
        setActiveToolCalls([...collectedToolCalls]);
        continue;
      }

      // select_cwd — no permission needed (user picks folder interactively)
      if (tc.name === 'select_cwd') {
        if (!canExecuteTools()) {
          const cwdMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (cwdMatch) { cwdMatch.status = 'failed'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: Not supported in browser.' });
          continue;
        }

        const proceed = await handleCwdSelectRequired();
        if (!proceed) {
          const cwdMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (cwdMatch) { cwdMatch.status = 'failed'; cwdMatch.output = 'User declined working directory selection.'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'User declined working directory selection.' });
          continue;
        }
        const cwdResult = await window.api!.selectCwd();
        if (cwdResult.path) {
          setSessionCwd(cwdResult.path);
          setCwd(cwdResult.path);
          if (currentSessionId) await updateSessionCwd(currentSessionId, cwdResult.path);
          const cwdMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (cwdMatch) { cwdMatch.status = 'completed'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: `Working directory set to: ${cwdResult.path}` });
        } else {
          const cwdMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (cwdMatch) { cwdMatch.status = 'failed'; cwdMatch.output = 'User cancelled folder selection.'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'User cancelled folder selection.' });
        }
        continue;
      }

      // bash
      if (tc.name === 'bash') {
        if (!canExecuteTools() || !getSessionCwd()) {
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: No working directory set.' });
          continue;
        }
        const args = JSON.parse(tc.arguments);
        const command: string = args.command;
        const baseCommand = command.trim().split(/\s+/)[0];

        const decision = await checkAndLogPermission(clientId, 'bash', command, baseCommand, tc.call_id, currentSessionId);
        if (decision === 'deny') {
          const denyMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (denyMatch) { denyMatch.status = 'failed'; denyMatch.output = 'Permission denied'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected tool execution.' });
          continue;
        }

        const result = await window.api!.executeBash(command, getSessionCwd() || undefined);
        const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
        const bashMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
        if (bashMatch) {
          bashMatch.status = result.exitCode === 0 ? 'completed' : 'failed';
          bashMatch.output = output || '(no output)';
          bashMatch.exitCode = result.exitCode;
        }
        setActiveToolCalls([...collectedToolCalls]);
        results.push({ type: 'function_call_output', call_id: tc.call_id, output: output || '(no output)' });
        continue;
      }

      // browser tools
      if (tc.name.startsWith('browser_')) {
        if (!canExecuteTools()) {
          const bMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (bMatch) { bMatch.status = 'failed'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: Not supported in browser.' });
          continue;
        }

        const browserArgs = JSON.parse(tc.arguments);
        const browserAction = tc.name.replace('browser_', '');
        const displayCommand =
          tc.name === 'browser_navigate' ? `Navigate: ${browserArgs.url}`
          : tc.name === 'browser_new_tab' ? `New tab: ${browserArgs.url}`
          : tc.name === 'browser_click' ? `Click: ${browserArgs.selector}`
          : tc.name === 'browser_type' ? `Type into ${browserArgs.selector}: "${browserArgs.text}"`
          : 'Get page content';

        const decision = await checkAndLogPermission(clientId, tc.name, displayCommand, tc.name, tc.call_id, currentSessionId);
        if (decision === 'deny') {
          const bMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (bMatch) { bMatch.status = 'failed'; bMatch.output = 'Permission denied'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected browser action.' });
          continue;
        }

        const browserResult = await window.api!.browserCommand(browserAction, browserArgs);
        const browserOutput = browserResult.success
          ? browserResult.output
          : `Error: ${browserResult.error || 'Unknown error'}`;
        const bMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
        if (bMatch) {
          bMatch.status = browserResult.success ? 'completed' : 'failed';
          bMatch.output = browserOutput || '(no output)';
          bMatch.exitCode = browserResult.success ? 0 : 1;
        }
        setActiveToolCalls([...collectedToolCalls]);
        results.push({ type: 'function_call_output', call_id: tc.call_id, output: browserOutput || '(no output)' });
        continue;
      }

      // mobile tools
      if (MOBILE_TOOL_NAMES.has(tc.name)) {
        if (!isMobileApp()) {
          const mMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (mMatch) { mMatch.status = 'failed'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: Mobile device tools are only available on mobile.' });
          continue;
        }

        const decision = await checkAndLogPermission(clientId, tc.name, tc.name, tc.name, tc.call_id, currentSessionId);
        if (decision === 'deny') {
          const mMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (mMatch) { mMatch.status = 'failed'; mMatch.output = 'Permission denied'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected tool execution.' });
          continue;
        }

        try {
          const tcArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
          const mobileResult = await window.mobileBridge!.request(tc.name, tcArgs);
          const mobileOutput = JSON.stringify(mobileResult);
          const mMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (mMatch) {
            mMatch.status = 'completed';
            mMatch.output = mobileOutput;
            mMatch.exitCode = 0;
          }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: mobileOutput });
        } catch (err: any) {
          const errOutput = `Error: ${err.message || 'Failed to execute mobile tool'}`;
          const mMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (mMatch) {
            mMatch.status = 'failed';
            mMatch.output = errOutput;
            mMatch.exitCode = 1;
          }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: errOutput });
        }
        continue;
      }

      // TODO: re-enable when document tools are ready
      // // docx tools
      // if (tc.name.startsWith('docx_')) {
      //   if (!canExecuteTools()) {
      //     const dMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (dMatch) { dMatch.status = 'failed'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: DOCX tools require the desktop app.' });
      //     continue;
      //   }
      //
      //   const docxArgs = JSON.parse(tc.arguments);
      //   const decision = await checkAndLogPermission(clientId, tc.name, tc.name, tc.name, tc.call_id, currentSessionId);
      //   if (decision === 'deny') {
      //     const dMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (dMatch) { dMatch.status = 'failed'; dMatch.output = 'Permission denied'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected DOCX tool execution.' });
      //     continue;
      //   }
      //
      //   const docxResult = await window.api!.docxTool(tc.name, docxArgs);
      //   const docxOutput = docxResult.success
      //     ? docxResult.output
      //     : `Error: ${docxResult.error || 'DOCX tool failed'}`;
      //   const dMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //   if (dMatch) {
      //     dMatch.status = docxResult.success ? 'completed' : 'failed';
      //     dMatch.output = docxOutput || '(no output)';
      //     dMatch.exitCode = docxResult.success ? 0 : 1;
      //   }
      //   setActiveToolCalls([...collectedToolCalls]);
      //   results.push({ type: 'function_call_output', call_id: tc.call_id, output: docxOutput || '(no output)' });
      //   continue;
      // }
      //
      // // pdf tools
      // if (tc.name.startsWith('pdf_')) {
      //   if (!canExecuteTools()) {
      //     const pMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (pMatch) { pMatch.status = 'failed'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: PDF tools require the desktop app.' });
      //     continue;
      //   }
      //   const pdfArgs = JSON.parse(tc.arguments);
      //   const decision = await checkAndLogPermission(clientId, tc.name, tc.name, tc.name, tc.call_id, currentSessionId);
      //   if (decision === 'deny') {
      //     const pMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (pMatch) { pMatch.status = 'failed'; pMatch.output = 'Permission denied'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected PDF tool execution.' });
      //     continue;
      //   }
      //   const pdfResult = await window.api!.pdfTool(tc.name, pdfArgs);
      //   const pdfOutput = pdfResult.success ? pdfResult.output : `Error: ${pdfResult.error || 'PDF tool failed'}`;
      //   const pMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //   if (pMatch) {
      //     pMatch.status = pdfResult.success ? 'completed' : 'failed';
      //     pMatch.output = pdfOutput || '(no output)';
      //     pMatch.exitCode = pdfResult.success ? 0 : 1;
      //   }
      //   setActiveToolCalls([...collectedToolCalls]);
      //   results.push({ type: 'function_call_output', call_id: tc.call_id, output: pdfOutput || '(no output)' });
      //   continue;
      // }
      //
      // // ppt tools
      // if (tc.name.startsWith('ppt_')) {
      //   if (!canExecuteTools()) {
      //     const ppMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (ppMatch) { ppMatch.status = 'failed'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: PPT tools require the desktop app.' });
      //     continue;
      //   }
      //   const pptArgs = JSON.parse(tc.arguments);
      //   const decision = await checkAndLogPermission(clientId, tc.name, tc.name, tc.name, tc.call_id, currentSessionId);
      //   if (decision === 'deny') {
      //     const ppMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (ppMatch) { ppMatch.status = 'failed'; ppMatch.output = 'Permission denied'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected PPT tool execution.' });
      //     continue;
      //   }
      //   const pptResult = await window.api!.pptTool(tc.name, pptArgs);
      //   const pptOutput = pptResult.success ? pptResult.output : `Error: ${pptResult.error || 'PPT tool failed'}`;
      //   const ppMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //   if (ppMatch) {
      //     ppMatch.status = pptResult.success ? 'completed' : 'failed';
      //     ppMatch.output = pptOutput || '(no output)';
      //     ppMatch.exitCode = pptResult.success ? 0 : 1;
      //   }
      //   setActiveToolCalls([...collectedToolCalls]);
      //   results.push({ type: 'function_call_output', call_id: tc.call_id, output: pptOutput || '(no output)' });
      //   continue;
      // }
      //
      // // xlsx tools
      // if (tc.name.startsWith('xlsx_')) {
      //   if (!canExecuteTools()) {
      //     const xMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (xMatch) { xMatch.status = 'failed'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: XLSX tools require the desktop app.' });
      //     continue;
      //   }
      //   const xlsxArgs = JSON.parse(tc.arguments);
      //   const decision = await checkAndLogPermission(clientId, tc.name, tc.name, tc.name, tc.call_id, currentSessionId);
      //   if (decision === 'deny') {
      //     const xMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //     if (xMatch) { xMatch.status = 'failed'; xMatch.output = 'Permission denied'; }
      //     setActiveToolCalls([...collectedToolCalls]);
      //     results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected XLSX tool execution.' });
      //     continue;
      //   }
      //   const xlsxResult = await window.api!.xlsxTool(tc.name, xlsxArgs);
      //   const xlsxOutput = xlsxResult.success ? xlsxResult.output : `Error: ${xlsxResult.error || 'XLSX tool failed'}`;
      //   const xMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      //   if (xMatch) {
      //     xMatch.status = xlsxResult.success ? 'completed' : 'failed';
      //     xMatch.output = xlsxOutput || '(no output)';
      //     xMatch.exitCode = xlsxResult.success ? 0 : 1;
      //   }
      //   setActiveToolCalls([...collectedToolCalls]);
      //   results.push({ type: 'function_call_output', call_id: tc.call_id, output: xlsxOutput || '(no output)' });
      //   continue;
      // }

      // Fallback for unknown tools
      const fallbackMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      if (fallbackMatch) { fallbackMatch.status = 'failed'; }
      setActiveToolCalls([...collectedToolCalls]);
      results.push({ type: 'function_call_output', call_id: tc.call_id, output: `Error: Client tool ${tc.name} not implemented.` });
    }

    return results;
  }, [checkAndLogPermission, handleQuestionRequired, handleCwdSelectRequired, setCwd]);

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    const content = input.trim();
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const userMessage: Message = { role: 'user', content };
    addMessage(userMessage);
    handleStreamingSend([...messages, userMessage], sessionId);
  };

  const handleSuggestionClick = (text: string) => {
    if (isLoading) return;
    const userMessage: Message = { role: 'user', content: text };
    addMessage(userMessage);
    handleStreamingSend([...messages, userMessage], sessionId);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  /* ── Sidebar actions ── */
  const isMobile = () => window.innerWidth <= 640;

  const handleNewChat = () => {
    clearMessages();
    setSubagentPollingSessionId(null);
    setActiveToolCalls([]);
    setLoading(false);
    clearStreamingText();
    if (isMobile()) setSidebarExpanded(false);
  };

  const handleSelectSession = async (session: SessionListItem) => {
    if (session.session_id === sessionId || isLoading) return;
    try {
      setSubagentPollingSessionId(null);
      const { messages: msgs, hasMore } = await fetchSessionMessagesPage(session.session_id, 1);
      loadSession(session.session_id, msgs, session.cwd, hasMore);
      // Scroll to bottom after loading
      requestAnimationFrame(() => {
        endRef.current?.scrollIntoView();
        isNearBottomRef.current = true;
      });
    } catch { /* silently fail */ }
    if (isMobile()) setSidebarExpanded(false);
  };

  const handleDeleteSession = async (e: React.MouseEvent, sid: string) => {
    e.stopPropagation();
    if (deletingId) return;
    const target = sessions.find((s) => s.session_id === sid);
    if (target?.has_periodic_task) {
      if (!window.confirm('This session has scheduled tasks. Deleting it will also remove all associated periodic tasks. Continue?')) return;
    }
    setDeletingId(sid);
    try {
      await deleteSession(sid);
      setSessions((prev) => prev.filter((s) => s.session_id !== sid));
      if (sid === sessionId) {
        clearMessages();
        setSubagentPollingSessionId(null);
      }
    } catch { /* silently fail */ }
    finally { setDeletingId(null); }
  };

  const handleLogout = async () => { await logout(); navigate('/'); };

  /* ── Derived ── */
  const activeSession = sessions.find((s) => s.session_id === sessionId);
  const activeTitle = activeSession?.title || (sessionId ? 'Chat' : 'New Chat');
  const userInitial = user?.first_name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || '?';

  /* ── Render message ── */
  const renderMessage = (msg: Message, i: number) => {
    if (msg.periodicRun) {
      return (
        <div key={i} className="ac-msg-row ac-msg-periodic-run">
          <PeriodicRunCard run={msg.periodicRun} />
        </div>
      );
    }
    if (msg.todo) {
      return (
        <div key={i} className="ac-msg-row ac-msg-todo">
          <TodoProgress todo={msg.todo} />
        </div>
      );
    }
    if (msg.subagentProgress) {
      return (
        <div key={i} className="ac-msg-row ac-msg-tool">
          <SubagentProgressCard progress={msg.subagentProgress} />
        </div>
      );
    }
    if (msg.toolCall) {
      return (
        <div key={i} className="ac-msg-row ac-msg-tool">
          <ToolBlock toolCall={msg.toolCall} />
        </div>
      );
    }
    if (msg.cancelled === 'permission' && msg.cancelledPermission) {
      return (
        <div key={i} className="ac-msg-row ac-msg-tool">
          <div className="ac-tool ac-tool-failed">
            <div className="ac-tool-dot" />
            <div className="ac-tool-content">
              <div className="ac-tool-header">
                <span className="ac-tool-action">{msg.cancelledPermission.toolName || 'Permission'}</span>
                <span className="ac-tool-detail">{msg.cancelledPermission.command}</span>
                <span className="ac-tool-status-label">denied</span>
              </div>
            </div>
          </div>
        </div>
      );
    }
    if (msg.cancelled === 'question' && msg.question) {
      return (
        <div key={i} className="ac-msg-row ac-msg-tool">
          <div className="ac-tool ac-tool-failed">
            <div className="ac-tool-dot" />
            <div className="ac-tool-content">
              <div className="ac-tool-header">
                <span className="ac-tool-action">Question</span>
                <span className="ac-tool-detail">cancelled</span>
              </div>
            </div>
          </div>
        </div>
      );
    }
    if (msg.question && msg.questionAnswer && msg.questionAnswer.type !== 'cancelled') {
      const answerText = msg.questionAnswer.type === 'choice'
        ? `Selected: ${msg.questionAnswer.value}`
        : `Answered: ${msg.questionAnswer.value}`;
      return (
        <div key={i} className="ac-msg-row ac-msg-tool">
          <div className="ac-tool ac-tool-completed">
            <div className="ac-tool-dot" />
            <div className="ac-tool-content">
              <div className="ac-tool-header">
                <span className="ac-tool-action">Question</span>
                <span className="ac-tool-detail">{msg.question.question}</span>
              </div>
              <div className="ac-tool-subtitle">{answerText}</div>
            </div>
          </div>
        </div>
      );
    }
    if (!msg.content) return null;
    return (
      <div key={i} className={`ac-msg-row ${msg.role === 'user' ? 'ac-msg-user' : 'ac-msg-ai'}`}>
        <div className={`ac-bubble ${msg.role === 'user' ? 'ac-bubble-user' : 'ac-bubble-ai'}`}>
          {msg.role === 'assistant' ? <MarkdownMessage content={msg.content} /> : msg.content}
        </div>
        {msg.role === 'assistant' && msg.cost != null && msg.cost > 0 && (
          <span className="ac-msg-cost">{formatCost(msg.cost)}</span>
        )}
      </div>
    );
  };

  return (
    <div className="ac-page">
      {/* ── Sidebar overlay (mobile) ── */}
      {sidebarExpanded && (
        <div className="ac-sidebar-overlay" onClick={() => setSidebarExpanded(false)} />
      )}
      {/* ── Sidebar ── */}
      <aside className={`ac-sidebar ${sidebarExpanded ? 'expanded' : 'collapsed'}`}>
        <div className="ac-sb-top">
          <div className="ac-sb-logo">
            <HeureumIcon size={24} />
            {sidebarExpanded && <span className="ac-sb-logo-text">Heureum</span>}
          </div>
          <button className="ac-sb-toggle" onClick={() => setSidebarExpanded((v) => !v)} title={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}>
            <PanelIcon />
          </button>
        </div>

        <div className="ac-sb-nav">
          <button className="ac-sb-nav-item" onClick={handleNewChat}>
            <PlusIcon />
            {sidebarExpanded && <span>New Chat</span>}
          </button>

          <button className="ac-sb-nav-item" onClick={() => navigate('/tasks')}>
            <ClockIcon />
            {sidebarExpanded && <span>Tasks</span>}
          </button>
        </div>

        {sidebarExpanded ? (
          <>
            <div className="ac-sb-section-label">Recent</div>
            <div className="ac-sb-sessions">
              {sessionsLoading && sessions.length === 0 && (
                <div className="ac-sb-empty">Loading...</div>
              )}
              {!sessionsLoading && sessions.length === 0 && (
                <div className="ac-sb-empty">No previous chats</div>
              )}
              {sessions.map((s) => (
                <div
                  key={s.session_id}
                  className={`ac-sb-session ${s.session_id === sessionId ? 'active' : ''}`}
                  onClick={() => handleSelectSession(s)}
                >
                  <div className="ac-sb-session-title">
                    {s.has_periodic_task && <span className="ac-sb-session-periodic" title="Has scheduled task">⏱</span>}
                    {s.title || 'Untitled Chat'}
                  </div>
                  <div className="ac-sb-session-meta">
                    <span>{timeAgo(s.updated_at)}</span>
                    {parseFloat(String(s.total_cost)) > 0 && <span className="ac-sb-session-cost">{formatCost(s.total_cost)}</span>}
                  </div>
                  <button
                    className="ac-sb-session-delete"
                    onClick={(e) => handleDeleteSession(e, s.session_id)}
                    disabled={deletingId === s.session_id}
                    title="Delete chat"
                  >
                    {'\u00D7'}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="ac-sb-spacer" />
        )}

        <div className="ac-sb-footer" ref={userMenuRef}>
          {showUserMenu && sidebarExpanded && (
            <div className="ac-sb-usermenu">
              <div className="ac-sb-usermenu-email">{user?.email || ''}</div>
              <div className="ac-sb-usermenu-divider" />
              <button className="ac-sb-usermenu-item" onClick={() => { setShowUserMenu(false); navigate('/settings'); }}>
                <SettingsIcon />
                <span>Settings</span>
              </button>
              <div className="ac-sb-usermenu-divider" />
              <button className="ac-sb-usermenu-item ac-sb-usermenu-danger" onClick={handleLogout}>
                <LogOutIcon />
                <span>Sign out</span>
              </button>
            </div>
          )}
          <div className="ac-sb-footer-user">
            {sidebarExpanded ? (
              <>
                <div className="ac-sb-user ac-sb-user-clickable" onClick={() => setShowUserMenu(v => !v)}>
                  <div className="ac-sb-avatar">{userInitial}</div>
                  <div className="ac-sb-user-info">
                    <span className="ac-sb-user-name">{user?.first_name || user?.email || 'User'}</span>
                    <span className="ac-sb-user-plan">Free plan</span>
                  </div>
                </div>
                <ThemeToggle />
              </>
            ) : (
              <>
                <div className="ac-sb-avatar" onClick={() => navigate('/settings')} style={{ cursor: 'pointer' }}>{userInitial}</div>
                <ThemeToggle />
              </>
            )}
          </div>
        </div>
      </aside>

      {/* ── Chat area + file panel ── */}
      <div className={`ac-main ${isFilePanelOpen ? 'file-panel-open' : ''}`}>
      <div className="ac-chat">
        <div className="ac-topbar">
          <button className="ac-topbar-menu" onClick={() => setSidebarExpanded(true)} title="Open sidebar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h2 className="ac-topbar-title">{activeTitle}</h2>
          <div className="ac-topbar-right">
            {canExecuteTools() && (
              <button className="ac-topbar-cwd" onClick={handleManualCwdSelect} title={cwd || 'Select working directory'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
                {cwd
                  ? <><span className="ac-cwd-short">{pathBasename(cwd)}</span><span className="ac-cwd-full">{cwd}</span></>
                  : <span>Select directory</span>
                }
              </button>
            )}
            {canExecuteTools() && (
              <span className={`ac-status ${extensionConnected ? 'connected' : 'disconnected'}`}>
                {extensionConnected ? 'Connected' : 'Browser control disconnected'}
              </span>
            )}
            {sessionId && (
              <button className={`ac-topbar-files ${isFilePanelOpen ? 'active' : ''}`} onClick={toggleFilePanel} title="Session files">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="ac-messages" ref={messagesContainerRef} onScroll={() => { handleMessagesScroll(); handleScrollUp(); }}>
          <div className="ac-messages-inner">
            {isLoadingOlder && (
              <div className="ac-load-more-spinner">
                <span /><span /><span />
              </div>
            )}
            {messages.length === 0 && !isLoading && (
              <div className="ac-empty">
                <HeureumIcon size={48} />
                <h3>How can I help you today?</h3>
                <p>Ask me to write code, debug issues, or set up projects.</p>
              </div>
            )}
            {messages.map(renderMessage)}
            {activeToolCalls.map((tc, i) => (
              <div key={`active-tc-${i}`} className="ac-msg-row ac-msg-tool">
                <ToolBlock toolCall={tc} />
              </div>
            ))}
            {streamingText && (
              <div className="ac-msg-row ac-msg-ai">
                <div className="ac-bubble ac-bubble-ai">
                  <MarkdownMessage content={streamingText} />
                </div>
              </div>
            )}
            {isLoading && !streamingText && (
              <div className="ac-msg-row ac-msg-tool">
                <div className="ac-agent-running">
                  <div className="ac-agent-running-dot" />
                  <span className="ac-agent-running-text">Running</span>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        {hasPrompt && (
          <div className="ac-prompt-area">
            <div className="ac-prompt-inner">
              {pendingPermission && (
                <PermissionPrompt
                  request={pendingPermission}
                  onDecision={handlePermissionDecision}
                  onCancel={handlePermissionCancel}
                />
              )}
              {pendingQuestion && (
                <QuestionPrompt
                  question={pendingQuestion}
                  onAnswer={handleQuestionAnswer}
                  onCancel={handleQuestionCancel}
                />
              )}
              {pendingCwdSelect && (
                <CwdPrompt onDecision={handleCwdSelectDecision} />
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="ac-error">{error}</div>
        )}

        <div className="ac-input-area">
          <div className="ac-input-inner">
            {messages.length === 0 && randomSuggestions.length > 0 && !isLoading && (
              <div className="ac-suggestions">
                {randomSuggestions.map(q => (
                  <button key={q.id} className="ac-suggestion-btn" onClick={() => handleSuggestionClick(q.question_text)}>
                    {q.question_text}
                  </button>
                ))}
              </div>
            )}
            <div className="ac-input-wrap">
              <textarea
                ref={textareaRef}
                className="ac-input"
                value={input}
                onChange={(e) => { setInput(e.target.value); autoResize(); }}
                onKeyDown={handleKeyDown}
                placeholder="Message Heureum..."
                rows={1}
                disabled={isLoading || hasPrompt}
              />
              <button className="ac-send-btn" onClick={handleSend} disabled={isLoading || hasPrompt || !input.trim()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      {sessionId && <FilePanel sessionId={sessionId} sessionTitle={activeTitle} />}
      </div>
    </div>
  );
}
