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

Quit: stdin is closed first (graceful stop), then the process tree is killed after 5 s
(`taskkill /T` on Windows, process group on macOS/Linux). One instance per user (single-instance lock).

## Plugin bridge

`window.gahDesktop` (only on the backend origin; context-isolated, sandboxed renderer):
`version`, `platform`, `pickDirectory({title, defaultPath})`, `openPath(abs)`, `openExternal(http_url)`.
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
installers as artifacts. Pushing a `desktop-v<semver>` tag sets the app version and creates a
**draft** GitHub release with all installers.

## Not done yet

User plugin directory and per-plugin venvs (uv), signing/notarization (installers are unsigned:
Windows SmartScreen and macOS Gatekeeper will warn; on macOS use right-click > Open or
`xattr -dr com.apple.quarantine`), auto-update.
