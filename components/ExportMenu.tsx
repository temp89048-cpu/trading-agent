'use client';

import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { useAppState } from './AppState';
import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';
import { useMcp } from './Mcp';
import { buildBackup, exportConversationJSON, exportConversationMarkdown, exportFullBackup, type BackupFile } from '@/lib/exportImport';

export function ExportMenu() {
  const { activeConv, conversations, config, restoreConversations, restoreConfig } = useAppState();
  const { watchlist, setWatchlist } = useMarketData();
  const { portfolio, tradeLog, restorePortfolio, restoreTradeLog } = usePortfolio();
  const { servers, restoreServers } = useMcp();

  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function pick(fn: () => void) {
    fn();
    setOpen(false);
  }

  function doExportBackup() {
    const backup = buildBackup(config, conversations, watchlist, portfolio, tradeLog, servers);
    exportFullBackup(backup);
  }

  function importBackup(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as Partial<BackupFile>;
        if (Array.isArray(data.conversations)) restoreConversations(data.conversations);
        if (data.watchlist) setWatchlist(data.watchlist);
        if (data.portfolio) restorePortfolio(data.portfolio);
        if (data.tradeLog) restoreTradeLog(data.tradeLog);
        if (data.mcpServers) restoreServers(data.mcpServers);
        if (data.config) restoreConfig(data.config);
      } catch {
        alert('Could not read that backup file — is it a QUANT// export?');
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} title="Export / backup" className="p-2 rounded-md transition hover:bg-bg3 text-txt1">
        <Icon name="save" size={18} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-64 rounded-lg border shadow-2xl z-40 overflow-hidden border-line bg-bg2">
            <button
              disabled={!activeConv}
              onClick={() => activeConv && pick(() => exportConversationMarkdown(activeConv))}
              className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-bg3 disabled:opacity-40 text-txt0"
            >
              Export this chat — Markdown
            </button>
            <button
              disabled={!activeConv}
              onClick={() => activeConv && pick(() => exportConversationJSON(activeConv))}
              className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-bg3 disabled:opacity-40 text-txt0"
            >
              Export this chat — JSON
            </button>
            <div className="border-t border-line" />
            <button onClick={() => pick(doExportBackup)} className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-bg3 text-txt0">
              Export full backup (all chats, watchlist, portfolio)
            </button>
            <button onClick={() => fileRef.current?.click()} className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-bg3 text-txt0">
              Import backup…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importBackup(f);
                e.target.value = '';
                setOpen(false);
              }}
            />
            <p className="px-3 py-2 text-[10px] border-t border-line text-txt2">Backups never include API keys.</p>
          </div>
        </>
      )}
    </div>
  );
}
