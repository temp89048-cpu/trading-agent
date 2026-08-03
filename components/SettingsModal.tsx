'use client';

import { useState } from 'react';
import { Icon } from './Icon';
import { PROVIDERS, THEMES } from '@/lib/constants';
import { useAppState } from './AppState';
import type { ThemeId } from '@/lib/types';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { config, setConfig, activeProvider, resolvedApiKey } = useAppState();
  const [draftKey, setDraftKey] = useState(resolvedApiKey);
  const [draftBaseUrl, setDraftBaseUrl] = useState(config.baseUrlOverride);

  function saveAndClose() {
    setConfig((c) => ({
      ...c,
      apiKeys: { ...c.apiKeys, [c.provider]: draftKey },
      baseUrlOverride: draftBaseUrl,
    }));
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(4,5,7,0.75)' }} onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden rise border-line bg-bg1 card-shadow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2 font-mono text-sm font-semibold text-txt0">
            <Icon name="settings" size={16} className="text-amber" /> Settings
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg3 text-txt2">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          <Field label="Provider">
            <select
              value={config.provider}
              onChange={(e) => setConfig((c) => ({ ...c, provider: e.target.value, model: '' }))}
              className="w-full rounded-md px-3 py-2 text-sm font-mono"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          {activeProvider.needsKey && (
            <Field label="API Key" hint="Stored only in this browser's localStorage. Never sent anywhere except this provider's API, via your own /api/chat route.">
              <input
                type="password"
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder={`${activeProvider.name} API key`}
                className="w-full rounded-md px-3 py-2 text-sm font-mono"
              />
            </Field>
          )}

          <Field label="Base URL" hint="Leave blank to use the provider default.">
            <input
              type="text"
              value={draftBaseUrl}
              onChange={(e) => setDraftBaseUrl(e.target.value)}
              placeholder={activeProvider.baseUrl || 'https://…'}
              className="w-full rounded-md px-3 py-2 text-sm font-mono"
            />
          </Field>

          <Field label="Model">
            {activeProvider.models.length > 0 ? (
              <select
                value={config.model || activeProvider.models[0]}
                onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
                className="w-full rounded-md px-3 py-2 text-sm font-mono"
              >
                {activeProvider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.model}
                onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
                placeholder="model name"
                className="w-full rounded-md px-3 py-2 text-sm font-mono"
              />
            )}
          </Field>

          <Field label={`Temperature — ${config.temperature.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={config.temperature}
              onChange={(e) => setConfig((c) => ({ ...c, temperature: parseFloat(e.target.value) }))}
              className="w-full"
            />
          </Field>

          <Field
            label={`Max Response Length — ${config.maxTokens} tokens`}
            hint="Lower = faster replies (less for the model to generate), but longer answers get cut off. If chat feels slow, try lowering this before assuming anything else is wrong — a long conversation history and a high token cap are the two biggest levers this app actually controls."
          >
            <input
              type="range"
              min={256}
              max={4096}
              step={128}
              value={config.maxTokens}
              onChange={(e) => setConfig((c) => ({ ...c, maxTokens: parseInt(e.target.value, 10) }))}
              className="w-full"
            />
          </Field>

          <Field label="Theme">
            <div className="flex gap-2">
              {(Object.keys(THEMES) as ThemeId[]).map((id) => (
                <button
                  key={id}
                  onClick={() => setConfig((c) => ({ ...c, theme: id }))}
                  className={`flex-1 rounded-md py-2 text-[10px] font-mono border transition ${
                    config.theme === id ? 'border-amber' : 'border-line'
                  }`}
                  style={{ color: THEMES[id].accent }}
                >
                  {THEMES[id].label}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs font-mono text-txt1 hover:bg-bg3">
            Cancel
          </button>
          <button onClick={saveAndClose} className="px-3 py-1.5 rounded-md text-xs font-mono font-semibold bg-amber text-black">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-mono uppercase tracking-wider text-txt2">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-txt2">{hint}</span>}
    </label>
  );
}
