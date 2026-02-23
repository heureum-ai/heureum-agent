// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useRef, useCallback, useEffect } from 'react';
import { useChatStore } from '../store/chatStore';
import { fetchSessionMessagesPage } from '../lib/api';
import type { ToolCallInfo, PermissionRequest, QuestionRequest } from '../types';

interface UseScrollBehaviorArgs {
  activeToolCalls: ToolCallInfo[];
  pendingPermission: PermissionRequest | null;
  pendingQuestion: QuestionRequest | null;
  pendingCwdSelect: boolean;
}

export function useScrollBehavior({
  activeToolCalls,
  pendingPermission,
  pendingQuestion,
  pendingCwdSelect,
}: UseScrollBehaviorArgs) {
  const { messages, isLoading, streamingText, sessionId, isLoadingOlder, hasOlderMessages, oldestLoadedPage, prependMessages, setLoadingOlder, setOldestLoadedPage, setHasOlderMessages } = useChatStore();

  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

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

  return {
    endRef,
    textareaRef,
    messagesContainerRef,
    isNearBottomRef,
    autoResize,
    handleMessagesScroll,
    handleScrollUp,
  };
}
