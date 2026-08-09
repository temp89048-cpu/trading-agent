'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from './Icon';
import { WatchlistEditor } from './WatchlistEditor';
import { PaperTradePanel } from './PaperTradePanel';
import { RealPortfolioPanel } from './RealPortfolioPanel';
import { TradeLogPanel } from './TradeLogPanel';
import { RiskMeter } from './RiskMeter';
import { PortfolioStats } from './PortfolioStats';
import { PortfolioAnalytics } from './PortfolioAnalytics';
import { NewsPanel } from './NewsPanel';
import { ChartModal } from './ChartModal';
import { AgentPanel } from './AgentPanel';
import { MTFBadges } from './MTFBadges';
import { LiquidityVolumePanel } from './LiquidityVolumePanel';
import { OrderFlowPanel } from './OrderFlowPanel';
import { StrategyEnsemblePanel } from './StrategyEnsemblePanel';
import { RiskManagerPanel } from './RiskManagerPanel';
import { MarketIntelPanel } from './MarketIntelPanel';
import { MultiExchangePanel } from './MultiExchangePanel';
import { PortfolioIntelligencePanel } from './PortfolioIntelligencePanel';
import { EventDetectionPanel } from './EventDetectionPanel';
import { SystemHealthPanel } from './SystemHealthPanel';
import { MemoryPanel } from './MemoryPanel';
import { DebatePanel } from './DebatePanel';
import { AutonomousResearchPanel } from './AutonomousResearchPanel';
import { TradingControlsPanel } from './TradingControlsPanel';
import { ExchangeConnectionsPanel } from './ExchangeConnectionsPanel';
import { AgentOSPanel } from './AgentOSPanel';
import { MissionPlannerPanel } from './MissionPlannerPanel';
import { AutonomousTraderPanel } from './AutonomousTraderPanel';
import { useMarketData } from './MarketData';
import { useMcp } from './Mcp';
import { loadLS, saveLS, LS_KEYS } from '@/lib/storage';
import type { WatchItem } from '@/lib/types';

type IconName = Parameters<typeof Icon>[0]['name'];

// A single panel within a group — one collapsed level down from the group
// header, so the visual hierarchy reads group > section > content instead
// of 26 identical-weight blocks in one flat scroll.
function SectionBlock({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: IconName;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-txt2">
          <Icon name={icon} size={12} /> {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// One top-level category (Market, Strategy & AI, Risk & Controls, Portfolio
// & History, Integrations). Open/closed state persists per-device so a
// collapsed group stays out of the way across reloads instead of resetting
// every time. Defaults to open — nothing that was visible before this
// reorganization disappears on first load, it just becomes collapsible.
function CollapsibleGroup({
  id,
  title,
  icon,
  count,
  children,
}: {
  id: string;
  title: string;
  icon: IconName;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = loadLS<Record<string, boolean>>(LS_KEYS.sidebarGroups, {});
    if (id in saved) setOpen(saved[id]);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const saved = loadLS<Record<string, boolean>>(LS_KEYS.sidebarGroups, {});
    saveLS(LS_KEYS.sidebarGroups, { ...saved, [id]: open });
  }, [open, hydrated, id]);

  return (
    <div className="border-b border-line">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg2 hover-lift transition group"
      >
        <div className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-wider text-txt1 group-hover:text-amber transition-colors">
          <Icon name={icon} size={15} />
          {title}
          <span className="text-[10px] font-normal normal-case tracking-normal text-txt2">{count}</span>
        </div>
        <Icon name="chevron-down" size={14} className={`text-txt2 transition-transform duration-150 ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="divide-y divide-line/70 bg-bg1/40">{children}</div>}
    </div>
  );
}

export function TradingSidebar({ onClose }: { onClose?: () => void }) {
  const [tab, setTab] = useState<'paper' | 'real'>('paper');
  const [chartItem, setChartItem] = useState<WatchItem | null>(null);
  const { watchlist } = useMarketData();

  return (
    <aside className="w-80 max-w-[85vw] h-full shrink-0 border-l flex flex-col border-line bg-bg1">
      <div className="lg:hidden flex items-center justify-between px-4 h-14 border-b border-line shrink-0">
        <span className="font-mono text-xs uppercase tracking-wider text-txt2">Trading</span>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-bg3 text-txt1">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="overflow-y-auto flex-1 flex flex-col">
        {/* Watchlist is pinned above the collapsible groups — it's the one
            panel that drives everything else below it, so it never hides. */}
        <div className="px-4 py-3.5 border-b border-line bg-bg2/40">
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-txt2 mb-2.5">
            <Icon name="trend-up" size={12} /> Watchlist
          </div>
          <WatchlistEditor onSelectSymbol={(symbol) => setChartItem(watchlist.find((w) => w.symbol === symbol) ?? null)} />
        </div>

        <CollapsibleGroup id="market" title="Market Intelligence" icon="trend-up" count={6}>
          <SectionBlock title="Multi-Timeframe" icon="trend-up">
            <MTFBadges />
          </SectionBlock>
          <SectionBlock title="Liquidity & Volume" icon="trend-up">
            <LiquidityVolumePanel />
          </SectionBlock>
          <SectionBlock title="Order Flow" icon="trend-up">
            <OrderFlowPanel />
          </SectionBlock>
          <SectionBlock title="Market Intelligence" icon="search">
            <MarketIntelPanel />
          </SectionBlock>
          <SectionBlock title="Multi-Exchange" icon="refresh">
            <MultiExchangePanel />
          </SectionBlock>
          <SectionBlock title="Market News" icon="edit">
            <NewsPanel />
          </SectionBlock>
        </CollapsibleGroup>

        <CollapsibleGroup id="strategy" title="Strategy & AI" icon="terminal" count={8}>
          <SectionBlock title="Mission Planner" icon="cpu">
            <MissionPlannerPanel />
          </SectionBlock>
          <SectionBlock title="Autonomous Trader" icon="cpu">
            <AutonomousTraderPanel />
          </SectionBlock>
          <SectionBlock title="Strategy Ensemble" icon="trend-up">
            <StrategyEnsemblePanel />
          </SectionBlock>
          <SectionBlock title="Debate System" icon="terminal">
            <DebatePanel />
          </SectionBlock>
          <SectionBlock title="Autonomous Research" icon="search">
            <AutonomousResearchPanel />
          </SectionBlock>
          <SectionBlock title="Trading Agent" icon="terminal">
            <AgentPanel />
          </SectionBlock>
          <SectionBlock title="Backtest Lab" icon="trend-up">
            <div className="flex flex-col gap-2">
              <p className="text-[11px] text-txt2">Replay any strategy (or the full ensemble) against real historical candles, and grid-search a tunable EMA/RSI strategy with walk-forward validation.</p>
              <Link href="/backtest" className="px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 hover:border-amberDim transition text-center">
                Open Backtest Lab
              </Link>
            </div>
          </SectionBlock>
          <SectionBlock title="Learning Dashboard" icon="save">
            <div className="flex flex-col gap-2">
              <p className="text-[11px] text-txt2">Win rate by origin/market condition/volatility regime/weekday/time-of-day, expectancy, hold time, and max drawdown — all computed from the real trade log.</p>
              <Link href="/dashboard" className="px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 hover:border-amberDim transition text-center">
                Open Learning Dashboard
              </Link>
            </div>
          </SectionBlock>
        </CollapsibleGroup>

        <CollapsibleGroup id="risk" title="Risk & Controls" icon="shield" count={7}>
          <SectionBlock title="Trading Controls" icon="stop">
            <TradingControlsPanel />
          </SectionBlock>
          <SectionBlock title="Exchange Connections" icon="plug">
            <ExchangeConnectionsPanel />
          </SectionBlock>
          <SectionBlock
            title="Audit Trail"
            icon="search"
            action={
              <Link href="/audit" className="text-[10px] font-mono text-txt2 hover:text-amber transition">
                Open full log
              </Link>
            }
          >
            <p className="text-[11px] text-txt2">Every Supervisor decision — approved, rejected, or queued for manual approval — persisted with full risk-check evidence.</p>
          </SectionBlock>
          <SectionBlock title="Risk Manager" icon="alert">
            <RiskManagerPanel />
          </SectionBlock>
          <SectionBlock title="Portfolio Intelligence" icon="shield">
            <PortfolioIntelligencePanel />
          </SectionBlock>
          <SectionBlock title="Event Detection" icon="alert">
            <EventDetectionPanel />
          </SectionBlock>
          <SectionBlock title="System Health" icon="shield">
            <SystemHealthPanel />
          </SectionBlock>
        </CollapsibleGroup>

        <CollapsibleGroup id="agent-os" title="Agent OS" icon="cpu" count={27}>
          <SectionBlock title="Multi-Agent Runtime" icon="cpu">
            <AgentOSPanel />
          </SectionBlock>
        </CollapsibleGroup>

        <CollapsibleGroup id="portfolio" title="Portfolio & History" icon="wallet" count={6}>
          <SectionBlock
            title="Portfolio"
            icon="wallet"
            action={
              <div className="flex gap-1 text-[10px] font-mono">
                <button onClick={() => setTab('paper')} className={`tabbtn ${tab === 'paper' ? 'bg-bg3 text-amber' : 'text-txt2'}`}>
                  PAPER
                </button>
                <button onClick={() => setTab('real')} className={`tabbtn ${tab === 'real' ? 'bg-bg3 text-amber' : 'text-txt2'}`}>
                  REAL
                </button>
              </div>
            }
          >
            {tab === 'paper' ? <PaperTradePanel /> : <RealPortfolioPanel />}
          </SectionBlock>
          <SectionBlock title="Risk Meter" icon="shield">
            <RiskMeter tab={tab} />
          </SectionBlock>
          <SectionBlock title="Portfolio Stats" icon="wallet">
            <PortfolioStats tab={tab} />
          </SectionBlock>
          <SectionBlock title="Portfolio Analytics" icon="trend-up">
            <PortfolioAnalytics tab={tab} />
          </SectionBlock>
          <SectionBlock title="Trade Log" icon="terminal">
            <TradeLogPanel tab={tab} />
          </SectionBlock>
          <SectionBlock title="Memory & Trade Journal" icon="save">
            <MemoryPanel />
          </SectionBlock>
        </CollapsibleGroup>

        <CollapsibleGroup id="integrations" title="Integrations" icon="plug" count={1}>
          <SectionBlock title="MCP Bridges" icon="plug">
            <McpBridgesList />
          </SectionBlock>
        </CollapsibleGroup>
      </div>

      <ChartModal item={chartItem} onClose={() => setChartItem(null)} />
    </aside>
  );
}

function McpBridgesList() {
  const { servers, statusById } = useMcp();
  if (servers.length === 0) {
    return <p className="text-[11px] text-txt2">No MCP servers registered — add one from the plug icon in the header.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {servers.map((s) => {
        const st = statusById[s.id];
        const dotColor = st?.checking ? 'var(--amber)' : st?.reachable === true ? 'var(--green)' : st?.reachable === false ? 'var(--red)' : 'var(--txt-2)';
        return (
          <div key={s.id} className="flex items-center gap-1.5 text-[11px] font-mono">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
            <span className="truncate text-txt1">{s.name}</span>
          </div>
        );
      })}
      <p className="text-[10px] mt-1 text-txt2">Reachability only — no tool-calling wired into chat yet.</p>
    </div>
  );
}
