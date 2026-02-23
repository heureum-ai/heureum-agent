// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { usePlanStore } from '../store/planStore';
import { restorePlanFromMessages } from '../lib/planEventProcessor';
import {
  fetchSessions,
  deleteSession,
  fetchSessionMessagesPage,
  checkSessionUpdates,
  fetchSubagentStatus,
  fetchSuggestedQuestions,
} from '../lib/api';
import type { SuggestedQuestion } from '../lib/api';
import type { SessionListItem } from '../types';

interface UseSessionManagementArgs {
  endRef: React.RefObject<HTMLDivElement | null>;
  isNearBottomRef: React.MutableRefObject<boolean>;
  setActiveToolCalls: (v: never[]) => void;
}

export function useSessionManagement({ endRef, isNearBottomRef, setActiveToolCalls }: UseSessionManagementArgs) {
  const {
    messages, sessionId, isLoading, cwd, streamingText,
    setLoading, clearStreamingText, clearMessages, loadSession,
    addMessage,
  } = useChatStore();

  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [subagentPollingSessionId, setSubagentPollingSessionId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedQuestion[]>([]);
  const [randomSuggestions, setRandomSuggestions] = useState<SuggestedQuestion[]>([]);

  const messageSignature = (m: (typeof messages)[number]): string => {
    if (m.todo) return `todo:${m.todo.team}:${m.todo.tasks.length}`;
    if (m.toolCall) return `tool:${m.toolCall.callId || m.toolCall.command}`;
    if (m.periodicRun) return `periodic:${m.periodicRun.taskId}:${m.periodicRun.executedAt}`;
    return `msg:${m.role}:${m.content}`;
  };

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

  /* ── Re-randomize suggestions on new chat ── */
  useEffect(() => {
    if (messages.length === 0 && suggestions.length > 0) {
      const shuffled = [...suggestions].sort(() => Math.random() - 0.5);
      setRandomSuggestions(shuffled.slice(0, 4));
    }
  }, [messages.length, suggestions]);

  /* ── Poll for session updates (periodic task execution) ── */
  const lastUpdatedAtRef = useRef<string | null>(null);
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const streamingTextRef = useRef(streamingText);
  streamingTextRef.current = streamingText;

  useEffect(() => {
    if (!sessionId) {
      lastUpdatedAtRef.current = null;
      return;
    }

    checkSessionUpdates(sessionId)
      .then((data) => { lastUpdatedAtRef.current = data.updated_at; })
      .catch(() => {});

    const interval = setInterval(async () => {
      if (isLoadingRef.current) return;
      if (streamingTextRef.current.length > 0) return;
      try {
        const data = await checkSessionUpdates(sessionId);
        if (!lastUpdatedAtRef.current) {
          lastUpdatedAtRef.current = data.updated_at;
          return;
        }
        if (data.updated_at !== lastUpdatedAtRef.current) {
          lastUpdatedAtRef.current = data.updated_at;
          const currentMessages = useChatStore.getState().messages;
          const currentCount = currentMessages.length;
          let page = 1;
          let hasMore = false;
          let mergedMessages: typeof messages = [];

          // Keep at least as many messages as currently visible to avoid
          // page-1 replacement dropping older assistant text.
          while (page <= 20) {
            const { messages: pageMessages, hasMore: pageHasMore } =
              await fetchSessionMessagesPage(sessionId, page);
            mergedMessages = [...pageMessages, ...mergedMessages];
            hasMore = pageHasMore;

            if (!hasMore || mergedMessages.length >= currentCount) break;
            page += 1;
          }

          // Guardrail:
          // 1) never shrink visible timeline
          // 2) only accept server refresh when it still contains recent local tail
          const mergedSignatures = new Set(mergedMessages.map(messageSignature));
          const localTail = currentMessages.slice(-3).map(messageSignature);
          const tailPreserved = localTail.every((sig) => mergedSignatures.has(sig));

          if (mergedMessages.length >= currentCount && tailPreserved) {
            loadSession(sessionId, mergedMessages, cwd, hasMore, page);
            restorePlanFromMessages(mergedMessages);
          }
          loadSessions();
          requestAnimationFrame(() => {
            endRef.current?.scrollIntoView({ behavior: 'smooth' });
          });
        }
      } catch { /* ignore */ }
    }, 10000);
    return () => clearInterval(interval);
  }, [sessionId, cwd, loadSession, loadSessions, endRef]);

  // Re-baseline after user finishes chatting
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading && sessionId) {
      checkSessionUpdates(sessionId)
        .then((data) => { lastUpdatedAtRef.current = data.updated_at; })
        .catch(() => {});
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, sessionId]);

  /* ── Poll sub-agent progress ── */
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
        failCount = 0;

        let hasRunning = false;
        for (const child of data.children || []) {
          if (child.status === 'running') hasRunning = true;
          usePlanStore.getState().mergeSubagentProgress({
            childSessionId: child.child_session_id,
            status: (child.status as 'running' | 'completed' | 'failed' | 'timeout') || 'running',
            elapsedSeconds: child.elapsed_seconds,
            currentIteration: child.current_iteration,
            resultSummary: child.result_summary,
            steps: (child.progress || []).map((s: any) => ({
              toolName: s.tool_name,
              displayName: s.display_name || s.tool_name,
              detail: s.detail,
              status: s.status,
            })),
          });
        }

        if (!hasRunning) {
          setSubagentPollingSessionId((prev) => (prev === sid ? null : prev));
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
  }, [subagentPollingSessionId, addMessage]);

  /* ── Sidebar actions ── */
  const isMobile = () => window.innerWidth <= 640;

  const handleNewChat = useCallback((setSidebarExpanded: (v: boolean) => void) => {
    clearMessages();
    usePlanStore.getState().reset();
    setSubagentPollingSessionId(null);
    setActiveToolCalls([]);
    setLoading(false);
    clearStreamingText();
    if (isMobile()) setSidebarExpanded(false);
  }, [clearMessages, setLoading, clearStreamingText, setActiveToolCalls]);

  const handleSelectSession = useCallback(async (
    session: SessionListItem,
    setSidebarExpanded: (v: boolean) => void,
  ) => {
    if (session.session_id === sessionId || isLoading) return;
    try {
      setSubagentPollingSessionId(null);
      usePlanStore.getState().reset();
      const { messages: msgs, hasMore } = await fetchSessionMessagesPage(session.session_id, 1);
      loadSession(session.session_id, msgs, session.cwd, hasMore);
      restorePlanFromMessages(msgs);
      requestAnimationFrame(() => {
        endRef.current?.scrollIntoView();
        isNearBottomRef.current = true;
      });
    } catch { /* silently fail */ }
    if (isMobile()) setSidebarExpanded(false);
  }, [sessionId, isLoading, loadSession, endRef, isNearBottomRef]);

  const handleDeleteSession = useCallback(async (e: React.MouseEvent, sid: string) => {
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
  }, [deletingId, sessions, sessionId, clearMessages]);

  return {
    sessions,
    setSessions,
    sessionsLoading,
    deletingId,
    loadSessions,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    subagentPollingSessionId,
    setSubagentPollingSessionId,
    suggestions,
    randomSuggestions,
  };
}
