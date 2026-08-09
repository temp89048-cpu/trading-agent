import { describe, it, expect } from 'vitest';
import { contractCoverage, SOLE_EXECUTION_AUTHORITY, type AgentDescriptor } from './agentOS';
import { AGENT_DESCRIPTORS } from './agentDescriptors';

// These are the "try to break the safety principles" tests the
// engineering spec (Section 22.9) calls the most important tests in the
// system. They guard architectural invariants, not behavior — a failure
// here means someone gave an agent authority it must not have.

function descriptor(overrides: Partial<AgentDescriptor> & { id: string }): AgentDescriptor {
  return {
    name: 'Test',
    version: '1.0.0',
    description: 'test',
    capabilities: [],
    dependencies: [],
    category: 'strategy',
    priority: 0,
    tickIntervalMs: 0,
    ...overrides,
  } as AgentDescriptor;
}

function contract(permissions: NonNullable<AgentDescriptor['contract']>['permissions']): NonNullable<AgentDescriptor['contract']> {
  return {
    purpose: 'p',
    inputs: [],
    outputs: [],
    permissions,
    memory: 'none',
    metrics: [],
    failureRecovery: 'r',
    healthCheck: 'h',
    explainability: 'e',
  };
}

describe('agent contract coverage', () => {
  it('counts specified vs missing contracts', () => {
    const result = contractCoverage([
      descriptor({ id: 'a', contract: contract(['read-market-data']) }),
      descriptor({ id: 'b' }),
    ]);
    expect(result.total).toBe(2);
    expect(result.withContract).toBe(1);
    expect(result.missing).toEqual(['b']);
  });

  it('handles an empty descriptor list without throwing', () => {
    const result = contractCoverage([]);
    expect(result).toEqual({ total: 0, withContract: 0, missing: [], unexpectedExecutionAuthority: [] });
  });
});

describe('single execution authority (safety invariant)', () => {
  it('flags any non-Supervisor agent claiming execute-trades', () => {
    const result = contractCoverage([
      descriptor({ id: 'rogue-strategy', contract: contract(['execute-trades']) }),
    ]);
    expect(result.unexpectedExecutionAuthority).toEqual(['rogue-strategy']);
  });

  it('permits the Supervisor to hold execute-trades', () => {
    const result = contractCoverage([
      descriptor({ id: SOLE_EXECUTION_AUTHORITY, contract: contract(['execute-trades']) }),
    ]);
    expect(result.unexpectedExecutionAuthority).toEqual([]);
  });

  it('does not flag an agent that only proposes trades', () => {
    // The autonomous trader proposes; it must never execute directly.
    const result = contractCoverage([
      descriptor({ id: 'autonomous-trader', contract: contract(['propose-trade']) }),
    ]);
    expect(result.unexpectedExecutionAuthority).toEqual([]);
  });

  it('THE REAL REGISTRY has exactly one execution authority, and it is the Supervisor', () => {
    // This is the test that actually matters — it runs against the live
    // descriptor list, so adding a rogue 'execute-trades' permission
    // anywhere in the real system fails the suite.
    const result = contractCoverage(AGENT_DESCRIPTORS);
    expect(result.unexpectedExecutionAuthority).toEqual([]);

    const executors = AGENT_DESCRIPTORS.filter((d) => d.contract?.permissions.includes('execute-trades')).map((d) => d.id);
    expect(executors).toEqual([SOLE_EXECUTION_AUTHORITY]);
  });

  it('THE REAL REGISTRY keeps the learning layer walled off from execution', () => {
    // Spec Section 12's hard rule: learning improves understanding and
    // must never deploy anything. No learning-category agent may hold
    // propose-trade or execute-trades.
    const learningAgents = AGENT_DESCRIPTORS.filter((d) => d.category === 'learning' && d.contract);
    for (const agent of learningAgents) {
      const perms = agent.contract!.permissions;
      expect(perms, `${agent.id} must not execute trades`).not.toContain('execute-trades');
      expect(perms, `${agent.id} must not propose trades`).not.toContain('propose-trade');
    }
  });

  it('THE REAL REGISTRY marks the hypothesis agent as human-gated', () => {
    // The hypothesis pipeline is the one place a "learn and change
    // something" path could plausibly be introduced, so its human gate
    // is asserted explicitly rather than left to review.
    const hypothesis = AGENT_DESCRIPTORS.find((d) => d.id === 'hypothesis');
    expect(hypothesis?.contract?.permissions).toContain('human-gated');
  });
});

describe('registry hygiene', () => {
  it('has no duplicate agent ids', () => {
    const ids = AGENT_DESCRIPTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every declared dependency refers to a real registered agent', () => {
    const ids = new Set(AGENT_DESCRIPTORS.map((d) => d.id));
    for (const d of AGENT_DESCRIPTORS) {
      for (const dep of d.dependencies) {
        expect(ids.has(dep), `${d.id} depends on unknown agent "${dep}"`).toBe(true);
      }
    }
  });

  it('no agent declares itself as its own dependency', () => {
    for (const d of AGENT_DESCRIPTORS) {
      expect(d.dependencies, `${d.id} depends on itself`).not.toContain(d.id);
    }
  });

  it('every contract states a failure-recovery and health-check story', () => {
    // "Must degrade safely, never fail silently" is only meaningful if
    // someone actually wrote down what happens.
    for (const d of AGENT_DESCRIPTORS) {
      if (!d.contract) continue;
      expect(d.contract.failureRecovery.length, `${d.id} failureRecovery`).toBeGreaterThan(0);
      expect(d.contract.healthCheck.length, `${d.id} healthCheck`).toBeGreaterThan(0);
      expect(d.contract.explainability.length, `${d.id} explainability`).toBeGreaterThan(0);
    }
  });
});
