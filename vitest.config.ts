import { defineConfig } from 'vitest/config';
import path from 'path';

// Unit tests only, targeting the pure logic modules (agentEngine,
// riskManager, indicators, backtest engine) — no React/DOM environment
// configured, since none of the tests here render components. The `@/`
// alias mirrors tsconfig.json's `paths` so test files can import the
// same way app code does.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules', '.next'],
  },
});
