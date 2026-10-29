# Desktop shell (Electron)

A thin window around the existing `ui-web` backend. The React host, web plugins, sessions and
model settings are all served by Python exactly as in the browser; the shell adds no UI of its
own. Targets Windows, macOS and Linux (Electron bundles Chromium, so rendering is identical).

## Run from source

```sh
cd frontend && npm install && npm run build   # ui-web serves frontend/dist only
cd ../desktop && npm install && npm start
```

The backend is `python -m ga_harness.cli run --ui web` using the repository `.venv` by default.
Optional `<userData>/desktop.json` (path shown in startup error dialogs):

```json
{ "ga_root": "E:/Work/GenericAgent",
  "python": "E:/Work/GenericAgent/.venv/Scripts/python.exe",
  "args": [], "cwd": "C:/path/to/ga-harness", "env": {} }
```

`GAH_DESKTOP_PYTHON` overrides `python`. Backend output goes to `<userData>/logs/backend.log`.

**GenericAgent folder.** Before spawning the backend the shell resolves the GA checkout in this
order: `--ga-root` in `args` > `ga_root` in desktop.json > `$GA_ROOT` > `ga_root` in
`~/.ga-harness/config.toml`. If none points at a folder containing `agentmain.py` (typical when
launched from the Start menu / Finder, where shell env vars are absent), a dialog asks the user to
choose it and saves the choice as `ga_root` in desktop.json. The startup-failure dialog also offers
"Choose GenericAgent folder..." and relaunches.

Startup errors from `gah` itself (`[gah] ...`) are written to the real stderr even after
`ga-stdout` has replaced `sys.stderr`, so they appear in `backend.log` and the failure dialog.

## Backend contract

The shell sets these for `ui-web` (documented in its module docstring):

| Variable | Purpose |
|---|---|
| `GAH_WEB_PORT=0` | free port on 127.0.0.1; never collides with a running 8765 instance |
| `GAH_WEB_OPEN_BROWSER=0` | the shell owns the window |
| `GAH_WEB_TOKEN` | random per launch; required on every request (HttpOnly cookie after `/?gah_token=`) |
| `GAH_WEB_READY_FILE` | `{"url","pid"}` written atomically once listening (no token inside) |
| `GAH_WEB_EXIT_ON_STDIN_EOF=1` | backend aborts the run and stops if the shell dies |

Closing the window only hides it to the system tray; the backend and running tasks keep going.
Left-click the tray icon (or launch the app again / click the Dock icon on macOS) to bring it back;
the tray menu **Quit** (or Cmd+Q on macOS) really exits. Without a tray (some Linux desktops) closing
the window quits as before.

Quit: stdin is closed first (graceful stop), then the process tree is killed after 5 s
(`taskkill /T` on Windows, process group on macOS/Linux). One instance per user (single-instance lock).

## Plugin bridge

`window.gahDesktop` (only on the backend origin; context-isolated, sandboxed renderer):
`version`, `platform`, `pickDirectory({title, defaultPath})`, `openPath(abs)`, `openExternal(http_url)`,
`updates.status()`, `updates.check()`, `updates.configure({mirror, auto_check})`.
Plugins must feature-detect it and keep a browser fallback. Native work beyond this belongs in the
plugin's Python side, reached over HTTP.

## Packaging

```
cd frontend && npm ci && npm run build
cd ../desktop && npm ci && npm run dist      # needs uv on PATH
```

`scripts/prepare.mjs` stages a standalone CPython (`uv python install`, default 3.12, override with
`GAH_DESKTOP_PYTHON_VERSION`) into `stage/python` and the `ga_harness` package (with built web
bundles) into `stage/py`; electron-builder ships both as `resources/python` and `resources/py`.
The packaged app runs `resources/python` with `PYTHONPATH=resources/py`; GA itself is still
resolved by `--ga-root` / `$GA_ROOT` / `~/.ga-harness/config.toml` and its own interpreter.

CI: `.github/workflows/desktop.yml` builds windows-x64, macos-arm64, macos-x64 and linux-x64 on
pushes to `main`/`desktop` and on PRs touching desktop/frontend/ga_harness, uploading unsigned
installers as artifacts. Pushing a `v<semver>` tag (one tag for the whole project, e.g. `v0.2.0`)
stamps that version into `desktop/package.json`, `pyproject.toml` and `ga_harness/__init__.py`
(`scripts/set-version.mjs`) and creates a **draft** GitHub release with all installers plus the
update files below. Publish the draft to make it visible to the updater.

## Updates

Two kinds, both checked from the tray menu (Updates > Check for updates) and automatically
15 s after start and every 6 h (`auto_check`):

- **Code update** (most releases): `update.json` + `ga-harness-app-<version>.zip`, built by
  `scripts/app_bundle.py` (the `ga_harness` package incl. web dist and plugins, ~a few MB). The
  app verifies sha256, unpacks into `<userData>/app/<version>/`, then restarts; from then on
  the backend runs that code instead of `resources/py`. Only the new and the current version are
  kept. If the updated code fails to start, the app marks it bad and falls back to the bundled code.
  It waits for confirmation while a task is running.
- **Installer update**: when `update.json`'s `min_shell` is newer than the installed app, the
  code package is not applied; Windows/Linux (AppImage) download the new installer through
  electron-updater (`latest.yml` / `latest-linux.yml` + blockmap, generic feed on
  `releases/latest/download`) and install on restart. macOS builds are only ad-hoc signed, so they open
  the release page instead. Bump `desktop/MIN_SHELL` in any release that changes Electron code,
  the bundled Python, dependencies or the backend launch contract.

GitHub mirror: Updates > Download mirror offers direct, `https://ghfast.top/` and
`https://gh-proxy.com/`, or edit `<userData>/desktop.json`:

```json
{ "update": { "mirror": "https://ghfast.top/", "auto_check": true } }
```

A mirror is a prefix put before the full GitHub URL; use `{url}` for other shapes
(`"https://example.com/get?u={url}"`). Mirrors only proxy downloads; sha256 still comes from
`update.json` fetched through the same mirror, so pick one you trust.

## Not done yet

User plugin directory and per-plugin venvs (uv), Developer ID signing and notarization, in-place updates on macOS.
Windows installers are unsigned (SmartScreen warns). macOS builds are ad-hoc signed
(`mac.identity: "-"`), so Gatekeeper reports "cannot verify the developer" instead of "damaged":
open once via System Settings > Privacy & Security > Open Anyway, or run
`xattr -cr "/Applications/GenericAgent-Harness.app"`.
