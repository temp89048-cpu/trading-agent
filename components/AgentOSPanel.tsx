'use client';

// =====================================================================
// Agent OS Panel — Phase 21
//
// Dashboard panel showing all registered agents, their lifecycle state,
// health metrics, and controls (pause/resume/restart). Lives in the
// Trading Sidebar.
// =====================================================================

import { useState } from 'react';
import { useAgentRuntime } from './AgentRuntime';
import { Icon } from './Icon';
import type { AgentCategory, AgentLifecycleState } from '@/lib/agentOS';

const STATE_COLORS: Record<AgentLifecycleState, string> = {
  init: 'var(--txt-2)',
  ready: 'var(--cyan)',
  running: 'var(--green)',
  paused: 'var(--amber)',
  stopped: 'var(--txt-2)',
  error: 'var(--red)',
  recovering: 'var(--amber)',
};

const STATE_LABELS: Record<AgentLifecycleState, string> = {
  init: 'INIT',
  ready: 'READY',
  running: 'RUNNING',
  paused: 'PAUSED',
  stopped: 'STOPPED',
  error: 'ERROR',
  recovering: 'RECOVERING',
};

const CATEGORY_LABELS: Record<AgentCategory, string> = {
  'market-intelligence': '📊 Market Intelligence',
  strategy: '🎯 Strategy',
  risk: '🛡️ Risk',
  execution: '⚡ Execution',
  learning: '🧠 Learning',
  orchestration: '🔗 Orchestration',
};

const CATEGORY_ORDER: AgentCategory[] = [
  'market-intelligence',
  'strategy',
  'risk',
  'execution',
  'orchestration',
  'learning',
];

export function AgentOSPanel() {
  const { snapshot, pauseAgent, resumeAgent, restartAgent } = useAgentRuntime();
  const [expandedCategory, setExpandedCategory] = useState<AgentCategory | null>(null);
  const [showDetails, setShowDetails] = useState<string | null>(null);

  // Group agents by category
  const grouped = new Map<AgentCategory, typeof snapshot.agents>();
  for (const cat of CATEGORY_ORDER) {
    grouped.set(cat, []);
  }
  for (const agent of snapshot.agents) {
    const group = grouped.get(agent.descriptor.category);
    if (group) group.push(agent);
  }

  // Summary counts
  const totalAgents = snapshot.agents.length;
  const runningCount = snapshot.agents.filter((a) => a.health.status === 'running').length;
  const errorCount = snapshot.agents.filter((a) => a.health.status === 'error').length;
  const pausedCount = snapshot.agents.filter((a) => a.health.status === 'paused').length;

  return (
    <div className="flex flex-col gap-2">
      {/* Header summary */}
      <div className="flex items-center justify-between text-[10px] font-mono">
        <div className="flex items-center gap-2">
          <span className="text-green">{runningCount}</span>
          <span className="text-txt2">running</span>
          {pausedCount > 0 && (
            <>
              <span className="text-amber">{pausedCount}</span>
              <span className="text-txt2">paused</span>
            </>
          )}
          {errorCount > 0 && (
            <>
              <span className="text-red">{errorCount}</span>
              <span className="text-txt2">error</span>
            </>
          )}
        </div>
        <span className="text-txt2">{totalAgents} agents</span>
      </div>

      {/* Scheduler status */}
      <div className="flex items-center gap-1.5 text-[9px] font-mono text-txt2">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: snapshot.schedulerRunning ? 'var(--green)' : 'var(--red)' }}
        />
        Scheduler {snapshot.schedulerRunning ? 'active' : 'stopped'}
      </div>

      {/* Category groups */}
      {CATEGORY_ORDER.map((category) => {
        const agents = grouped.get(category);
        if (!agents || agents.length === 0) return null;
        const isExpanded = expandedCategory === category;
        const catRunning = agents.filter((a) => a.health.status === 'running').length;
        const catError = agents.filter((a) => a.health.status === 'error').length;

        return (
          <div key={category} className="rounded border border-line bg-bg1">
            {/* Category header */}
            <button
              onClick={() => setExpandedCategory(isExpanded ? null : category)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-[10px] font-mono hover-lift"
            >
              <span className="text-txt0 font-semibold">{CATEGORY_LABELS[category]}</span>
              <div className="flex items-center gap-2">
                <span className="text-txt2">
                  {catRunning}/{agents.length}
                  {catError > 0 && <span className="text-red ml-1">⚠ {catError}</span>}
                </span>
                <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={10} />
              </div>
            </button>

            {/* Agent list */}
            {isExpanded && (
              <div className="border-t border-line">
                {agents.map((agent) => {
                  const { descriptor: d, health: h } = agent;
                  const isDetailOpen = showDetails === d.id;

                  return (
                    <div key={d.id} className="border-b border-line last:border-b-0">
                      {/* Agent row */}
                      <div className="flex items-center justify-between px-2 py-1 text-[10px] font-mono">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0 pulse"
                            style={{ background: STATE_COLORS[h.status], animationPlayState: h.status === 'running' ? 'running' : 'paused' }}
                          />
                          <button
                            className="text-txt0 truncate hover:text-amber transition-colors text-left"
                            onClick={() => setShowDetails(isDetailOpen ? null : d.id)}
                            title={d.description}
                          >
                            {d.name}
                          </button>
                          <span className="text-txt2 text-[8px] shrink-0">v{d.version}</span>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <span
                            className="text-[8px] px-1 py-0.5 rounded"
                            style={{ color: STATE_COLORS[h.status] }}
                          >
                            {STATE_LABELS[h.status]}
                          </span>
                          {h.status === 'running' && (
                            <button
                              onClick={() => pauseAgent(d.id)}
                              className="p-0.5 rounded hover:text-amber text-txt2"
                              title="Pause"
                            >
                              <Icon name="pause" size={9} />
                            </button>
                          )}
                          {h.status === 'paused' && (
                            <button
                              onClick={() => resumeAgent(d.id)}
                              className="p-0.5 rounded hover:text-green text-txt2"
                              title="Resume"
                            >
                              <Icon name="play" size={9} />
                            </button>
                          )}
                          {h.status === 'error' && (
                            <button
                              onClick={() => restartAgent(d.id)}
                              className="p-0.5 rounded hover:text-cyan text-txt2"
                              title="Restart"
                            >
                              <Icon name="refresh-cw" size={9} />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Agent details */}
                      {isDetailOpen && (
                        <div className="px-2 pb-1.5 pt-0.5 bg-bg2 flex flex-col gap-1 text-[9px] font-mono text-txt2">
                          <p>{d.description}</p>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                            <span>ticks: {h.totalTicks}</span>
                            <span>errors: {h.totalErrors}</span>
                            {h.tickDurationsMs.length > 0 && (
                              <span>avg: {(h.tickDurationsMs.reduce((a, b) => a + b, 0) / h.tickDurationsMs.length).toFixed(0)}ms</span>
                            )}
                            {h.lastHeartbeat > 0 && (
                              <span>last: {Math.round((Date.now() - h.lastHeartbeat) / 1000)}s ago</span>
                            )}
                          </div>
                          {h.lastError && (
                            <p className="text-red truncate" title={h.lastError}>
                              last error: {h.lastError}
                            </p>
                          )}
                          {d.dependencies.length > 0 && (
                            <p className="text-txt2">
                              deps: {d.dependencies.join(', ')}
                            </p>
                          )}
                          {d.capabilities.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {d.capabilities.map((cap) => (
                                <span key={cap} className="px-1 py-0.5 rounded border border-line text-[8px]">
                                  {cap}
                                </span>
                              ))}
                            </div>
                          )}
                          {d.changelog && (
                            <p className="text-txt2 italic">{d.changelog}</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <p className="text-[8px] text-txt2">
        Phase 21 — Multi-Agent Operating System. Registry, lifecycle, health monitoring, dependency graph, sandboxed execution.
      </p>
    </div>
  );
}
