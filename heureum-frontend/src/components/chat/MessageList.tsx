// Copyright (c) 2026 Heureum AI. All rights reserved.

import type { Message, ToolCallInfo } from '../../types';
import { usePlanStore } from '../../store/planStore';
import HeureumIcon from '../HeureumIcon';
import MarkdownMessage from '../MarkdownMessage';
import TodoProgressPanel from '../TodoProgressPanel';
import ToolBlock from './ToolBlock';
import PeriodicRunCard from './PeriodicRunCard';
import { formatCost } from './helpers';

interface MessageListProps {
  messages: Message[];
  activeToolCalls: ToolCallInfo[];
  streamingText: string;
  isLoading: boolean;
  isLoadingOlder: boolean;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  endRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}

export default function MessageList({
  messages,
  activeToolCalls,
  streamingText,
  isLoading,
  isLoadingOlder,
  messagesContainerRef,
  endRef,
  onScroll,
}: MessageListProps) {
  const hasPlan = usePlanStore((state) => state.plan !== null || state.history.length > 0);
  const hasActivePlan = usePlanStore((state) => state.plan !== null && !state.plan.finalized);
  const hasTodoMarker = messages.some((m) => m.todo);
  let todoRendered = false;
  let pastTodo = false;

  const renderMessage = (msg: Message, i: number) => {
    if (msg.periodicRun) {
      return (
        <div key={i} className="ac-msg-row ac-msg-periodic-run">
          <PeriodicRunCard run={msg.periodicRun} />
        </div>
      );
    }
    if (msg.todo) {
      pastTodo = true;
      if (!hasPlan || todoRendered) return null;
      todoRendered = true;
      return (
        <div key={i} className="ac-msg-row ac-msg-todo">
          <TodoProgressPanel />
        </div>
      );
    }
    if (msg.subagentProgress) return null;
    if (msg.toolCall) {
      if (hasActivePlan && pastTodo) return null;
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
    <div className="ac-messages" ref={messagesContainerRef} onScroll={onScroll}>
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
        {!hasActivePlan && activeToolCalls.map((tc, i) => (
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
        {hasPlan && !hasTodoMarker && (
          <div className="ac-msg-row ac-msg-todo">
            <TodoProgressPanel />
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
