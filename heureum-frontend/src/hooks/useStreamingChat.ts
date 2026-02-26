// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { useChatStore } from '../store/chatStore';
import { useFileStore } from '../store/fileStore';
import {
  chatAPI,
  getSessionCwd,
  setSessionCwd,
  updateSessionCwd,
  generateSessionTitle,
  isMobileApp,
  MOBILE_TOOL_NAMES,
  CODING_TOOL_NAMES,
  fetchSessionFiles,
} from '../lib/api';
import { FILE_MUTATION_TOOLS } from '../lib/tools';
import { processPlanEvent, finalizePlan } from '../lib/planEventProcessor';
import type {
  ChatRequest,
  Message,
  ToolCallInfo,
  QuestionRequest,
  SessionListItem,
  StreamEvent,
  FunctionToolCall,
  FunctionToolResult,
  InputItem,
} from '../types';
import { extractTextFromItem, isToolCall, isMessageItem } from '../types';

function canExecuteTools(): boolean {
  return typeof window !== 'undefined' && window.api?.canExecuteTools === true;
}

interface UseStreamingChatArgs {
  loadSessions: () => Promise<void>;
  setSessions: React.Dispatch<React.SetStateAction<SessionListItem[]>>;
  setSubagentPollingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  checkAndLogPermission: (
    clientId: string,
    toolName: string,
    command: string,
    baseCommand: string,
    callId: string,
    currentSessionId: string,
  ) => Promise<'always_allow' | 'allow_once' | 'deny' | 'auto_approved'>;
  handleQuestionRequired: (req: QuestionRequest) => Promise<import('../types').QuestionAnswer>;
  handleCwdSelectRequired: () => Promise<boolean>;
}

export function useStreamingChat({
  loadSessions,
  setSessions,
  setSubagentPollingSessionId,
  checkAndLogPermission,
  handleQuestionRequired,
  handleCwdSelectRequired,
}: UseStreamingChatArgs) {
  const {
    messages, sessionId, isLoading,
    addMessage, setSessionId, setLoading, setCwd,
    appendStreamDelta, clearStreamingText, updateOrAddTodo,
  } = useChatStore();

  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const previousResponseIdRef = useRef<string | null>(null);

  // Reset previous_response_id when switching sessions
  useEffect(() => {
    previousResponseIdRef.current = null;
  }, [sessionId]);

  // Stable ref to handleStreamingSend for use in polling useEffect
  const handleStreamingSendRef = useRef<(allMessages: Message[], currentSessionId: string | null, extraInput?: InputItem[]) => Promise<void>>(async () => {});

  /* ── Send message (streaming) ── */
  const handleStreamingSend = useCallback(async (allMessages: Message[], currentSessionId: string | null, extraInput?: InputItem[]) => {
    setLoading(true);
    setError(null);
    setActiveToolCalls([]);
    clearStreamingText();

    const req: ChatRequest = { messages: allMessages, session_id: currentSessionId || undefined, extraInput, previous_response_id: previousResponseIdRef.current || undefined };
    const collectedToolCalls: ToolCallInfo[] = [];
    const spawnCallIds = new Set<string>();
    let streamSessionId = currentSessionId || '';
    let flushedStreamingText = false;

    try {
      const finalResponse = await chatAPI.sendMessageStream(req, (event: StreamEvent) => {
        // Dual-write: route every event to planStore
        processPlanEvent(event);

        switch (event.type) {
          case 'response.created':
            streamSessionId = event.response.metadata?.session_id || streamSessionId;
            break;
          case 'response.output_text.delta':
            appendStreamDelta(event.delta);
            break;
          case 'response.function_call.done': {
            // Flush previously collected tool calls as messages (even without text)
            if (collectedToolCalls.length > 0) {
              for (const prevTc of collectedToolCalls) {
                if (prevTc.status === 'running') prevTc.status = 'completed';
                addMessage({ role: 'assistant', content: '', toolCall: prevTc });
              }
              collectedToolCalls.length = 0;
            }
            const currentText = useChatStore.getState().streamingText;
            if (currentText) {
              addMessage({ role: 'assistant', content: currentText });
              clearStreamingText();
              flushedStreamingText = true;
            }

            const tc = event.item;
            if (tc.name === 'manage_todo') break;
            if (tc.name === 'ask_question') break;
            if (tc.name === 'sessions_spawn') {
              spawnCallIds.add(tc.call_id);
              break;
            }
            const existingMsgs = useChatStore.getState().messages;
            if (existingMsgs.some(m => m.toolCall?.callId === tc.call_id)) break;
            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(tc.arguments); } catch { /* ignore */ }
            const displayCmd = typeof parsedArgs.command === 'string' ? parsedArgs.command : tc.name;
            const tcCost = event.usage?.total_cost;
            const toolCallInfo: ToolCallInfo = { callId: tc.call_id, command: displayCmd, toolName: tc.name, toolArgs: parsedArgs, displayName: tc.display_name, status: 'running', cost: tcCost };
            collectedToolCalls.push(toolCallInfo);
            setActiveToolCalls([...collectedToolCalls]);
            break;
          }
          case 'response.tool_result.done': {
            const match = collectedToolCalls.find((tc) => tc.callId === event.call_id);
            const resultStatus = event.status === 'completed' ? 'completed' as const : 'failed' as const;
            const resultOutput = event.output ? String(event.output) : undefined;
            if (match) {
              match.status = resultStatus;
              if (resultOutput) match.output = resultOutput;
              if (event.status === 'completed' && match.toolName && FILE_MUTATION_TOOLS.has(match.toolName)) {
                const sid = req.session_id;
                if (sid) fetchSessionFiles(sid).then((files) => useFileStore.getState().setFiles(files)).catch(() => {});
              }
            } else {
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
                  setSubagentPollingSessionId((prev: string | null) => (prev === pollingSid ? prev : pollingSid));
                }
              } catch {
                // ignore non-JSON outputs
              }
            }

            setActiveToolCalls([...collectedToolCalls]);
            break;
          }
          case 'response.todo.updated':
            // Handled by processPlanEvent → planStore
            updateOrAddTodo(event.todo);
            break;
          case 'response.output_text.abandoned': {
            clearStreamingText();
            break;
          }
        }
      });

      clearStreamingText();
      previousResponseIdRef.current = finalResponse.id;
      const newSessionId = finalResponse.metadata?.session_id || currentSessionId || '';
      const isNewSession = !currentSessionId && !!newSessionId;

      if (finalResponse.status === 'incomplete') {
        const toolCalls = (finalResponse.output ?? []).filter(isToolCall);
        if (toolCalls.length > 0) {
          const assistantText = (finalResponse.output ?? [])
            .filter(isMessageItem)
            .filter((m) => m.role === 'assistant')
            .map(extractTextFromItem)
            .join('');
          if (assistantText) {
            addMessage({ role: 'assistant', content: assistantText });
          }

          const toolResults = await processClientToolCalls(
            toolCalls,
            allMessages,
            newSessionId,
            collectedToolCalls,
          );

          for (const tc of collectedToolCalls) {
            addMessage({ role: 'assistant', content: '', toolCall: tc });
          }

          if (toolResults === null) {
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

          const followUpMessages: Message[] = [...allMessages];
          if (assistantText) {
            followUpMessages.push({ role: 'assistant', content: assistantText });
          }

          setActiveToolCalls([]);
          setSessionId(newSessionId);
          setCwd(getSessionCwd());

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

      for (const tc of collectedToolCalls) {
        addMessage({ role: 'assistant', content: '', toolCall: tc });
      }
      setActiveToolCalls([]);
      setCwd(getSessionCwd());

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
      if (assistantOutput && !flushedStreamingText) {
        addMessage({
          role: 'assistant',
          content: assistantOutput,
          cost: finalResponse.usage?.total_cost,
        });
      }

      // Finalize plan: mark non-failed tasks as completed
      finalizePlan();

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
  }, [addMessage, appendStreamDelta, clearStreamingText, setLoading, setSessionId, setCwd, sessionId, loadSessions, setSessions, setSubagentPollingSessionId, checkAndLogPermission, handleQuestionRequired, handleCwdSelectRequired, updateOrAddTodo]);
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
      // tool_approval
      if (tc.name === 'tool_approval') {
        const approvalArgs = JSON.parse(tc.arguments);
        const toolName = approvalArgs.tool_name || 'tool';
        const displayName = tc.display_name || toolName;
        const decision = await checkAndLogPermission(clientId, toolName, displayName, toolName, tc.call_id, currentSessionId);
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

      // ask_question
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

      // select_cwd
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

      // coding tools
      if (CODING_TOOL_NAMES.has(tc.name)) {
        if (!canExecuteTools()) {
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: Desktop app required for file operations.' });
          continue;
        }
        if (!getSessionCwd()) {
          const cwdResult = await window.api!.selectCwd();
          if (cwdResult.path) {
            setSessionCwd(cwdResult.path);
            setCwd(cwdResult.path);
          } else {
            results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Error: No working directory set. User declined folder selection.' });
            continue;
          }
        }
        const codingArgs = JSON.parse(tc.arguments);
        const codingDisplay = `${tc.name}: ${JSON.stringify(codingArgs).substring(0, 100)}`;

        const decision = await checkAndLogPermission(clientId, tc.name, codingDisplay, tc.name, tc.call_id, currentSessionId);
        if (decision === 'deny') {
          const denyMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
          if (denyMatch) { denyMatch.status = 'failed'; denyMatch.output = 'Permission denied'; }
          setActiveToolCalls([...collectedToolCalls]);
          results.push({ type: 'function_call_output', call_id: tc.call_id, output: 'Permission denied: user rejected tool execution.' });
          continue;
        }

        const codingResult = await window.api!.codingTool(tc.name, codingArgs, getSessionCwd()!);
        const codingOutput = codingResult.success
          ? codingResult.output
          : `Error: ${codingResult.output || 'Coding tool execution failed'}`;
        const cMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
        if (cMatch) {
          cMatch.status = codingResult.success ? 'completed' : 'failed';
          cMatch.output = codingOutput || '(no output)';
          cMatch.exitCode = codingResult.success ? 0 : 1;
        }
        setActiveToolCalls([...collectedToolCalls]);
        results.push({ type: 'function_call_output', call_id: tc.call_id, output: codingOutput || '(no output)' });

        if (codingResult.success && FILE_MUTATION_TOOLS.has(tc.name)) {
          const sid = currentSessionId;
          if (sid) fetchSessionFiles(sid).then((files) => useFileStore.getState().setFiles(files)).catch(() => {});
        }
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

      // Fallback for unknown tools
      const fallbackMatch = collectedToolCalls.find(t => t.callId === tc.call_id);
      if (fallbackMatch) { fallbackMatch.status = 'failed'; }
      setActiveToolCalls([...collectedToolCalls]);
      results.push({ type: 'function_call_output', call_id: tc.call_id, output: `Error: Client tool ${tc.name} not implemented.` });
    }

    return results;
  }, [checkAndLogPermission, handleQuestionRequired, handleCwdSelectRequired, setCwd]);

  const handleSend = useCallback((input: string, setInput: (v: string) => void, textareaRef: React.RefObject<HTMLTextAreaElement | null>) => {
    if (!input.trim() || isLoading) return;
    const content = input.trim();
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    if (!sessionId) previousResponseIdRef.current = null;
    const userMessage: Message = { role: 'user', content };
    addMessage(userMessage);
    handleStreamingSend([...messages, userMessage], sessionId);
  }, [isLoading, addMessage, handleStreamingSend, messages, sessionId]);

  const handleSuggestionClick = useCallback((text: string) => {
    if (isLoading) return;
    const userMessage: Message = { role: 'user', content: text };
    addMessage(userMessage);
    handleStreamingSend([...messages, userMessage], sessionId);
  }, [isLoading, addMessage, handleStreamingSend, messages, sessionId]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>, input: string, setInput: (v: string) => void, textareaRef: React.RefObject<HTMLTextAreaElement | null>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(input, setInput, textareaRef);
    }
  }, [handleSend]);

  return {
    activeToolCalls,
    error,
    handleSend,
    handleSuggestionClick,
    handleKeyDown,
    handleStreamingSendRef,
  };
}
