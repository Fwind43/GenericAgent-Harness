// Spawns and supervises the Python ui-web backend for the desktop shell.
//
// Contract with ga_harness/plugins/ui-web (see its module docstring):
//   GAH_WEB_PORT=0                 bind a free port on 127.0.0.1 (never the 8765 web instance)
//   GAH_WEB_OPEN_BROWSER=0         the shell owns the window
//   GAH_WEB_TOKEN=<random>         every request needs it; the page enters via /?gah_token=
//   GAH_WEB_READY_FILE=<path>      {"url","pid"} appears once the server listens
//   GAH_WEB_EXIT_ON_STDIN_EOF=1    backend stops by itself if this process dies
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

// ---- Versions and updated code ---------------------------------------------------------
// A release ships the shell installer and a small "app bundle" (just the ga_harness package).
// Code-only updates unpack into <userData>/app/<version>/ga_harness; app/state.json records
// {"current", "previous", "bad": [...]}. The packaged resources/py stays the last fallback.

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null } : null;
}

// -1 / 0 / 1; unparsable versions sort first. A prerelease sorts before its release.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) < 0 ? -1 : 1;
}

// __version__ of the ga_harness package under `dir`, or null.
function readCodeVersion(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'ga_harness', '__init__.py'), 'utf8');
    const m = /^__version__\s*=\s*["']([^"']+)["']/m.exec(text);
    return m ? m[1] : null;
  } catch { return null; }
}

function appDir(userData) { return path.join(userData, 'app'); }

function readAppState(userData) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(appDir(userData), 'state.json'), 'utf8'));
    return { current: data.current || null, previous: data.previous || null, bad: Array.isArray(data.bad) ? data.bad.map(String) : [] };
  } catch { return { current: null, previous: null, bad: [] }; }
}

function writeAppState(userData, state) {
  const file = path.join(appDir(userData), 'state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// The newest usable updated code, if it is newer than what the installer shipped.
function selectUpdatedCode(userData, builtinVersion) {
  const state = readAppState(userData);
  for (const version of [state.current, state.previous]) {
    if (!version || state.bad.includes(version)) continue;
    const dir = path.join(appDir(userData), version);
    if (readCodeVersion(dir) !== version) continue;
    if (compareVersions(version, builtinVersion) <= 0) continue;   // a newer installer wins
    return { dir, version, source: 'update' };
  }
  return null;
}

// Where the backend comes from. Packaged builds carry a standalone CPython under
// resources/python and the ga_harness package under resources/py (see scripts/prepare.mjs);
// a code-only update replaces resources/py with <userData>/app/<version>.
// From source we use the repository checkout and its .venv.
function runtime(resourcesPath, userData, builtinVersion) {
  if (resourcesPath) {
    const python = process.platform === 'win32'
      ? path.join(resourcesPath, 'python', 'python.exe')
      : path.join(resourcesPath, 'python', 'bin', 'python3');
    const builtin = path.join(resourcesPath, 'py');
    const code = selectUpdatedCode(userData, builtinVersion)
      || { dir: builtin, version: readCodeVersion(builtin) || builtinVersion, source: 'builtin' };
    return { python, cwd: code.dir, pythonPath: code.dir, code };
  }
  const venv = process.platform === 'win32'
    ? path.join(REPO, '.venv', 'Scripts', 'python.exe')
    : path.join(REPO, '.venv', 'bin', 'python');
  const python = fs.existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3');
  return { python, cwd: REPO, pythonPath: null, code: { dir: REPO, version: readCodeVersion(REPO), source: 'source' } };
}

// Optional <userData>/desktop.json:
//   {"ga_root": "...", "python": "...", "args": [...], "cwd": "...", "env": {},
//    "update": {"mirror": "", "auto_check": true}}
// ga_root and update are written by the shell itself (folder picker, tray menu).
function readSettingsFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${file}: ${err.message}`);
  }
}

function loadSettings(userData, rt) {
  const file = path.join(userData, 'desktop.json');
  const data = readSettingsFile(file);
  return {
    file,
    gaRoot: typeof data.ga_root === 'string' ? data.ga_root : null,
    python: process.env.GAH_DESKTOP_PYTHON || data.python || rt.python,
    args: Array.isArray(data.args) ? data.args.map(String) : [],
    cwd: data.cwd || rt.cwd,
    pythonPath: rt.pythonPath,
    env: data.env && typeof data.env === 'object' ? data.env : {},
  };
}

// ---- GenericAgent checkout ------------------------------------------------------------
// The backend needs GA's agentmain.py. Mirror ga_harness/launcher.resolve_ga_root so the shell
// can check *before* spawning and ask the user instead of letting the backend die with code 2.

function isGaRoot(dir) {
  return typeof dir === 'string' && dir !== '' && fs.existsSync(path.join(dir, 'agentmain.py'));
}

// ---- Bundled GenericAgent ---------------------------------------------------------------
// Packaged builds (and code packages) carry GA's source at <code>/genericagent, pinned by
// desktop/GA_REF. GA writes its state next to its code (mykey.py, memory/, temp/), so the
// shell runs a copy in <userData>/GenericAgent rather than the read-only install dir. The
// copy is refreshed whenever the shipped commit changes: code files are overwritten, user
// state is kept — mykey.py is never touched, existing memory/ files are not replaced, and
// files that only exist in the copy (temp/, sessions, user additions) are never deleted.

const GA_REF_FILE = '.gah-ga-ref';
const EMPTY_MYKEY = `# GenericAgent model configuration.
# Add models in GenericAgent-Harness: Settings > Models (they are written to this file).
`;

function readGaRef(dir) {
  try { return fs.readFileSync(path.join(dir, GA_REF_FILE), 'utf8').trim() || null; } catch { return null; }
}

function bundledGaDir(userData) { return path.join(userData, 'GenericAgent'); }

function copyGaTree(src, dest, rel = '') {
  for (const ent of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) {
      fs.mkdirSync(path.join(dest, r), { recursive: true });
      copyGaTree(src, dest, r);
      continue;
    }
    if (!ent.isFile() || r === GA_REF_FILE) continue;
    const top = r.split(path.sep)[0];
    const out = path.join(dest, r);
    if (r === 'mykey.py' || top === 'temp') continue;
    if (top === 'memory' && fs.existsSync(out)) continue;
    fs.copyFileSync(path.join(src, r), out);
  }
}

// Ensures <userData>/GenericAgent matches the GA shipped with the running code and returns
// it; null when this code carries no GA (running from source, or an older code package).
function syncBundledGa(codeDir, userData) {
  const src = path.join(codeDir, 'genericagent');
  if (!isGaRoot(src)) return null;
  const dest = bundledGaDir(userData);
  const ref = readGaRef(src);
  if (!(ref && readGaRef(dest) === ref && isGaRoot(dest))) {
    fs.mkdirSync(dest, { recursive: true });
    copyGaTree(src, dest);
    // Written last: an interrupted copy is retried on the next start.
    fs.writeFileSync(path.join(dest, GA_REF_FILE), `${ref || 'unknown'}\n`, 'utf8');
  }
  const mykey = path.join(dest, 'mykey.py');
  if (!fs.existsSync(mykey)) fs.writeFileSync(mykey, EMPTY_MYKEY, 'utf8');
  return dest;
}

function harnessConfigPath() {
  return path.join(process.env.GAH_HOME || path.join(os.homedir(), '.ga-harness'), 'config.toml');
}

// Only the top-level `ga_root = "..."` / `'...'` line is needed; not a general TOML parser.
function readHarnessGaRoot() {
  let text;
  try { text = fs.readFileSync(harnessConfigPath(), 'utf8'); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;                     // keys after a table header are not top-level
    let m = line.match(/^\s*ga_root\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\(["\\])/g, '$1');
    m = line.match(/^\s*ga_root\s*=\s*'([^']*)'/);
    if (m) return m[1];
  }
  return null;
}

function expandHome(p) {
  return p && /^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p;
}

// Returns {value, source} in launcher order (--ga-root arg > desktop.json > $GA_ROOT >
// config.toml); value is null when nothing is configured.
function configuredGaRoot(settings) {
  const i = settings.args.indexOf('--ga-root');
  if (i >= 0 && settings.args[i + 1]) return { value: path.resolve(settings.args[i + 1]), source: `${settings.file} (args)` };
  const eq = settings.args.find((a) => a.startsWith('--ga-root='));
  if (eq) return { value: path.resolve(eq.slice('--ga-root='.length)), source: `${settings.file} (args)` };
  if (settings.gaRoot) return { value: path.resolve(expandHome(settings.gaRoot)), source: settings.file };
  const env = { ...process.env, ...settings.env }.GA_ROOT;
  if (env) return { value: path.resolve(env), source: 'GA_ROOT' };
  const toml = readHarnessGaRoot();
  if (toml) return { value: path.resolve(expandHome(toml)), source: harnessConfigPath() };
  return { value: null, source: null };
}

// Read-modify-write desktop.json, keeping every other key. Returns the written object.
function editSettingsFile(file, mutate) {
  const data = readSettingsFile(file);
  mutate(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return data;
}

// Persist the chosen folder in desktop.json.
function saveGaRoot(settings, dir) {
  editSettingsFile(settings.file, (data) => { data.ga_root = dir; });
  settings.gaRoot = dir;
}

class Backend {
  // resourcesPath: process.resourcesPath when packaged, otherwise null (run from source).
  // builtinVersion: the shell (installer) version, which equals the code it shipped with.
  constructor(userData, resourcesPath = null, builtinVersion = null) {
    this.userData = userData;
    const rt = runtime(resourcesPath, userData, builtinVersion);
    this.code = rt.code;     // {dir, version, source: 'builtin' | 'update' | 'source'}
    this.settings = loadSettings(userData, rt);
    this.url = null;
    this.token = crypto.randomBytes(32).toString('hex');
    this.readyFile = path.join(userData, 'run', `backend-${process.pid}.json`);
    this.logFile = path.join(userData, 'logs', 'backend.log');
    this.child = null;
    this.exited = null;      // Promise resolved with the exit code
    this.tail = [];          // last output lines for error dialogs
  }

  // The configured checkout wins; otherwise the bundled copy (synced on first use).
  gaRoot() {
    const configured = configuredGaRoot(this.settings);
    if (configured.value) return configured;
    if (this.bundledGa === undefined) {
      try {
        this.bundledGa = syncBundledGa(this.code.dir, this.userData);
      } catch (err) {
        this.bundledGa = null;
        this.bundledGaError = err.message;
      }
    }
    return this.bundledGa ? { value: this.bundledGa, source: 'bundled' } : configured;
  }

  setGaRoot(dir) { saveGaRoot(this.settings, dir); }

  // The updated code failed to start: never pick it again. Returns true when another
  // start attempt makes sense (an older update or the built-in code is left to try).
  rejectUpdatedCode() {
    if (this.code.source !== 'update') return false;
    const state = readAppState(this.userData);
    if (!state.bad.includes(this.code.version)) state.bad.push(this.code.version);
    if (state.current === this.code.version) state.current = state.previous;
    if (state.previous === this.code.version || state.previous === state.current) state.previous = null;
    writeAppState(this.userData, state);
    return true;
  }

  start() {
    fs.mkdirSync(path.dirname(this.readyFile), { recursive: true });
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    fs.rmSync(this.readyFile, { force: true });
    const log = fs.createWriteStream(this.logFile, { flags: 'a' });
    log.write(`\n=== ${new Date().toISOString()} ${this.settings.python} ${this.settings.args.join(' ')}\n`);
    const env = {
      ...process.env,
      ...this.settings.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONNOUSERSITE: '1',
      GAH_WEB_PORT: '0',
      GAH_WEB_OPEN_BROWSER: '0',
      GAH_WEB_TOKEN: this.token,
      GAH_WEB_READY_FILE: this.readyFile,
      GAH_WEB_EXIT_ON_STDIN_EOF: '1',
    };
    if (this.settings.pythonPath) {
      // launcher.maybe_reexec keeps REPO on PYTHONPATH when it hops to GA's interpreter.
      env.PYTHONPATH = [this.settings.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    }
    const args = ['-m', 'ga_harness.cli', 'run', '--ui', 'web', ...this.settings.args];
    // desktop.json ga_root wins over $GA_ROOT / config.toml; an explicit --ga-root arg wins over both.
    const hasArg = this.settings.args.some((a) => a === '--ga-root' || a.startsWith('--ga-root='));
    if (this.settings.gaRoot && !hasArg) args.push('--ga-root', path.resolve(expandHome(this.settings.gaRoot)));
    else if (!hasArg) {
      const ga = this.gaRoot();
      if (ga.source === 'bundled') args.push('--ga-root', ga.value);
    }
    this.child = spawn(this.settings.python, args, {
      cwd: this.settings.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',   // own process group -> kill(-pid) reaches workers
    });
    const keep = (chunk) => {
      log.write(chunk);
      this.tail.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean));
      this.tail = this.tail.slice(-40);
    };
    this.child.stdout.on('data', keep);
    this.child.stderr.on('data', keep);
    this.exited = new Promise((resolve) => {
      this.child.on('error', (err) => { keep(Buffer.from(`spawn failed: ${err.message}\n`)); resolve(-1); });
      this.child.on('exit', (code, signal) => {
        log.end(`=== backend exited code=${code} signal=${signal}\n`);
        resolve(code ?? -1);
      });
    });
  }

  // Resolves with the base URL once the ready file appears; rejects if the backend dies first.
  async waitReady(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let dead = false;
    this.exited.then(() => { dead = true; });
    while (Date.now() < deadline) {
      if (dead) throw new Error('backend exited before it was ready');
      try {
        const info = JSON.parse(fs.readFileSync(this.readyFile, 'utf8'));
        if (info.url) { this.url = info.url; return info.url; }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`backend not ready after ${timeoutMs / 1000}s`);
  }

  // Graceful first (stdin EOF -> backend aborts the run and stops), then kill the whole tree.
  async stop(graceMs = 5000) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    const done = await Promise.race([
      this.exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), graceMs)),
    ]);
    if (!done) this.killTree();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
    fs.rmSync(this.readyFile, { force: true });
  }

  killTree() {
    const pid = this.child && this.child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ }
    }
  }
}

module.exports = {
  Backend, isGaRoot, editSettingsFile, readSettingsFile, syncBundledGa, bundledGaDir,
  compareVersions, parseVersion, readCodeVersion, appDir, readAppState, writeAppState,
};
