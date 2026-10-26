# React + TypeScript web host

## Source implementation

The web host now has a React 19 + strict TypeScript implementation in `frontend/`.
It uses Vite; the Python HTTP server and plugin manifest/API protocol remain in
place. This is an incremental migration, not a rewrite of every plugin UI.

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
- `src/plugins.tsx`: native React theme plugin, enabled by the backend manifest.
- `src/host.css`: host layout; existing output and plugin styles remain reused.

Models, plugin management, sessions and workspaces still run their existing
JavaScript UIs through `GAH.define`. Their backend plugins, assets and richer
behaviors are retained. They are **not yet native React components**.

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
at `http://127.0.0.1:8765`. Start that service separately using the established
launcher/configuration; Vite does not replace the backend. The Vite dev server
binds to localhost. A dependency lockfile should be generated and committed with
the first authorized dependency installation.

The build writes `ga_harness/plugins/ui-web/dist/`. The Python server prefers
`dist/index.html` when it exists and otherwise serves the original `index.html`.
Hashed assets are served under `/assets/`, restricted to files inside the dist
assets directory and an allowlist of extensions. Python package configuration
includes existing dist artifacts; it does **not** invoke npm automatically.
Build the frontend before packaging a release intended to contain React.

An old dist directory takes precedence over source edits. Rebuild it to deliver
subsequent React changes; changing TypeScript alone does not update a served
bundle. Without a built dist, users continue to receive the legacy page.

## Plugin API

Slots: `sidebar`, `sidebar-foot`, `header`, `toolbar`, `composer-top`, `composer`
and `overlay`. The host does not reconcile plugin-owned children inside slots.

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
Type-only imports can reference `src/sdk.ts` without adding runtime imports:

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
locking, plugin enable/disable/revision cleanup, the four compatibility UIs and
production asset routing. Existing browser coverage targets the legacy host;
it must be deliberately exercised against the React build as well.
