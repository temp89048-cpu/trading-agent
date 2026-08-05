// =====================================================================
// Agent Operating System — Phase 21
//
// The central runtime kernel for the Multi-Agent Operating System.
// Provides: Agent Registry, Lifecycle Management, Scheduler,
// Dependency Graph, Heartbeat/Health, Capability Discovery,
// Sandboxing, and Isolation.
//
// This sits ALONGSIDE the existing 17 React context providers — it
// does not replace them. It provides a formal registry, monitoring
// overlay, and scheduling framework on top of the existing
// architecture. Each provider's existing logic continues to work
// as-is; the Agent OS tracks and orchestrates them.
// =====================================================================

// ---- Types ----------------------------------------------------------

export type AgentId = string;

export type AgentCapability =
  | 'live-price'
  | 'tick-stream'
  | 'ohlc-history'
  | 'multi-timeframe'
  | 'trend-detection'
  | 'structure-events'
  | 'liquidity-zones'
  | 'sweep-detection'
  | 'poc'
  | 'value-area'
  | 'bid-ask-imbalance'
  | 'pressure'
  | 'news-sentiment'
  | 'funding-analysis'
  | 'signal-generation'
  | 'cross-exchange'
  | 'consensus-signal'
  | 'trade-validation'
  | 'position-sizing'
  | 'post-trade-analysis'
  | 'conditional-plans'
  | 'multi-analyst-debate'
  | 'trade-approval'
  | 'conflict-resolution'
  | 'anomaly-detection'
  | 'opportunity-discovery'
  | 'memory-persistence'
  | 'portfolio-analysis'
  | 'correlation-analysis'
  | 'mission-planning'
  | 'trade-alignment'
  | 'strategic-goal-tracking';

export type AgentCategory =
  | 'market-intelligence'
  | 'strategy'
  | 'risk'
  | 'execution'
  | 'learning'
  | 'orchestration';

export type AgentLifecycleState =
  | 'init'
  | 'ready'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'error'
  | 'recovering';

// Valid state transitions — enforced by transitionState().
// init → ready: agent registered and dependencies satisfied
// ready → running: scheduler activates the agent
// running → paused: operator or dependency pause
// paused → running: resume
// running → stopped: clean shutdown
// running → error: unhandled exception during tick
// error → recovering: auto-recovery attempt begins
// recovering → ready: recovery succeeded
// recovering → error: recovery failed
// stopped → ready: re-registration
const VALID_TRANSITIONS: Record<AgentLifecycleState, AgentLifecycleState[]> = {
  init: ['ready', 'error'],
  ready: ['running', 'stopped', 'error'],
  running: ['paused', 'stopped', 'error'],
  paused: ['running', 'stopped', 'error'],
  stopped: ['ready'],
  error: ['recovering', 'stopped'],
  recovering: ['ready', 'error', 'stopped'],
};

export type AgentDescriptor = {
  id: AgentId;
  name: string;
  version: string;
  description: string;
  changelog?: string;
  capabilities: AgentCapability[];
  dependencies: AgentId[];
  category: AgentCategory;
  priority: number; // lower = higher priority (0 = highest)
  tickIntervalMs: number; // 0 = on-demand only, never auto-scheduled
};

export type AgentHealthRecord = {
  agentId: AgentId;
  lastHeartbeat: number; // timestamp of last successful tick
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveErrors: number;
  totalTicks: number;
  totalErrors: number;
  tickDurationsMs: number[]; // last N durations for avg computation
  status: AgentLifecycleState;
};

export type AgentTickFn = (agentId: AgentId) => void | Promise<void>;

type RegisteredAgent = {
  descriptor: AgentDescriptor;
  health: AgentHealthRecord;
  tickFn: AgentTickFn | null; // null = monitoring-only (no executable tick)
  lastScheduledAt: number;
};

// ---- Constants ------------------------------------------------------

const MAX_CONSECUTIVE_ERRORS = 5;
const RECOVERY_COOLDOWN_MS = 10_000; // wait 10s before attempting recovery
const TICK_DURATION_HISTORY = 20; // keep last 20 tick durations for avg
const STALENESS_MULTIPLIER = 3; // a heartbeat is stale if > 3× its tick interval
const TICK_WARN_DURATION_MS = 1000; // warn if a tick takes longer than 1s

// ---- Agent OS Runtime -----------------------------------------------

export class AgentOS {
  private agents = new Map<AgentId, RegisteredAgent>();
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private schedulerTickMs = 1000; // base scheduler tick rate
  private listeners = new Set<() => void>();

  // -- Registry -------------------------------------------------------

  register(descriptor: AgentDescriptor, tickFn: AgentTickFn | null = null): void {
    if (this.agents.has(descriptor.id)) {
      // Re-registration: update descriptor but preserve health state
      const existing = this.agents.get(descriptor.id)!;
      existing.descriptor = descriptor;
      existing.tickFn = tickFn;
      this.notify();
      return;
    }
    this.agents.set(descriptor.id, {
      descriptor,
      health: {
        agentId: descriptor.id,
        lastHeartbeat: 0,
        lastError: null,
        lastErrorAt: null,
        consecutiveErrors: 0,
        totalTicks: 0,
        totalErrors: 0,
        tickDurationsMs: [],
        status: 'init',
      },
      tickFn,
      lastScheduledAt: 0,
    });
    // Auto-transition to ready if dependencies are satisfied
    this.tryReady(descriptor.id);
    this.notify();
  }

  unregister(id: AgentId): boolean {
    const deleted = this.agents.delete(id);
    if (deleted) this.notify();
    return deleted;
  }

  getAgent(id: AgentId): RegisteredAgent | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  getDescriptor(id: AgentId): AgentDescriptor | undefined {
    return this.agents.get(id)?.descriptor;
  }

  getAllDescriptors(): AgentDescriptor[] {
    return this.getAllAgents().map((a) => a.descriptor);
  }

  // -- Lifecycle ------------------------------------------------------

  private transitionState(id: AgentId, to: AgentLifecycleState): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const from = agent.health.status;
    if (!VALID_TRANSITIONS[from]?.includes(to)) return false;
    agent.health.status = to;
    this.notify();
    return true;
  }

  private tryReady(id: AgentId): void {
    const agent = this.agents.get(id);
    if (!agent || agent.health.status !== 'init') return;
    const depsOk = agent.descriptor.dependencies.every((depId) => {
      const dep = this.agents.get(depId);
      return dep && (dep.health.status === 'ready' || dep.health.status === 'running');
    });
    if (depsOk) {
      this.transitionState(id, 'ready');
    }
  }

  pauseAgent(id: AgentId): boolean {
    return this.transitionState(id, 'paused');
  }

  resumeAgent(id: AgentId): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.health.status === 'paused') {
      return this.transitionState(id, 'running');
    }
    if (agent.health.status === 'error') {
      return this.transitionState(id, 'recovering');
    }
    return false;
  }

  stopAgent(id: AgentId): boolean {
    return this.transitionState(id, 'stopped');
  }

  restartAgent(id: AgentId): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    // Reset health
    agent.health.consecutiveErrors = 0;
    agent.health.lastError = null;
    agent.health.lastErrorAt = null;
    // Transition through stopped → ready if possible
    if (agent.health.status === 'error' || agent.health.status === 'running' || agent.health.status === 'paused') {
      agent.health.status = 'stopped';
    }
    agent.health.status = 'init';
    this.tryReady(id);
    // If ready and scheduler is running, auto-start. Use getStatus()
    // to read current state — tryReady() may have mutated it, but TS
    // narrows agent.health.status to 'init' and won't let us compare
    // directly. getStatus() crosses a method-call boundary that resets
    // narrowing.
    if (this.getStatus(id) === 'ready' && this.schedulerInterval !== null) {
      this.transitionState(id, 'running');
    }
    this.notify();
    return true;
  }

  getStatus(id: AgentId): AgentLifecycleState | undefined {
    return this.agents.get(id)?.health.status;
  }

  // -- Heartbeat & Health ---------------------------------------------

  recordHeartbeat(id: AgentId, durationMs: number): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.health.lastHeartbeat = Date.now();
    agent.health.totalTicks++;
    agent.health.consecutiveErrors = 0;
    agent.health.tickDurationsMs.push(durationMs);
    if (agent.health.tickDurationsMs.length > TICK_DURATION_HISTORY) {
      agent.health.tickDurationsMs.shift();
    }
    if (durationMs > TICK_WARN_DURATION_MS) {
      console.warn(`[AgentOS] Agent "${id}" tick took ${durationMs}ms (threshold: ${TICK_WARN_DURATION_MS}ms)`);
    }
  }

  recordError(id: AgentId, error: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.health.lastError = error;
    agent.health.lastErrorAt = Date.now();
    agent.health.consecutiveErrors++;
    agent.health.totalErrors++;
    if (agent.health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      this.transitionState(id, 'error');
    }
  }

  getHealth(id: AgentId): AgentHealthRecord | undefined {
    return this.agents.get(id)?.health;
  }

  getAllHealth(): AgentHealthRecord[] {
    return this.getAllAgents().map((a) => a.health);
  }

  getAvgTickDuration(id: AgentId): number | null {
    const agent = this.agents.get(id);
    if (!agent || agent.health.tickDurationsMs.length === 0) return null;
    const sum = agent.health.tickDurationsMs.reduce((a, b) => a + b, 0);
    return sum / agent.health.tickDurationsMs.length;
  }

  isStale(id: AgentId): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.descriptor.tickIntervalMs === 0) return false; // on-demand agents can't be stale
    if (agent.health.lastHeartbeat === 0) return false; // never ticked yet
    const elapsed = Date.now() - agent.health.lastHeartbeat;
    return elapsed > agent.descriptor.tickIntervalMs * STALENESS_MULTIPLIER;
  }

  // -- Capability Discovery -------------------------------------------

  findByCapability(capability: AgentCapability): AgentDescriptor[] {
    return this.getAllDescriptors().filter((d) => d.capabilities.includes(capability));
  }

  findByCategory(category: AgentCategory): AgentDescriptor[] {
    return this.getAllDescriptors().filter((d) => d.category === category);
  }

  hasCapability(id: AgentId, capability: AgentCapability): boolean {
    const descriptor = this.getDescriptor(id);
    return descriptor?.capabilities.includes(capability) ?? false;
  }

  // -- Dependency Graph -----------------------------------------------

  /** Returns agents in topological order (dependencies before dependents). */
  getExecutionOrder(): AgentId[] {
    const visited = new Set<AgentId>();
    const visiting = new Set<AgentId>(); // cycle detection
    const result: AgentId[] = [];

    const visit = (id: AgentId) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        console.error(`[AgentOS] Circular dependency detected involving agent "${id}"`);
        return; // break cycle, don't crash
      }
      visiting.add(id);
      const agent = this.agents.get(id);
      if (agent) {
        for (const dep of agent.descriptor.dependencies) {
          visit(dep);
        }
      }
      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };

    // Sort by priority first, then topological order preserves it
    const byPriority = this.getAllAgents()
      .sort((a, b) => a.descriptor.priority - b.descriptor.priority)
      .map((a) => a.descriptor.id);

    for (const id of byPriority) {
      visit(id);
    }
    return result;
  }

  /** Returns all agents that depend on the given agent (direct dependents). */
  getDependents(id: AgentId): AgentId[] {
    return this.getAllAgents()
      .filter((a) => a.descriptor.dependencies.includes(id))
      .map((a) => a.descriptor.id);
  }

  /** Validates the dependency graph — returns list of issues. */
  validateDependencies(): string[] {
    const issues: string[] = [];
    for (const agent of this.getAllAgents()) {
      for (const dep of agent.descriptor.dependencies) {
        if (!this.agents.has(dep)) {
          issues.push(`Agent "${agent.descriptor.id}" depends on "${dep}", which is not registered.`);
        }
      }
    }
    // Check for circular dependencies
    const visited = new Set<AgentId>();
    const visiting = new Set<AgentId>();
    const checkCycle = (id: AgentId, path: AgentId[]): boolean => {
      if (visiting.has(id)) {
        issues.push(`Circular dependency: ${[...path, id].join(' → ')}`);
        return true;
      }
      if (visited.has(id)) return false;
      visiting.add(id);
      const agent = this.agents.get(id);
      if (agent) {
        for (const dep of agent.descriptor.dependencies) {
          if (checkCycle(dep, [...path, id])) return true;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    for (const id of this.agents.keys()) {
      checkCycle(id, []);
    }
    return issues;
  }

  // -- Scheduler ------------------------------------------------------

  /** Starts the global scheduler. Agents in 'ready' state are transitioned to 'running'. */
  startScheduler(tickMs: number = 1000): void {
    if (this.schedulerInterval !== null) return; // already running
    this.schedulerTickMs = tickMs;

    // Transition all ready agents to running
    for (const agent of this.getAllAgents()) {
      if (agent.health.status === 'ready') {
        this.transitionState(agent.descriptor.id, 'running');
      }
    }

    this.schedulerInterval = setInterval(() => {
      this.tick();
    }, this.schedulerTickMs);
  }

  stopScheduler(): void {
    if (this.schedulerInterval !== null) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    // Transition all running agents to stopped
    for (const agent of this.getAllAgents()) {
      if (agent.health.status === 'running') {
        this.transitionState(agent.descriptor.id, 'stopped');
      }
    }
  }

  isSchedulerRunning(): boolean {
    return this.schedulerInterval !== null;
  }

  /** One scheduler tick — runs all due agents in dependency order. */
  private tick(): void {
    const now = Date.now();
    const executionOrder = this.getExecutionOrder();

    for (const id of executionOrder) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      if (agent.health.status !== 'running') continue;
      if (!agent.tickFn) continue; // monitoring-only agent
      if (agent.descriptor.tickIntervalMs === 0) continue; // on-demand only

      // Check if this agent is due for a tick
      const elapsed = now - agent.lastScheduledAt;
      if (elapsed < agent.descriptor.tickIntervalMs) continue;

      // Check dependency health — pause this agent if a dependency is unhealthy
      const depsHealthy = agent.descriptor.dependencies.every((depId) => {
        const dep = this.agents.get(depId);
        return dep && (dep.health.status === 'running' || dep.health.status === 'ready');
      });
      if (!depsHealthy) {
        // Don't error out — just skip this tick, dependency may recover
        continue;
      }

      // Sandboxed execution — isolate each agent's tick
      agent.lastScheduledAt = now;
      const startTime = performance.now();
      try {
        const result = agent.tickFn(id);
        // Handle async tick functions
        if (result instanceof Promise) {
          result
            .then(() => {
              const duration = Math.round(performance.now() - startTime);
              this.recordHeartbeat(id, duration);
            })
            .catch((err) => {
              const duration = Math.round(performance.now() - startTime);
              this.recordHeartbeat(id, duration);
              this.recordError(id, err instanceof Error ? err.message : String(err));
            });
        } else {
          const duration = Math.round(performance.now() - startTime);
          this.recordHeartbeat(id, duration);
        }
      } catch (err) {
        const duration = Math.round(performance.now() - startTime);
        this.recordHeartbeat(id, duration);
        this.recordError(id, err instanceof Error ? err.message : String(err));
      }
    }

    // Auto-recovery: attempt to recover agents in 'error' state after cooldown
    for (const agent of this.getAllAgents()) {
      if (agent.health.status !== 'error') continue;
      if (!agent.health.lastErrorAt) continue;
      if (now - agent.health.lastErrorAt < RECOVERY_COOLDOWN_MS) continue;
      // Attempt recovery
      agent.health.consecutiveErrors = 0;
      if (this.transitionState(agent.descriptor.id, 'recovering')) {
        // Check if dependencies are still OK
        const depsOk = agent.descriptor.dependencies.every((depId) => {
          const dep = this.agents.get(depId);
          return dep && (dep.health.status === 'ready' || dep.health.status === 'running');
        });
        if (depsOk) {
          this.transitionState(agent.descriptor.id, 'ready');
          this.transitionState(agent.descriptor.id, 'running');
        } else {
          this.transitionState(agent.descriptor.id, 'error');
        }
      }
    }

    this.notify();
  }

  // -- Subscription (for React re-renders) ----------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // -- Snapshot (for useSyncExternalStore) -----------------------------

  getSnapshot(): { agents: RegisteredAgent[]; schedulerRunning: boolean } {
    return {
      agents: this.getAllAgents(),
      schedulerRunning: this.isSchedulerRunning(),
    };
  }

  // -- Destroy --------------------------------------------------------

  destroy(): void {
    this.stopScheduler();
    this.agents.clear();
    this.listeners.clear();
  }
}

// Singleton instance — created once, shared across the app.
// Components access it via the AgentRuntime React context provider.
let _instance: AgentOS | null = null;

export function getAgentOS(): AgentOS {
  if (!_instance) {
    _instance = new AgentOS();
  }
  return _instance;
}

export function resetAgentOS(): void {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}
