import type { CandleProvider, SupportedInterval, AssetType, ProviderFetchResult } from './types';
import { requestedDaysOfHistory } from './types';
import { binanceProvider } from './binance';
import { yahooProvider } from './yahoo';
import { STUB_PROVIDERS } from './stubs';

export const ALL_PROVIDERS: CandleProvider[] = [binanceProvider, yahooProvider, ...STUB_PROVIDERS];

export function providersForAssetType(type: AssetType): CandleProvider[] {
  return ALL_PROVIDERS.filter((p) => p.capability.assetTypes.includes(type));
}

export function configuredProvidersForAssetType(type: AssetType): CandleProvider[] {
  return providersForAssetType(type).filter((p) => p.isConfigured());
}

export type ProviderSelection = {
  provider: CandleProvider;
  requestedDays: number;
  cappedByProvider: boolean; // true if the provider's own historyDays ceiling is below what was requested
  warnings: string[];
};

// Picks the configured provider that can cover the most of the
// requested history at this interval, rather than always defaulting to
// whichever provider happens to be listed first. If NO configured
// provider supports the interval at all, or every one of them falls
// well short of the request, this says so plainly instead of silently
// handing back a truncated result with no explanation.
export function selectProvider(type: AssetType, interval: SupportedInterval, totalBars: number): ProviderSelection | { error: string } {
  const candidates = configuredProvidersForAssetType(type);
  if (candidates.length === 0) {
    const known = providersForAssetType(type).map((p) => p.label);
    return { error: `No configured candle provider supports ${type} (known but unconfigured: ${known.join(', ')} — set their API key env vars to enable them).` };
  }

  const requestedDays = requestedDaysOfHistory(interval, totalBars);
  const withCapability = candidates
    .map((p) => ({ provider: p, days: p.capability.historyDays[interval] }))
    .filter((x): x is { provider: CandleProvider; days: number | null } => x.days !== undefined);

  if (withCapability.length === 0) {
    return { error: `No configured provider for ${type} advertises support for the ${interval} interval.` };
  }

  // Prefer providers with no stated ceiling (days === null, i.e.
  // "effectively unlimited at this granularity") over ones with a
  // stated ceiling, then prefer whichever stated ceiling is largest.
  withCapability.sort((a, b) => {
    if (a.days === null && b.days === null) return 0;
    if (a.days === null) return -1;
    if (b.days === null) return 1;
    return b.days - a.days;
  });

  const best = withCapability[0];
  const warnings: string[] = [];
  let cappedByProvider = false;
  if (best.days !== null && best.days < requestedDays) {
    cappedByProvider = true;
    warnings.push(
      `Requested ~${requestedDays.toFixed(0)} days of ${interval} history, but ${best.provider.label} only keeps ~${best.days} days at this granularity — results will cover a shorter window than asked for. This is a data-provider limit, not something more pagination fixes.`,
    );
  }

  return { provider: best.provider, requestedDays, cappedByProvider, warnings };
}

export async function fetchViaSelectedProvider(symbol: string, type: AssetType, interval: SupportedInterval, totalBars: number): Promise<(ProviderFetchResult & { providerLabel: string; warnings: string[] }) | { error: string }> {
  const selection = selectProvider(type, interval, totalBars);
  if ('error' in selection) return selection;
  try {
    const result = await selection.provider.fetchCandles(symbol, interval, totalBars);
    return { ...result, providerLabel: selection.provider.label, warnings: selection.warnings };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'unknown provider error' };
  }
}
