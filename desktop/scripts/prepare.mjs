// Stages what electron-builder ships as extraResources:
//   stage/python  standalone CPython (python-build-standalone via `uv python install`)
//   stage/py      the ga_harness package, including the built ui-web dist and plugin bundles
// Requires uv on PATH and a prior `npm run build` in ../frontend.
// GAH_DESKTOP_PYTHON_VERSION picks the CPython minor (default 3.12).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const stage = path.join(desktop, 'stage');
const version = process.env.GAH_DESKTOP_PYTHON_VERSION || '3.12';

function die(msg) { console.error(`[prepare] ${msg}`); process.exit(1); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

const dist = path.join(repo, 'ga_harness', 'plugins', 'ui-web', 'dist', 'index.html');
if (!fs.existsSync(dist)) die(`missing ${dist}; run "npm ci && npm run build" in frontend/ first`);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 1. Backend sources (no tests, caches or local session data).
const skip = new Set(['__pycache__', '.pytest_cache', 'node_modules', 'sessions']);
fs.cpSync(path.join(repo, 'ga_harness'), path.join(stage, 'py', 'ga_harness'), {
  recursive: true,
  filter: (src) => !skip.has(path.basename(src)) && !src.endsWith('.pyc'),
});

// 2. Standalone CPython. uv also creates minor-version links next to the real directory;
//    copy only the real cpython-X.Y.Z-* directory.
const installDir = path.join(stage, '.uv-python');
run('uv', ['python', 'install', version], { env: { ...process.env, UV_PYTHON_INSTALL_DIR: installDir } });
const real = fs.readdirSync(installDir).filter((name) => {
  const st = fs.lstatSync(path.join(installDir, name));
  return /^cpython-\d+\.\d+\.\d+/.test(name) && st.isDirectory() && !st.isSymbolicLink();
});
if (real.length !== 1) die(`expected one CPython install in ${installDir}, found: ${real.join(', ') || 'none'}`);
const pyDir = path.join(stage, 'python');
fs.cpSync(path.join(installDir, real[0]), pyDir, { recursive: true, verbatimSymlinks: true });
fs.rmSync(installDir, { recursive: true, force: true });

// Trim the bundled stdlib test suite (~30% of the runtime); nothing imports it.
const lib = process.platform === 'win32' ? path.join(pyDir, 'Lib') : path.join(pyDir, 'lib', `python${version}`);
for (const name of ['test', 'idlelib', 'turtledemo']) fs.rmSync(path.join(lib, name), { recursive: true, force: true });
// uv marks managed interpreters EXTERNALLY-MANAGED; plugins install into their own venvs anyway.

// 3. Smoke: the staged interpreter imports the staged package.
const exe = process.platform === 'win32' ? path.join(pyDir, 'python.exe') : path.join(pyDir, 'bin', 'python3');
if (!fs.existsSync(exe)) die(`interpreter not found at ${exe}`);
run(exe, ['-c', 'import sys, ga_harness.cli, ga_harness.launcher; print("[prepare] ok", sys.version.split()[0], ga_harness.__file__)'], {
  env: { ...process.env, PYTHONPATH: path.join(stage, 'py'), PYTHONNOUSERSITE: '1' },
  cwd: path.join(stage, 'py'),
});
