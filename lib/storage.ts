export const LS_KEYS = {
  config: 'qt_config_v2',
  conversations: 'qt_conversations',
  mcp: 'qt_mcp_v2',
  watchlist: 'qt_watchlist_v2',
  portfolio: 'qt_portfolio_v2',
  tradeLog: 'qt_tradelog_v1',
  pvHistory: 'qt_pv_history_v1',
  tradingControls: 'qt_trading_controls_v1',
  sidebarGroups: 'qt_sidebar_groups_v1',
  exchangeAccounts: 'qt_exchange_accounts_v1',
} as const;

export function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLS<T>(key: string, val: T): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* storage full or unavailable — ignore, matches original app's behavior */
  }
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
