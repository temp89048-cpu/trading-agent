'use client';

import { Icon } from './Icon';
import { useAppState } from './AppState';

export function ConversationSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { conversations, activeId, newConversation, selectConversation, deleteConversation } = useAppState();

  return (
    <aside className="w-64 max-w-[85vw] h-full shrink-0 border-r flex flex-col border-line/30 glass-panel z-30">
      <div className="p-3 flex items-center gap-2">
        <button
          onClick={() => {
            newConversation();
            onNavigate?.();
          }}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-semibold font-mono transition bg-cyan/10 hover:bg-cyan/20 text-cyan border border-cyan/20 card-shadow hover-lift"
        >
          <Icon name="plus" size={14} /> New Session
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
            className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-pointer transition-all duration-200 ${
              c.id === activeId ? 'bg-cyan/10 text-cyan border border-cyan/20 shadow-[0_0_10px_rgba(0,240,255,0.1)]' : 'text-txt1 hover:bg-white/5 border border-transparent'
            }`}
          >
            <span className="truncate flex-1 font-mono text-xs">{c.title || 'New session'}</span>
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
      <div className="p-3 border-t text-[10px] font-mono flex items-center gap-1.5 border-line/30 text-txt2 bg-black/20">
        <Icon name="shield" size={12} className="text-green" /> Local OS Active
      </div>
    </aside>
  );
}
