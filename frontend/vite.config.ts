import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
      target: (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.GAH_WEB_URL
        || 'http://127.0.0.1:8765', changeOrigin: true,
    }])),
  },
});
