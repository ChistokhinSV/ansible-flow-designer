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
