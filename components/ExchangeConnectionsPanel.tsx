'use client';

import { useState } from 'react';
import { useExchangeAccounts } from './ExchangeAccounts';
import type { TradingExchangeId } from '@/lib/exchangeClients/types';

const EXCHANGE_LABELS: Record<TradingExchangeId, string> = { binance: 'Binance', bybit: 'Bybit' };

function ExchangeCard({ exchange }: { exchange: TradingExchangeId }) {
  const { connections, setCredentials, testConnection } = useExchangeAccounts();
  const conn = connections[exchange];
  const [showSecret, setShowSecret] = useState(false);

  const statusColor = conn.status === 'connected' ? 'text-green' : conn.status === 'error' ? 'text-red' : conn.status === 'checking' ? 'text-amber' : 'text-txt2';
  const statusLabel = conn.status === 'connected' ? 'Connected' : conn.status === 'error' ? 'Error' : conn.status === 'checking' ? 'Checking…' : 'Not connected';

  return (
    <div className="rounded-md border border-line bg-bg2 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[12px] font-semibold text-txt0">{EXCHANGE_LABELS[exchange]}</span>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: conn.status === 'connected' ? 'var(--green)' : conn.status === 'error' ? 'var(--red)' : conn.status === 'checking' ? 'var(--amber)' : 'var(--txt-2)' }} />
          <span className={`text-[10px] font-mono ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-[10px] font-mono text-txt2">
        API Key
        <input
          type="text"
          value={conn.credentials.apiKey}
          onChange={(e) => setCredentials(exchange, { apiKey: e.target.value })}
          placeholder={`${EXCHANGE_LABELS[exchange]} API key`}
          className="bg-bg1 border border-line rounded px-2 py-1 text-[11px] font-mono text-txt0"
          autoComplete="off"
        />
      </label>

      <label className="flex flex-col gap-1 text-[10px] font-mono text-txt2">
        API Secret
        <div className="flex gap-1">
          <input
            type={showSecret ? 'text' : 'password'}
            value={conn.credentials.apiSecret}
            onChange={(e) => setCredentials(exchange, { apiSecret: e.target.value })}
            placeholder={`${EXCHANGE_LABELS[exchange]} API secret`}
            className="flex-1 bg-bg1 border border-line rounded px-2 py-1 text-[11px] font-mono text-txt0"
            autoComplete="off"
          />
          <button onClick={() => setShowSecret(!showSecret)} className="px-2 text-[10px] font-mono text-txt2 hover:text-txt0 border border-line rounded">
            {showSecret ? 'hide' : 'show'}
          </button>
        </div>
      </label>

      <label className="flex items-center gap-2 text-[10.5px] font-mono text-txt2">
        <input type="checkbox" checked={conn.credentials.testnet} onChange={(e) => setCredentials(exchange, { testnet: e.target.checked })} />
        Testnet (recommended until you've verified this end to end)
      </label>

      <button
        onClick={() => testConnection(exchange)}
        disabled={conn.status === 'checking'}
        className="px-2 py-1.5 rounded-md text-[11px] font-mono border border-line bg-bg1 text-txt0 hover:bg-bg3 transition disabled:opacity-50"
      >
        {conn.status === 'checking' ? 'Connecting…' : 'Connect / Test'}
      </button>

      {conn.status === 'error' && conn.lastError && <p className="text-[10px] font-mono text-red">{conn.lastError}</p>}

      {conn.status === 'connected' && (
        <div className="flex flex-col gap-0.5 pt-1 border-t border-line">
          <p className="text-[9.5px] font-mono text-txt2 uppercase tracking-wider">
            {conn.credentials.testnet ? 'Testnet' : 'LIVE MAINNET'} balances
          </p>
          {conn.balances.length === 0 ? (
            <p className="text-[10px] text-txt2">No non-zero balances.</p>
          ) : (
            conn.balances.slice(0, 6).map((b) => (
              <div key={b.asset} className="flex justify-between text-[10.5px] font-mono">
                <span className="text-txt2">{b.asset}</span>
                <span className="text-txt0">{(b.free + b.locked).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ExchangeConnectionsPanel() {
  const { connections, realTradingMode, setRealTradingMode, preferredExchange, setPreferredExchange } = useExchangeAccounts();
  const anyLiveConnected = (['binance', 'bybit'] as TradingExchangeId[]).some((ex) => connections[ex].status === 'connected' && !connections[ex].credentials.testnet);
  const anyConnected = (['binance', 'bybit'] as TradingExchangeId[]).some((ex) => connections[ex].status === 'connected');

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10.5px] text-txt2">
        Spot trading only — not futures/margin. Connecting an exchange here lets the Supervisor place REAL orders on your
        actual account instead of just tracking a manual ledger. API keys are stored in this browser's local storage only,
        never sent anywhere except this app's own server (which signs and forwards the request) — same trust model as this
        app's LLM provider keys. Use a trading-only key with withdrawals disabled.
      </p>

      <div className="grid grid-cols-1 gap-2">
        <ExchangeCard exchange="binance" />
        <ExchangeCard exchange="bybit" />
      </div>

      <div className="border-t border-line pt-2 flex flex-col gap-2">
        <label className="text-[10px] font-mono text-txt2">Preferred exchange for real trades</label>
        <select
          value={preferredExchange ?? ''}
          onChange={(e) => setPreferredExchange(e.target.value === '' ? null : (e.target.value as TradingExchangeId))}
          className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-[11px] font-mono text-txt0"
        >
          <option value="">None selected — real trades will be rejected until you pick one</option>
          <option value="binance">Binance</option>
          <option value="bybit">Bybit</option>
        </select>

        <label className="text-[10px] font-mono text-txt2 mt-1">Real Trading Mode</label>
        <div className="flex gap-2">
          <button
            onClick={() => setRealTradingMode('manual')}
            className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-mono border transition ${realTradingMode === 'manual' ? 'border-amber text-amber bg-amber/10' : 'border-line text-txt2 hover:bg-bg3'}`}
          >
            Manual approval
          </button>
          <button
            onClick={() => setRealTradingMode('automatic')}
            className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-mono border transition ${realTradingMode === 'automatic' ? 'border-red text-red bg-red/10' : 'border-line text-txt2 hover:bg-bg3'}`}
          >
            Automatic
          </button>
        </div>
        <p className="text-[9.5px] text-txt2">
          Manual: every real-money BUY is queued in Trading Controls for you to Approve/Reject, regardless of the approval
          threshold there. Sells/closes are never gated — same "never block an exit" principle this app applies everywhere
          else, which matters more, not less, for real money. Automatic: real buys execute the moment they pass risk checks,
          same as paper trading today — subject only to Trading Controls' pause toggle and approval threshold (if set).
        </p>

        {realTradingMode === 'automatic' && anyLiveConnected && (
          <p className="text-[10.5px] font-mono text-red bg-red/10 border border-red/40 rounded px-2 py-1.5">
            ⚠ Automatic mode + a connected LIVE mainnet account: real orders will execute with real funds with no click
            required, the moment the Agent or a trade decision approves one. Switch to Manual if you haven't watched this
            behave correctly on testnet first.
          </p>
        )}
        {!anyConnected && (
          <p className="text-[10.5px] text-txt2">No exchange connected yet — real trades fall back to the existing manual ledger (no order is actually placed) until you connect one above.</p>
        )}
      </div>
    </div>
  );
}
