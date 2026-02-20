// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchAllSessionMessages } from '../lib/api';
import type { Message, ToolCallInfo } from '../types';
import { getToolDisplay } from '../lib/tools';
import MarkdownMessage from '../components/MarkdownMessage';
import './ChatPage.css';

function ToolBlock({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = !!toolCall.output;
  const { action, detail } = getToolDisplay(toolCall);

  return (
    <div className={`ac-tool ac-tool-${toolCall.status}`}>
      <div className="ac-tool-dot" />
      <div className="ac-tool-content">
        <div className="ac-tool-header" onClick={() => hasOutput && setExpanded(!expanded)}>
          <span className="ac-tool-action">{action}</span>
          {detail && <span className="ac-tool-detail">{detail}</span>}
          {hasOutput && <span className={`ac-tool-chevron ${expanded ? 'expanded' : ''}`}>&#x25B6;</span>}
        </div>
        {expanded && toolCall.output && <pre className="ac-tool-output">{toolCall.output}</pre>}
      </div>
    </div>
  );
}

export default function ChatViewerPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    fetchAllSessionMessages(sessionId)
      .then(setMessages)
      .catch((e) => setError(e.message || 'Failed to load messages'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const renderMessage = (msg: Message, i: number) => {
    if (msg.periodicRun) {
      const executedAt = msg.periodicRun.executedAt
        ? new Date(msg.periodicRun.executedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
        : '';
      return (
        <div key={i} className="ac-msg-row ac-msg-periodic-run">
          <div className="ac-periodic-run-card">
            <div className="ac-periodic-run-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div className="ac-periodic-run-info">
              <span className="ac-periodic-run-title">{msg.periodicRun.taskTitle}</span>
              {executedAt && <span className="ac-periodic-run-time">{executedAt}</span>}
            </div>
          </div>
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
    if (!msg.content) return null;
    return (
      <div key={i} className={`ac-msg-row ${msg.role === 'user' ? 'ac-msg-user' : 'ac-msg-ai'}`}>
        <div className={`ac-bubble ${msg.role === 'user' ? 'ac-bubble-user' : 'ac-bubble-ai'}`}>
          {msg.role === 'assistant' ? <MarkdownMessage content={msg.content} /> : msg.content}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="ac-messages" style={{ height: '100vh' }}>
        <div className="ac-messages-inner">
          <div className="ac-empty">Loading...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ac-messages" style={{ height: '100vh' }}>
        <div className="ac-messages-inner">
          <div className="ac-empty">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="ac-messages" style={{ height: '100vh' }}>
      <div className="ac-messages-inner">
        {messages.length === 0 ? (
          <div className="ac-empty">No messages in this session.</div>
        ) : (
          messages.map(renderMessage)
        )}
      </div>
    </div>
  );
}
