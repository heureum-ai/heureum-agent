// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState, useEffect, useCallback, type KeyboardEvent } from 'react';
import { useChatStore } from '../store/chatStore';
import { useFileStore } from '../store/fileStore';
import {
  setSessionCwd,
  updateSessionCwd,
  initCodingTools,
  initBrowserTools,
  fetchSessionFiles,
} from '../lib/api';
import { usePromptSystem } from '../hooks/usePromptSystem';
import { useSessionManagement } from '../hooks/useSessionManagement';
import { useScrollBehavior } from '../hooks/useScrollBehavior';
import { useStreamingChat } from '../hooks/useStreamingChat';
import { Sidebar, MessageList, canExecuteTools, pathBasename } from '../components/chat';
import PermissionPrompt from '../components/PermissionPrompt';
import QuestionPrompt from '../components/QuestionPrompt';
import CwdPrompt from '../components/CwdPrompt';
import FilePanel from '../components/FilePanel';
import './ChatPage.css';

export default function ChatPage() {
  const { messages, sessionId, isLoading, cwd, streamingText, setCwd } = useChatStore();
  const { isFilePanelOpen, toggleFilePanel } = useFileStore();

  // UI state
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [input, setInput] = useState('');

  // Prompt system (permissions, questions, CWD select)
  const promptSystem = usePromptSystem();
  const {
    pendingPermission, pendingQuestion, pendingCwdSelect, hasPrompt, extensionConnected,
    handlePermissionDecision, handlePermissionCancel,
    handleQuestionAnswer, handleQuestionCancel,
    handleCwdSelectDecision,
    checkAndLogPermission, handleQuestionRequired, handleCwdSelectRequired,
  } = promptSystem;

  // Scroll behavior (needs activeToolCalls from streaming, but we solve the circular dep via initial empty)
  const scroll = useScrollBehavior({
    activeToolCalls: [], // Will be filled after streaming hook init; auto-scroll deps include messages/isLoading/streamingText
    pendingPermission,
    pendingQuestion,
    pendingCwdSelect,
  });
  const { endRef, textareaRef, messagesContainerRef, isNearBottomRef, autoResize, handleMessagesScroll, handleScrollUp } = scroll;

  // Session management (sessions, polling, sidebar actions)
  const sessionMgmt = useSessionManagement({
    endRef,
    isNearBottomRef,
    setActiveToolCalls: (() => {}) as any, // activeToolCalls cleared via streaming hook
  });
  const {
    sessions, setSessions, sessionsLoading, deletingId, loadSessions,
    handleNewChat, handleSelectSession, handleDeleteSession,
    setSubagentPollingSessionId, randomSuggestions,
  } = sessionMgmt;

  // Streaming chat (send, tool execution, active tool calls)
  const streaming = useStreamingChat({
    loadSessions,
    setSessions,
    setSubagentPollingSessionId,
    checkAndLogPermission,
    handleQuestionRequired,
    handleCwdSelectRequired,
  });
  const { activeToolCalls, error, handleSend, handleSuggestionClick, handleKeyDown } = streaming;

  // Initialize coding + browser tools from Electron main process
  useEffect(() => {
    initCodingTools();
    initBrowserTools();
  }, []);

  // Re-trigger auto-scroll when activeToolCalls change
  useEffect(() => {
    if (isNearBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeToolCalls, endRef, isNearBottomRef]);

  // Refresh file panel when session changes
  useEffect(() => {
    if (sessionId) {
      fetchSessionFiles(sessionId).then((files) => useFileStore.getState().setFiles(files)).catch(() => {});
    }
  }, [sessionId]);

  /* ── CWD manual selection ── */
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

  /* ── Derived ── */
  const activeSession = sessions.find((s) => s.session_id === sessionId);
  const activeTitle = activeSession?.title || (sessionId ? 'Chat' : 'New Chat');

  /* ── Local send/keydown wrappers ── */
  const onSend = () => handleSend(input, setInput, textareaRef);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => handleKeyDown(e, input, setInput, textareaRef);

  return (
    <div className="ac-page">
      <Sidebar
        sidebarExpanded={sidebarExpanded}
        setSidebarExpanded={setSidebarExpanded}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        sessionId={sessionId}
        deletingId={deletingId}
        onNewChat={() => handleNewChat(setSidebarExpanded)}
        onSelectSession={(s) => handleSelectSession(s, setSidebarExpanded)}
        onDeleteSession={handleDeleteSession}
      />

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

        <MessageList
          messages={messages}
          activeToolCalls={activeToolCalls}
          streamingText={streamingText}
          isLoading={isLoading}
          isLoadingOlder={useChatStore.getState().isLoadingOlder}
          messagesContainerRef={messagesContainerRef}
          endRef={endRef}
          onScroll={() => { handleMessagesScroll(); handleScrollUp(); }}
        />

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
                onKeyDown={onKeyDown}
                placeholder="Message Heureum..."
                rows={1}
                disabled={isLoading || hasPrompt}
              />
              <button className="ac-send-btn" onClick={onSend} disabled={isLoading || hasPrompt || !input.trim()}>
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
