'use client';

import { useEffect, useState } from 'react';

type NewsItem = { title: string; link: string; source: string; pubDate: string | null };
type LoadState = 'loading' | 'ok' | 'error';

export function NewsPanel() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/news');
        const json = await res.json();
        if (cancelled) return;
        if (json.items) {
          setItems(json.items);
          setState('ok');
        } else {
          setState('error');
        }
      } catch {
        if (!cancelled) setState('error');
      }
    }
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  if (state === 'error') {
    return (
      <p className="text-[11px] text-txt2">
        Couldn&apos;t reach the news feeds right now — the <code className="font-mono">/api/news</code> route fetches
        public RSS server-side, so this needs the app actually deployed/running with real outbound network access.
      </p>
    );
  }
  if (state === 'loading') return <p className="text-[11px] text-txt2">Loading headlines…</p>;
  if (items.length === 0) return <p className="text-[11px] text-txt2">No headlines returned.</p>;

  return (
    <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
      {items.slice(0, 12).map((it, i) => (
        <a key={i} href={it.link} target="_blank" rel="noopener noreferrer" className="block group">
          <p className="text-[11.5px] leading-snug group-hover:underline text-txt0">{it.title}</p>
          <p className="text-[9.5px] font-mono text-txt2">
            {it.source}
            {it.pubDate ? ` · ${it.pubDate}` : ''}
          </p>
        </a>
      ))}
    </div>
  );
}
