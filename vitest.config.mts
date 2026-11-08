import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // AFD-166: `just coverage` measures the unit projects; no thresholds yet.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['test/unit/core/**/*.test.ts'],
        },
      },
      // Catalog search gates on a full environment dump: `just test-catalog <dir>`.
      ...(process.env.AFD_CATALOG_DIR
        ? [
            {
              test: {
                name: 'catalog',
                environment: 'node',
                include: ['test/catalog/**/*.test.ts'],
                testTimeout: 120_000,
              },
            },
          ]
        : []),
      // The MCP server end to end on dist/mcp.js: `just test-mcp` builds it first (AFD-19).
      ...(process.env.AFD_MCP
        ? [
            {
              test: {
                name: 'mcp',
                environment: 'node',
                include: ['test/mcp/**/*.test.ts'],
                testTimeout: 30_000,
              },
            },
          ]
        : []),
      // Docker-based engine contract tests run only through `just test-engine` (AFD_ENGINE=1).
      ...(process.env.AFD_ENGINE
        ? [
            {
              test: {
                name: 'engine',
                environment: 'node',
                include: ['test/engine/**/*.test.ts'],
                testTimeout: 30_000,
              },
            },
          ]
        : []),
      {
        plugins: [react()],
        test: {
          name: 'webview',
          environment: 'jsdom',
          // AFD-166: one jsdom per worker instead of per file: 13 s to 9 s on this machine.
          pool: 'vmThreads',
          include: ['test/unit/webview/**/*.test.{ts,tsx}'],
          setupFiles: ['test/unit/webview/setup.ts'],
        },
      },
    ],
  },
});
