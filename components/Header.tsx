'use client';

import { Icon } from './Icon';
import { useAppState } from './AppState';
import { ExportMenu } from './ExportMenu';
import { AgentLivePnlBadge } from './AgentLivePnlBadge';

export function Header({
  onToggleSidebar,
  onToggleRight,
  onOpenSettings,
  onOpenMcp,
  onOpenSearch,
}: {
  onToggleSidebar: () => void;
  onToggleRight: () => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
  onOpenSearch: () => void;
}) {
  const { activeProvider, resolvedModel, hasKey } = useAppState();

  return (
    <header className="flex items-center gap-3 px-4 h-14 shrink-0 z-40 relative" style={{ background: 'rgba(5, 5, 7, 0.4)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', borderBottom: '1px solid rgba(0, 240, 255, 0.1)', boxShadow: '0 4px 30px rgba(0, 0, 0, 0.5)' }}>
      <button onClick={onToggleSidebar} className="p-1.5 rounded-md hover:bg-white/5 transition text-txt1 hover:text-cyan">
        <Icon name="menu" size={18} />
      </button>
      <div className="flex items-center gap-2 font-mono">
        <span className="pulse text-amber">●</span>
        <span className="font-bold tracking-widest text-sm text-txt0 animate-pulse-slow drop-shadow-[0_0_8px_rgba(0,240,255,0.8)]">
          QUANT<span className="text-cyan">//</span>
        </span>
        <span className="hidden md:inline text-xs text-txt2">AI TRADING WORKSTATION</span>
      </div>
      <div className="flex-1" />
      <AgentLivePnlBadge />
      <button
        onClick={onOpenSearch}
        className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono transition glass-input text-txt1 hover:text-txt0"
      >
        <Icon name="search" size={14} /> Search
        <kbd className="ml-1 px-1 rounded text-[10px] bg-white/10 text-cyan">⌘K</kbd>
      </button>
      <button
        onClick={onOpenSettings}
        className="flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-md text-xs font-mono glass-input text-txt0 hover:text-cyan transition"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: hasKey ? 'var(--green)' : 'var(--red)' }} />
        <span className="hidden sm:inline">
          {activeProvider.name} · {resolvedModel || '—'}
        </span>
      </button>
      <ExportMenu />
      <button onClick={onOpenMcp} className="p-2 rounded-md transition hover:bg-white/5 text-txt1 hover:text-cyan" title="MCP Bridges">
        <Icon name="plug" size={18} />
      </button>
      <button onClick={onOpenSettings} className="p-2 rounded-md transition hover:bg-white/5 text-txt1 hover:text-cyan" title="Settings">
        <Icon name="settings" size={18} />
      </button>
      <button onClick={onToggleRight} className="p-1.5 rounded-md hover:bg-white/5 text-txt1 hover:text-cyan" title="Trading panel">
        <Icon name="terminal" size={18} />
      </button>
    </header>
  );
}
