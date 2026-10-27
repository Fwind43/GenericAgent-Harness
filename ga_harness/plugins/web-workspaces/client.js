var GAHPlugin_web_workspaces = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  function Workspaces({ api }) {
    const { state } = sdk.useHost(), { busy, working, run } = sdk.useOperation(api, !!state.parallel_runs), scope = state.scope;
    const [editing, setEditing] = react.useState(null), [error, setError] = react.useState("");
    const [draft, setDraft] = react.useState(""), [focused, setFocused] = react.useState(false), [active, setActive] = react.useState(0);
    const [dismissed, setDismissed] = react.useState(false);
    const open = (action) => {
      if (busy || !scope) return;
      const p = scope.project;
      if (action === "workspace" && p) {
        open("update");
        return;
      }
      if (action === "update" && !p) return;
      setError("");
      setDismissed(true);
      setEditing({ action, id: action === "update" ? p == null ? void 0 : p.id : void 0, name: action === "update" ? (p == null ? void 0 : p.name) ?? "" : "", workspace: scope.workspace ?? "" });
    };
    async function change(body, inDialog = false) {
      return run(async () => {
        const previous = api.state().session_id;
        const next = await api.post("", body);
        api.setState(next, next.session_id !== previous);
      }, inDialog ? setError : api.notice);
    }
    const enter = (body = {}) => {
      void change({ action: "enter", ...body });
    };
    const exits = ["off", "exit", "none", sdk.T("退出", "Leave").toLowerCase()];
    react.useEffect(() => api.listen(window, "gah:workspace-dialog", (event) => {
      var _a;
      const action = (_a = event.detail) == null ? void 0 : _a.action;
      open(action === "update" || action === "workspace" ? action : "create");
    }), [api, busy, scope]);
    react.useEffect(() => api.onHost("composer-draft", (value) => {
      setDraft(value);
      setActive(0);
      setDismissed(false);
    }), [api]);
    react.useEffect(() => api.onHost("composer-focus", setFocused), [api]);
    react.useEffect(() => api.intercept((text) => {
      const match2 = /^\/(project|workspace)(?:\s+([\s\S]*))?$/i.exec(text.trim());
      if (!match2 || !scope) return false;
      const cmd = match2[1].toLowerCase(), arg = (match2[2] || "").trim();
      if (!arg) open(cmd === "workspace" ? "workspace" : scope.project ? "update" : "create");
      else if (exits.includes(arg.toLowerCase())) enter();
      else if (cmd === "workspace") enter({ workspace: arg });
      else if (arg.toLowerCase() === "new") open("create");
      else {
        const matches = scope.projects.filter((p) => p.name.toLowerCase().startsWith(arg.toLowerCase()));
        const project = scope.projects.find((p) => p.id === arg || p.name.toLowerCase() === arg.toLowerCase()) ?? (matches.length === 1 ? matches[0] : void 0);
        if (!project) throw new Error(sdk.T("没有找到项目：", "Project not found: ") + arg + " (/project new)");
        enter({ id: project.id });
      }
      return true;
    }), [api, busy, scope]);
    const suggestions = [];
    const match = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(draft);
    if (match && scope && focused && !busy && !dismissed) {
      const cmd = match[1].toLowerCase(), arg = (match[2] || "").trim(), q = arg.toLowerCase();
      if (match[2] === void 0 && !/\s$/.test(draft)) {
        suggestions.push(...[{ label: "/project", hint: sdk.T("进入项目", "Enter project"), fill: "/project " }, { label: "/workspace", hint: sdk.T("切换工作目录", "Switch directory"), fill: "/workspace " }].filter((item) => item.label.startsWith("/" + cmd)));
      } else if (cmd === "project") {
        suggestions.push(...scope.projects.filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => ({ label: p.name, hint: p.id === scope.project_id ? sdk.T("当前", "Current") : p.workspace, run: () => enter({ id: p.id }) })));
        if (!q || "新建".includes(q) || "new".startsWith(q)) suggestions.push({ label: sdk.T("新建项目", "New project"), hint: "new", run: () => open("create") });
        if (scope.project && (!q || exits.some((exit) => exit.startsWith(q)))) suggestions.push({ label: sdk.T("退出项目", "Leave project"), hint: "off", run: () => enter() });
      } else if (cmd === "workspace") {
        suggestions.push(q ? { label: sdk.T("进入 ", "Enter ") + arg, hint: sdk.T("目录", "Directory"), run: () => enter({ workspace: arg }) } : { label: sdk.T("选择目录", "Choose directory"), hint: scope.workspace ?? "", run: () => open("workspace") });
        if (scope.project || !q) suggestions.push({ label: sdk.T("退出到默认工作区", "Back to default workspace"), hint: "off", run: () => enter() });
      }
    }
    const selected = Math.min(active, Math.max(0, suggestions.length - 1));
    const pick = (index) => {
      var _a;
      const item = suggestions[index];
      if (!item) return;
      sdk.host.emit("draft", item.fill ?? "");
      if (!item.fill) {
        setDismissed(true);
        (_a = item.run) == null ? void 0 : _a.call(item);
      }
    };
    react.useEffect(() => api.onHost("composer-key", (event) => {
      if (!suggestions.length || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") setActive((selected + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
      else if (event.key === "Tab" || event.key === "Enter" && !event.shiftKey) pick(selected);
      else if (event.key === "Escape") setDismissed(true);
      else return;
      event.preventDefault();
      event.stopPropagation();
    }), [api, suggestions, selected]);
    async function submit(event) {
      event.preventDefault();
      if (!editing || busy) return;
      setError("");
      const body = editing.action === "workspace" ? { action: "enter", workspace: editing.workspace } : editing;
      if (await change(body, true)) setEditing(null);
    }
    const field = (key, value) => setEditing((old) => old ? { ...old, [key]: value } : null);
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "composer-top", children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-scope-bar", children: !!suggestions.length && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-slash", role: "listbox", "aria-label": sdk.T("命令", "Command"), children: suggestions.map((item, index) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-slash-item${index === selected ? " active" : ""}`, role: "option", "aria-selected": index === selected, onMouseDown: (event) => {
        event.preventDefault();
        pick(index);
      }, children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.label }),
        /* @__PURE__ */ jsxRuntime.jsx("small", { children: item.hint })
      ] }, `${item.label}:${index}`)) }) }) }),
      editing && /* @__PURE__ */ jsxRuntime.jsx(sdk.Modal, { className: "gah-ws-dialog", label: sdk.T("工作区与项目设置", "Workspace and project settings"), busy: working, onClose: () => setEditing(null), children: /* @__PURE__ */ jsxRuntime.jsxs("form", { onSubmit: submit, children: [
        /* @__PURE__ */ jsxRuntime.jsx("h2", { children: editing.action === "workspace" ? sdk.T("切换工作目录", "Switch directory") : editing.action === "create" ? sdk.T("新建项目", "New project") : sdk.T("项目设置", "Project settings") }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-ws-help", children: editing.action === "workspace" ? sdk.T("使用服务器已存在的目录。空对话原地切换，有历史时新开对话。工作区不是权限沙箱。", "Use an existing server directory. Empty chats switch in place; chats with history open a new chat. A workspace is not a permission sandbox.") : sdk.T("项目共享工作目录，对话历史独立。项目记忆由 GA 官方项目模式维护（temp/projects/<名称>/）。", "Projects share a working directory; chat histories stay separate. Project memory is maintained by GA's official project mode (temp/projects/<name>/).") }),
        /* @__PURE__ */ jsxRuntime.jsxs("fieldset", { disabled: busy, style: { border: 0, padding: 0, margin: 0, minWidth: 0 }, children: [
          editing.action !== "workspace" && /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "gah-ws-field", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("名称", "Name") }),
            /* @__PURE__ */ jsxRuntime.jsx("input", { name: "name", required: true, maxLength: 120, autoFocus: true, value: editing.name, onChange: (event) => field("name", event.target.value) })
          ] }),
          editing.id && /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "gah-ws-field", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: "ID" }),
            /* @__PURE__ */ jsxRuntime.jsx("input", { name: "project_id", readOnly: true, value: editing.id })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "gah-ws-field", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("服务器上的绝对目录", "Absolute directory on the server") }),
            /* @__PURE__ */ jsxRuntime.jsx("input", { name: "workspace", required: true, autoFocus: editing.action === "workspace", readOnly: editing.action === "update", value: editing.workspace, onChange: (event) => field("workspace", event.target.value) })
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-ws-error", role: "alert", children: error }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ws-actions", children: [
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: working, onClick: () => setEditing(null), children: sdk.T("取消", "Cancel") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", className: "gah-ws-save", disabled: busy, children: editing.action === "workspace" ? sdk.T("进入工作区", "Enter workspace") : editing.action === "create" ? sdk.T("创建并进入", "Create and enter") : sdk.T("保存", "Save") })
        ] })
      ] }) })
    ] });
  }
  sdk.defineReact("web-workspaces", Workspaces);
  exports.Workspaces = Workspaces;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
