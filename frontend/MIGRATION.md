# React + TypeScript web host

## Source implementation

The web host now has a React 19 + strict TypeScript implementation in `frontend/`.
It uses Vite; the Python HTTP server and plugin manifest/API protocol remain in
place. The host and all five built-in web plugin UIs use React components;
each plugin's React source lives in its own plugin directory (see below).

- `src/App.tsx`: application shell, composer, sidebar, plugin slots and controls.
- `src/store.ts`: immutable host snapshots, `useSyncExternalStore`, SSE updates
  and 50 ms batching of streamed deltas. Unchanged messages retain their identity.
- `src/components/`: memoized messages/turns, independent disclosures, complete
  summary/reply/thinking content, ask_user presentation, token/cache usage and
  model/reasoning-effort labels. Markdown still uses the existing sanitized
  output renderer rather than a second rendering implementation.
- `src/sdk.ts`: TypeScript browser SDK and plugin API contracts.
- `src/plugin-runtime.tsx`: manifest/revision synchronization, shared React,
  plugin roots/error boundaries, cancellation and owned cleanup.
- `src/gah-sdk.ts`: the `@gah/sdk` module for plugin sources (React hooks, store,
  i18n, `plugin-kit` helpers, `define`/`defineReact`). `main.tsx` publishes it as
  `window.GAH` together with `React`, `ReactDOM` and `jsxRuntime`.
- `src/plugin-kit.tsx`: shared Modal/PluginSlot/useOperation/matches helpers.
- `src/host.css`: host layout; existing output and plugin styles remain reused.

## Plugin-owned frontend sources

Each built-in web plugin owns its React source next to its manifest:
`ga_harness/plugins/web-*/src/index.tsx` (plus local modules). Sources import only
`react`, `react-dom`, `react/jsx-runtime` and `@gah/sdk`; the entry ends with
`defineReact('<plugin>', Component)`. `frontend/build-plugins.mjs` bundles every
`web-*/src/index.tsx` into that plugin's `client.js` as a classic IIFE with those
imports mapped to `window.GAH` (no second React copy). The host contains no
built-in plugin registry: it loads `client.js`/`client.css` from the backend
manifest like any third-party plugin, so disabling a plugin removes its UI.

The generated `client.js` files are committed so a checkout works without npm for
the plugin bundles; regenerate them with `npm run build` (or `npm run
build:plugins`) after editing `src/`. Do not hand-edit `client.js`.

The legacy single-file `ui-web/index.html` page was removed: it could not run the
React plugin bundles. Without `dist/index.html` the server returns a 503 page with
build instructions.

## Development and build

The commands below are instructions, not evidence that they have been run:

```sh
cd frontend
npm install
npm run dev
# Separate checks/build, when requested:
npm run typecheck
npm run build
```

Vite proxies `/api`, `/web` and `/ui-web-assets` to the existing Python service
at `GAH_WEB_URL` (default `http://127.0.0.1:8765`; the web UI port is random
unless pinned, so start it with `GAH_WEB_PORT=8765` or set `GAH_WEB_URL`). Start that service separately using the established
launcher/configuration; Vite does not replace the backend. The Vite dev server
binds to localhost. A dependency lockfile should be generated and committed with
the first authorized dependency installation.

The build writes `ga_harness/plugins/ui-web/dist/` and each plugin's `client.js`.
The Python server serves `dist/index.html` and otherwise a 503 "not built" page.
Hashed assets are served under `/assets/`, restricted to files inside the dist
assets directory and an allowlist of extensions. Python package configuration
includes existing dist artifacts; it does **not** invoke npm automatically.
Build the frontend before packaging a release intended to contain React.

An old dist directory takes precedence over source edits. Rebuild it to deliver
subsequent React changes; changing TypeScript alone does not update a served
bundle.

## Plugin API

Slots: `sidebar`, `sidebar-foot`, `header`, `toolbar`, `composer-top`, `composer`,
`overlay`, `settings`, `view` and `page`. The host does not reconcile plugin-owned children inside slots.

Plugin pages: `PagePanel({ api, label, icon, order })` from `@gah/sdk` registers a full
main-area page listed under "New chat" in the sidebar (`PageNav`, placed by web-sessions;
the host renders a fallback list when no plugin places one). The route is the URL hash
`#/p/<plugin>`; while active, the header title, view tabs, toolbar, chat and composer are
hidden. `pages.open(id)` / `pages.home()` navigate programmatically; opening or creating a
chat returns to the chat.

The host owns one Settings entry and dialog. Built-in model, channel and plugin
management panels register with the shared `SettingsPanel` component exported by
`@gah/sdk`, rather than adding their own sidebar buttons or modal shells:

```tsx
<SettingsPanel api={api} label={T('Example', 'Example')} icon="settings"
  order={40} className="example-settings" onOpen={load}>
  <div className="dialog-content">{/* plugin-owned settings UI */}</div>
</SettingsPanel>
```

A panel is identified by `api.name`; lower `order` values appear first. It is
registered only while mounted and is removed when its plugin unloads. The host
retains the settings slot even while the dialog is closed, so plugins can mount
at startup. `onOpen` runs each time the panel becomes visible (including tab
switches); inactive panel children are unmounted. Keep reloadable state in the
plugin component, and use `useOperation` for requests so the shared close button
and tabs stay locked during changes. Do not nest `Modal` in a settings panel.

Pass `onBeforeLeave={() => boolean | Promise<boolean>}` to protect unsaved edits.
The host awaits the active panel's guard before closing Settings or changing a
settings tab; return `false` to stay in the panel. Only one host navigation can
be pending at a time. Internal list/detail navigation and browser unload warnings
remain the panel's responsibility. Plugin unload is not a cancellable navigation.


- `api.slot(name, node)`: attach a DOM node owned by the plugin.
- `api.mount(name, reactNode)`: create an owned React root in a slot; returns an
  idempotent cleanup function. React render errors have a per-root boundary.
- `api.get/post`: JSON requests relative to `/api/p/<plugin>/`.
- `api.host.get/post`: host API requests. Both request families share the
  plugin's AbortSignal and reject HTTP/invalid-JSON responses.
- `api.on/onHost`, `listen`, `every`, `cleanup`, `intercept`: owned subscriptions,
  listeners, timers and composer interceptors. Register external resources with
  `cleanup`; manually created resources cannot be discovered automatically.
- `api.state/setState`, `notice`, `lock`: compatible host integration. Plugin
  locks are released on unload. `setState(snapshot, true)` also resets the draft.
- `api.signal`: cancelled when a plugin is disabled or its revision is replaced.

On unload, requests are cancelled and owned resources are cleaned up in reverse
registration order. Register plugins synchronously from the manifest's classic
script. Assets must be same-origin; delayed registrations from withdrawn script
revisions are ignored. This lifecycle isolation is **not a security sandbox**:
plugins still execute trusted code in the host page.

### React plugin example

An external plugin must still be registered by the backend so its script appears
in the web manifest. Bundle its browser entry as a classic, self-executing script;
use the host's React instance, not a second bundled React/ReactDOM runtime.
Built-in plugins use `@gah/sdk` imports plus `build-plugins.mjs`; an external
plugin can do the same with its own bundler, or use `window.GAH` directly:

```ts
import type { PluginAPI } from './path/to/frontend/src/sdk';

const { React, useHost } = window.GAH;

function Example({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  return React.createElement('button', {
    type: 'button',
    disabled: state.running,
    onClick: () => api.notice('Hello from the plugin'),
  }, state.running ? 'Running' : 'Example');
}

window.GAH.define('example', api =>
  api.mount('toolbar', React.createElement(Example, { api })));
```

`GAH.defineReact(name, Component)` is a convenience entry point mounted in the
`overlay` slot. For other slots use `GAH.define` plus `api.mount` as above, or a
portal with cleanup as demonstrated by the built-in theme plugin.

`GAH.define(name, setup)` and DOM helpers remain available for existing plugins.
New plugins should prefer the typed API over direct host DOM access. The composer
retains an input-event bridge for existing plugins that set the textarea value.

## Verification and rollout boundary

This change was reviewed at source level only. No dependency installation,
TypeScript check, build, automated/browser test, service restart or deployment
was performed as part of this migration. Runtime compatibility and performance
are therefore not yet verified; no performance improvement is claimed.

When verification is authorized, start with typechecking/building, then focus on
SSE updates/reconnect, turn content and disclosure state, ask_user, composer
locking, plugin enable/disable/revision cleanup, the five native built-in UIs,
third-party compatibility plugins and production asset routing. Existing browser
coverage targets the legacy host; it must be deliberately exercised against the
React build as well.
