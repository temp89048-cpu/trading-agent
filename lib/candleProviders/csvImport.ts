import type { Candle } from './types';

// Parquet import is NOT implemented here. Parsing Parquet correctly
// means decoding its binary column-chunk/page format (compression
// codecs, dictionary encoding, repetition/definition levels) — a real
// binary-format parser that needs real Parquet fixtures to verify
// against, not something to bolt on unverified alongside nine other
// features in one pass. CSV covers the same "don't be limited by
// provider history" goal and is fully implemented and tested below.
// Parquet remains a documented gap, not a silent one.

export type CsvImportResult = { candles: Candle[]; warnings: string[] } | { error: string };

const REQUIRED_COLUMNS = ['t', 'o', 'h', 'l', 'c', 'v'] as const;
// Accept a few common aliases so a raw exchange/export CSV doesn't need
// manual re-heading first.
const COLUMN_ALIASES: Record<string, (typeof REQUIRED_COLUMNS)[number]> = {
  time: 't',
  timestamp: 't',
  date: 't',
  open: 'o',
  high: 'h',
  low: 'l',
  close: 'c',
  volume: 'v',
  vol: 'v',
};

function parseCsvLine(line: string): string[] {
  // Minimal CSV split: handles quoted fields with commas, not full RFC
  // 4180 (no embedded newlines in quoted fields) — sufficient for plain
  // numeric OHLCV exports, which is the only thing this is for.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    // Heuristic: 10-digit numbers are seconds, 13-digit are milliseconds.
    return trimmed.length <= 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(trimmed);
  return isNaN(parsed) ? null : parsed;
}

export function parseCandlesCsv(text: string): CsvImportResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { error: 'CSV needs a header row plus at least one data row.' };

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const columnIndex: Partial<Record<(typeof REQUIRED_COLUMNS)[number], number>> = {};
  header.forEach((h, i) => {
    const canonical = (REQUIRED_COLUMNS as readonly string[]).includes(h) ? (h as (typeof REQUIRED_COLUMNS)[number]) : COLUMN_ALIASES[h];
    if (canonical) columnIndex[canonical] = i;
  });

  const missing = REQUIRED_COLUMNS.filter((c) => columnIndex[c] === undefined);
  if (missing.length > 0) {
    return { error: `CSV is missing required column(s): ${missing.join(', ')}. Header found: ${header.join(', ')}. Accepted names: t/time/timestamp/date, o/open, h/high, l/low, c/close, v/volume/vol.` };
  }

  const candles: Candle[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const t = parseTimestamp(fields[columnIndex.t!]);
    const o = parseFloat(fields[columnIndex.o!]);
    const h = parseFloat(fields[columnIndex.h!]);
    const l = parseFloat(fields[columnIndex.l!]);
    const c = parseFloat(fields[columnIndex.c!]);
    const v = parseFloat(fields[columnIndex.v!]);
    if (t === null || [o, h, l, c, v].some((x) => isNaN(x))) {
      skipped++;
      continue;
    }
    candles.push({ t, o, h, l, c, v });
  }

  if (skipped > 0) warnings.push(`Skipped ${skipped} row(s) with unparseable timestamp or numeric fields.`);
  if (candles.length === 0) return { error: 'No valid candle rows found after parsing.' };

  candles.sort((a, b) => a.t - b.t);

  // De-dupe on identical timestamps (keep the first occurrence) — a
  // common artifact of concatenating overlapping CSV exports.
  const seen = new Set<number>();
  const deduped: Candle[] = [];
  for (const c of candles) {
    if (seen.has(c.t)) continue;
    seen.add(c.t);
    deduped.push(c);
  }
  if (deduped.length < candles.length) warnings.push(`Removed ${candles.length - deduped.length} duplicate-timestamp row(s).`);

  return { candles: deduped, warnings };
}
