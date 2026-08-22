// Stage B component logic.
//
// The exported pure functions — `buildJourney`, `mergeNodeStates`, `stageForNode` —
// carry the behaviour that would be invisible in a screenshot: which journey steps
// come back `unknown`, whether a node the stream never mentioned is dropped or shown
// as idle, and which stage a node belongs to. A mock-driven implementation would
// never exercise any of it, because mock data is always complete.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildJourney, type JourneySource } from './viz/journey';
import { EXEC_STAGES, mergeNodeStates, stageForNode } from './viz/flow';
import type { GraphNodeState } from './realtime/store';

const ROOT = path.resolve(__dirname, '..');

/** Source with comments stripped. Required for every source-text assertion —
 *  see the note in `designSystem.test.ts`: the naive form of this check matched
 *  the comment warning against the thing it checks. */
function code(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('TradeJourney.buildJourney', () => {
  it('always produces the 8 documented steps', () => {
    expect(buildJourney({})).toHaveLength(8);
    expect(buildJourney({}).map((s) => s.label)).toEqual([
      'Market Data',
      'Indicators',
      'Regime',
      'Strategy Signal',
      'Risk Checks',
      'Decision',
      'Execution',
      'Outcome',
    ]);
  });

  it('marks every step unknown when the run produced nothing', () => {
    // THE point of this component. A run that exited at strategy scoring must not
    // show PASS for risk checks that never ran — that would assert the agent
    // checked something it did not.
    const steps = buildJourney({});
    expect(steps.every((s) => s.state === 'unknown')).toBe(true);
  });

  it('gives every unknown step a reason', () => {
    // An unexplained gap in an explainability view defeats the view.
    for (const step of buildJourney({})) {
      expect(step.reason, step.label).toBeTruthy();
    }
  });

  it('does not mark risk checks as passed when the gateway was never reached', () => {
    const src: JourneySource = {
      symbol: 'BTC/USDT',
      price: 61000,
      strategy: 'MeanReversion',
      confidencePct: 71,
      // No `risk` — the run ended before the gateway.
    };
    const risk = buildJourney(src).find((s) => s.label === 'Risk Checks')!;
    expect(risk.state).toBe('unknown');
    expect(risk.reason).toMatch(/not reached/i);
  });

  it('marks risk FAIL when the gateway ran and refused', () => {
    const steps = buildJourney({ risk: { approved: false, passed: 6, total: 9 } });
    const risk = steps.find((s) => s.label === 'Risk Checks')!;
    expect(risk.state).toBe('fail');
    expect(risk.lines).toContain('6/9 passed');
  });

  it('shows an OPEN position as unknown outcome, not a flat result', () => {
    // The common case. A zero would read as "closed at breakeven".
    const outcome = buildJourney({ outcome: { status: 'OPEN' } }).find((s) => s.label === 'Outcome')!;
    expect(outcome.state).toBe('unknown');
    expect(outcome.reason).toMatch(/still open/i);
  });

  it('shows a realised loss as fail and a gain as ok', () => {
    expect(buildJourney({ outcome: { pnl: -212.4 } }).find((s) => s.label === 'Outcome')!.state).toBe('fail');
    expect(buildJourney({ outcome: { pnl: 212.4 } }).find((s) => s.label === 'Outcome')!.state).toBe('ok');
  });

  it('treats a zero P&L as a measured result, not as missing', () => {
    // `0` is a real outcome; only `null`/absent is unknown.
    const outcome = buildJourney({ outcome: { pnl: 0 } }).find((s) => s.label === 'Outcome')!;
    expect(outcome.state).toBe('ok');
    expect(outcome.lines[0]).toBe('+0.00');
  });

  it('warns rather than passes on a low-confidence signal', () => {
    expect(buildJourney({ strategy: 'X Y', confidencePct: 41 }).find((s) => s.label === 'Strategy Signal')!.state).toBe('warn');
    expect(buildJourney({ strategy: 'X Y', confidencePct: 71 }).find((s) => s.label === 'Strategy Signal')!.state).toBe('ok');
  });

  it('marks DO_NOT_TRADE as fail and WAIT as warn', () => {
    expect(buildJourney({ decision: { action: 'DO_NOT_TRADE' } }).find((s) => s.label === 'Decision')!.state).toBe('fail');
    expect(buildJourney({ decision: { action: 'WAIT' } }).find((s) => s.label === 'Decision')!.state).toBe('warn');
    expect(buildJourney({ decision: { action: 'TRADE' } }).find((s) => s.label === 'Decision')!.state).toBe('ok');
  });

  it('marks execution warn when nothing was submitted', () => {
    const exec = buildJourney({ execution: { submitted: false } }).find((s) => s.label === 'Execution')!;
    expect(exec.state).toBe('warn');
    expect(exec.lines).toContain('not submitted');
  });
});

describe('FlowDiagram.mergeNodeStates', () => {
  const live: Record<string, GraphNodeState> = {
    specialist_market: { name: 'specialist_market', status: 'COMPLETED', durationMs: 82, detail: 'ok', at: 1 },
    debate: { name: 'debate', status: 'RUNNING', durationMs: null, detail: null, at: 2 },
  };

  it('keeps the declared topology so the pipeline does not change shape', () => {
    // Rendering only nodes the stream mentioned would make the diagram grow during
    // a run and vanish between runs — a quiet system would look like a system with
    // no pipeline.
    const merged = mergeNodeStates(
      [{ name: 'specialist_market' }, { name: 'debate' }, { name: 'supervisor' }],
      live,
    );
    expect(merged.map((n) => n.name)).toEqual(['specialist_market', 'debate', 'supervisor']);
  });

  it('shows an unreported node as IDLE rather than dropping it', () => {
    const merged = mergeNodeStates([{ name: 'supervisor' }], live);
    expect(merged[0].status).toBe('IDLE');
    expect(merged[0].durationMs).toBeNull();
  });

  it('carries the live status, duration and detail through', () => {
    const merged = mergeNodeStates([{ name: 'specialist_market' }], live);
    expect(merged[0].status).toBe('COMPLETED');
    expect(merged[0].durationMs).toBe(82);
    expect(merged[0].detail).toBe('ok');
  });

  it('preserves the LLM flag from the contract', () => {
    // "Which node may call a model" is the most important property of this
    // pipeline; losing it in the merge would hide the one thing worth watching.
    const merged = mergeNodeStates([{ name: 'trade_thesis_narrative', mayCallLlm: true }], {});
    expect(merged[0].mayCallLlm).toBe(true);
  });
});

describe('ExecCycleStepper', () => {
  it('names the real pipeline, not the reference\'s invented labels', () => {
    // The reference uses Scan/Detect/Validate/Size/Fill/Settle — stages this
    // system does not have. Sizing happens inside Validate, and an operator
    // looking for a "Size" stage would be looking for something that is not there.
    expect(EXEC_STAGES.map((s) => s.label)).toEqual([
      'Trigger', 'Analyse', 'Decide', 'Validate', 'Submit', 'Fill',
    ]);
  });

  it('maps specialists and the debate to Analyse', () => {
    expect(stageForNode('specialist_prediction')).toBe('analyse');
    expect(stageForNode('debate')).toBe('analyse');
  });

  it('maps the supervisor to Decide and the gateway to Validate', () => {
    expect(stageForNode('supervisor')).toBe('decide');
    expect(stageForNode('risk_gateway')).toBe('validate');
  });

  it('returns null when nothing is running, so nothing highlights', () => {
    // An idle system must not appear to be mid-cycle.
    expect(stageForNode(null)).toBeNull();
  });
});

describe('honesty in the Stage B components', () => {
  it('the swarm viz is labelled illustrative and denies being a swarm', () => {
    const src = code('components/viz/AgentSwarmViz.tsx');
    expect(src).toContain('Illustrative');
    expect(src).toMatch(/not<\/strong> a multi-agent swarm/);
  });

  it('the swarm viz uses no Math.random in its layout', () => {
    // `Math.random()` in render re-randomises on every unrelated state change and
    // differs between server and client, which is a hydration mismatch.
    expect(code('components/viz/AgentSwarmViz.tsx')).not.toContain('Math.random');
  });

  it('the sparkline draws no invented shape', () => {
    expect(code('components/ui/Sparkline.tsx')).not.toContain('Math.random');
  });

  it('the Polymarket card does not call concern "relevance"', () => {
    // Renaming `concern` to "relevance" would match the mockup and tell the
    // operator something false: a constraint's concern is not a relevance score.
    const src = code('components/cards/PolymarketCard.tsx');
    expect(src).toContain('Event-risk concern');
    expect(src).toContain('Directional confidence');
    expect(src).not.toMatch(/Agent Relevance/);
  });

  it('the market card labels funding/OI when they describe another symbol', () => {
    // `fetch_macro_data` queries BTCUSDT specifically, so an unlabelled funding
    // rate under SOL is a wrong number, not a rounding.
    expect(code('components/cards/MarketCard.tsx')).toContain('macroSymbol');
  });

  it('the live inspector marks all three panels with their source', () => {
    // The specific thing the brief requires be visually verifiable.
    const src = code('components/modals/LiveAgentInspectorModal.tsx');
    expect(src).toContain('app/api/news');
    expect(src).toContain('polymarketSnapshots');
    expect(src).toContain('NODE_LEVEL_ONLY');
    expect(src).toMatch(/No sentiment or relevance is shown/);
  });

  it('no Stage B component contains the mock-data marker', () => {
    for (const f of [
      'components/viz/FlowDiagram.tsx',
      'components/viz/TradeJourney.tsx',
      'components/viz/ExecCycleStepper.tsx',
      'components/viz/AgentSwarmViz.tsx',
      'components/cards/MarketCard.tsx',
      'components/cards/PolymarketCard.tsx',
      'components/modals/LiveAgentInspectorModal.tsx',
      'components/ui/CandlestickChart.tsx',
      'components/ui/Sparkline.tsx',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).not.toContain('TODO: REMOVE MOCK DATA');
    }
  });
});
