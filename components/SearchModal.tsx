'use client';

import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useAppState } from './AppState';

export function SearchModal({ onClose }: { onClose: () => void }) {
  const { conversations, selectConversation } = useAppState();
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations.slice(0, 20);
    return conversations
      .filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
      .slice(0, 20);
  }, [conversations, query]);

  function pick(id: string) {
    selectConversation(id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 p-4" style={{ background: 'rgba(4,5,7,0.75)' }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden rise border-line bg-bg1 card-shadow" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <Icon name="search" size={16} className="text-txt2" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="flex-1 bg-transparent border-none outline-none text-sm text-txt0 placeholder:text-txt2"
          />
          <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-bg3 text-txt2">Esc</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-txt2">No conversations match.</p>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                onClick={() => pick(c.id)}
                className="w-full text-left px-4 py-2.5 hover:bg-bg3 transition flex flex-col gap-0.5"
              >
                <span className="text-sm truncate text-txt0">{c.title || 'New chat'}</span>
                <span className="text-[10px] font-mono text-txt2">
                  {c.messages.length} messages · {new Date(c.updatedAt).toLocaleDateString()}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
