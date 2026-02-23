// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useChatStore } from '../store/chatStore';
import {
  checkPermission,
  setPermission,
  logPermissionDecision,
  setExtensionConnected as setApiExtensionConnected,
} from '../lib/api';
import type {
  PermissionRequest,
  PermissionDecision,
  QuestionRequest,
  QuestionAnswer,
} from '../types';

function canExecuteTools(): boolean {
  return typeof window !== 'undefined' && window.api?.canExecuteTools === true;
}

export function usePromptSystem() {
  const { addMessage } = useChatStore();

  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const permissionResolveRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const questionResolveRef = useRef<((answer: QuestionAnswer) => void) | null>(null);
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [pendingCwdSelect, setPendingCwdSelect] = useState(false);
  const cwdSelectResolveRef = useRef<((proceed: boolean) => void) | null>(null);

  const hasPrompt = !!(pendingPermission || pendingQuestion || pendingCwdSelect);

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

  return {
    pendingPermission,
    pendingQuestion,
    pendingCwdSelect,
    hasPrompt,
    extensionConnected,
    handlePermissionRequired,
    handlePermissionDecision,
    handlePermissionCancel,
    handleQuestionRequired,
    handleQuestionAnswer,
    handleQuestionCancel,
    handleCwdSelectRequired,
    handleCwdSelectDecision,
    checkAndLogPermission,
  };
}
