'use client';

// ---------------------------------------------------------------------
// /chat — the full-page chat, sharing state with the Command Center drawer.
//
// Both read `useAppState()`, so a message sent in the drawer appears here and vice
// versa — the brief's requirement, met by reusing the existing store rather than
// adding a second one that could disagree about whether a message was sent.
//
// `AppState.sendMessage` is the same path the old terminal used, which means the
// natural-language trade action still routes through the Supervisor gate. That is
// why this page does not call `/api/chat` directly.
// ---------------------------------------------------------------------

import { useEffect, useRef } from 'react';

import { useAppState } from '@/components/AppState';
import { Card, NotAvailable, SectionTitle } from '@/components/ui/primitives';

const SUGGESTIONS = [
  'What is the agent doing right now?',
  'Why did it not trade in the last cycle?',
  'Summarise the open positions and their risk',
  'Which specialists are unavailable, and why?',
  'Explain the most recent decision',
];

export default function ChatPage() {
  const {
    conversations, activeConv, activeId, newConversation, selectConversation,
    input, setInput, streaming, sendMessage, hasKey, lastError,
  } = useAppState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = activeConv?.messages ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming]);

  return (
    <div className="flex gap-3 h-[calc(100vh-8rem)]">
      {/* ---- History rail ---- */}
      <div className="w-[220px] shrink-0 hidden lg:flex flex-col card p-0 overflow-hidden">
        <div className="p-3 border-b hairline shrink-0">
          <button type="button" className="chip btn-accent w-full" onClick={newConversation}>New chat</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {conversations.length === 0 ? (
            <div className="text-[11px] p-2" style={{ color: 'var(--text-muted)' }}>No conversations yet.</div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectConversation(c.id)}
                className="navlink w-full text-left px-2 py-1.5 rounded truncate border-l-2 border-transparent"
                style={c.id === activeId ? { background: 'var(--bg-surface-2)', color: 'var(--text-primary)' } : undefined}
              >
                {c.title || 'Untitled'}
              </button>
            ))
          )}
        </div>
      </div>

      {/* ---- Thread ---- */}
      <div className="flex-1 flex flex-col min-w-0 card p-0 overflow-hidden">
        <div className="h-11 flex items-center justify-between px-4 border-b hairline shrink-0">
          <span className="text-[12.5px] font-semibold">{activeConv?.title || 'Agent Chat'}</span>
          <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            shares state with the Command Center drawer
          </span>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {!hasKey ? (
            <NotAvailable
              what="Chat"
              reason={
                'no API key is configured. /api/chat proxies to your provider with a key you supply, ' +
                'and the backend has no LLM provider of its own — its resolver recognises only ' +
                '`null` — so there is no server-side fallback. Add a key in Settings.'
              }
            />
          ) : messages.length === 0 ? (
            <div className="space-y-3">
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Ask about the agent&apos;s state, a decision, or a position.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chip text-left" onClick={() => void sendMessage(s)} disabled={streaming}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
                {m.role !== 'user' ? (
                  <div className="avatar shrink-0" style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)' }}>A</div>
                ) : null}
                <div className={`bubble ${m.role === 'user' ? 'user' : 'assistant'} whitespace-pre-wrap`}>{m.content}</div>
              </div>
            ))
          )}

          {lastError ? (
            <div className="text-[11.5px]" style={{ color: 'var(--negative)' }} role="alert">{lastError}</div>
          ) : null}
        </div>

        <div className="p-3 border-t hairline shrink-0">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={hasKey ? 'Ask the agent…' : 'Add an API key in Settings'}
              disabled={!hasKey || streaming}
              className="flex-1 px-3 py-2 text-[13px] rounded"
            />
            <button type="button" className="chip btn-accent" onClick={() => void sendMessage()}
                    disabled={!hasKey || streaming || input.trim().length === 0}>
              {streaming ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
