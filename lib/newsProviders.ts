// ---------------------------------------------------------------------
// Free news aggregator rotation. Each of these has a real daily free-
// tier limit; rather than picking one and failing once it's exhausted,
// the app tracks usage per provider per day and automatically rotates
// to the next one with quota left. If none have quota (or none are
// configured with an API key), the app falls back to the RSS feeds
// (Commit 14's other free source, no key or limit at all).
//
// None of these work without a real API key from that provider — this
// app doesn't fabricate one. Set the corresponding env var to enable a
// provider; leave it unset and it's automatically skipped in rotation,
// not silently retried and failed.
// ---------------------------------------------------------------------

export type NewsProviderMeta = {
  id: string;
  name: string;
  envKeyName: string;
  dailyLimit: number;
  // What the limit actually is, in the provider's own terms — dailyLimit
  // above is normalized to "number of article-fetches this counts as
  // roughly," documented per-provider since they don't all meter the
  // same way (requests vs. credits).
  limitNote: string;
};

// Ordered by priority: highest free-tier ceiling and richest data first,
// since it means less rotation churn day to day. This order is only a
// starting preference — pickAvailableProvider always honors whichever
// actually has quota left, not just this order blindly.
export const NEWS_AGGREGATOR_PROVIDERS: NewsProviderMeta[] = [
  { id: 'apitube', name: 'APITube', envKeyName: 'APITUBE_API_KEY', dailyLimit: 1000, limitNote: '1,000 requests/day free tier, includes sentiment enrichment' },
  { id: 'gnews', name: 'GNews', envKeyName: 'GNEWS_API_KEY', dailyLimit: 100, limitNote: '100 requests/day free tier' },
  { id: 'newsx', name: 'NewsX', envKeyName: 'NEWSX_API_KEY', dailyLimit: 100, limitNote: '100 requests/day free tier' },
  { id: 'newsdata', name: 'NewsData.io', envKeyName: 'NEWSDATA_API_KEY', dailyLimit: 20, limitNote: '200 credits/day ≈ 20 articles free tier' },
];

// Pure selection logic — no fetching, no env reads here, so it's fully
// testable without a network call or real API keys. `configuredKeys` is
// the set of envKeyNames that actually have a non-empty value; the
// caller reads process.env for that (this function stays pure).
export function pickAvailableProvider(
  providers: NewsProviderMeta[],
  configuredKeys: Set<string>,
  usageToday: Record<string, number>,
): NewsProviderMeta | null {
  for (const p of providers) {
    if (!configuredKeys.has(p.envKeyName)) continue; // no key set — not an option today or any day until configured
    const used = usageToday[p.id] ?? 0;
    if (used < p.dailyLimit) return p;
  }
  return null; // every configured provider is exhausted for today, or none are configured at all
}

// X (Twitter) and Reddit — Status: Planned, not silently absent. Both
// require authenticated, non-free API access; no free-tier rotation
// trick gets around that the way it does for the news aggregators above.
export type PlannedIntelSource = {
  name: string;
  status: 'planned';
  reason: string;
  requiredComponents: string[];
  plannedVersion: string;
};

export const X_TWITTER_STATUS: PlannedIntelSource = {
  name: 'X (Twitter)',
  status: 'planned',
  reason: 'The official X API requires an authenticated, paid application tier for meaningful access — free access is extremely limited, and scraping is unreliable and against platform policy.',
  requiredComponents: ['Official X API access', 'An authenticated application', 'An elevated (paid) API tier'],
  plannedVersion: 'v2 / Future Release',
};

export const REDDIT_STATUS: PlannedIntelSource = {
  name: 'Reddit',
  status: 'planned',
  reason: 'Requires Reddit OAuth, authenticated API access, rate-limit handling, subreddit filtering, and comment ranking — none of which exist in this app yet.',
  requiredComponents: ['Reddit OAuth', 'Authenticated API access', 'Rate-limit handling', 'A sentiment pipeline for ranked comments'],
  plannedVersion: 'v2 / Future Release',
};
