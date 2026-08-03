// Browsers can't fetch these RSS feeds directly (no CORS headers on the
// feed hosts), so this route fetches + parses them server-side and hands
// back plain JSON. Same zero-dependency regex parser as the original
// server.js version.
//
// Commit 14 adds: more free RSS sources, plus an optional layer of free
// news-aggregator APIs (APITube/GNews/NewsX/NewsData.io) that rotate
// automatically when one hits its daily free-tier limit — see
// lib/newsProviders.ts for the rotation logic and lib/newsProviderUsage.server.ts
// for the persistence. None of the aggregators require this app to work
// at all: with zero API keys configured, this route still returns the
// full RSS feed list, which has no key and no rate limit.

import { NEWS_AGGREGATOR_PROVIDERS, pickAvailableProvider, type NewsProviderMeta } from '@/lib/newsProviders';
import { getUsageToday, incrementUsage } from '@/lib/newsProviderUsage.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type NewsItem = { title: string; link: string; source: string; pubDate: string | null };

const NEWS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', source: 'WSJ Markets' },
  // Added in Commit 14 — all free, no key, no rate limit.
  { url: 'https://www.binance.com/en/support/announcement/rss', source: 'Binance Announcements' },
  { url: 'https://blog.coinbase.com/feed', source: 'Coinbase Blog' },
  { url: 'https://blog.kraken.com/feed', source: 'Kraken Blog' },
  { url: 'https://cryptoslate.com/feed/', source: 'CryptoSlate' },
  // The Block doesn't appear to expose a public RSS feed as of this
  // writing — omitted rather than guessing a URL that might not exist.
  // If they add one, it slots in the same way as everything else here.
];

function stripCdata(s: string | undefined): string {
  return (s ?? '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRe) ?? [];
  for (const block of matches.slice(0, 8)) {
    const titleM = block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkM = block.match(/<link>([\s\S]*?)<\/link>/i);
    const dateM = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const title = decodeEntities(stripCdata(titleM?.[1]));
    const link = decodeEntities(stripCdata(linkM?.[1]));
    if (!title || !link) continue;
    items.push({ title, link, source, pubDate: dateM ? dateM[1].trim() : null });
  }
  return items;
}

async function fetchFeed(feed: { url: string; source: string }): Promise<NewsItem[]> {
  try {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal news fetch)' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, feed.source);
  } catch {
    return [];
  }
}

// Each aggregator has its own request shape and response shape — this
// is the one place that translates "some provider, some API key" into
// the same NewsItem[] shape the rest of the app already understands.
// Wrapped in try/catch per-provider so one bad response doesn't take
// down the whole route; RSS results still come back regardless.
async function fetchFromAggregator(provider: NewsProviderMeta, apiKey: string, query: string): Promise<NewsItem[]> {
  try {
    if (provider.id === 'apitube') {
      const res = await fetch(`https://api.apitube.io/v1/news/everything?title=${encodeURIComponent(query)}&per_page=10&api_key=${apiKey}`);
      if (!res.ok) return [];
      const json = await res.json();
      const results = json?.results ?? [];
      return results.map((r: { title?: string; href?: string; source?: { domain?: string }; published_at?: string }) => ({
        title: r.title ?? '',
        link: r.href ?? '',
        source: r.source?.domain ?? 'APITube',
        pubDate: r.published_at ?? null,
      })).filter((i: NewsItem) => i.title && i.link);
    }
    if (provider.id === 'gnews') {
      const res = await fetch(`https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=10&apikey=${apiKey}`);
      if (!res.ok) return [];
      const json = await res.json();
      const articles = json?.articles ?? [];
      return articles.map((a: { title?: string; url?: string; source?: { name?: string }; publishedAt?: string }) => ({
        title: a.title ?? '',
        link: a.url ?? '',
        source: a.source?.name ?? 'GNews',
        pubDate: a.publishedAt ?? null,
      })).filter((i: NewsItem) => i.title && i.link);
    }
    if (provider.id === 'newsx') {
      const res = await fetch(`https://api.newsx.dev/v1/news?query=${encodeURIComponent(query)}&limit=10&apikey=${apiKey}`);
      if (!res.ok) return [];
      const json = await res.json();
      const items = json?.articles ?? json?.data ?? [];
      return items.map((a: { title?: string; url?: string; source?: string; publishedAt?: string }) => ({
        title: a.title ?? '',
        link: a.url ?? '',
        source: a.source ?? 'NewsX',
        pubDate: a.publishedAt ?? null,
      })).filter((i: NewsItem) => i.title && i.link);
    }
    if (provider.id === 'newsdata') {
      const res = await fetch(`https://newsdata.io/api/1/news?apikey=${apiKey}&q=${encodeURIComponent(query)}&language=en`);
      if (!res.ok) return [];
      const json = await res.json();
      const results = json?.results ?? [];
      return results.map((r: { title?: string; link?: string; source_id?: string; pubDate?: string }) => ({
        title: r.title ?? '',
        link: r.link ?? '',
        source: r.source_id ?? 'NewsData.io',
        pubDate: r.pubDate ?? null,
      })).filter((i: NewsItem) => i.title && i.link);
    }
    return [];
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // Optional query param to bias the aggregator search (e.g. "BTC") —
  // RSS feeds always return their general feed regardless, since they
  // don't support server-side filtering by keyword.
  const query = searchParams.get('q') ?? 'crypto';

  try {
    const rssResults = await Promise.all(NEWS_FEEDS.map(fetchFeed));
    let items = rssResults.flat();
    let aggregatorUsed: string | null = null;
    let aggregatorNote: string;

    const configuredKeys = new Set(
      NEWS_AGGREGATOR_PROVIDERS.map((p) => p.envKeyName).filter((key) => !!process.env[key]),
    );
    const usageToday = await getUsageToday();
    const provider = pickAvailableProvider(NEWS_AGGREGATOR_PROVIDERS, configuredKeys, usageToday);

    if (provider) {
      const apiKey = process.env[provider.envKeyName] as string;
      const aggregatorItems = await fetchFromAggregator(provider, apiKey, query);
      if (aggregatorItems.length > 0) {
        items = [...aggregatorItems, ...items];
        await incrementUsage(provider.id);
        aggregatorNote = `${provider.name} (${(usageToday[provider.id] ?? 0) + 1}/${provider.dailyLimit} used today)`;
        aggregatorUsed = provider.id;
      } else {
        aggregatorNote = `${provider.name} was selected but returned no results this call — RSS-only for this response`;
      }
    } else if (configuredKeys.size === 0) {
      aggregatorNote = 'No aggregator API keys configured — RSS feeds only (still free, no limit)';
    } else {
      aggregatorNote = 'All configured aggregator providers have hit their daily free-tier limit — RSS feeds only until they reset (UTC midnight)';
    }

    items.sort((a, b) => {
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return tb - ta;
    });

    return Response.json({ items, aggregatorUsed, aggregatorNote });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return Response.json({ error: `Could not fetch news: ${message}` }, { status: 502 });
  }
}
