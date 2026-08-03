import type { Config, Conversation, McpServer, PortfolioState, TradeLogEntry, WatchItem } from './types';

export function downloadBlob(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function conversationToMarkdown(conv: Conversation): string {
  const lines = [`# ${conv.title || 'Conversation'}`, ''];
  conv.messages.forEach((m) => {
    lines.push(`**${m.role === 'user' ? 'You' : 'QUANT//'}** — ${new Date(m.ts).toLocaleString()}`, '', m.content, '', '---', '');
  });
  return lines.join('\n');
}

function slug(title: string): string {
  return (title || 'chat').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
}

export function exportConversationMarkdown(conv: Conversation) {
  downloadBlob(`${slug(conv.title)}.md`, 'text/markdown', conversationToMarkdown(conv));
}

export function exportConversationJSON(conv: Conversation) {
  downloadBlob(`${slug(conv.title)}.json`, 'application/json', JSON.stringify(conv, null, 2));
}

export type BackupFile = {
  exportedAt: string;
  config: Omit<Config, 'apiKeys'>;
  conversations: Conversation[];
  watchlist: WatchItem[];
  portfolio: PortfolioState;
  tradeLog: TradeLogEntry[];
  mcpServers: McpServer[];
};

export function buildBackup(
  config: Config,
  conversations: Conversation[],
  watchlist: WatchItem[],
  portfolio: PortfolioState,
  tradeLog: TradeLogEntry[],
  mcpServers: McpServer[],
): BackupFile {
  // API keys are deliberately excluded — a backup file is something people
  // might paste into chat, attach to a support request, or drop in a
  // shared drive without thinking about it the way they would a password.
  const { apiKeys: _apiKeys, ...configWithoutKeys } = config;
  return { exportedAt: new Date().toISOString(), config: configWithoutKeys, conversations, watchlist, portfolio, tradeLog, mcpServers };
}

export function exportFullBackup(backup: BackupFile) {
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(`quant-terminal-backup-${date}.json`, 'application/json', JSON.stringify(backup, null, 2));
}
