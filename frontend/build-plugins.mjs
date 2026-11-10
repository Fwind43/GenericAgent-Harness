// Builds each web plugin's React source (<plugin>/src/index.{tsx,ts,jsx,js})
// into that plugin's client.js. Shared modules come from the host via window.GAH.
// Accepts optional CLI args: either built-in plugin names or arbitrary plugin directory paths.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const frontendRoot = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../ga_harness/plugins/', import.meta.url));
const globals = {
  '@gah/sdk': 'GAH',
  react: 'GAH.React',
  'react-dom': 'GAH.ReactDOM',
  'react/jsx-runtime': 'GAH.jsxRuntime',
};
const ENTRY_CANDIDATES = ['src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js'];

function findEntry(dir) {
  for (const rel of ENTRY_CANDIDATES) {
    const full = join(dir, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

function readPluginName(dir) {
  const tomlPath = join(dir, 'plugin.toml');
  if (existsSync(tomlPath)) {
    try {
      const m = readFileSync(tomlPath, 'utf-8').match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m && m[1]) return m[1].trim();
    } catch { /* fallback to directory name */ }
  }
  return basename(dir);
}

const args = process.argv.slice(2);
const targets = [];
if (!args.length) {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const entry = findEntry(dir);
    if (entry) targets.push({ name, dir, entry });
  }
} else {
  for (const arg of args) {
    const builtinDir = join(root, arg);
    const dir = existsSync(builtinDir) && findEntry(builtinDir) ? builtinDir : resolve(arg);
    const entry = findEntry(dir);
    if (!entry) {
      throw new Error(`No frontend entry (${ENTRY_CANDIDATES.join(', ')}) found in ${dir}`);
    }
    targets.push({ name: readPluginName(dir), dir, entry });
  }
}

for (const { name, dir, entry } of targets) {
  await build({
    root: frontendRoot,
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: dir,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['iife'], name: `GAHPlugin_${name.replace(/\W/g, '_')}`, fileName: () => 'client.js' },
      rollupOptions: { external: Object.keys(globals), output: { globals } },
    },
  });
  console.log(`built ${name}/client.js`);
}
