import { defineConfig } from 'vitest/config';
import path from 'path';

// Unit tests targeting pure logic — agentEngine, riskManager, indicators, the
// backtest engine, the realtime event router, and the pure builders exported by
// the visualization components.
//
// The `@/` alias mirrors tsconfig.json's `paths` so tests import the same way app
// code does.
//
// NO JSX SUPPORT HERE, DELIBERATELY.
//
// `tsconfig.json` sets `jsx: "preserve"` because Next.js does its own transform,
// and vitest's importer then refuses a `.tsx` file outright with "content contains
// invalid JS syntax". Overriding `esbuild.jsx` in this file does NOT win over
// tsconfig — that was tried and failed.
//
// The alternative was adding `@vitejs/plugin-react` as a dependency. Instead the
// pure logic moved OUT of the components into `lib/viz/*.ts`, which is where this
// codebase's own convention puts it anyway (CLAUDE.md: pure logic separate from
// the thing with side effects). So `buildJourney`, `mergeNodeStates` and
// `stageForNode` are testable as plain modules, and the components became pure
// presentation with nothing worth unit-testing in isolation.
//
// If Phase 19's component tests are wanted later, that is the point to add the
// React plugin — not before, since it buys nothing today.

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    // `.tsx` deliberately NOT included — see the note above.
    include: ['**/*.test.ts'],
    exclude: ['node_modules', '.next'],
  },
});
