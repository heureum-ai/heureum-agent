// Copyright (c) 2026 Heureum AI. All rights reserved.

import { create } from 'zustand';
import type { Message } from '../types';
import { clearSessionCwd, setSessionCwd } from '../lib/api';

interface ChatState {
  messages: Message[];
  sessionId: string | null;
  isLoading: boolean;
  cwd: string | null;
  streamingText: string;
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  oldestLoadedPage: number;
  addMessage: (message: Message) => void;
  prependMessages: (messages: Message[]) => void;
  setSessionId: (sessionId: string) => void;
  setLoading: (loading: boolean) => void;
  setCwd: (cwd: string | null) => void;
  appendStreamDelta: (delta: string) => void;
  clearStreamingText: () => void;
  clearMessages: () => void;
  updateOrAddTodo: (todo: NonNullable<Message['todo']>) => void;
  loadSession: (
    sessionId: string,
    messages: Message[],
    cwd: string | null,
    hasOlderMessages?: boolean,
    loadedPages?: number,
  ) => void;
  updateToolCallStatus: (callId: string, status: 'completed' | 'failed', output?: string) => void;
  setHasOlderMessages: (v: boolean) => void;
  setLoadingOlder: (v: boolean) => void;
  setOldestLoadedPage: (p: number) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessionId: null,
  isLoading: false,
  cwd: null,
  streamingText: '',
  hasOlderMessages: false,
  isLoadingOlder: false,
  oldestLoadedPage: 1,
  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  prependMessages: (messages) =>
    set((state) => ({ messages: [...messages, ...state.messages] })),
  setSessionId: (sessionId) => set({ sessionId }),
  setLoading: (loading) => set({ isLoading: loading }),
  setCwd: (cwd) => set({ cwd }),
  appendStreamDelta: (delta) =>
    set((state) => ({ streamingText: state.streamingText + delta })),
  clearStreamingText: () => set({ streamingText: '' }),
  clearMessages: () => {
    clearSessionCwd();
    set({ messages: [], sessionId: null, cwd: null, streamingText: '', hasOlderMessages: false, isLoadingOlder: false, oldestLoadedPage: 1 });
  },
  updateOrAddTodo: (todo) => {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.todo != null);
      if (idx < 0) {
        return { messages: [...state.messages, { role: 'assistant', content: '', todo }] };
      }
      const updated = [...state.messages];
      updated[idx] = { ...updated[idx], todo };
      return { messages: updated };
    });
  },
  loadSession: (sessionId, messages, cwd, hasOlderMessages = false, loadedPages = 1) => {
    if (cwd) {
      setSessionCwd(cwd);
    } else {
      clearSessionCwd();
    }
    const isSessionChange = sessionId !== get().sessionId;
    set({
      messages,
      sessionId,
      cwd,
      ...(isSessionChange && { streamingText: '' }),
      hasOlderMessages,
      oldestLoadedPage: loadedPages,
    });
  },
  updateToolCallStatus: (callId, status, output) => {
    set((state) => {
      const msgs = state.messages;
      const idx = msgs.findIndex(m => m.toolCall?.callId === callId);
      if (idx < 0) return state;
      const updated = [...msgs];
      const tc = { ...msgs[idx].toolCall!, status, ...(output != null ? { output } : {}) };
      updated[idx] = { ...msgs[idx], toolCall: tc };
      return { messages: updated };
    });
  },
  setHasOlderMessages: (v) => set({ hasOlderMessages: v }),
  setLoadingOlder: (v) => set({ isLoadingOlder: v }),
  setOldestLoadedPage: (p) => set({ oldestLoadedPage: p }),
}));
