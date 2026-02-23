// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import HeureumIcon from '../HeureumIcon';
import ThemeToggle from '../ThemeToggle';
import { PanelIcon, PlusIcon, LogOutIcon, SettingsIcon, ClockIcon } from './icons';
import { timeAgo, formatCost } from './helpers';
import type { SessionListItem } from '../../types';

interface SidebarProps {
  sidebarExpanded: boolean;
  setSidebarExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  sessions: SessionListItem[];
  sessionsLoading: boolean;
  sessionId: string | null;
  deletingId: string | null;
  onNewChat: () => void;
  onSelectSession: (session: SessionListItem) => void;
  onDeleteSession: (e: React.MouseEvent, sid: string) => void;
}

export default function Sidebar({
  sidebarExpanded,
  setSidebarExpanded,
  sessions,
  sessionsLoading,
  sessionId,
  deletingId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
}: SidebarProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const userInitial = user?.first_name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || '?';

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

  const handleLogout = async () => { await logout(); navigate('/'); };

  return (
    <>
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
          <button className="ac-sb-toggle" onClick={() => setSidebarExpanded((v: boolean) => !v)} title={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}>
            <PanelIcon />
          </button>
        </div>

        <div className="ac-sb-nav">
          <button className="ac-sb-nav-item" onClick={onNewChat}>
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
                  onClick={() => onSelectSession(s)}
                >
                  <div className="ac-sb-session-title">
                    {s.has_periodic_task && <span className="ac-sb-session-periodic" title="Has scheduled task">&#x23F1;</span>}
                    {s.title || 'Untitled Chat'}
                  </div>
                  <div className="ac-sb-session-meta">
                    <span>{timeAgo(s.updated_at)}</span>
                    {parseFloat(String(s.total_cost)) > 0 && <span className="ac-sb-session-cost">{formatCost(s.total_cost)}</span>}
                  </div>
                  <button
                    className="ac-sb-session-delete"
                    onClick={(e) => onDeleteSession(e, s.session_id)}
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
    </>
  );
}
