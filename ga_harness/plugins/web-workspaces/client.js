var GAHPlugin_web_workspaces = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  function Workspaces({ api }) {
    const { state } = sdk.useHost(), { busy, working, run } = sdk.useOperation(api, !!state.parallel_runs), scope = state.scope;
    const [editing, setEditing] = react.useState(null), [error, setError] = react.useState("");
    const [draft, setDraft] = react.useState(""), [focused, setFocused] = react.useState(false), [active, setActive] = react.useState(0);
    const [dismissed, setDismissed] = react.useState(false);
    const open = (action, id) => {
      if (busy || !scope) return;
      const p = id ? scope.projects.find((item) => item.id === id) : scope.project;
      if (action === "workspace" && p && !id) {
        open("update");
        return;
      }
      if (action === "update" && !p) return;
      setError("");
      setDismissed(true);
      if (action === "update" && p) setEditing({ action, id: p.id, name: p.name, workspace: p.workspace, updated: p.updated });
      else setEditing({ action, name: "", workspace: action === "workspace" ? scope.workspace ?? "" : "" });
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
      const detail = event.detail;
      open((detail == null ? void 0 : detail.action) === "update" || (detail == null ? void 0 : detail.action) === "workspace" ? detail.action : "create", detail == null ? void 0 : detail.id);
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
      /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "composer-top", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-scope-bar", children: [
        scope && !state.messages.length && !state.running && /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "gah-scope-pick", title: sdk.T("发送第一条消息前可以更改", "Can be changed until the first message is sent"), children: [
          /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "folder" }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("项目", "Project") }),
          /* @__PURE__ */ jsxRuntime.jsxs("select", { value: scope.project_id ?? "", disabled: busy, "aria-label": sdk.T("新对话所属项目", "Project for this new chat"), onChange: (event) => enter({ id: event.target.value }), children: [
            /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("未绑定项目", "No project") }),
            scope.projects.map((p) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: p.id, children: p.name }, p.id))
          ] })
        ] }),
        scope && !state.messages.length && !state.running && /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-scope-dir", disabled: busy, title: `${scope.workspace ?? ""}
${scope.project ? sdk.T("点击修改项目目录", "Click to change the project directory") : sdk.T("点击切换工作目录", "Click to switch directory")}`, onClick: () => open("workspace"), children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("目录", "Directory") }),
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: (scope.workspace ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || scope.workspace })
        ] }),
        !!suggestions.length && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-slash", role: "listbox", "aria-label": sdk.T("命令", "Command"), children: suggestions.map((item, index) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-slash-item${index === selected ? " active" : ""}`, role: "option", "aria-selected": index === selected, onMouseDown: (event) => {
          event.preventDefault();
          pick(index);
        }, children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.label }),
          /* @__PURE__ */ jsxRuntime.jsx("small", { children: item.hint })
        ] }, `${item.label}:${index}`)) })
      ] }) }),
      editing && /* @__PURE__ */ jsxRuntime.jsx(sdk.Modal, { className: "gah-ws-dialog", label: sdk.T("工作区与项目设置", "Workspace and project settings"), busy: working, onClose: () => setEditing(null), children: /* @__PURE__ */ jsxRuntime.jsxs("form", { onSubmit: submit, children: [
        /* @__PURE__ */ jsxRuntime.jsx("h2", { children: editing.action === "workspace" ? sdk.T("切换工作目录", "Switch directory") : editing.action === "create" ? sdk.T("新建项目", "New project") : sdk.T("项目设置", "Project settings") }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-ws-help", children: editing.action === "workspace" ? sdk.T("使用服务器已存在的目录。空对话原地切换，有历史时新开对话。工作区不是权限沙箱。", "Use an existing server directory. Empty chats switch in place; chats with history open a new chat. A workspace is not a permission sandbox.") : sdk.T("项目是长期身份，记忆按名称保存在 GA 的 temp/projects/<名称>/。目录只是新会话的默认工作区，修改后已有会话不变。", "A project is a durable identity; its memory lives in GA's temp/projects/<name>/. The directory is only the default for new chats; changing it leaves existing chats untouched.") }),
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
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: editing.action === "workspace" ? sdk.T("服务器上的绝对目录", "Absolute directory on the server") : sdk.T("默认工作目录（可选）", "Default directory (optional)") }),
            /* @__PURE__ */ jsxRuntime.jsx("input", { name: "workspace", required: editing.action === "workspace", autoFocus: editing.action === "workspace", placeholder: editing.action === "workspace" ? "" : `${sdk.T("可留空，使用全局默认工作区", "Optional; uses the global default workspace")}${(scope == null ? void 0 : scope.default_workspace) ? ": " + scope.default_workspace : ""}`, value: editing.workspace, onChange: (event) => field("workspace", event.target.value) })
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
