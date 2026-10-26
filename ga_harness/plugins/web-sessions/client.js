var GAHPlugin_web_sessions = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const base = (path = "") => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  const scopeKey = (state) => {
    var _a, _b;
    return ((_a = state.scope) == null ? void 0 : _a.project_id) ? `p:${state.scope.project_id}` : `w:${((_b = state.scope) == null ? void 0 : _b.workspace) ?? ""}`;
  };
  function groupSessions(state) {
    const groups = /* @__PURE__ */ new Map(), scope = state.scope;
    if (!scope) return [];
    const get = (group) => {
      if (!groups.has(group.key)) groups.set(group.key, group);
      return groups.get(group.key);
    };
    const projectGroup = (p) => ({ key: `p:${p.id}`, kind: "project", name: p.name, path: p.workspace, body: { id: p.id }, items: [] });
    const workspaceGroup = (path = "") => ({ key: `w:${path}`, kind: "workspace", name: base(path), path, body: { workspace: path }, items: [] });
    for (const session of state.sessions ?? []) {
      const project = scope.projects.find((p) => p.id === session.project_id);
      get(project ? projectGroup(project) : workspaceGroup(session.workspace)).items.push(session);
    }
    scope.projects.forEach((p) => get(projectGroup(p)));
    if (!scope.project_id) get(workspaceGroup(scope.workspace));
    return [...groups.values()];
  }
  function Sessions({ api }) {
    var _a;
    const { state } = sdk.useHost(), { busy, run } = sdk.useOperation(api, !!state.parallel_runs);
    const [toggled, setToggled] = react.useState(() => {
      try {
        const value = JSON.parse(sdk.saved("gah.sessions.groups") ?? "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    });
    const current = scopeKey(state), previous = react.useRef(current);
    react.useEffect(() => {
      if (previous.current !== current) {
        previous.current = current;
        setToggled((old) => {
          const next = { ...old };
          delete next[current];
          return next;
        });
      }
    }, [current]);
    const change = (path, body, reset) => run(async () => {
      const next = await api.host.post(path, body);
      api.setState(next, reset);
    });
    const act = (action, extra = {}) => change("/api/sessions", { action, id: state.session_id, ...extra }, ["new", "select", "delete", "clear"].includes(action));
    const row = (session) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-sess-row${session.id === state.session_id ? " current" : ""}`, role: "listitem", children: [
      /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-open", disabled: busy, "data-gah-close": "", onClick: () => void act("select", { id: session.id }), title: session.title, children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-title", children: session.title === "新会话" ? sdk.T("新会话", "New chat") : session.title || sdk.T("新会话", "New chat") }) }),
      /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-sess-acts", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-act", disabled: busy, "aria-label": sdk.T("重命名", "Rename"), onClick: () => {
          const title = prompt(sdk.T("会话名称", "Chat name"), session.title);
          if (title == null ? void 0 : title.trim()) void act("rename", { id: session.id, title: title.trim() });
        }, children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pencil" }) }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-act", disabled: busy, "aria-label": sdk.T("删除", "Remove"), onClick: () => {
          if (confirm(sdk.T("从列表删除此会话？历史记录保留在本地数据库。", "Remove this chat from the list? History stays in the local database."))) void act("delete", { id: session.id });
        }, children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "trash" }) })
      ] })
    ] }, session.id);
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "sidebar", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sessions", hidden: !state.sessions, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "side-item gah-sess-new", disabled: busy, "data-gah-close": "", onClick: () => void act("new"), children: [
        /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pen" }),
        sdk.T("新会话", "New chat")
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-label", children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("会话", "Chat") }),
        state.scope && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-head-btn", disabled: busy, "aria-label": sdk.T("新建项目", "New project"), onClick: () => window.dispatchEvent(new CustomEvent("gah:workspace-dialog", { detail: { action: "create" } })), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "folder-plus" }) })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-list", "aria-label": sdk.T("会话列表", "Chats"), children: state.scope ? groupSessions(state).map((group) => {
        const isCurrent = group.key === current, open = toggled[group.key] ?? isCurrent;
        return /* @__PURE__ */ jsxRuntime.jsxs("section", { className: `gah-group ${group.kind}${isCurrent ? " current" : ""}`, "data-key": group.key, children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-group-head", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-group-toggle", title: group.path, "aria-expanded": open, onClick: () => setToggled((old) => {
              const next = { ...old, [group.key]: !open };
              sdk.save("gah.sessions.groups", JSON.stringify(next));
              return next;
            }), children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-ico gah-ico-closed", "data-i": "folder", "aria-hidden": "true" }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-ico gah-ico-open", "data-i": "folder-open", "aria-hidden": "true" }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-group-name", children: group.name })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-group-add", disabled: busy, "data-gah-close": "", "aria-label": `${sdk.T("新建对话", "New chat")}: ${group.name}`, onClick: () => void (isCurrent ? act("new") : change("/api/p/web-workspaces/", { action: "enter", ...group.body }, true)), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "plus" }) })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-items", role: "list", hidden: !open, children: group.items.length ? group.items.map(row) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-empty", children: sdk.T("暂无会话", "No chats yet") }) })
        ] }, group.key);
      }) : (_a = state.sessions) == null ? void 0 : _a.map(row) })
    ] }) });
  }
  sdk.defineReact("web-sessions", Sessions);
  exports.Sessions = Sessions;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
