'use client';

// ---------------------------------------------------------------------
// Right-docked chat drawer. Shares message state with `/chat` — which the brief
// requires — by reading `useAppState()` rather than holding its own store.
//
// WHY REUSE `AppState` INSTEAD OF A NEW CHAT STORE
//
// `components/AppState.tsx` already owns conversations, the input buffer, the
// streaming flag, `sendMessage`, provider/model/key resolution and the
// natural-language trade path that routes through the Supervisor gate. A second
// store would duplicate all of that and — worse — could disagree with it about
// whether a message had been sent, which for a surface that can trigger a trade
// action is not an acceptable ambiguity.
//
// `AppShell` renders inside `AppStateProvider` (see `app/layout.tsx`: children
// sit below it), so `useAppState()` resolves here. That ordering is load-bearing
// and documented in CLAUDE.md; this component must not be hoisted above it.
//
// THE KEY IS THE USER'S. `/api/chat` is a proxy that requires an `apiKey` in the
// request body — the backend's own LLM provider is `null`/unavailable, so there
// is no server-side fallback. With no key configured this says so instead of
// appearing to work.
// ---------------------------------------------------------------------

import { useEffect, useRef } from 'react';

import { useAppState } from '@/components/AppState';

const SUGGESTIONS = [
  'What is the agent doing right now?',
  'Why did it not trade BTC in the last cycle?',
  'Summarise the open positions and their risk',
  'Which specialists are unavailable and why?',
];

export function CommandDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeConv, input, setInput, streaming, sendMessage, hasKey, lastError } = useAppState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = activeConv?.messages ?? [];

  // Pin to the newest message as it streams. Guarded on `open` so a closed
  // drawer does not fight the page for scroll position.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, messages.length, streaming]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={`fixed top-0 right-0 h-full w-[420px] max-w-full z-40 border-l hairline flex flex-col transition-transform duration-200${
        open ? '' : ' translate-x-full'
      }`}
      style={{ background: 'var(--bg-surface)' }}
      aria-hidden={!open}
    >
      <div className="h-12 flex items-center justify-between px-4 border-b hairline shrink-0">
        <div className="text-[12.5px] font-semibold">Command Center</div>
        <button type="button" className="chip" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 text-[12.5px]">
        {!hasKey ? (
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            No API key configured. The chat route proxies to your provider with a key you
            supply — the backend has no LLM provider of its own, so there is nothing to
            fall back to. Add a key in <span style={{ color: 'var(--text-secondary)' }}>Settings</span>.
          </div>
        ) : messages.length === 0 ? (
          <div className="space-y-2">
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Ask about the agent&apos;s current state, a decision, or a position.
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip text-left"
                  onClick={() => void sendMessage(s)}
                  disabled={streaming}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {m.role !== 'user' ? (
                <div
                  className="avatar shrink-0"
                  style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)' }}
                >
                  A
                </div>
              ) : null}
              <div className={`bubble ${m.role === 'user' ? 'user' : 'assistant'} whitespace-pre-wrap`}>
                {m.content}
              </div>
            </div>
          ))
        )}

        {lastError ? (
          <div className="text-[11.5px]" style={{ color: 'var(--negative)' }} role="alert">
            {lastError}
          </div>
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
            className="flex-1 px-2.5 py-2 text-[12.5px] rounded"
          />
          <button
            type="button"
            className="chip btn-accent"
            onClick={() => void sendMessage()}
            disabled={!hasKey || streaming || input.trim().length === 0}
          >
            {streaming ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
