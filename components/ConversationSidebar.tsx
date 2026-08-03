'use client';

import { Icon } from './Icon';
import { useAppState } from './AppState';

export function ConversationSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { conversations, activeId, newConversation, selectConversation, deleteConversation } = useAppState();

  return (
    <aside className="w-64 max-w-[85vw] h-full shrink-0 border-r flex flex-col border-line bg-bg1">
      <div className="p-3 flex items-center gap-2">
        <button
          onClick={() => {
            newConversation();
            onNavigate?.();
          }}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-semibold font-mono transition hover:opacity-90 bg-amber text-black"
        >
          <Icon name="plus" size={14} /> New Chat
        </button>
        {onNavigate && (
          <button onClick={onNavigate} className="md:hidden p-2 rounded-md hover:bg-bg3 text-txt1">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 flex flex-col gap-1">
        {conversations.length === 0 && (
          <p className="text-xs px-2 py-4 text-center text-txt2">No conversations yet — start one above.</p>
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            onClick={() => {
              selectConversation(c.id);
              onNavigate?.();
            }}
            className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-pointer transition ${
              c.id === activeId ? 'bg-bg3 text-txt0' : 'text-txt1 hover:bg-bg2'
            }`}
          >
            <span className="truncate flex-1">{c.title || 'New chat'}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteConversation(c.id);
              }}
              className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:text-red text-txt2"
              title="Delete"
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="p-3 border-t text-[10px] font-mono flex items-center gap-1.5 border-line text-txt2">
        <Icon name="shield" size={12} /> Local-only. No server DB.
      </div>
    </aside>
  );
}
