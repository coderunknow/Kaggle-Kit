import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The browser client. In development the Vite dev server proxies `/api` to
 * the local proxy backend so the browser only ever talks to one origin.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: Number.parseInt(process.env.KAGGLE_KIT_CLIENT_PORT ?? '5173', 10),
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.KAGGLE_KIT_PORT ?? '8787'}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
});
