export type ParsedTradeBlock = {
  tab: 'paper' | 'real';
  side: 'buy' | 'sell';
  symbol: string;
  qty: number;
  price: number;
  leverage?: number;
  margin?: number;
};

// Detects @real or @papertrade ANYWHERE in a message (not just as a
// prefix), so "hey agent @real trade me SOL/USDT with..." tags a
// natural-language message instead of requiring rigid command syntax.
export function detectTradeTag(text: string): 'paper' | 'real' | null {
  if (/@papertrade\b/i.test(text)) return 'paper';
  if (/@real\b/i.test(text)) return 'real';
  return null;
}

// The model is instructed (see buildTradeExecutionInstruction) to end
// its analysis with a fenced ```trade block containing strict JSON if
// — and only if — it has everything it needs to execute a concrete
// trade. This extracts and validates that block; returns null if it's
// missing, malformed, or fails validation, in which case nothing gets
// auto-executed (the model asked a clarifying question instead, which
// is the correct outcome for an underspecified request).
export function extractTradeBlock(text: string): ParsedTradeBlock | null {
  const match = text.match(/```trade\s*\n([\s\S]*?)```/i);
  if (!match) return null;

  let data: unknown;
  try {
    data = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  if (d.tab !== 'paper' && d.tab !== 'real') return null;
  if (d.side !== 'buy' && d.side !== 'sell') return null;
  if (typeof d.symbol !== 'string' || !d.symbol.trim()) return null;
  if (typeof d.qty !== 'number' || !isFinite(d.qty) || d.qty <= 0) return null;
  if (typeof d.price !== 'number' || !isFinite(d.price) || d.price <= 0) return null;

  const leverage = typeof d.leverage === 'number' && isFinite(d.leverage) ? d.leverage : undefined;
  const margin = typeof d.margin === 'number' && isFinite(d.margin) ? d.margin : undefined;

  return { tab: d.tab, side: d.side, symbol: d.symbol.toUpperCase(), qty: d.qty, price: d.price, leverage, margin };
}

// Only sent to the model when a tag is detected — keeps the normal
// system prompt clean for every other message.
export function buildTradeExecutionInstruction(tag: 'paper' | 'real'): string {
  return `TRADE EXECUTION MODE — the user tagged this message with @${tag === 'paper' ? 'papertrade' : 'real'}, meaning they want you to actually propose a concrete, executable trade based on this conversation, in addition to whatever analysis they asked for (patterns, support/resistance, risk, etc.).

After your analysis, if — and only if — you have everything needed to execute a specific trade, end your reply with exactly one fenced code block labeled "trade" containing ONLY strict JSON (no comments, no trailing commas, nothing else inside the fence):
\`\`\`trade
{"tab":"${tag}","side":"buy or sell","symbol":"one of the symbols from the LIVE MARKET DATA message above","qty":number,"price":number matching that symbol's live price exactly,"leverage":number (only if the user mentioned leverage),"margin":number (only if the user mentioned a margin amount)}
\`\`\`
Rules:
- "symbol" must be one of the symbols listed in LIVE MARKET DATA above — never invent a pair that isn't listed. If the symbol the user wants isn't on that list, say so in your analysis and ask them to add it to the watchlist instead of guessing a price — do not include the trade block in that case.
- "price" must be the exact live price given for that symbol above.
- If the user gave margin and leverage instead of a direct quantity, compute qty = (margin × leverage) ÷ price, and show that calculation in your analysis text so it isn't hidden.
- This app does not implement real margin/liquidation mechanics (funding rates, maintenance margin, liquidation price) — if leverage is mentioned, say plainly in your analysis that the trade will be logged as a spot-equivalent notional position sized by margin×leverage, not a real leveraged derivatives position.
- If you don't have enough information to fill every required field confidently, do NOT include the trade block at all — ask a clarifying question instead. A missing/incomplete block means nothing gets executed, which is the safe default.
- Never include more than one trade block in a single reply.`;
}

export type TradeCommand =
  | { tab: 'paper'; side: 'buy' | 'sell'; qty: number; symbol: string; price?: number }
  | { tab: 'real'; side: 'buy'; qty: number; symbol: string; price?: number }
  | { tab: 'real'; side: 'sell'; symbol: string };

// Syntax (forgiving on purpose — see resolveSymbol in AppState.tsx for
// the other half of this: matching a bare "SOL" against your watchlist's
// "SOL/USDT" entry):
//   @papertrade buy 0.5 BTC/USDT        @papertrade buy 0.5BTC/USDT   (no space is fine)
//   @papertrade sell 0.5 BTC/USDT @ 65000
//   @real buy 10 NVDA                   (price optional here too — falls back to the live tick)
//   @real buy 10 NVDA @ 121.50
//   @real sell NVDA                     (closes the whole real position)
export function parseTradeCommand(raw: string): TradeCommand | null {
  const text = raw.trim();
  const head = text.match(/^@(papertrade|real)\s+(buy|sell)\s*(.*)$/i);
  if (!head) return null;

  const tab = head[1].toLowerCase() === 'papertrade' ? 'paper' : 'real';
  const side = head[2].toLowerCase() as 'buy' | 'sell';
  const rest = head[3].trim();

  if (tab === 'real' && side === 'sell') {
    const symbol = rest.replace(/\s+/g, '').toUpperCase();
    if (!symbol) return null;
    return { tab: 'real', side: 'sell', symbol };
  }

  // Quantity and symbol no longer require a space between them — "0.1SOL/USDT"
  // and "0.1 SOL/USDT" both work, since typing the space every time was the
  // exact friction reported.
  const parts = rest.match(/^([\d.]+)\s*([A-Za-z][A-Za-z0-9/]*)(?:\s*@\s*([\d.]+))?$/);
  if (!parts) return null;

  const qty = parseFloat(parts[1]);
  const symbol = parts[2].toUpperCase();
  const price = parts[3] ? parseFloat(parts[3]) : undefined;
  if (!qty || qty <= 0 || !symbol) return null;

  if (tab === 'real') {
    return { tab: 'real', side: 'buy', qty, symbol, price };
  }
  return { tab: 'paper', side, qty, symbol, price };
}
