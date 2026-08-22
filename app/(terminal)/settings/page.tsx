'use client';

// ---------------------------------------------------------------------
// /settings — runtime gates plus the client-side provider config.
//
// Two clearly separated halves, because they live in different places and have very
// different consequences:
//
//   BACKEND GATES are read-only here. LIVE_TRADING, GRAPH_EXECUTION_ENABLED and
//   POSITION_MONITORING_ENABLED are environment variables read at call time; there
//   is no endpoint that writes them, and there should not be — a browser toggle
//   that turned on real-money trading would be the single most dangerous control in
//   the app. They are shown with their live values and how to change them.
//
//   CLIENT CONFIG (provider, model, API key) lives in localStorage via AppState and
//   is genuinely editable, because the key is the user's and the chat proxy needs it.
// ---------------------------------------------------------------------

import { useAppState } from '@/components/AppState';
import { Badge } from '@/components/ui/Badge';
import { Card, NotAvailable, SectionTitle, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useBackend } from '@/lib/realtime/useRealtime';

export default function SettingsPage() {
  const { config, setConfig, activeProvider, resolvedModel, hasKey } = useAppState();
  const exchange = useBackend<Record<string, unknown>>(BACKEND_PATHS.exchangeStatus, { intervalMs: 30_000 });
  const admin = useBackend<{ isPaused?: boolean; emergencyStop?: boolean; auth?: { writeAuthEnabled?: boolean; note?: string } }>(
    BACKEND_PATHS.adminStatus, { intervalMs: 15_000 },
  );
  const polymarket = useBackend<{ enabled?: boolean; gateMeaning?: string }>(BACKEND_PATHS.polymarket, { intervalMs: 60_000 });

  const live = exchange.data?.liveTradingEnabled === true;

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Settings</h1>

      <Card>
        <SectionTitle>Runtime gates — read-only</SectionTitle>
        <TermTable columns={[{ key: 'g', label: 'Gate' }, { key: 'v', label: 'Value' }, { key: 'e', label: 'Effect' }]}>
          <tr>
            <td className="mono text-[11.5px]">LIVE_TRADING</td>
            <td><Badge state={live ? 'CRITICAL' : 'INFO'} label={live ? 'true — REAL MONEY' : 'false — paper'} /></td>
            <td className="text-[11px] whitespace-normal max-w-[480px]" style={{ color: 'var(--text-secondary)' }}>
              The only flag that routes real orders. Not togglable from a browser by design.
            </td>
          </tr>
          <tr>
            <td className="mono text-[11.5px]">POLYMARKET_ENABLED</td>
            <td><Badge state={polymarket.data?.enabled ? 'PASS' : 'IDLE'} label={String(polymarket.data?.enabled ?? '—')} /></td>
            <td className="text-[11px] whitespace-normal max-w-[480px]" style={{ color: 'var(--text-secondary)' }}>
              Registers two supplementary specialists and widens the panel from 7 nodes to 9,
              which changes every confidence number.
            </td>
          </tr>
          <tr>
            <td className="mono text-[11.5px]">Paused / Emergency stop</td>
            <td>
              <span className="flex gap-1.5">
                <Badge state={admin.data?.isPaused ? 'PAUSED' : 'ACTIVE'} />
                {admin.data?.emergencyStop ? <Badge state="CRITICAL" label="Stopped" /> : null}
              </span>
            </td>
            <td className="text-[11px] whitespace-normal max-w-[480px]" style={{ color: 'var(--text-secondary)' }}>
              Both are togglable from the top bar. Closing a position is never blocked by either.
            </td>
          </tr>
        </TermTable>
        <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          These are environment variables read at call time. Change them in{' '}
          <span className="mono">.env</span> and restart the backend — there is deliberately no
          endpoint that writes them.
        </div>
      </Card>

      {admin.data?.auth?.note ? (
        <Card>
          <SectionTitle>API auth</SectionTitle>
          <div className="flex items-center gap-2 mb-2">
            <Badge state={admin.data.auth.writeAuthEnabled ? 'PASS' : 'WARN'}
                   label={admin.data.auth.writeAuthEnabled ? 'Write auth on' : 'All endpoints open'} />
          </div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {admin.data.auth.note}
          </div>
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Chat provider — stored in this browser</SectionTitle>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <div className="mb-1">Provider</div>
            <select
              value={config.provider}
              onChange={(e) => setConfig((c) => ({ ...c, provider: e.target.value }))}
              className="px-2 py-1.5 text-[12px] rounded"
            >
              <option value={config.provider}>{activeProvider?.id ?? config.provider}</option>
            </select>
          </label>
          <label className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <div className="mb-1">Model</div>
            <input
              value={config.model ?? ''}
              placeholder={resolvedModel}
              onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
              className="mono px-2 py-1.5 text-[12px] rounded w-[220px]"
            />
          </label>
          <label className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <div className="mb-1">API key</div>
            <input
              type="password"
              value={config.apiKeys?.[config.provider] ?? ''}
              onChange={(e) =>
                setConfig((c) => ({ ...c, apiKeys: { ...c.apiKeys, [c.provider]: e.target.value } }))
              }
              className="mono px-2 py-1.5 text-[12px] rounded w-[260px]"
              placeholder="sk-…"
            />
          </label>
          <Badge state={hasKey ? 'PASS' : 'WARN'} label={hasKey ? 'Key set' : 'No key'} />
        </div>
        <div className="text-[10.5px] mt-2.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The key stays in this browser and is sent to <span className="mono">/api/chat</span>,
          which proxies to your provider. The backend has no LLM provider of its own — its
          resolver recognises only <span className="mono">null</span> — so without a key here
          there is no chat at all, and no server-side fallback.
        </div>
      </Card>

      <NotAvailable
        what="Notification settings"
        reason="there is no notification subsystem — no email, webhook or push transport exists in the backend, so there is nothing to configure."
      />
    </div>
  );
}
