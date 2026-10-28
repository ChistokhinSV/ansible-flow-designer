import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['test/unit/core/**/*.test.ts'],
        },
      },
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
          include: ['test/unit/webview/**/*.test.{ts,tsx}'],
          setupFiles: ['test/unit/webview/setup.ts'],
        },
      },
    ],
  },
});
