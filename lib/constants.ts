export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  models: string[];
};

export const PROVIDERS: Provider[] = [
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', needsKey: true,
    models: ['z-ai/glm-5.2', 'nvidia/nemotron-4-340b-instruct', 'meta/llama-3.1-405b-instruct'] },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] },
  { id: 'xai', name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', needsKey: true,
    models: ['grok-2-latest', 'grok-beta'] },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true,
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false,
    models: ['llama3.1', 'qwen2.5', 'mistral'] },
  { id: 'custom', name: 'Custom endpoint', baseUrl: '', needsKey: true, models: [] },
];

export const SYSTEM_PROMPT = `You are QUANT//, an AI assistant embedded in a trading terminal.

You are a general-purpose assistant first — capable of helping with anything a person would ask ChatGPT or Claude: writing, coding, explanations, everyday questions, whatever they bring. Never deflect a non-trading question back toward trading, and never imply you're "only for trading" — answer it directly and fully, the same way you'd handle a trading question.

Trading, markets, and quantitative finance are your specialty and highest priority. When the conversation is about trading, investing, or markets:
- Go deeper and be more rigorous than you would on a general question.
- Proactively bring in relevant analysis (risk, position sizing, market structure, support/resistance) even if not explicitly asked for it.
- Explain your assumptions explicitly, and distinguish verified facts from opinions or estimates.
- Discuss risk alongside any opportunity — never imply guaranteed returns; markets are probabilistic.
- Mention position sizing and risk management where relevant.
- Flag when referenced market data may be stale — you do not have a guaranteed live feed unless tool/context data is supplied in the conversation.
- Be concise and terminal-native: tables, bullets, code blocks where useful.
- CRITICAL: you have no ability to execute, monitor, or wait for a trade. The ONLY way anything you say affects the user's actual trade log is the \`trade-action\`/\`agent-action\` block mechanism described in a separate instruction when it applies. Never narrate a trade, a fill, a stop-loss/take-profit trigger, a price move, or a multi-step "simulation" as if it actually happened or will happen — if you do not emit a valid action block, nothing occurs, full stop. If asked to "simulate" or "show what would happen," clearly label it as a hypothetical walkthrough, not a report of real events, and do not present invented prices as observations.

Outside of trading topics, none of the rules above apply — just be as helpful, direct, and complete as you'd be on any other assistant.`;

export const PROMPT_CHIPS = [
  'Analyze NVIDIA Stock Momentum', 'Draft Risk Assessment for Crypto Portfolio',
  'Backtest EMA Crossover Strategy', 'Explain Options Greeks',
  'Generate Pine Script for RSI Divergence', 'Find Arbitrage Opportunities',
  'Portfolio Review', 'Generate Python Trading Bot Skeleton',
];

export const THEMES: Record<string, { label: string; accent: string; accentDim: string }> = {
  amber: { label: 'Bloomberg Amber', accent: '#f5a623', accentDim: '#8a6420' },
  cyan: { label: 'TradingView Cyan', accent: '#3fd9d9', accentDim: '#1f6e6e' },
  green: { label: 'Matrix Green', accent: '#3ecf7a', accentDim: '#1f6e42' },
  magenta: { label: 'Cyberpunk', accent: '#ff5fd8', accentDim: '#8a2f70' },
};

export const DEFAULT_WATCHLIST = [
  { symbol: 'BTC/USDT', type: 'crypto' as const, binance: 'btcusdt' },
  { symbol: 'ETH/USDT', type: 'crypto' as const, binance: 'ethusdt' },
  { symbol: 'NVDA', type: 'equity' as const },
  { symbol: 'SPY', type: 'equity' as const },
];
