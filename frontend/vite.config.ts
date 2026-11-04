import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

type IncomingRequest = { headers: Record<string, string | string[] | undefined> & { origin?: string; host?: string } };
type OutgoingRequest = { setHeader(name: string, value: string): void };
const target = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.GAH_WEB_URL
  || 'http://127.0.0.1:8765';
const targetOrigin = new URL(target).origin;

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: { alias: { '@gah/sdk': '/src/gah-sdk.ts' } },
  build: {
    outDir: '../ga_harness/plugins/ui-web/dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets',
  },
  server: {
    proxy: Object.fromEntries(['/api', '/web', '/ui-web-assets'].map(path => [path, {
      target, changeOrigin: true,
      // changeOrigin rewrites Host to the backend, but the browser's Origin stays the dev server's,
      // so the backend's same-origin check rejects every POST. Translate only this dev page's own
      // Origin; any other site's Origin is passed through unchanged and still rejected.
      configure: (proxy: { on(event: 'proxyReq', fn: (proxyReq: OutgoingRequest, req: IncomingRequest) => void): void }) => {
        proxy.on('proxyReq', (proxyReq, req) => {
          const origin = req.headers.origin, host = req.headers.host;
          if (origin && host && (origin === `http://${host}` || origin === `https://${host}`)) proxyReq.setHeader('origin', targetOrigin);
        });
      },
    }])),
  },
});
