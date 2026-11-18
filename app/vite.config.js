import { defineConfig } from 'vite';

// npm build loads this ESM file natively on Node 24, avoiding ancestor-directory scans on Windows.

export default defineConfig({
  root: 'src/web',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3080',
    },
  },
});
