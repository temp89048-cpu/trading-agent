'use client';

import { useState } from 'react';
import { Icon } from './Icon';
import { useMcp } from './Mcp';

export function McpManagerModal({ onClose }: { onClose: () => void }) {
  const { servers, addServer, removeServer, statusById, checkServer } = useMcp();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  function submit() {
    if (!name.trim() || !url.trim()) return;
    addServer(name, url);
    setName('');
    setUrl('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(4,5,7,0.75)' }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden rise border-line bg-bg1 card-shadow" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2 font-mono text-sm font-semibold text-txt0">
            <Icon name="plug" size={16} className="text-amber" /> MCP Bridges
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg3 text-txt2">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          <p className="text-[11px] text-txt2">
            This registers MCP server URLs and checks whether they&apos;re reachable. It does <strong>not</strong>{' '}
            implement the MCP protocol (JSON-RPC handshake, tool listing) and doesn&apos;t wire tool-calling into
            chat — that&apos;s a separate, larger piece of work than a connectivity check. Treat this as a bridge
            registry, not live tool integration.
          </p>

          <div className="flex flex-col gap-2">
            {servers.length === 0 && <p className="text-[11px] text-txt2">No MCP servers registered yet.</p>}
            {servers.map((s) => {
              const st = statusById[s.id];
              const dotColor = st?.checking ? 'var(--amber)' : st?.reachable === true ? 'var(--green)' : st?.reachable === false ? 'var(--red)' : 'var(--txt-2)';
              return (
                <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-line bg-bg2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
                      <span className="text-xs font-mono truncate text-txt0">{s.name}</span>
                    </div>
                    <p className="text-[10px] font-mono truncate text-txt2">{s.url}</p>
                    {st?.reachable === true && (
                      <p className="text-[10px] font-mono text-green">
                        reachable · HTTP {st.status} · {st.latencyMs}ms
                      </p>
                    )}
                    {st?.reachable === false && <p className="text-[10px] font-mono text-red">{st.error || 'unreachable'}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => checkServer(s.id)}
                      disabled={st?.checking}
                      className="p-1.5 rounded hover:bg-bg3 text-txt2 disabled:opacity-40"
                      title="Check reachability"
                    >
                      <Icon name="refresh" size={13} />
                    </button>
                    <button onClick={() => removeServer(s.id)} className="p-1.5 rounded hover:bg-bg3 hover:text-red text-txt2" title="Remove">
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-1.5 pt-2 border-t border-line">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (e.g. Crypto.com Market Data)"
              className="w-full rounded-md px-3 py-2 text-xs font-mono"
            />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/..."
              className="w-full rounded-md px-3 py-2 text-xs font-mono"
            />
            <button onClick={submit} className="py-1.5 rounded-md text-xs font-mono font-semibold bg-amber text-black">
              Add server
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
