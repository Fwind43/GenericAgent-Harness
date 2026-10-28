var GAHPlugin_web_sessions = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const RECENT = 5, NEW = "新会话";
  const base = (path = "") => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  const label = (s) => !s.title || s.title === NEW ? sdk.T(NEW, "New chat") : s.title;
  const ago = (ts) => {
    if (!ts) return "";
    const secs = Math.max(0, Date.now() / 1e3 - ts);
    if (secs < 60) return sdk.T("刚刚", "now");
    if (secs < 3600) return Math.floor(secs / 60) + sdk.T("分", "m");
    if (secs < 86400) return Math.floor(secs / 3600) + sdk.T("小时", "h");
    if (secs < 86400 * 7) return Math.floor(secs / 86400) + sdk.T("天", "d");
    const d = new Date(ts * 1e3);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const stamp = (ts) => ts ? new Date(ts * 1e3).toLocaleString() : "";
  const loadToggles = () => {
    try {
      const value = JSON.parse(sdk.saved("gah.sessions.groups") ?? "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  function nest(items) {
    const ids = new Set(items.map((s) => s.id)), kids = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
    for (const s of items) if (s.parent_id && s.parent_id !== s.id && ids.has(s.parent_id)) kids.set(s.parent_id, [...kids.get(s.parent_id) ?? [], s]);
    const out = [];
    const walk = (s, depth) => {
      if (seen.has(s.id)) return;
      seen.add(s.id);
      out.push({ session: s, depth });
      for (const k of kids.get(s.id) ?? []) walk(k, Math.min(depth + 1, 3));
    };
    for (const s of items) if (!s.parent_id || !ids.has(s.parent_id)) walk(s, 0);
    for (const s of items) walk(s, 0);
    return out;
  }
  function Sessions({ api }) {
    const { state } = sdk.useHost(), { busy, run } = sdk.useOperation(api, !!state.parallel_runs);
    const [toggled, setToggled] = react.useState(loadToggles), [expanded, setExpanded] = react.useState({});
    const [query, setQuery] = react.useState(""), [moving, setMoving] = react.useState("");
    const scope = state.scope, projects = (scope == null ? void 0 : scope.projects) ?? [];
    const current = (scope == null ? void 0 : scope.project_id) ? `p:${scope.project_id}` : "recent", previous = react.useRef(current);
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
    const scoped = (body, reset = true) => change("/api/p/web-workspaces/", body, reset);
    const dialog = (action, id) => window.dispatchEvent(new CustomEvent("gah:workspace-dialog", { detail: { action, id } }));
    const toggle = (key, open) => setToggled((old) => {
      const next = { ...old, [key]: !open };
      sdk.save("gah.sessions.groups", JSON.stringify(next));
      return next;
    });
    const activity = /* @__PURE__ */ new Map();
    for (const item of state.runs ?? []) if (item.status === "running" || item.status === "cancelling") activity.set(item.session_id, item.status);
    if (state.running && state.session_id && !activity.has(state.session_id)) activity.set(state.session_id, "running");
    const q = query.trim().toLowerCase();
    const known = new Set(projects.map((p) => p.id)), byProject = /* @__PURE__ */ new Map(), loose = [];
    for (const s of state.sessions ?? []) {
      if (q && !label(s).toLowerCase().includes(q) && !(s.workspace ?? "").toLowerCase().includes(q)) continue;
      if (s.project_id && known.has(s.project_id)) byProject.set(s.project_id, [...byProject.get(s.project_id) ?? [], s]);
      else loose.push(s);
    }
    const row = (session, depth, home) => {
      const status = activity.get(session.id), tag = session.workspace && session.workspace !== home ? base(session.workspace) : "";
      return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-sess-row${session.id === state.session_id ? " current" : ""}${status ? " running" : ""}${depth ? " child" : ""}`, style: depth ? { paddingLeft: depth * 14 } : void 0, role: "listitem", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-sess-open", disabled: busy, "data-gah-close": "", onClick: () => void act("select", { id: session.id }), title: [label(session), session.workspace, stamp(session.updated)].filter(Boolean).join("\n"), children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-title", children: label(session) }),
          tag && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-tag", children: tag }),
          !status && session.updated ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-age", children: ago(session.updated) }) : null,
          status && /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-sess-status ${status}`, role: "status", title: status === "cancelling" ? sdk.T("正在停止", "Stopping") : sdk.T("运行中", "Running"), "aria-label": status === "cancelling" ? sdk.T("正在停止", "Stopping") : sdk.T("运行中", "Running") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-sess-acts", children: [
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-act", disabled: busy, "aria-label": sdk.T("重命名", "Rename"), onClick: async () => {
            const title = await sdk.promptDialog({ title: sdk.T("重命名会话", "Rename chat"), placeholder: sdk.T("会话名称", "Chat name"), value: session.title, confirm: sdk.T("保存", "Save") });
            if (title == null ? void 0 : title.trim()) void act("rename", { id: session.id, title: title.trim() });
          }, children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pencil" }) }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-act", disabled: busy || !!status, "aria-label": sdk.T("移动到项目", "Move to project"), "aria-expanded": moving === session.id, onClick: () => setMoving(moving === session.id ? "" : session.id), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "folder" }) }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-act", disabled: busy, "aria-label": sdk.T("删除", "Remove"), onClick: async () => {
            if (await sdk.confirmDialog({ title: sdk.T("删除会话", "Remove chat"), danger: true, confirm: sdk.T("删除", "Remove"), message: sdk.T("从列表删除此会话？历史记录保留在本地数据库。", "Remove this chat from the list? History stays in the local database.") })) void act("delete", { id: session.id });
          }, children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "trash" }) })
        ] }),
        moving === session.id && /* @__PURE__ */ jsxRuntime.jsxs(
          "select",
          {
            className: "gah-sess-move",
            autoFocus: true,
            "aria-label": sdk.T("移动到项目", "Move to project"),
            value: session.project_id && known.has(session.project_id) ? session.project_id : "",
            onKeyDown: (event) => {
              if (event.key === "Escape") setMoving("");
            },
            onBlur: () => setMoving(""),
            onChange: (event) => {
              const target = event.target.value;
              setMoving("");
              void scoped({ action: "move", session_id: session.id, project_id: target }, false);
            },
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("无项目", "No project") }),
              projects.map((p) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: p.id, children: p.name }, p.id))
            ]
          }
        )
      ] }, session.id);
    };
    const list = (key, items, home) => {
      const rows = nest(items), all = !!q || !!expanded[key];
      const shown = all ? rows : rows.filter((r, i) => i < RECENT || r.session.id === state.session_id);
      return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-items", role: "list", children: [
        rows.length ? shown.map((r) => row(r.session, r.depth, home)) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-empty", children: q ? sdk.T("无匹配会话", "No matching chats") : sdk.T("暂无会话", "No chats yet") }),
        !q && rows.length > RECENT && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-more", onClick: () => setExpanded((old) => ({ ...old, [key]: !all })), children: all ? sdk.T("收起", "Show less") : `${sdk.T("显示全部", "Show all")} (${rows.length})` })
      ] });
    };
    const projectGroups = projects.map((p) => {
      const key = `p:${p.id}`, items = byProject.get(p.id) ?? [];
      if (q && !items.length && !p.name.toLowerCase().includes(q)) return null;
      const isCurrent = key === current, open = q ? true : toggled[key] ?? isCurrent;
      return /* @__PURE__ */ jsxRuntime.jsxs("section", { className: `gah-group project${isCurrent ? " current" : ""}`, "data-key": key, children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-group-head", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-group-toggle", title: p.workspace, "aria-expanded": open, onClick: () => toggle(key, open), children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-ico gah-ico-closed", "data-i": "folder", "aria-hidden": "true" }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-ico gah-ico-open", "data-i": "folder-open", "aria-hidden": "true" }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-group-name", children: p.name }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-group-count", children: (byProject.get(p.id) ?? []).length })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-group-add", disabled: busy, "data-gah-close": "", "aria-label": `${sdk.T("新建对话", "New chat")}: ${p.name}`, onClick: () => void (isCurrent ? act("new") : scoped({ action: "enter", id: p.id })), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "plus" }) }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-group-add", disabled: busy, "aria-label": `${sdk.T("项目设置", "Project settings")}: ${p.name}`, onClick: () => dialog("update", p.id), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pencil" }) }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-group-add", disabled: busy, "aria-label": `${sdk.T("删除项目", "Delete project")}: ${p.name}`, onClick: async () => {
            if (await sdk.confirmDialog({ title: sdk.T("删除项目", "Delete project"), danger: true, confirm: sdk.T("删除", "Delete"), message: sdk.T("删除项目“", 'Delete project "') + p.name + sdk.T("”？其中的会话会移到“最近”，项目记忆文件保留在磁盘上。", '"? Its chats move to Recent; the project memory files stay on disk.') })) void scoped({ action: "delete", id: p.id }, isCurrent);
          }, children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "trash" }) })
        ] }),
        open && list(key, items, p.workspace || (scope == null ? void 0 : scope.default_workspace))
      ] }, key);
    });
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "sidebar", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sessions", hidden: !state.sessions, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "side-item gah-sess-new", disabled: busy, title: (scope == null ? void 0 : scope.project) ? `${sdk.T("在项目中新建", "New chat in")}: ${scope.project.name}` : sdk.T("新建未绑定项目的对话", "New chat without a project"), "data-gah-close": "", onClick: () => void act("new"), children: [
        /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pen" }),
        sdk.T("新会话", "New chat")
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("input", { type: "search", className: "gah-sess-search", value: query, placeholder: sdk.T("搜索会话", "Search chats"), "aria-label": sdk.T("搜索会话", "Search chats"), onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => {
        if (event.key === "Escape") setQuery("");
      } }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-list", "aria-label": sdk.T("会话列表", "Chats"), children: scope ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-label", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("项目", "Projects") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-head-btn", disabled: busy, "aria-label": sdk.T("新建项目", "New project"), onClick: () => dialog("create"), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "folder-plus" }) })
        ] }),
        projects.length ? projectGroups : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-empty", children: sdk.T("还没有项目", "No projects yet") }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-label", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("最近", "Recent") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-head-btn", disabled: busy, "data-gah-close": "", "aria-label": sdk.T("新建对话", "New chat"), onClick: () => void (current === "recent" ? act("new") : scoped({ action: "enter" })), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "plus" }) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("section", { className: `gah-group recent${current === "recent" ? " current" : ""}`, "data-key": "recent", children: list("recent", loose, scope.project_id ? void 0 : scope.workspace) })
      ] }) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-items flat", role: "list", children: (state.sessions ?? []).filter((s) => !q || label(s).toLowerCase().includes(q)).map((s) => row(s, 0)) }) })
    ] }) });
  }
  sdk.defineReact("web-sessions", Sessions);
  exports.Sessions = Sessions;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
