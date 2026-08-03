'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { loadLS, saveLS, LS_KEYS } from '@/lib/storage';
import type { TradingExchangeId, ExchangeCredentials, ExchangeBalance, PlaceOrderParams, OrderResult, OrderStatusResult } from '@/lib/exchangeClients/types';

// ---------------------------------------------------------------------
// Real Exchange Trading (Binance + Bybit, SPOT only — see
// lib/exchangeClients/types.ts's header for the scope note). Mounted
// above SupervisorProvider in app/layout.tsx, same reasoning as
// components/TradingControls.tsx: Supervisor.tsx needs to read
// credentials/mode and place real orders, and context only flows
// downward, so this has to sit above it in the tree, not below.
//
// SECURITY TRADEOFF, stated plainly rather than buried: API keys/secrets
// here are stored in browser localStorage, in plain text — the exact
// same trust model this app already uses for LLM provider keys
// (components/AppState.tsx's Config.apiKeys). That's a reasonable
// tradeoff for a single-user app that never leaves your own machine. It
// is NOT a reasonable tradeoff if you ever expose this app beyond
// localhost. Before pasting real exchange keys in here:
//   - Create a key with TRADING permission only — never enable
//     withdrawals on it. A stolen trading-only key can lose you money
//     through bad trades; a withdrawal-enabled key can lose you
//     everything in it, directly.
//   - Use your exchange's IP-allowlist feature if you run this from a
//     fixed IP.
//   - Prefer testnet keys while you're still verifying this works
//     correctly end to end.
// ---------------------------------------------------------------------

export type RealTradingMode = 'manual' | 'automatic';

export type ExchangeConnectionState = {
  credentials: ExchangeCredentials;
  status: 'idle' | 'checking' | 'connected' | 'error';
  lastError: string | null;
  balances: ExchangeBalance[];
  lastCheckedAt: number | null;
};

const DEFAULT_CREDS: ExchangeCredentials = { apiKey: '', apiSecret: '', testnet: true };

function defaultConnectionState(): ExchangeConnectionState {
  return { credentials: DEFAULT_CREDS, status: 'idle', lastError: null, balances: [], lastCheckedAt: null };
}

type PersistedShape = {
  binance: ExchangeCredentials;
  bybit: ExchangeCredentials;
  realTradingMode: RealTradingMode;
  preferredExchange: TradingExchangeId | null;
};

const DEFAULT_PERSISTED: PersistedShape = {
  binance: DEFAULT_CREDS,
  bybit: DEFAULT_CREDS,
  // Manual by default — automatic real-money execution is something you
  // opt into deliberately in Settings, never the out-of-the-box behavior.
  realTradingMode: 'manual',
  preferredExchange: null,
};

type ExchangeAccountsValue = {
  connections: Record<TradingExchangeId, ExchangeConnectionState>;
  realTradingMode: RealTradingMode;
  setRealTradingMode: (mode: RealTradingMode) => void;
  preferredExchange: TradingExchangeId | null;
  setPreferredExchange: (ex: TradingExchangeId | null) => void;
  setCredentials: (exchange: TradingExchangeId, partial: Partial<ExchangeCredentials>) => void;
  testConnection: (exchange: TradingExchangeId) => Promise<void>;
  isConnected: (exchange: TradingExchangeId) => boolean;
  placeRealOrder: (exchange: TradingExchangeId, params: PlaceOrderParams) => Promise<OrderResult>;
  getRealOrderStatus: (exchange: TradingExchangeId, symbol: string, exchangeOrderId: string) => Promise<OrderStatusResult>;
};

const ExchangeAccountsContext = createContext<ExchangeAccountsValue | null>(null);

export function useExchangeAccounts(): ExchangeAccountsValue {
  const ctx = useContext(ExchangeAccountsContext);
  if (!ctx) throw new Error('useExchangeAccounts must be used within ExchangeAccountsProvider');
  return ctx;
}

async function callExchangeApi(exchange: TradingExchangeId, creds: ExchangeCredentials, action: string, params?: Record<string, unknown>) {
  const res = await fetch('/api/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange, apiKey: creds.apiKey, apiSecret: creds.apiSecret, testnet: creds.testnet, action, params }),
  });
  return res.json();
}

export function ExchangeAccountsProvider({ children }: { children: React.ReactNode }) {
  const [persisted, setPersisted] = useState<PersistedShape>(DEFAULT_PERSISTED);
  const [hydrated, setHydrated] = useState(false);
  const [connections, setConnections] = useState<Record<TradingExchangeId, ExchangeConnectionState>>({
    binance: defaultConnectionState(),
    bybit: defaultConnectionState(),
  });

  useEffect(() => {
    const loaded = loadLS(LS_KEYS.exchangeAccounts, DEFAULT_PERSISTED);
    setPersisted(loaded);
    setConnections({
      binance: { ...defaultConnectionState(), credentials: loaded.binance },
      bybit: { ...defaultConnectionState(), credentials: loaded.bybit },
    });
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLS(LS_KEYS.exchangeAccounts, persisted);
  }, [persisted, hydrated]);

  function setCredentials(exchange: TradingExchangeId, partial: Partial<ExchangeCredentials>) {
    setConnections((prev) => ({
      ...prev,
      [exchange]: { ...defaultConnectionState(), credentials: { ...prev[exchange].credentials, ...partial } }, // changing credentials invalidates any prior connection status
    }));
    setPersisted((prev) => ({ ...prev, [exchange]: { ...prev[exchange], ...partial } }));
  }

  async function testConnection(exchange: TradingExchangeId) {
    const creds = connections[exchange].credentials;
    if (!creds.apiKey || !creds.apiSecret) {
      setConnections((prev) => ({ ...prev, [exchange]: { ...prev[exchange], status: 'error', lastError: 'API key and secret are both required.' } }));
      return;
    }
    setConnections((prev) => ({ ...prev, [exchange]: { ...prev[exchange], status: 'checking', lastError: null } }));
    const json = await callExchangeApi(exchange, creds, 'balance').catch((err) => ({ ok: false, error: err instanceof Error ? err.message : 'Request failed' }));
    if (json.ok) {
      setConnections((prev) => ({
        ...prev,
        [exchange]: { ...prev[exchange], status: 'connected', lastError: null, balances: json.snapshot?.balances ?? [], lastCheckedAt: Date.now() },
      }));
    } else {
      setConnections((prev) => ({ ...prev, [exchange]: { ...prev[exchange], status: 'error', lastError: json.error ?? 'Connection failed', lastCheckedAt: Date.now() } }));
    }
  }

  function isConnected(exchange: TradingExchangeId): boolean {
    return connections[exchange].status === 'connected';
  }

  async function placeRealOrder(exchange: TradingExchangeId, params: PlaceOrderParams): Promise<OrderResult> {
    const creds = connections[exchange].credentials;
    if (!creds.apiKey || !creds.apiSecret) return { ok: false, error: `No ${exchange} API credentials configured.` };
    try {
      const json = await callExchangeApi(exchange, creds, 'placeOrder', { symbol: params.symbol, side: params.side, qty: params.qty });
      return json as OrderResult;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Order request failed' };
    }
  }

  async function getRealOrderStatus(exchange: TradingExchangeId, symbol: string, exchangeOrderId: string): Promise<OrderStatusResult> {
    const creds = connections[exchange].credentials;
    try {
      const json = await callExchangeApi(exchange, creds, 'orderStatus', { symbol, exchangeOrderId });
      return json as OrderStatusResult;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Order status request failed' };
    }
  }

  const value: ExchangeAccountsValue = {
    connections,
    realTradingMode: persisted.realTradingMode,
    setRealTradingMode: (mode) => setPersisted((prev) => ({ ...prev, realTradingMode: mode })),
    preferredExchange: persisted.preferredExchange,
    setPreferredExchange: (ex) => setPersisted((prev) => ({ ...prev, preferredExchange: ex })),
    setCredentials,
    testConnection,
    isConnected,
    placeRealOrder,
    getRealOrderStatus,
  };

  return <ExchangeAccountsContext.Provider value={value}>{children}</ExchangeAccountsContext.Provider>;
}
