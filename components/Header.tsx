'use client';

import { Icon } from './Icon';
import { useAppState } from './AppState';
import { ExportMenu } from './ExportMenu';

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
    <header className="flex items-center gap-3 px-4 h-14 border-b shrink-0 border-line bg-bg1 header-glow">
      <button onClick={onToggleSidebar} className="p-1.5 rounded-md hover:bg-bg3 transition text-txt1">
        <Icon name="menu" size={18} />
      </button>
      <div className="flex items-center gap-2 font-mono">
        <span className="pulse text-amber">●</span>
        <span className="font-bold tracking-widest text-sm text-txt0">
          QUANT<span className="text-amber">//</span>
        </span>
        <span className="hidden md:inline text-xs text-txt2">AI TRADING WORKSTATION</span>
      </div>
      <div className="flex-1" />
      <button
        onClick={onOpenSearch}
        className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono border transition border-line text-txt1 bg-bg2 hover:bg-bg3"
      >
        <Icon name="search" size={14} /> Search
        <kbd className="ml-1 px-1 rounded text-[10px] bg-bg3">⌘K</kbd>
      </button>
      <button
        onClick={onOpenSettings}
        className="flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-md text-xs font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: hasKey ? 'var(--green)' : 'var(--red)' }} />
        <span className="hidden sm:inline">
          {activeProvider.name} · {resolvedModel || '—'}
        </span>
      </button>
      <ExportMenu />
      <button onClick={onOpenMcp} className="p-2 rounded-md transition hover:bg-bg3 text-txt1" title="MCP Bridges">
        <Icon name="plug" size={18} />
      </button>
      <button onClick={onOpenSettings} className="p-2 rounded-md transition hover:bg-bg3 text-txt1" title="Settings">
        <Icon name="settings" size={18} />
      </button>
      <button onClick={onToggleRight} className="p-1.5 rounded-md hover:bg-bg3 text-txt1" title="Trading panel">
        <Icon name="terminal" size={18} />
      </button>
    </header>
  );
}
