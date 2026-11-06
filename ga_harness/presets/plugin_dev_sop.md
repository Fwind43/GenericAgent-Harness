# [GA-Harness Plugin & Mode Development SOP]

Creative mode extends GA-Harness by writing **user plugins** under `{data_dir}/plugins/<name>/` or **mode presets** under `{data_dir}/presets/<id>.toml`.
**Hard boundary**: NEVER modify the `ga-harness` or `GenericAgent` source tree unless the user explicitly asks to edit the repository. All user-requested features, UI extensions, themes, tools, and modes belong in `{data_dir}`.

---

## 1. Host vs. Worker Process Boundary (Critical)

GA-Harness runs a persistent **Host** process (Web server, session store, plugin catalog) and spawns an isolated **Worker** child process for each agent run/turn.

1. **Host-only plugins** (`worker.host_only(manifest) == True`):
   - Any plugin whose `inject` contains `"web.host"` or `"web.host?"`, or whose `provides` intersects `{"frontend", "web.host", "sessions", "runs", "workspaces", "models"}`.
   - Loaded **only** in the Host process. Activated and hot-reloaded **immediately** in the browser via SSE without restarting the server.
2. **Worker-compatible plugins** (`worker.host_only(manifest) == False`):
   - Plugins that only inject worker capabilities (`"ga.tools"`, `"ga.hooks"`, `"ga.agent"`, `"ga.prompt"`, `"events"`, `"run.host?"`).
   - When enabled in the Host, modes containing `"*"` in `plugins` (such as `standard` and `creative`) automatically mount them into **every subsequently started Worker run**.
3. **NEVER mix `web.host` and `ga.tools` in the same `plugin.toml`!**
   - The Host does not provide `ga.tools` (so `inject = ["web.host", "ga.tools"]` stays `pending` forever in the Host), and `web.host` marks the plugin Host-only (excluding it from Workers).
   - **Correct pattern for UI + Tool features**: split into a Host UI plugin (`<name>-ui`, `inject = ["web.host"]`) and a Worker tool plugin (`<name>-tool`, `inject = ["ga.tools"]`), or have the Host plugin inject `["web.host", "runs"]` and call `ctx.scope.add(runs.register_worker_plugin("<name>-worker"))` for a companion plugin with `worker_only = true`.

---

## 2. Plugin Directory & `plugin.toml` Contract

Directory: `{data_dir}/plugins/<name>/` (`<name>` must match `^[a-z0-9][a-z0-9_-]{0,63}$`).

```toml
name = "my-plugin"
category = "extension"        # "extension" | "ui" | "service" | "observe" | "other" (never "core")
entry = "main:apply"          # module_name:function_name (NO ".py" suffix! Never write "main.py:apply")
description = "English summary shown in the Plugins panel."
description_zh = "在插件面板中显示的中文简介。"
inject = ["web.host"]         # append "?" for optional capabilities, e.g. ["web.host?"]
provides = []                 # capabilities registered via ctx.provide(...)
packages = []                 # optional pip specs, e.g. ["httpx>=0.27"]
isolated = false              # if true, installs packages into {data_dir}/plugin-envs/<name>
worker_only = false           # if true, hidden from UI toggle; loaded only via runs.register_worker_plugin

[settings.max_items]
type = "integer"              # "string" | "integer" | "boolean" | "choice"
default = 10
min = 1                       # integer: min/max; string: max_length
max = 100
label = "Max items"
label_zh = "最大条数"
description = "Maximum items displayed."
description_zh = "显示的最大条目数。"
```
- For `type = "choice"`, declare `options = [{ value = "a", label = "A", label_zh = "选项A" }]` or `options_from = "mykey-models"`.
- Fields with `secret = true` are masked in UI/API reads and never exposed to `plugin_control`.

---

## 3. Backend Lifecycle & Capabilities (`main.py`)

Every `main.py` defines `def apply(ctx, config):`.
**Teardown rule**: Register every side effect with `ctx.scope.add(dispose_fn)` (or return `dispose_fn` from `apply`) so `plugin_control(action="disable")` cleans up completely.

### 3.1 Host Capabilities (`web.host`, `runs`, `sessions`, `workspaces`)

```python
from pathlib import Path

HERE = Path(__file__).parent

def apply(ctx, config):
    web = ctx.get("web.host")
    if web is None:
        return

    def get_items(req):
        # req = {"method": "GET", "path": "items", "query": dict[str, list[str]], "body": {}}
        return {"items": [], "limit": config.get("max_items", 10)}

    def create_item(req):
        # req["body"] is the parsed JSON dict (or {} if empty)
        item = req["body"]
        web.emit("my-plugin", "updated", {"item": item})  # push SSE event to browser api.on("updated", fn)
        return (201, {"ok": True, "item": item})

    ctx.scope.add(web.register(
        "my-plugin",
        script=HERE / "client.js",
        style=HERE / "style.css",
        routes={
            ("GET", "items"): get_items,
            ("POST", "items"): create_item,
        },
    ))
```

**`web.register` & `routes` exact contract**:
- `web.register(name, *, script=None, style=None, head=None, files=None, routes=None, desktop=None)` returns an `unregister()` callback (always wrap in `ctx.scope.add(...)`).
- `script` / `style` / `head` are file paths (`Path` or `str`) that must exist on disk.
- `routes` dict keys **must** be 2-tuples `(METHOD, sub_path)`:
  - `METHOD`: `"GET"` or `"POST"` (normalized to uppercase).
  - `sub_path`: `"items"` or `"/items"` (leading/trailing `/` is stripped) -> served at `/api/plugins/<name>/items` (`""` serves `/api/plugins/<name>`).
- Every route handler takes **one argument** `req`: `{"method": str, "path": str, "query": dict[str, list[str]], "body": dict}`.
- Return value: a JSON-serializable dict/list (status `200`) or a `(status_code, payload_dict)` tuple.
- Push live events to browsers with `web.emit("my-plugin", "event_kind", {"k": "v"})`. To contribute initial state to `/api/state`, register a waterfall hook: `ctx.on("web.snapshot", lambda data, nxt: {**nxt(data), "my_plugin": {...}})`.

### 3.2 Worker Capabilities (`ga.tools`, `ga.hooks`, `ga.prompt`, `run.host`)

```python
import importlib

SCHEMA = {
    "type": "function",
    "function": {
        "name": "my_tool",
        "description": "Count characters in text.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "Input text"}},
            "required": ["text"],
        },
    },
}

def apply(ctx, config):
    tools = ctx.get("ga.tools")
    if tools is None:
        return

    def do_my_tool(handler, args, response):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        text = str((args or {}).get("text", ""))
        msg = f"length={len(text)}"
        return StepOutcome(msg, next_prompt=msg + "\n")

    ctx.scope.add(tools.register(SCHEMA, do_my_tool))
```

- `ga.prompt` (waterfall `ga.system_prompt`): inject `["ga.prompt"]` and register `ctx.on("ga.system_prompt", lambda prompt, nxt: nxt(prompt) + "\nExtra instructions")` (`ctx.on` is automatically cleaned up when the plugin scope closes).
- `ga.hooks` (waterfall `ga.<event>`): inject `["ga.hooks"]` and register `ctx.on("ga.llm_before", lambda gactx, nxt: nxt(gactx))`.
  Events: `"ga.agent_before"`, `"ga.agent_after"`, `"ga.turn_before"`, `"ga.turn_after"`, `"ga.llm_before"`, `"ga.llm_after"`, `"ga.tool_before"`, `"ga.tool_after"`.
- `run.host` (Worker -> Host bridge):
  - `ctx["run.host"].emit("my_kind", {"k": "v"})` emits `plugin.my_kind` to the run event stream.
  - `ctx["run.host"].call("op_name", {"k": "v"}, timeout=30.0)` calls a Host RPC handler registered via `ctx["runs"].register_rpc("op_name", fn)`.

---

## 4. Frontend SDK Contract (`window.GAH`)

User plugins need no bundler: write plain JS (`window.GAH.define(name, setup)`) or React (`window.GAH.defineReact(name, setup)`).
Always clean up DOM/timers via `api.cleanup(fn)` or by returning a cleanup function from `setup(api)`. CSS passed to `web.register(..., style=HERE / "style.css")` is automatically tagged with `data-gah-plugin="<name>"` and removed on disable.

### 4.1 Available UI Slots
- **Shell & Layout**: `sidebar.header`, `sidebar.list`, `sidebar.footer`, `topbar.left`, `topbar.right`, `main.before`, `main.after`, `modal`, `status`
- **Composer**: `composer.above`, `composer.left`, `composer.toolbar`, `composer.right`, `composer.placeholder`
- **Messages & Turns**: `messages.before`, `message.above`, `message.meta`, `message.actions`, `message.below`, `turn.below`
- **Settings**: `settings.nav`, `settings.section` (or `api.registerSettingsSection({ id, label, icon, order, Component })`)

### 4.2 Vanilla JS Example (`client.js`)
```javascript
window.GAH.define("my-plugin", function (api) {
  var btn = api.el("button", "gah-btn gah-btn-ghost", window.GAH.T("条目", "Items"));
  btn.onclick = function () {
    api.get("items").then(function (res) {
      btn.textContent = window.GAH.T("条目", "Items") + " (" + (res.items || []).length + ")";
    });
  };
  api.mount("topbar.right", btn);

  api.on("updated", function (data) {
    console.log("Server pushed update:", data);
  });
});
```

### 4.3 React Example (`client.js` without build step)
```javascript
window.GAH.defineReact("my-plugin", function (api) {
  var h = window.GAH.React.createElement;
  api.registerSlot("status", function MyStatus() {
    var host = window.GAH.useHost();
    return h("span", { className: "my-plugin-status" }, window.GAH.T("就绪", "Ready") + (host.busy ? " *" : ""));
  }, 50);
});
```

### 4.4 Key Frontend `api` & `window.GAH` Methods
- **Plugin HTTP & SSE (`api`)**:
  - `api.get(subPath)` -> `GET /api/plugins/<name>/<subPath>` (returns parsed JSON Promise).
  - `api.post(subPath, body)` -> `POST /api/plugins/<name>/<subPath>` (returns parsed JSON Promise).
  - `api.on(kind, fn)` -> subscribes to `web.emit("<name>", kind, data)` from backend; `api.on("*", fn)` receives all host SSE events.
- **DOM & Slots (`api`)**:
  - `api.slot(slotName)` -> returns the slot DOM container (`HTMLElement | null`).
  - `api.mount(slotName, node)` -> appends `node` to the slot and automatically removes it on plugin disable/reload.
  - `api.el(tag, className?, text?)` / `api.h(tag, props?, ...children)` -> DOM element helpers.
  - `api.cleanup(fn)` / `api.listen(target, type, fn)` / `api.every(ms, fn)` -> auto-cleaned on disable/reload.
  - `api.registerSlot(slotName, Component, order?)` / `api.registerSettingsSection({ id, label, icon, order, Component })` -> React slot & settings registration.
- **Host State & i18n (`window.GAH`)**:
  - `window.GAH.useHost()` -> React hook returning host state snapshot (`locale`, `busy`, `session`, `workspace`, `model`, `presets`, etc.).
  - `window.GAH.T(zh, en)` -> returns Chinese when `locale === "zh"`, otherwise English (**note parameter order: `zh` first, `en` second**).
  - Dialogs: `await window.GAH.confirmDialog({ title, message })`, `alertDialog`, `promptDialog`.
- **CSS & Theme Isolation Rules**:
  - Never write unscoped bare element selectors (`form`, `button`, `input`) in plugin CSS.
  - Theme plugins (`category = "ui"`) must set `document.documentElement.dataset.theme = "<id>"`, scope all rules under `:root[data-theme="<id>"]`, and delete `dataset.theme` in `api.cleanup(...)`.

---

## 5. Mode Presets (`{data_dir}/presets/<id>.toml`)

```toml
name = "My Mode"
name_zh = "自定义模式"
description = "One-line summary"
description_zh = "一句话中文说明"
plugins = ["*"]               # include "*" to inherit all enabled Host agent plugins
prompt = "Extra system instructions. Data dir: {data_dir}"
prompt_file = "optional_sop.md"  # optional relative file in the presets directory
disable_tools = []            # e.g. ["file_write", "file_patch"]

[config.ga-file-changes]      # per-plugin config overrides (cannot override protected ga-* core plugins)
max_files = 20
```

---

## 6. Standard Execution Workflow (SOP)

1. **Inspect first**: Call `plugin_control(action="list")` to check existing plugins, states, and settings before creating or editing files.
2. **Write clean files**: Create `{data_dir}/plugins/<name>/plugin.toml` and `main.py` (plus `client.js`/`style.css` if UI). Verify `entry = "main:apply"` and route tuple keys `(METHOD, sub_path)`.
3. **Activate / Hot-reload (`plugin_control` actions: `"list"`, `"enable"`, `"disable"`, `"rescan"`)**:
   - New plugin: `plugin_control(action="rescan")`, then `plugin_control(action="enable", name="<name>")`
   - Updated code/manifest: `plugin_control(action="disable", name="<name>")`, `plugin_control(action="rescan")`, then `plugin_control(action="enable", name="<name>")`
4. **Verify & report**:
   - Confirm the returned plugin record has `state == "active"`, `error == null`, and empty `issues`.
   - If the plugin is Host-only (Web UI, theme, HTTP routes), it is live in the user's browser immediately.
   - If the plugin registers Worker tools, hooks, or prompt fragments (`ga.tools`, `ga.hooks`, `ga.prompt`), explicitly inform the user that it takes effect starting from the **next** conversation turn/run.
