var GAHPlugin_web_sessions = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const NEW = "新会话";
  const SECTION_COUNTS = [5, 10, 15, 20, 50, 100];
  const SECTION_KEYS = ["projects", "recent"];
  const LAYOUT_KEY = "gah.sessions.layout", DEFAULT_COUNT = { projects: 5, recent: 10 };
  const sectionName = (key) => key === "projects" ? sdk.T("项目", "Projects") : sdk.T("最近", "Recent");
  function normalizeLayout(value) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const valid = Array.isArray(raw.order) ? [...new Set(raw.order.filter((k) => SECTION_KEYS.includes(k)))] : [];
    const order = [...valid, ...SECTION_KEYS.filter((k) => !valid.includes(k))];
    const sections = Object.fromEntries(SECTION_KEYS.map((k) => {
      const old = raw.sections && typeof raw.sections === "object" ? raw.sections[k] ?? {} : {};
      return [k, {
        show: typeof old.show === "boolean" ? old.show : true,
        open: typeof old.open === "boolean" ? old.open : true,
        count: SECTION_COUNTS.includes(Number(old.count)) ? Number(old.count) : DEFAULT_COUNT[k]
      }];
    }));
    return { order, sections };
  }
  const loadLayout = () => {
    try {
      return normalizeLayout(JSON.parse(sdk.saved(LAYOUT_KEY) ?? "{}"));
    } catch {
      return normalizeLayout();
    }
  };
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
    const walk = (s, depth, up) => {
      if (seen.has(s.id)) return;
      seen.add(s.id);
      const mine = (kids.get(s.id) ?? []).filter((k) => !seen.has(k.id));
      out.push({ session: s, depth, kids: mine.length, up });
      for (const k of mine) walk(k, Math.min(depth + 1, 3), [...up, s.id]);
    };
    for (const s of items) if (!s.parent_id || !ids.has(s.parent_id)) walk(s, 0, []);
    for (const s of items) walk(s, 0, []);
    return out;
  }
  const pinFirst = (items) => [...items].sort((a, b) => (b.pinned || 0) - (a.pinned || 0));
  function Sessions({ api }) {
    const { state } = sdk.useHost(), { busy, run } = sdk.useOperation(api, !!state.parallel_runs);
    const [toggled, setToggled] = react.useState(loadToggles), [expanded, setExpanded] = react.useState({});
    const [query, setQuery] = react.useState(""), [moving, setMoving] = react.useState("");
    const [layout, setLayout] = react.useState(loadLayout), [menu, setMenu] = react.useState("");
    const menuRef = react.useRef(null);
    react.useEffect(() => {
      if (!menu) return;
      const close = (event) => {
        var _a;
        if (!((_a = menuRef.current) == null ? void 0 : _a.contains(event.target))) setMenu("");
      };
      const esc = (event) => {
        if (event.key === "Escape") setMenu("");
      };
      document.addEventListener("pointerdown", close, true);
      document.addEventListener("keydown", esc);
      return () => {
        document.removeEventListener("pointerdown", close, true);
        document.removeEventListener("keydown", esc);
      };
    }, [menu]);
    const edited = react.useRef(false);
    const persist = (key, value) => {
      edited.current = true;
      void api.post("", { key, value }).catch(() => void 0);
    };
    react.useEffect(() => {
      void api.get("").then((res) => {
        if (edited.current) return;
        const prefs = (res == null ? void 0 : res.prefs) ?? {};
        if (prefs["sidebar.layout"] !== void 0) {
          const next = normalizeLayout(prefs["sidebar.layout"]);
          setLayout(next);
          sdk.save(LAYOUT_KEY, JSON.stringify(next));
        } else if (sdk.saved(LAYOUT_KEY)) void api.post("", { key: "sidebar.layout", value: loadLayout() }).catch(() => void 0);
        const groups = prefs["sidebar.groups"];
        if (groups && typeof groups === "object" && !Array.isArray(groups)) {
          setToggled(groups);
          sdk.save("gah.sessions.groups", JSON.stringify(groups));
        } else if (sdk.saved("gah.sessions.groups")) void api.post("", { key: "sidebar.groups", value: loadToggles() }).catch(() => void 0);
      }).catch(() => void 0);
    }, []);
    const updateLayout = (edit) => setLayout((old) => {
      const next = normalizeLayout(edit(old));
      if (JSON.stringify(next) !== JSON.stringify(old)) {
        sdk.save(LAYOUT_KEY, JSON.stringify(next));
        persist("sidebar.layout", next);
      }
      return next;
    });
    const setSection = (key, patch) => updateLayout((old) => ({ ...old, sections: { ...old.sections, [key]: { ...old.sections[key], ...patch } } }));
    const moveSection = (key, delta) => updateLayout((old) => {
      const order = [...old.order], from = order.indexOf(key), to = from + delta;
      if (to < 0 || to >= order.length) return old;
      [order[from], order[to]] = [order[to], order[from]];
      return { ...old, order };
    });
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
      if (reset) sdk.pages.home();
    });
    const act = (action, extra = {}) => change("/api/sessions", { action, id: state.session_id, ...extra }, ["new", "select", "delete", "clear"].includes(action));
    const scoped = (body, reset = true) => change("/api/p/web-workspaces/", body, reset);
    const dialog = (action, id) => window.dispatchEvent(new CustomEvent("gah:workspace-dialog", { detail: { action, id } }));
    const toggle = (key, open) => setToggled((old) => {
      const next = { ...old, [key]: !open };
      sdk.save("gah.sessions.groups", JSON.stringify(next));
      persist("sidebar.groups", next);
      return next;
    });
    const activity = /* @__PURE__ */ new Map();
    for (const item of state.runs ?? []) if (item.status === "running" || item.status === "cancelling") activity.set(item.session_id, item.status);
    if (state.running && state.session_id && !activity.has(state.session_id)) activity.set(state.session_id, "running");
    const q = query.trim().toLowerCase();
    const known = new Set(projects.map((p) => p.id)), byProject = /* @__PURE__ */ new Map(), recentAll = [];
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    for (const s of state.sessions ?? []) {
      if (q && !label(s).toLowerCase().includes(q) && !(s.workspace ?? "").toLowerCase().includes(q)) continue;
      recentAll.push(s);
      if (s.project_id && known.has(s.project_id)) byProject.set(s.project_id, [...byProject.get(s.project_id) ?? [], s]);
    }
    const byId = new Map((state.sessions ?? []).map((s) => [s.id, s])), lineage = /* @__PURE__ */ new Set();
    for (let s = byId.get(state.session_id ?? ""); (s == null ? void 0 : s.parent_id) && !lineage.has(s.parent_id); s = byId.get(s.parent_id)) lineage.add(s.parent_id);
    const kidsOpen = (id) => !!q || (toggled[`c:${id}`] ?? lineage.has(id));
    const row = (session, depth, home, recent = false, kids = 0) => {
      const kidsShown = kids > 0 && kidsOpen(session.id);
      const menuKey = `s:${session.id}`, menuOpen = menu === menuKey;
      const pick = (fn) => () => {
        setMenu("");
        fn();
      };
      const owner = recent && session.project_id ? projectName.get(session.project_id) : void 0;
      const status = activity.get(session.id), tag = owner ?? (session.workspace && session.workspace !== home ? base(session.workspace) : "");
      const unread = !status && !!session.unread && !session.parent_id && session.id !== state.session_id;
      return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-sess-row${session.id === state.session_id ? " current" : ""}${status ? " running" : ""}${unread ? " unread" : ""}${depth ? " child" : ""}${kids ? " parent" : ""}${menuOpen ? " menu-open" : ""}`, style: depth ? { "--gah-depth": depth } : void 0, role: "listitem", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-sess-open", disabled: busy, "data-gah-close": "", onClick: () => void act("select", { id: session.id }), title: [label(session), session.workspace, stamp(session.updated)].filter(Boolean).join("\n"), children: [
          session.pinned ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-pin", "aria-label": sdk.T("已置顶", "Pinned"), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pin" }) }) : null,
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-title", children: depth ? label(session).replace(/^\u25b8\s*/, "") : label(session) }),
          tag && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-tag", children: tag }),
          unread && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-unread", role: "status", title: sdk.T("未读", "Unread"), "aria-label": sdk.T("未读", "Unread") }),
          !status && session.updated ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-age", children: ago(session.updated) }) : null,
          status && /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-sess-status ${status}`, role: "status", title: status === "cancelling" ? sdk.T("正在停止", "Stopping") : sdk.T("运行中", "Running"), "aria-label": status === "cancelling" ? sdk.T("正在停止", "Stopping") : sdk.T("运行中", "Running") })
        ] }),
        kids > 0 && /* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            type: "button",
            className: `gah-sess-kids${kidsShown ? " open" : ""}`,
            "aria-expanded": kidsShown,
            disabled: !!q,
            title: kidsShown ? sdk.T("收起子会话", "Collapse sub-chats") : sdk.T("展开子会话", "Expand sub-chats"),
            "aria-label": kidsShown ? sdk.T("收起子会话", "Collapse sub-chats") : sdk.T("展开子会话", "Expand sub-chats"),
            onClick: () => toggle(`c:${session.id}`, kidsShown),
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-kids-n", children: kids }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-caret", "aria-hidden": "true" })
            ]
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-sess-acts", ref: menuOpen ? menuRef : void 0, children: [
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: `gah-sess-act gah-sess-more-btn${menuOpen ? " on" : ""}`, "aria-haspopup": "menu", "aria-expanded": menuOpen, "aria-label": sdk.T("更多操作", "More actions"), title: sdk.T("更多操作", "More actions"), onClick: () => setMenu((m) => m === menuKey ? "" : menuKey), children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-dots", "aria-hidden": "true", children: "⋯" }) }),
          menuOpen && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-menu gah-sess-row-menu", role: "menu", "aria-label": sdk.T("更多操作", "More actions"), children: [
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", disabled: busy, onClick: pick(() => void act(session.pinned ? "unpin" : "pin", { id: session.id })), children: [
              /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pin" }),
              session.pinned ? sdk.T("取消置顶", "Unpin") : sdk.T("置顶", "Pin")
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", disabled: busy, onClick: pick(async () => {
              const title = await sdk.promptDialog({ title: sdk.T("重命名会话", "Rename chat"), placeholder: sdk.T("会话名称", "Chat name"), value: session.title, confirm: sdk.T("保存", "Save") });
              if (title == null ? void 0 : title.trim()) void act("rename", { id: session.id, title: title.trim() });
            }), children: [
              /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pencil" }),
              sdk.T("重命名", "Rename")
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", disabled: busy || !!status, onClick: pick(() => setMoving(session.id)), children: [
              /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "folder" }),
              sdk.T("移动到项目", "Move to project")
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-menu-sep" }),
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item danger", disabled: busy, onClick: pick(async () => {
              if (await sdk.confirmDialog({ title: sdk.T("删除会话", "Remove chat"), danger: true, confirm: sdk.T("删除", "Remove"), message: sdk.T("从列表删除此会话？历史记录保留在本地数据库。", "Remove this chat from the list? History stays in the local database.") })) void act("delete", { id: session.id });
            }), children: [
              /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "trash" }),
              sdk.T("删除", "Remove")
            ] })
          ] })
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
    const list = (key, items, home, limit, recent = false) => {
      const rows = nest(pinFirst(items)).filter((r) => r.up.every(kidsOpen)), all = !!q || !!expanded[key];
      const shown = all ? rows : rows.filter((r, i) => i < limit || r.session.id === state.session_id || !!r.session.pinned);
      return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-items", role: "list", children: [
        rows.length ? shown.map((r) => row(r.session, r.depth, home, recent, r.kids)) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-empty", children: q ? sdk.T("无匹配会话", "No matching chats") : sdk.T("暂无会话", "No chats yet") }),
        !q && rows.length > limit && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-more", onClick: () => setExpanded((old) => ({ ...old, [key]: !all })), children: all ? sdk.T("收起", "Show less") : `${sdk.T("显示全部", "Show all")} (${rows.length})` })
      ] });
    };
    const projectCap = layout.sections.projects.count, allProjects = !!q || !!expanded["projects:all"];
    const matchedProjects = projects.filter((p) => !q || (byProject.get(p.id) ?? []).length || p.name.toLowerCase().includes(q));
    const cappedProjects = allProjects ? matchedProjects : matchedProjects.filter((p, i) => i < projectCap || `p:${p.id}` === current);
    const projectGroups = cappedProjects.map((p) => {
      const key = `p:${p.id}`, items = byProject.get(p.id) ?? [];
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
        open && list(key, items, p.workspace || (scope == null ? void 0 : scope.default_workspace), projectCap)
      ] }, key);
    });
    const sectionMenu = (key, open) => {
      const pref = layout.sections[key], name = sectionName(key), index = layout.order.indexOf(key);
      const pick = (fn) => () => {
        fn();
        setMenu("");
      };
      const hidden = layout.order.filter((k) => k !== key && !layout.sections[k].show);
      return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-menu", role: "menu", "aria-label": `${name}: ${sdk.T("编辑分区", "Edit section")}`, children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-menu-title", children: sdk.T("显示个数", "Display count") }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-menu-counts", children: SECTION_COUNTS.map((n) => /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitemradio", "aria-checked": pref.count === n, className: `gah-sess-menu-count${pref.count === n ? " on" : ""}`, onClick: pick(() => setSection(key, { count: n })), children: n }, n)) }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-menu-sep" }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", disabled: !!q, onClick: pick(() => setSection(key, { open: !open })), children: open ? sdk.T("收起分区", "Collapse section") : sdk.T("展开分区", "Expand section") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", disabled: index <= 0, onClick: pick(() => moveSection(key, -1)), children: sdk.T("上移", "Move up") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", disabled: index >= layout.order.length - 1, onClick: pick(() => moveSection(key, 1)), children: sdk.T("下移", "Move down") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", onClick: pick(() => setSection(key, { show: false })), children: sdk.T("隐藏此分区", "Hide this section") }),
        hidden.map((k) => /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", onClick: pick(() => setSection(k, { show: true })), children: sdk.T("显示“", 'Show "') + sectionName(k) + sdk.T("”", '"') }, k)),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-menu-sep" }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", disabled: busy || !(state.sessions ?? []).some((s) => s.unread), onClick: pick(() => void act("read_all")), children: sdk.T("全部标为已读", "Mark all as read") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "gah-sess-menu-item", onClick: pick(() => updateLayout(() => normalizeLayout())), children: sdk.T("恢复默认", "Restore defaults") })
      ] });
    };
    const sectionHead = (key, open, action) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-label", ref: menu === key ? menuRef : void 0, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-sess-label-toggle", "aria-expanded": open, disabled: !!q, title: open ? sdk.T("收起分区", "Collapse section") : sdk.T("展开分区", "Expand section"), onClick: () => setSection(key, { open: !open }), children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sess-chevron", "aria-hidden": "true" }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sectionName(key) })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: `gah-sess-head-btn gah-sess-edit${menu === key ? " on" : ""}`, "aria-haspopup": "menu", "aria-expanded": menu === key, "aria-label": `${sectionName(key)}: ${sdk.T("编辑分区", "Edit section")}`, title: sdk.T("编辑分区", "Edit section"), onClick: () => setMenu((m) => m === key ? "" : key), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pencil" }) }),
      action,
      menu === key && sectionMenu(key, open)
    ] });
    const sections = {
      projects: () => {
        const open = !!q || layout.sections.projects.open;
        return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-section", "data-section": "projects", children: [
          sectionHead("projects", open, /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-head-btn", disabled: busy, "aria-label": sdk.T("新建项目", "New project"), onClick: () => dialog("create"), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "folder-plus" }) })),
          open && (projects.length ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
            projectGroups,
            !q && matchedProjects.length > projectCap && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-more", onClick: () => setExpanded((old) => ({ ...old, "projects:all": !allProjects })), children: allProjects ? sdk.T("收起项目", "Show fewer projects") : `${sdk.T("显示全部项目", "Show all projects")} (${matchedProjects.length})` })
          ] }) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-empty", children: sdk.T("还没有项目", "No projects yet") }))
        ] }, "projects");
      },
      recent: () => {
        const open = !!q || layout.sections.recent.open;
        return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-section", "data-section": "recent", children: [
          sectionHead("recent", open, /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-head-btn", disabled: busy, "data-gah-close": "", "aria-label": sdk.T("新建对话", "New chat"), onClick: () => void (current === "recent" ? act("new") : scoped({ action: "enter" })), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "plus" }) })),
          open && /* @__PURE__ */ jsxRuntime.jsx("section", { className: `gah-group recent${current === "recent" ? " current" : ""}`, "data-key": "recent", children: list("recent", recentAll, (scope == null ? void 0 : scope.project_id) ? void 0 : scope == null ? void 0 : scope.workspace, layout.sections.recent.count, true) })
        ] }, "recent");
      }
    };
    const shownSections = layout.order.filter((key) => layout.sections[key].show);
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "sidebar", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sessions", hidden: !state.sessions, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "side-item gah-sess-new", disabled: busy, title: (scope == null ? void 0 : scope.project) ? `${sdk.T("在项目中新建", "New chat in")}: ${scope.project.name}` : sdk.T("新建未绑定项目的对话", "New chat without a project"), "data-gah-close": "", onClick: () => void act("new"), children: [
        /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pen" }),
        sdk.T("新会话", "New chat")
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(sdk.PageNav, {}),
      /* @__PURE__ */ jsxRuntime.jsx("input", { type: "search", className: "gah-sess-search", value: query, placeholder: sdk.T("搜索会话", "Search chats"), "aria-label": sdk.T("搜索会话", "Search chats"), onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => {
        if (event.key === "Escape") setQuery("");
      } }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-list", "aria-label": sdk.T("会话列表", "Chats"), children: scope ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        shownSections.map((key) => sections[key]()),
        !shownSections.length && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sess-empty", children: [
          sdk.T("所有分区已隐藏", "All sections are hidden"),
          " ",
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sess-more", onClick: () => updateLayout((old) => ({ ...old, sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, { ...old.sections[k], show: true }])) })), children: sdk.T("全部显示", "Show all") })
        ] })
      ] }) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sess-items flat", role: "list", children: pinFirst((state.sessions ?? []).filter((s) => !q || label(s).toLowerCase().includes(q))).map((s) => row(s, 0)) }) })
    ] }) });
  }
  sdk.defineReact("web-sessions", Sessions);
  exports.SECTION_COUNTS = SECTION_COUNTS;
  exports.Sessions = Sessions;
  exports.normalizeLayout = normalizeLayout;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
