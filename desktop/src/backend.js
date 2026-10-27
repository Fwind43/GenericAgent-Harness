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
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

// Where the backend comes from. Packaged builds carry a standalone CPython under
// resources/python and the ga_harness package under resources/py (see scripts/prepare.mjs);
// from source we use the repository checkout and its .venv.
function runtime(resourcesPath) {
  if (resourcesPath) {
    const python = process.platform === 'win32'
      ? path.join(resourcesPath, 'python', 'python.exe')
      : path.join(resourcesPath, 'python', 'bin', 'python3');
    return { python, cwd: path.join(resourcesPath, 'py'), pythonPath: path.join(resourcesPath, 'py') };
  }
  const venv = process.platform === 'win32'
    ? path.join(REPO, '.venv', 'Scripts', 'python.exe')
    : path.join(REPO, '.venv', 'bin', 'python');
  const python = fs.existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3');
  return { python, cwd: REPO, pythonPath: null };
}

// Optional <userData>/desktop.json: {"python": "...", "args": ["--ga-root", "..."], "cwd": "...", "env": {}}
function loadSettings(userData, rt) {
  const file = path.join(userData, 'desktop.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${file}: ${err.message}`);
  }
  return {
    file,
    python: process.env.GAH_DESKTOP_PYTHON || data.python || rt.python,
    args: Array.isArray(data.args) ? data.args.map(String) : [],
    cwd: data.cwd || rt.cwd,
    pythonPath: rt.pythonPath,
    env: data.env && typeof data.env === 'object' ? data.env : {},
  };
}

class Backend {
  // resourcesPath: process.resourcesPath when packaged, otherwise null (run from source).
  constructor(userData, resourcesPath = null) {
    this.userData = userData;
    this.settings = loadSettings(userData, runtime(resourcesPath));
    this.token = crypto.randomBytes(32).toString('hex');
    this.readyFile = path.join(userData, 'run', `backend-${process.pid}.json`);
    this.logFile = path.join(userData, 'logs', 'backend.log');
    this.child = null;
    this.exited = null;      // Promise resolved with the exit code
    this.tail = [];          // last output lines for error dialogs
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
        if (info.url) return info.url;
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

module.exports = { Backend };
