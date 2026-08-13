'use client';

// =====================================================================
// Mission Planner Panel — Phase 22
//
// Sidebar panel for creating, monitoring, and managing strategic
// missions. Shows the active mission's progress, constraints, and
// alignment with recent trades.
// =====================================================================

import { useState } from 'react';
import { Icon } from './Icon';
import { useMissionPlanner } from './MissionPlanner';
import {
  MISSION_TYPE_LABELS,
  MISSION_STATUS_LABELS,
  describeMissionTarget,
  type MissionType,
  type MissionTarget,
  type MissionStatus,
} from '@/lib/missionPlanner';

const STATUS_COLORS: Record<MissionStatus, string> = {
  active: 'var(--green)',
  paused: 'var(--amber)',
  completed: 'var(--cyan)',
  failed: 'var(--red)',
  expired: 'var(--txt-2)',
};

const PROGRESS_COLORS: Record<string, string> = {
  'on-track': 'var(--green)',
  ahead: 'var(--cyan)',
  behind: 'var(--amber)',
  'at-risk': 'var(--red)',
};

type CreationStep = 'idle' | 'type' | 'params';

export function MissionPlannerPanel() {
  const { missions, activeMission, createMission, updateMissionStatus, deleteMission } = useMissionPlanner();
  const [creationStep, setCreationStep] = useState<CreationStep>('idle');
  const [selectedType, setSelectedType] = useState<MissionType>('growth');
  const [name, setName] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  // Type-specific parameter inputs
  const [growthPct, setGrowthPct] = useState(5);
  const [growthDays, setGrowthDays] = useState(30);
  const [preserveDrawdown, setPreserveDrawdown] = useState(3);
  const [preserveDays, setPreserveDays] = useState(30);
  const [reductionExposure, setReductionExposure] = useState(20);
  const [reductionDays, setReductionDays] = useState(7);
  const [accumSymbol, setAccumSymbol] = useState('BTC/USDT');
  const [accumQty, setAccumQty] = useState(0.1);
  const [accumMaxCost, setAccumMaxCost] = useState(60000);
  const [cashPct, setCashPct] = useState(60);
  const [cashDays, setCashDays] = useState(14);
  const [capitalStart, setCapitalStart] = useState(25000);
  const [capitalTarget, setCapitalTarget] = useState(30000);
  const [agentLeverage, setAgentLeverage] = useState(1);

  function handleCreate() {
    let target: MissionTarget;
    const missionName = name || `${MISSION_TYPE_LABELS[selectedType]} Mission`;

    switch (selectedType) {
      case 'growth':
        target = { type: 'growth', targetPct: growthPct, timeframeDays: growthDays };
        break;
      case 'capital-preservation':
        target = { type: 'capital-preservation', maxDrawdownPct: preserveDrawdown, timeframeDays: preserveDays };
        break;
      case 'event-reduction':
        target = { type: 'event-reduction', targetExposurePct: reductionExposure, deadline: Date.now() + reductionDays * 24 * 60 * 60 * 1000 };
        break;
      case 'accumulation':
        target = { type: 'accumulation', symbol: accumSymbol, targetQty: accumQty, maxAvgCost: accumMaxCost };
        break;
      case 'cash-allocation':
        target = { type: 'cash-allocation', targetCashPct: cashPct, timeframeDays: cashDays };
        break;
      case 'capital-target':
        target = { type: 'capital-target', startEquityUsd: capitalStart, targetEquityUsd: capitalTarget };
        break;
    }

    createMission({
      type: selectedType,
      name: missionName,
      description: describeMissionTarget(target),
      target,
      constraints: [
        { kind: 'max-leverage', value: agentLeverage }
      ]
    });

    setCreationStep('idle');
    setName('');
  }

  const inactiveMissions = missions.filter((m) => m.status !== 'active');

  // ---- Active Mission Card ------------------------------------------
  if (activeMission) {
    const pct = activeMission.progress.currentPct;
    const progressColor = PROGRESS_COLORS[activeMission.progress.status] ?? 'var(--txt-2)';

    return (
      <div className="flex flex-col gap-2.5">
        {/* Active mission card */}
        <div className="rounded-md border border-line bg-bg2 px-2.5 py-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[10px] font-mono">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full shrink-0 pulse" style={{ background: 'var(--green)' }} />
              <span className="text-txt0 font-semibold truncate">{activeMission.name}</span>
            </div>
            <span className="text-[8px] px-1 py-0.5 rounded border border-line" style={{ color: STATUS_COLORS.active }}>
              {MISSION_STATUS_LABELS.active}
            </span>
          </div>

          <p className="text-[9px] text-txt2">{activeMission.description}</p>

          {/* Progress bar */}
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-[9px] font-mono">
              <span style={{ color: progressColor }}>{activeMission.progress.status.toUpperCase()}</span>
              <span className="text-txt2">{pct.toFixed(1)}%</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-bg3 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, pct)}%`, background: progressColor }}
              />
            </div>
          </div>

          <p className="text-[8px] text-txt2">{activeMission.progress.detail}</p>

          {/* Constraints summary */}
          {activeMission.constraints.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              {activeMission.constraints.map((c, i) => (
                <span key={i} className="text-[8px] font-mono px-1 py-0.5 rounded border border-line text-txt2">
                  {c.kind}: {('value' in c ? c.value : 'sides' in c ? c.sides.join('/') : 'symbols' in c ? c.symbols.join(',') : '')}
                </span>
              ))}
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-1 mt-1">
            <button
              onClick={() => updateMissionStatus(activeMission.id, 'paused')}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-line text-txt2 hover:text-amber hover:border-amber transition"
            >
              Pause
            </button>
            <button
              onClick={() => updateMissionStatus(activeMission.id, 'completed')}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-line text-txt2 hover:text-green hover:border-green transition"
            >
              Complete
            </button>
            <button
              onClick={() => updateMissionStatus(activeMission.id, 'failed')}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-line text-txt2 hover:text-red hover:border-red transition"
            >
              Fail
            </button>
          </div>
        </div>

        {/* History toggle */}
        {inactiveMissions.length > 0 && (
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="text-[9px] font-mono text-txt2 hover:text-amber transition flex items-center gap-1"
          >
            <Icon name={showHistory ? 'chevron-up' : 'chevron-down'} size={9} />
            {inactiveMissions.length} past mission{inactiveMissions.length > 1 ? 's' : ''}
          </button>
        )}

        {showHistory && (
          <div className="flex flex-col gap-1">
            {inactiveMissions.slice(0, 5).map((m) => (
              <div key={m.id} className="flex items-center justify-between text-[9px] font-mono px-2 py-1 rounded border border-line bg-bg1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="w-1 h-1 rounded-full shrink-0" style={{ background: STATUS_COLORS[m.status] }} />
                  <span className="text-txt2 truncate">{m.name}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span style={{ color: STATUS_COLORS[m.status] }}>{MISSION_STATUS_LABELS[m.status]}</span>
                  <button
                    onClick={() => deleteMission(m.id)}
                    className="p-0.5 rounded hover:text-red text-txt2"
                    title="Delete"
                  >
                    <Icon name="x" size={8} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- No active mission — show creation UI -------------------------
  if (creationStep === 'idle') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px] text-txt2">No active mission. Create one to give the AI a strategic goal.</p>
        <button
          onClick={() => setCreationStep('type')}
          className="px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 hover:border-amberDim transition text-center"
        >
          + Create Mission
        </button>

        {/* History */}
        {inactiveMissions.length > 0 && (
          <>
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="text-[9px] font-mono text-txt2 hover:text-amber transition flex items-center gap-1"
            >
              <Icon name={showHistory ? 'chevron-up' : 'chevron-down'} size={9} />
              {inactiveMissions.length} past mission{inactiveMissions.length > 1 ? 's' : ''}
            </button>
            {showHistory && (
              <div className="flex flex-col gap-1">
                {inactiveMissions.slice(0, 5).map((m) => (
                  <div key={m.id} className="flex items-center justify-between text-[9px] font-mono px-2 py-1 rounded border border-line bg-bg1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-1 h-1 rounded-full shrink-0" style={{ background: STATUS_COLORS[m.status] }} />
                      <span className="text-txt2 truncate">{m.name}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span style={{ color: STATUS_COLORS[m.status] }}>{MISSION_STATUS_LABELS[m.status]}</span>
                      {m.status === 'paused' && (
                        <button
                          onClick={() => updateMissionStatus(m.id, 'active')}
                          className="p-0.5 rounded hover:text-green text-txt2"
                          title="Resume"
                        >
                          <Icon name="play" size={8} />
                        </button>
                      )}
                      <button
                        onClick={() => deleteMission(m.id)}
                        className="p-0.5 rounded hover:text-red text-txt2"
                        title="Delete"
                      >
                        <Icon name="x" size={8} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (creationStep === 'type') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[10px] font-mono text-txt2 uppercase tracking-wider">Select Mission Type</p>
        {(Object.keys(MISSION_TYPE_LABELS) as MissionType[]).map((type) => (
          <button
            key={type}
            onClick={() => {
              setSelectedType(type);
              setCreationStep('params');
            }}
            className={`text-left px-2.5 py-2 rounded-md text-[10px] font-mono border transition ${
              selectedType === type ? 'border-amber bg-bg3 text-amber' : 'border-line bg-bg2 text-txt0 hover:bg-bg3 hover:border-amberDim'
            }`}
          >
            {MISSION_TYPE_LABELS[type]}
          </button>
        ))}
        <button
          onClick={() => setCreationStep('idle')}
          className="text-[9px] font-mono text-txt2 hover:text-amber transition"
        >
          Cancel
        </button>
      </div>
    );
  }

  // creationStep === 'params'
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-mono text-txt2 uppercase tracking-wider">
        {MISSION_TYPE_LABELS[selectedType]} — Parameters
      </p>

      <input
        type="text"
        placeholder="Mission name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full text-[10px] font-mono px-2 py-1.5 rounded border border-line bg-bg2 text-txt0 placeholder:text-txt2 focus:border-amber outline-none"
      />

      {selectedType === 'growth' && (
        <>
          <label className="text-[9px] font-mono text-txt2">
            Target growth %
            <input type="number" value={growthPct} onChange={(e) => setGrowthPct(Number(e.target.value))} min={0.1} step={0.5}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <label className="text-[9px] font-mono text-txt2">
            Timeframe (days)
            <input type="number" value={growthDays} onChange={(e) => setGrowthDays(Number(e.target.value))} min={1} step={1}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
        </>
      )}

      {selectedType === 'capital-preservation' && (
        <>
          <label className="text-[9px] font-mono text-txt2">
            Max drawdown %
            <input type="number" value={preserveDrawdown} onChange={(e) => setPreserveDrawdown(Number(e.target.value))} min={0.5} step={0.5}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <label className="text-[9px] font-mono text-txt2">
            Timeframe (days)
            <input type="number" value={preserveDays} onChange={(e) => setPreserveDays(Number(e.target.value))} min={1} step={1}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
        </>
      )}

      {selectedType === 'event-reduction' && (
        <>
          <label className="text-[9px] font-mono text-txt2">
            Target exposure %
            <input type="number" value={reductionExposure} onChange={(e) => setReductionExposure(Number(e.target.value))} min={0} max={100} step={5}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <label className="text-[9px] font-mono text-txt2">
            Deadline (days from now)
            <input type="number" value={reductionDays} onChange={(e) => setReductionDays(Number(e.target.value))} min={1} step={1}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
        </>
      )}

      {selectedType === 'accumulation' && (
        <>
          <label className="text-[9px] font-mono text-txt2">
            Symbol
            <input type="text" value={accumSymbol} onChange={(e) => setAccumSymbol(e.target.value)}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <label className="text-[9px] font-mono text-txt2">
            Target quantity
            <input type="number" value={accumQty} onChange={(e) => setAccumQty(Number(e.target.value))} min={0} step={0.01}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <label className="text-[9px] font-mono text-txt2">
            Max average cost ($)
            <input type="number" value={accumMaxCost} onChange={(e) => setAccumMaxCost(Number(e.target.value))} min={0} step={100}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
        </>
      )}

      {selectedType === 'cash-allocation' && (
        <>
          <label className="text-[9px] font-mono text-txt2">
            Target cash %
            <input type="number" value={cashPct} onChange={(e) => setCashPct(Number(e.target.value))} min={0} max={100} step={5}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <label className="text-[9px] font-mono text-txt2">
            Timeframe (days)
            <input type="number" value={cashDays} onChange={(e) => setCashDays(Number(e.target.value))} min={1} step={1}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
        </>
      )}

      {selectedType === 'capital-target' && (
        <>
          <label className="text-[9px] font-mono text-txt2">
            Starting capital ($)
            <input type="number" value={capitalStart} onChange={(e) => setCapitalStart(Number(e.target.value))} min={0.01} step={0.01}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <label className="text-[9px] font-mono text-txt2">
            Target capital ($)
            <input type="number" value={capitalTarget} onChange={(e) => setCapitalTarget(Number(e.target.value))} min={0.01} step={0.01}
              className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none" />
          </label>
          <p className="text-[8px] text-txt2">No fixed deadline — a hard time limit on a dollar target pushes toward unsafe risk-taking to hit the number in time. This only ever informs the Supervisor's caution notes, never a hard risk rule.</p>
        </>
      )}
            <div className="border-t border-line mt-2 pt-2">
              <label className="text-[10px] font-mono text-txt2 block mb-1">Agent Leverage</label>
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={agentLeverage}
                  onChange={(e) => setAgentLeverage(Math.max(1, Number(e.target.value)))}
                  className="bg-bg2 border border-line rounded px-2 py-1 w-20 text-txt0"
                />
                <span className="text-txt2">x (applied to spawned agents)</span>
              </div>
            </div>

      <div className="flex items-center gap-1.5 mt-1">
        <button
          onClick={handleCreate}
          className="flex-1 px-3 py-1.5 rounded-md text-[10px] font-mono bg-amber text-bg0 font-semibold hover:opacity-90 transition"
        >
          Create Mission
        </button>
        <button
          onClick={() => setCreationStep('type')}
          className="text-[9px] font-mono text-txt2 hover:text-amber transition px-2"
        >
          Back
        </button>
        <button
          onClick={() => setCreationStep('idle')}
          className="text-[9px] font-mono text-txt2 hover:text-red transition px-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
