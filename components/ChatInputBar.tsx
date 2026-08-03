'use client';

import { useRef } from 'react';
import { Icon } from './Icon';
import { useAppState } from './AppState';

export function ChatInputBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { input, setInput, streaming, sendMessage, stopGenerating, regenerate, activeConv, activeProvider, resolvedModel, hasKey } =
    useAppState();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const contextChars = (activeConv?.messages ?? []).reduce((n, m) => n + m.content.length, 0);
  const contextTokensApprox = Math.round(contextChars / 4);
  const canRegenerate = !!activeConv && activeConv.messages.length > 0 && !streaming;

  return (
    <div className="border-t shrink-0 border-line bg-bg1">
      <div className="max-w-3xl mx-auto px-4 pt-3">
        <div className="flex items-end gap-2 rounded-lg border px-3 py-2 border-line bg-bg2">
          <button
            onClick={onOpenSettings}
            title="Active model — click to change in Settings"
            className="shrink-0 flex items-center gap-1.5 mb-1 px-2 py-1 rounded-full text-[10px] font-mono border transition hover:bg-bg3 border-line bg-bg3 text-txt1"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: hasKey ? 'var(--green)' : 'var(--red)' }} />
            <span className="max-w-[130px] truncate">
              {activeProvider.name} · {resolvedModel || '—'}
            </span>
          </button>

          <textarea
            id="chat-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={hasKey ? 'Ask anything, or mention @papertrade / @real to log a trade from the conversation…' : 'Set an API key in Settings to start chatting…'}
            className="flex-1 resize-none bg-transparent text-sm py-1.5 outline-none border-none max-h-40 text-txt0 placeholder:text-txt2"
          />

          {streaming ? (
            <button onClick={stopGenerating} className="p-2.5 rounded-md transition bg-red text-black" title="Stop">
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim()}
              className="p-2.5 rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed bg-amber text-black"
              title="Send (Enter)"
            >
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="max-w-3xl mx-auto px-4 py-2 flex items-center justify-between text-[10px] font-mono text-txt2">
        <span>Context ~{(contextTokensApprox / 1000).toFixed(1)}k / 128k</span>
        <div className="flex items-center gap-3">
          {canRegenerate && (
            <button onClick={regenerate} className="flex items-center gap-1 hover:text-txt0 transition">
              <Icon name="refresh" size={11} /> regenerate
            </button>
          )}
          <span>Shift+Enter for newline</span>
        </div>
      </div>
    </div>
  );
}
