// Builds each web plugin's React source (ga_harness/plugins/<name>/src/index.tsx)
// into that plugin's client.js. Shared modules come from the host via window.GAH.
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../ga_harness/plugins/', import.meta.url));
const globals = {
  '@gah/sdk': 'GAH',
  react: 'GAH.React',
  'react-dom': 'GAH.ReactDOM',
  'react/jsx-runtime': 'GAH.jsxRuntime',
};
const only = process.argv.slice(2);
const names = readdirSync(root).filter(name => existsSync(`${root}${name}/src/index.tsx`)
  && (!only.length || only.includes(name)));

for (const name of names) {
  await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: `${root}${name}`,
      emptyOutDir: false,
      minify: false,
      lib: { entry: `${root}${name}/src/index.tsx`, formats: ['iife'], name: `GAHPlugin_${name.replace(/\W/g, '_')}`, fileName: () => 'client.js' },
      rollupOptions: { external: Object.keys(globals), output: { globals } },
    },
  });
  console.log(`built ${name}/client.js`);
}
