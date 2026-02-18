// Copyright (c) 2026 Heureum AI. All rights reserved.

import { create } from 'zustand';
import type { Message, TodoState } from '../types';
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
  loadSession: (sessionId: string, messages: Message[], cwd: string | null, hasOlderMessages?: boolean) => void;
  updateOrAddTodo: (todo: TodoState) => void;
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
  loadSession: (sessionId, messages, cwd, hasOlderMessages = false) => {
    if (cwd) {
      setSessionCwd(cwd);
    } else {
      clearSessionCwd();
    }
    set({ messages, sessionId, cwd, streamingText: '', hasOlderMessages, oldestLoadedPage: 1 });
  },
  updateToolCallStatus: (callId, status, output) => {
    const msgs = get().messages;
    const idx = msgs.findIndex(m => m.toolCall?.callId === callId);
    if (idx >= 0) {
      const updated = [...msgs];
      const tc = { ...msgs[idx].toolCall!, status, ...(output != null ? { output } : {}) };
      updated[idx] = { ...msgs[idx], toolCall: tc };
      set({ messages: updated });
    }
  },
  updateOrAddTodo: (todo) => {
    const msgs = get().messages;
    let lastIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].todo != null) { lastIdx = i; break; }
    }
    if (lastIdx >= 0) {
      const updated = [...msgs];
      updated[lastIdx] = { ...updated[lastIdx], todo };
      set({ messages: updated });
    } else {
      set({ messages: [...msgs, { role: 'assistant', content: '', todo }] });
    }
  },
  setHasOlderMessages: (v) => set({ hasOlderMessages: v }),
  setLoadingOlder: (v) => set({ isLoadingOlder: v }),
  setOldestLoadedPage: (p) => set({ oldestLoadedPage: p }),
}));
