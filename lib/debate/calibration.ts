import type { DebateRecord } from './types';

// The whole point: a model saying "96% confident" means nothing on its
// own. What matters is — historically, when THIS system said something
// in that confidence range, how often was it actually right? This bins
// past debate records (that have a known win/loss outcome) by their raw
// confidence, computes the empirical win rate per bin, and uses that
// bin's real accuracy as the calibrated number for a new prediction
// landing in the same bin.

export type ConfidenceBin = { rangeLabel: string; min: number; max: number; sampleSize: number; empiricalWinRate: number | null };

const BIN_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]; // 1.01 so a raw confidence of exactly 1.0 still falls inside the last bin
const MIN_SAMPLES_PER_BIN = 8; // below this, a bin's "accuracy" is mostly noise — reported as unavailable rather than a shaky number

export function buildConfidenceBins(records: DebateRecord[]): ConfidenceBin[] {
  const withOutcome = records.filter((r) => r.outcome !== null);
  const bins: ConfidenceBin[] = [];
  for (let i = 0; i < BIN_EDGES.length - 1; i++) {
    const min = BIN_EDGES[i];
    const max = BIN_EDGES[i + 1];
    const inBin = withOutcome.filter((r) => r.moderator.rawConfidence >= min && r.moderator.rawConfidence < max);
    const wins = inBin.filter((r) => r.outcome === 'win').length;
    bins.push({
      rangeLabel: `${(min * 100).toFixed(0)}–${Math.min(max, 1) * 100}%`,
      min,
      max,
      sampleSize: inBin.length,
      empiricalWinRate: inBin.length >= MIN_SAMPLES_PER_BIN ? wins / inBin.length : null,
    });
  }
  return bins;
}

export type CalibrationResult = {
  rawConfidence: number;
  calibratedConfidence: number; // falls back to rawConfidence when there's not enough history to calibrate against
  usedBin: string | null;
  sampleSize: number;
  note: string;
};

export function calibrateConfidence(rawConfidence: number, records: DebateRecord[]): CalibrationResult {
  const bins = buildConfidenceBins(records);
  const bin = bins.find((b) => rawConfidence >= b.min && rawConfidence < b.max) ?? bins[bins.length - 1];

  if (bin.empiricalWinRate === null) {
    // Not enough same-bin history — fall back to an overall empirical
    // rate across ALL bins with enough combined history, one level less
    // specific than "same confidence range" but still real data rather
    // than just trusting the raw number outright.
    const allWithOutcome = records.filter((r) => r.outcome !== null);
    if (allWithOutcome.length >= MIN_SAMPLES_PER_BIN) {
      const overallWinRate = allWithOutcome.filter((r) => r.outcome === 'win').length / allWithOutcome.length;
      return {
        rawConfidence,
        calibratedConfidence: overallWinRate,
        usedBin: null,
        sampleSize: allWithOutcome.length,
        note: `Not enough history in the ${bin.rangeLabel} confidence range yet (${bin.sampleSize} sample(s), need ${MIN_SAMPLES_PER_BIN}) — using this system's overall track record (${allWithOutcome.length} closed trades) instead.`,
      };
    }
    return {
      rawConfidence,
      calibratedConfidence: rawConfidence,
      usedBin: null,
      sampleSize: allWithOutcome.length,
      note: `Not enough closed-trade history yet to calibrate (${allWithOutcome.length} total) — showing the raw, uncalibrated confidence. This will start reflecting real performance once more trades close.`,
    };
  }

  return {
    rawConfidence,
    calibratedConfidence: bin.empiricalWinRate,
    usedBin: bin.rangeLabel,
    sampleSize: bin.sampleSize,
    note: `Based on ${bin.sampleSize} past prediction(s) in the ${bin.rangeLabel} confidence range, which were actually right ${(bin.empiricalWinRate * 100).toFixed(0)}% of the time.`,
  };
}
