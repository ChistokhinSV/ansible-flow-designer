import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The webview is built in library mode: one ES module (index.js) and one stylesheet (index.css)
// with stable names, so the extension host can reference them under a strict CSP.
// Mode "harness" serves src/webview/harness/index.html with a fake host for visual checks.
export default defineConfig(({ mode }) => ({
  root: 'src/webview',
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
  },
  server: { port: 5178, strictPort: true, open: false },
  build: {
    outDir: '../../dist/webview',
    emptyOutDir: true,
    target: 'es2023',
    sourcemap: mode !== 'production',
    minify: mode === 'production',
    lib: {
      entry: 'main.tsx',
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'index',
    },
  },
}));
