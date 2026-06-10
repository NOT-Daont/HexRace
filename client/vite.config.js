import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
      '/info': { target: 'http://localhost:3001' },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
