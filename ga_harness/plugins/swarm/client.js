(function(jsxRuntime, react, reactDom, sdk) {
  "use strict";
  const EFFORTS = ["low", "medium", "high"];
  const COORD = "coordinator";
  const errText = (error) => String((error == null ? void 0 : error.message) || error);
  function useSwarm(api) {
    const { state } = sdk.useHost();
    const [busy, setBusy] = react.useState(false);
    const data = state.swarm;
    const sid = state.session_id;
    const run = async (path, body = {}) => {
      if (!sid) return false;
      setBusy(true);
      try {
        await api.post(path, { session_id: sid, ...body });
        return true;
      } catch (error) {
        api.notice(errText(error));
        return false;
      } finally {
        setBusy(false);
      }
    };
    return { data, sid, busy, run };
  }
  const Icon = () => /* @__PURE__ */ jsxRuntime.jsxs("svg", { className: "gah-sw-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", fill: "none", stroke: "currentColor", strokeWidth: "1.4", children: [
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "8", cy: "3.2", r: "1.7" }),
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "3.2", cy: "12", r: "1.7" }),
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "12.8", cy: "12", r: "1.7" }),
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M7 4.7 4.2 10.4M9 4.7l2.8 5.7M4.9 12h6.2", strokeLinecap: "round" })
  ] });
  const Check = () => /* @__PURE__ */ jsxRuntime.jsx("svg", { className: "gah-menu-check", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "m3.5 8.5 3 3 6-7", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }) });
  const Empty = ({ title, hint, compact }) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: compact ? "gah-sw-empty compact" : "gah-sw-empty", children: [
    compact ? null : /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-empty-ico", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx(Icon, {}) }),
    /* @__PURE__ */ jsxRuntime.jsx("b", { children: title }),
    hint ? /* @__PURE__ */ jsxRuntime.jsx("span", { children: hint }) : null
  ] });
  const STATUS = {
    running: ["运行中", "Running"],
    queued: ["排队中", "Queued"],
    idle: ["空闲", "Idle"],
    recovering: ["等待恢复", "Waiting to resume"],
    waiting: ["等待中", "Waiting"],
    error: ["出错", "Error"],
    removed: ["已移除", "Removed"]
  };
  const statusLabel = (s) => {
    const v = STATUS[s || "idle"];
    return v ? sdk.T(v[0], v[1]) : s || "";
  };
  const fmtSecs = (s) => s == null ? "" : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m`;
  const fmtTime = (t) => {
    const d = new Date(t * 1e3);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  function Toggle({ api }) {
    var _a;
    const { data, sid, busy, run } = useSwarm(api);
    if (!data || !sid || ((_a = data.members) == null ? void 0 : _a[sid])) return null;
    const on = data.enabled.includes(sid);
    return /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        role: "menuitemcheckbox",
        className: "gah-menu-item",
        "aria-checked": on,
        disabled: busy,
        onClick: () => run("toggle", { enabled: !on }),
        title: sdk.T("蜂群模式：本会话作为协调者组建角色团队，成员在共享留言板上互相 @ 协作", "Swarm mode: this session coordinates a team of roles that collaborate by @-mentioning each other on a shared board"),
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("蜂群模式", "Swarm mode") }),
          on ? /* @__PURE__ */ jsxRuntime.jsx(Check, {}) : null
        ]
      }
    );
  }
  function Graph({ view }) {
    var _a;
    const names = [COORD, ...view.members.filter((m) => !m.removed).map((m) => m.name)];
    for (const e of view.edges) for (const n of [e.from, e.to]) if (!names.includes(n)) names.push(n);
    const size = 300, c = size / 2, r = names.length > 1 ? size / 2 - 42 : 0;
    const pos = {};
    names.forEach((n, i) => {
      const a = -Math.PI / 2 + 2 * Math.PI * i / names.length;
      pos[n] = [c + r * Math.cos(a), c + r * Math.sin(a)];
    });
    const max = Math.max(1, ...view.edges.map((e) => e.count));
    const status = { [COORD]: (_a = view.coordinator) == null ? void 0 : _a.status };
    view.members.forEach((m) => {
      status[m.name] = m.removed ? "removed" : m.status;
    });
    if (!view.edges.length) return /* @__PURE__ */ jsxRuntime.jsx(Empty, { title: sdk.T("还没有 @ 互动", "No @-mentions yet"), hint: sdk.T("成员之间每次 @ 对方，都会在这里画一条带方向的连线", "Each time one participant @-mentions another, a directed edge appears here.") });
    return /* @__PURE__ */ jsxRuntime.jsxs("svg", { className: "gah-sw-graph", viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": sdk.T("@ 关系图", "Mention graph"), children: [
      /* @__PURE__ */ jsxRuntime.jsx("defs", { children: /* @__PURE__ */ jsxRuntime.jsx("marker", { id: "gah-sw-arrow", viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M0 0 8 4 0 8z", fill: "currentColor" }) }) }),
      view.edges.filter((e) => pos[e.from] && pos[e.to] && e.from !== e.to).map((e) => {
        const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to];
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        const ox = -uy * 4, oy = ux * 4, pad = 20;
        return /* @__PURE__ */ jsxRuntime.jsx("g", { className: "gah-sw-edge", children: /* @__PURE__ */ jsxRuntime.jsx(
          "line",
          {
            x1: x1 + ux * pad + ox,
            y1: y1 + uy * pad + oy,
            x2: x2 - ux * pad + ox,
            y2: y2 - uy * pad + oy,
            strokeWidth: 1 + 3 * e.count / max,
            markerEnd: "url(#gah-sw-arrow)",
            children: /* @__PURE__ */ jsxRuntime.jsx("title", { children: `@${e.from} → @${e.to} ×${e.count}` })
          }
        ) }, `${e.from}>${e.to}`);
      }),
      names.map((n) => /* @__PURE__ */ jsxRuntime.jsxs("g", { className: `gah-sw-node ${status[n] || "idle"}`, transform: `translate(${pos[n][0]},${pos[n][1]})`, children: [
        /* @__PURE__ */ jsxRuntime.jsx("circle", { r: "16" }),
        /* @__PURE__ */ jsxRuntime.jsx("text", { y: "4", textAnchor: "middle", children: n === COORD ? "★" : n === "user" ? "U" : n.slice(0, 2) }),
        /* @__PURE__ */ jsxRuntime.jsxs("text", { className: "gah-sw-label", y: "30", textAnchor: "middle", children: [
          "@",
          n
        ] })
      ] }, n))
    ] });
  }
  function PostRow({ post }) {
    const [open, setOpen] = react.useState(false);
    const long = post.text.length > 280 || post.text.split("\n").length > 6;
    const parts = post.text.split(/(@[a-z0-9_-]+)/gi);
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-sw-post ${post.kind}${post.author === "user" ? " user" : ""}`, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-meta", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("b", { children: [
          "@",
          post.author
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
          "#",
          post.id
        ] }),
        post.kind === "direct" ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-direct", title: sdk.T("你在成员会话里的私聊指示，自动记录到留言板，不会唤醒任何人", "Your private instruction in a member session, recorded here without waking anyone"), children: sdk.T("私聊", "Private") }) : null,
        post.reply_to ? /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
          "↪",
          " #",
          post.reply_to
        ] }) : null,
        post.via ? /* @__PURE__ */ jsxRuntime.jsx("span", { title: sdk.T("来自非蜂群调度的运行", "Posted from a run not scheduled by the swarm"), children: post.via }) : null,
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-time", children: fmtTime(post.created) })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: `gah-sw-text${long && !open ? " clamp" : ""}`, children: parts.map((p, i) => p.startsWith("@") ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-at", children: p }, i) : p) }),
      long ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-more", onClick: () => setOpen(!open), children: open ? sdk.T("收起", "Less") : sdk.T("展开", "More") }) : null
    ] });
  }
  function mentionOptions(view) {
    const people = [view.coordinator, ...view.members].filter((m) => m && !m.removed);
    return [
      ...people.map((m) => ({ tag: m.name, hint: m.name === COORD ? sdk.T("协调者", "Coordinator") : m.role || "", kind: "member" })),
      ...Object.entries(view.groups || {}).map(([g, names]) => ({ tag: g, hint: names.map((n) => `@${n}`).join(" "), kind: "group" })),
      { tag: "all", hint: sdk.T("所有成员", "Everyone"), kind: "all" }
    ];
  }
  function Board({ api, view, run, busy }) {
    var _a;
    const [text, setText] = react.useState("");
    const [at, setAt] = react.useState(null);
    const [pick, setPick] = react.useState(0);
    const input = react.useRef(null);
    const [older, setOlder] = react.useState([]);
    const [loading, setLoading] = react.useState(false);
    const list = react.useRef(null);
    const { state } = sdk.useHost();
    const posts = [...older.filter((p) => !view.posts.some((q) => q.id === p.id)), ...view.posts];
    const last = (_a = view.posts[view.posts.length - 1]) == null ? void 0 : _a.id;
    react.useEffect(() => {
      setOlder([]);
    }, [view.id]);
    react.useEffect(() => {
      const el = list.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [last]);
    const more = async () => {
      if (!posts.length || loading) return;
      setLoading(true);
      try {
        const res = await api.post("board", { session_id: state.session_id, before: posts[0].id });
        setOlder((o) => [...res.posts || [], ...o]);
      } catch (error) {
        api.notice(errText(error));
      } finally {
        setLoading(false);
      }
    };
    const send = async (event) => {
      event.preventDefault();
      const value = text.trim();
      if (!value || busy) return;
      if (await run("post", { text: value })) setText("");
    };
    const options = at ? mentionOptions(view).filter((o) => o.tag.toLowerCase().startsWith(at.q.toLowerCase())).slice(0, 8) : [];
    const menu = at && options.length ? options : null;
    const track = (value, caret) => {
      const hit = /(?:^|[^\w@])@([A-Za-z0-9_-]{0,32})$/.exec(value.slice(0, caret ?? value.length));
      setAt(hit ? { start: (caret ?? value.length) - hit[1].length - 1, q: hit[1] } : null);
      setPick(0);
    };
    const choose = (o) => {
      if (!at) return;
      const rest = text.slice(at.start + 1 + at.q.length).replace(/^ /, "");
      const next = `${text.slice(0, at.start)}@${o.tag} ${rest}`;
      const caret = at.start + o.tag.length + 2;
      setText(next);
      setAt(null);
      requestAnimationFrame(() => {
        const el = input.current;
        if (el) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      });
    };
    const keys = (event) => {
      if (!menu || event.nativeEvent.isComposing) return;
      const n = menu.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") setPick((i) => (i + (event.key === "ArrowDown" ? 1 : n - 1)) % n);
      else if (event.key === "Enter" || event.key === "Tab") choose(menu[Math.min(pick, n - 1)]);
      else if (event.key === "Escape") setAt(null);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-board", ref: list, children: [
        posts.length && posts[0].id > 1 ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-more", disabled: loading, onClick: more, children: sdk.T("加载更早的帖子", "Load earlier posts") }) : null,
        posts.length ? posts.map((p) => /* @__PURE__ */ jsxRuntime.jsx(PostRow, { post: p }, p.id)) : /* @__PURE__ */ jsxRuntime.jsx(Empty, { title: sdk.T("留言板还是空的", "The board is empty"), hint: sdk.T("在主对话里把任务交给协调者，它会招募成员并在这里分工。\n也可以直接发帖，用 @名字 唤醒某个成员。", "Hand the task to the coordinator in the main chat; it recruits members and splits the work here.\nYou can also post directly; @name wakes a member.") })
      ] }),
      view.enabled ? /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "gah-sw-compose", onSubmit: send, children: [
        menu ? /* @__PURE__ */ jsxRuntime.jsx("ul", { className: "gah-sw-mention", role: "listbox", id: "gah-sw-mention", children: menu.map((o, i) => /* @__PURE__ */ jsxRuntime.jsxs(
          "li",
          {
            id: `gah-sw-mention-${i}`,
            role: "option",
            "aria-selected": i === pick,
            className: i === pick ? "on" : void 0,
            onMouseDown: (e) => {
              e.preventDefault();
              choose(o);
            },
            onMouseEnter: () => setPick(i),
            children: [
              /* @__PURE__ */ jsxRuntime.jsxs("b", { children: [
                "@",
                o.tag
              ] }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: o.hint })
            ]
          },
          `${o.kind}:${o.tag}`
        )) }) : null,
        /* @__PURE__ */ jsxRuntime.jsx(
          "input",
          {
            ref: input,
            value: text,
            disabled: busy,
            maxLength: 8e3,
            autoComplete: "off",
            onChange: (e) => {
              setText(e.target.value);
              track(e.target.value, e.target.selectionStart);
            },
            onClick: (e) => track(e.currentTarget.value, e.currentTarget.selectionStart),
            onKeyDown: keys,
            onBlur: () => setAt(null),
            role: "combobox",
            "aria-expanded": !!menu,
            "aria-controls": "gah-sw-mention",
            "aria-autocomplete": "list",
            "aria-activedescendant": menu ? `gah-sw-mention-${Math.min(pick, menu.length - 1)}` : void 0,
            placeholder: sdk.T("发帖，@名字 唤醒成员", "Post, @name wakes a member"),
            title: sdk.T("@名字 / @组 / @all 都会唤醒对应成员", "@name, @group or @all wakes the matching members")
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", disabled: busy || !text.trim(), children: sdk.T("发送", "Post") })
      ] }) : null
    ] });
  }
  function ModelEdit({ m, busy, models, save }) {
    const cur = m.pending_settings || m;
    const [model, setModel] = react.useState(cur.model_key || cur.model || "");
    const [effort, setEffort] = react.useState(cur.effort || "");
    const efforts = effort && !EFFORTS.includes(effort) ? [...EFFORTS, effort] : EFFORTS;
    const rows = models || [];
    const known = !model || rows.some((r) => (r.key || r.name) === model || r.name === model);
    const dirty = model !== (cur.model_key || cur.model || "") || effort !== (cur.effort || "");
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-model", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("label", { children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("模型", "Model") }),
        /* @__PURE__ */ jsxRuntime.jsxs("select", { value: model, disabled: busy || models === null, onChange: (e) => setModel(e.target.value), children: [
          /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("默认模型", "Default model") }),
          !known ? /* @__PURE__ */ jsxRuntime.jsx("option", { value: model, children: model }) : null,
          rows.map((r) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: r.key || r.name, children: r.name }, r.key || r.name))
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("label", { children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("推理", "Effort") }),
        /* @__PURE__ */ jsxRuntime.jsxs("select", { value: effort, disabled: busy, onChange: (e) => setEffort(e.target.value), children: [
          /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("默认", "Default") }),
          efforts.map((v) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: v, children: v }, v))
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-on", disabled: busy || !dirty, onClick: () => void save(m, model, effort), children: sdk.T("应用", "Apply") }),
      m.pending_settings ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-model-note", children: sdk.T("当前运行结束后生效", "Takes effect after the current run") }) : null,
      models !== null && !models.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-model-note", children: sdk.T("没有可选的模型目录", "No model catalog available") }) : null
    ] });
  }
  function MemberRow({ m, me, busy, act, enter, models, loadModels, save }) {
    var _a;
    const [open, setOpen] = react.useState(false);
    const st = m.removed ? "removed" : m.status || "idle";
    const stopLabel = st === "recovering" ? sdk.T("取消恢复", "Cancel recovery") : sdk.T("停止当前运行", "Stop current run");
    const detail = [m.role, m.model || sdk.T("默认模型", "Default model"), m.effort, m.branch && `⎇ ${m.branch}`].filter(Boolean).join(" · ");
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-sw-member${m.removed ? " removed" : ""}${m.name === me ? " me" : ""}`, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-row", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-sw-name", onClick: () => {
          if (!open) loadModels();
          setOpen(!open);
        }, "aria-expanded": open, children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-sw-dot ${st}`, "aria-hidden": "true" }),
          /* @__PURE__ */ jsxRuntime.jsxs("b", { children: [
            "@",
            m.name
          ] }),
          ((_a = m.groups) == null ? void 0 : _a.length) ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-groups", children: m.groups.map((g) => `@${g}`).join(" ") }) : null,
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-detail", children: detail })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-sw-st", children: [
          statusLabel(st),
          m.recovery ? ` ${m.recovery.attempt}/${m.recovery.limit}` : "",
          st === "running" && m.elapsed != null ? ` ${fmtSecs(m.elapsed)}` : "",
          m.pending ? ` +${m.pending}` : ""
        ] }),
        m.session && m.name !== me ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-act", title: sdk.T("打开该成员会话（私聊不会发到留言板）", "Open member session (private chat stays off the board)"), onClick: () => enter(m), children: "↗" }) : null,
        st === "running" || st === "recovering" ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-act", disabled: busy, title: stopLabel, "aria-label": stopLabel, onClick: () => act("cancel", m), children: "■" }) : null,
        !m.removed && m.name !== COORD ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-act", disabled: busy, title: sdk.T("移出蜂群", "Remove from swarm"), onClick: () => act("remove", m), children: "×" }) : null
      ] }),
      open ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-brief", children: [
        m.brief ? /* @__PURE__ */ jsxRuntime.jsx("div", { children: m.brief }) : null,
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-facts", children: [
          sdk.T("运行", "Runs"),
          " ",
          m.runs || 0,
          m.worktree ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
            " ",
            "·",
            " ",
            /* @__PURE__ */ jsxRuntime.jsx("code", { title: m.worktree, children: m.worktree })
          ] }) : null
        ] }),
        m.error ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-err", children: m.error }) : null,
        !m.removed ? /* @__PURE__ */ jsxRuntime.jsx(ModelEdit, { m, busy, models, save }, `${m.model_key || m.model || ""}|${m.effort || ""}|${JSON.stringify(m.pending_settings || null)}`) : null
      ] }) : null
    ] });
  }
  function Panel({ api }) {
    var _a, _b, _c;
    const { data, sid, busy, run } = useSwarm(api);
    const [open, setOpen] = react.useState(false);
    const [tab, setTab] = react.useState("board");
    const box = react.useRef(null);
    const pop = react.useRef(null);
    const kebab = react.useRef(null);
    const [menu, setMenu] = react.useState(false);
    const [models, setModels] = react.useState(null);
    const modelsLoading = react.useRef(false);
    react.useLayoutEffect(() => {
      if (!open) return;
      const fit = () => {
        const el = pop.current;
        if (!el) return;
        el.style.transform = "";
        const rect = el.getBoundingClientRect();
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const pad = 12;
        let dx = 0;
        if (rect.left < pad) dx = pad - rect.left;
        else if (rect.right > vw - pad) dx = vw - pad - rect.right;
        if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
      };
      fit();
      window.addEventListener("resize", fit);
      return () => window.removeEventListener("resize", fit);
    }, [open]);
    react.useEffect(() => {
      if (!open) return;
      const down = (event) => {
        var _a2;
        if (!((_a2 = box.current) == null ? void 0 : _a2.contains(event.target))) setOpen(false);
      };
      const key = (event) => {
        if (event.key === "Escape") setOpen(false);
      };
      document.addEventListener("mousedown", down);
      document.addEventListener("touchstart", down, { passive: true });
      document.addEventListener("keydown", key);
      return () => {
        document.removeEventListener("mousedown", down);
        document.removeEventListener("touchstart", down);
        document.removeEventListener("keydown", key);
      };
    }, [open]);
    react.useEffect(() => {
      setOpen(false);
    }, [sid]);
    react.useEffect(() => {
      if (!open) setMenu(false);
    }, [open]);
    react.useEffect(() => {
      if (!menu) return;
      const down = (event) => {
        var _a2;
        if (!((_a2 = kebab.current) == null ? void 0 : _a2.contains(event.target))) setMenu(false);
      };
      const key = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setMenu(false);
        }
      };
      document.addEventListener("mousedown", down);
      document.addEventListener("keydown", key, true);
      return () => {
        document.removeEventListener("mousedown", down);
        document.removeEventListener("keydown", key, true);
      };
    }, [menu]);
    const swid = ((_a = data == null ? void 0 : data.view) == null ? void 0 : _a.id) || "";
    const tail = ((_b = data == null ? void 0 : data.view) == null ? void 0 : _b.posts) || [];
    const lastId = tail.length ? tail[tail.length - 1].id : 0;
    const [seen, setSeen] = react.useState(null);
    react.useEffect(() => {
      if (!swid) {
        setSeen(null);
        return;
      }
      let stored = null;
      try {
        stored = localStorage.getItem(`gah-sw-seen:${swid}`);
      } catch {
      }
      setSeen(stored === null ? null : Number(stored) || 0);
    }, [swid]);
    react.useEffect(() => {
      if (!swid || seen !== null && !(open && tab === "board" && lastId > seen)) return;
      setSeen(lastId);
      try {
        localStorage.setItem(`gah-sw-seen:${swid}`, String(lastId));
      } catch {
      }
    }, [swid, seen, open, tab, lastId]);
    const view = data == null ? void 0 : data.view;
    if (!data || !sid || !view) return null;
    const isCoord = view.me === COORD;
    const live = view.members.filter((m) => !m.removed);
    const running = live.filter((m) => m.status === "running").length + (((_c = view.coordinator) == null ? void 0 : _c.status) === "running" ? 1 : 0);
    const act = async (path, m) => {
      if (path === "remove" && !window.confirm(sdk.T(`确定把 @${m.name} 移出蜂群？`, `Remove @${m.name} from the swarm?`))) return;
      await run(path, { name: m.name });
    };
    const loadModels = () => {
      if (models !== null || modelsLoading.current) return;
      modelsLoading.current = true;
      api.post("models", { session_id: sid }).then((res) => setModels((res || {}).models || [])).catch((error) => {
        api.notice(errText(error));
        setModels([]);
      }).finally(() => {
        modelsLoading.current = false;
      });
    };
    const save = (m, model, effort) => run("model", { name: m.name, model, effort });
    const enter = async (m) => {
      if (!m.session) return;
      setOpen(false);
      try {
        api.setState(await api.host.post("/api/sessions", { action: "select", id: m.session }), true);
        sdk.pages.home();
      } catch (error) {
        api.notice(errText(error));
      }
    };
    const fresh = seen === null ? [] : view.posts.filter((p) => p.id > seen && p.author !== "user");
    const latest = fresh[fresh.length - 1];
    const gist = latest ? `@${latest.author}: ${latest.text.replace(/\s+/g, " ").trim()}` : "";
    const label = isCoord ? sdk.T("蜂群", "Swarm") : `@${view.me}`;
    const state = !view.enabled ? sdk.T("已关闭", "Off") : view.awaiting_user ? sdk.T("等待你的回复", "Awaiting your reply") : view.paused ? sdk.T("已暂停", "Paused") : "";
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-anchor", ref: box, children: [
      /* @__PURE__ */ jsxRuntime.jsxs(
        "button",
        {
          type: "button",
          className: `gah-sw-chip${view.enabled ? " on" : ""}${open ? " open" : ""}`,
          "aria-expanded": open,
          onClick: () => setOpen(!open),
          title: isCoord ? sdk.T("蜂群模式：本会话是协调者", "Swarm mode: this session is the coordinator") : sdk.T("本会话是蜂群成员；在这里私聊不会发到留言板", "This session is a swarm member; chatting here stays off the board"),
          children: [
            /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: label }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-count", children: running ? `${running}/${live.length + 1}` : live.length + 1 }),
            state ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-state", children: state }) : null,
            fresh.length && !open ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-latest", title: gist, children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-gist", children: gist }) }) : null,
            /* @__PURE__ */ jsxRuntime.jsx("svg", { className: "gah-sw-caret", viewBox: "0 0 16 16", width: "10", height: "10", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "m4 6 4 4 4-4", fill: "none", stroke: "currentColor", strokeWidth: "1.6" }) })
          ]
        }
      ),
      open ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw", ref: pop, role: "dialog", "aria-label": sdk.T("蜂群", "Swarm"), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-bar", children: [
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-tabs", role: "tablist", children: ["board", "members", "graph"].map((k) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "tab", "aria-selected": tab === k, className: tab === k ? "on" : "", onClick: () => setTab(k), children: [
            k === "board" ? sdk.T("留言板", "Board") : k === "members" ? sdk.T("成员", "Members") : sdk.T("关系", "Graph"),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-tab-n", children: k === "board" ? view.total_posts : k === "members" ? live.length + 1 : view.edges.length })
          ] }, k)) }),
          view.enabled && view.paused && !view.awaiting_user ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-on", disabled: busy, onClick: () => run("resume"), title: String(view.paused), children: sdk.T("继续", "Resume") }) : null,
          isCoord && !view.enabled ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-on", disabled: busy, onClick: () => run("toggle", { enabled: true }), children: sdk.T("重新开启蜂群", "Turn swarm on") }) : null,
          /* @__PURE__ */ jsxRuntime.jsx(
            "button",
            {
              type: "button",
              className: "gah-sw-kebab-btn gah-sw-popout",
              title: sdk.T("在新窗口打开群聊", "Open group chat in a new window"),
              "aria-label": sdk.T("弹出群聊窗口", "Pop out group chat"),
              onClick: () => {
                setOpen(false);
                popout(view.id, sid);
              },
              children: /* @__PURE__ */ jsxRuntime.jsx("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M9 2.5h4.5V7M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }) })
            }
          ),
          isCoord && view.enabled ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-kebab", ref: kebab, children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: `gah-sw-kebab-btn${menu ? " open" : ""}`, "aria-haspopup": "menu", "aria-expanded": menu, "aria-label": sdk.T("更多", "More"), title: sdk.T("更多", "More"), onClick: () => setMenu(!menu), children: /* @__PURE__ */ jsxRuntime.jsxs("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "3.5", cy: "8", r: "1.3", fill: "currentColor" }),
              /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "8", cy: "8", r: "1.3", fill: "currentColor" }),
              /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "12.5", cy: "8", r: "1.3", fill: "currentColor" })
            ] }) }),
            menu ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-menu", role: "menu", children: /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "menuitem", className: "gah-sw-danger", disabled: busy, onClick: () => {
              setMenu(false);
              void run("toggle", { enabled: false });
            }, children: [
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("关闭蜂群", "Turn off swarm") }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("停止自动唤醒成员，留言和会话都保留\n可以随时重新开启", "Stops auto-waking members; posts and sessions are kept.\nYou can turn it back on anytime.") })
            ] }) }) : null
          ] }) : null
        ] }),
        view.enabled && view.paused && !view.awaiting_user ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-note", children: [
          sdk.T("已暂停自动唤醒：", "Auto-wake paused: "),
          String(view.paused)
        ] }) : null,
        view.enabled && view.awaiting_user ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-note", children: sdk.T("自动唤醒已暂停。在协调者对话中回复，或在看板发帖即可继续。", "Automatic wake-ups are on hold. Reply in the coordinator chat or post on the board to continue.") }) : null,
        data.persistence_error ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-note err", children: data.persistence_error }) : null,
        tab === "board" ? /* @__PURE__ */ jsxRuntime.jsx(Board, { api, view, run, busy }) : null,
        tab === "members" ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-list", children: [
          /* @__PURE__ */ jsxRuntime.jsx(MemberRow, { m: { ...view.coordinator, name: COORD, role: sdk.T("协调者", "Coordinator") }, me: view.me, busy, act, enter, models, loadModels, save }),
          view.members.map((m) => /* @__PURE__ */ jsxRuntime.jsx(MemberRow, { m, me: view.me, busy, act, enter, models, loadModels, save }, m.name)),
          !live.length ? /* @__PURE__ */ jsxRuntime.jsx(Empty, { compact: true, title: sdk.T("还没有招募其他成员", "No other members yet"), hint: sdk.T("协调者会按任务需要招募角色，每个成员都有独立会话", "The coordinator recruits roles as needed; each member gets its own session.") }) : null,
          data.limits ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-facts", children: [
            sdk.T("全局运行", "Running globally"),
            " ",
            data.running ?? 0,
            data.limits.global_max ? ` / ${data.limits.global_max}` : ""
          ] }) : null
        ] }) : null,
        tab === "graph" ? /* @__PURE__ */ jsxRuntime.jsx(Graph, { view }) : null
      ] }) : null
    ] });
  }
  function Slash({ api }) {
    const { data, sid, run } = useSwarm(api);
    react.useEffect(() => api.intercept((text) => {
      const match = /^\/swarm(?:\s+([\s\S]*))?$/i.exec(text.trim());
      if (!match || !sid || !data) return false;
      const arg = (match[1] || "").trim();
      const low = arg.toLowerCase();
      const view = data.view;
      if (!arg || low === "on") void run("toggle", { enabled: true });
      else if (low === "off" || low === sdk.T("关闭", "off")) void run("toggle", { enabled: false });
      else if (low === "resume") void run("resume");
      else if (!view) throw new Error(sdk.T("当前会话不在蜂群中，先用 /swarm 开启", "This session is not in a swarm; start one with /swarm"));
      else void run("post", { text: arg });
      return true;
    }), [api, sid, data]);
    return null;
  }
  const ROOM = (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      return q.get("gah_swarm") ? { id: q.get("gah_swarm") || "", sid: q.get("s") || "" } : null;
    } catch {
      return null;
    }
  })();
  function popout(id, sid) {
    const url = `${window.location.pathname}?gah_swarm=${encodeURIComponent(id)}&s=${encodeURIComponent(sid)}`;
    const w = window.open(url, `gah-swarm-${id}`, "popup=yes,width=980,height=780");
    if (w) w.focus();
  }
  function Room({ api }) {
    const { data, sid, busy, run } = useSwarm(api);
    const switching = react.useRef(false);
    react.useEffect(() => {
      if (!(ROOM == null ? void 0 : ROOM.sid) || !sid || sid === ROOM.sid || switching.current) return;
      switching.current = true;
      api.host.post("/api/sessions", { action: "select", id: ROOM.sid }).then((st) => api.setState(st, true)).catch((error) => api.notice(errText(error)));
    }, [api, sid]);
    const view = data == null ? void 0 : data.view;
    react.useEffect(() => {
      document.title = `${sdk.T("蜂群群聊", "Swarm chat")}${view ? ` · ${view.members.filter((m) => !m.removed).length + 1}` : ""}`;
    }, [view]);
    let body;
    if (!data || !sid) body = /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-room-empty", children: sdk.T("加载中…", "Loading…") });
    else if (!view) body = /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-room-empty", children: sdk.T("当前会话不在蜂群中", "This session is not in a swarm") });
    else {
      const people = [{ ...view.coordinator, name: COORD, role: sdk.T("协调者", "Coordinator") }, ...view.members.filter((m) => !m.removed)];
      const state = !view.enabled ? sdk.T("已关闭", "Off") : view.awaiting_user ? sdk.T("等待你的回复", "Awaiting your reply") : view.paused ? sdk.T("已暂停", "Paused") : "";
      body = /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        /* @__PURE__ */ jsxRuntime.jsxs("header", { className: "gah-sw-room-head", children: [
          /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("蜂群群聊", "Swarm chat") }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-sw-room-sub", children: [
            view.me === COORD ? "" : `@${view.me} · `,
            sdk.T(`${people.length} 位成员`, `${people.length} members`)
          ] }),
          state ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-state", children: state }) : null,
          view.enabled && view.paused && !view.awaiting_user ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sw-on", disabled: busy, onClick: () => run("resume"), children: sdk.T("继续", "Resume") }) : null
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-room-body", children: [
          /* @__PURE__ */ jsxRuntime.jsx("aside", { className: "gah-sw-room-roster", children: people.map((m) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sw-room-person", title: m.error || m.role || "", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-sw-dot ${m.status || "idle"}` }),
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-sw-room-name", children: [
              "@",
              m.name,
              m.name === view.me ? /* @__PURE__ */ jsxRuntime.jsx("i", { children: sdk.T("（我）", " (me)") }) : null
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-room-role", children: m.role || "" }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sw-room-st", children: statusLabel(m.status) })
          ] }, m.name)) }),
          /* @__PURE__ */ jsxRuntime.jsxs("main", { className: "gah-sw-room-main", children: [
            data.persistence_error ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-note err", children: data.persistence_error }) : null,
            /* @__PURE__ */ jsxRuntime.jsx(Board, { api, view, run, busy })
          ] })
        ] })
      ] });
    }
    return reactDom.createPortal(/* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sw-room", children: body }), document.body);
  }
  function SwarmPlugin({ api }) {
    react.useEffect(() => api.mount("composer-menu", /* @__PURE__ */ jsxRuntime.jsx(Toggle, { api })), [api]);
    react.useEffect(() => ROOM ? void 0 : api.mount("header", /* @__PURE__ */ jsxRuntime.jsx(Panel, { api })), [api]);
    react.useEffect(() => {
      if (!ROOM) return;
      document.documentElement.classList.add("gah-sw-room-mode");
      return () => document.documentElement.classList.remove("gah-sw-room-mode");
    }, []);
    return ROOM ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(Slash, { api }),
      /* @__PURE__ */ jsxRuntime.jsx(Room, { api })
    ] }) : /* @__PURE__ */ jsxRuntime.jsx(Slash, { api });
  }
  sdk.defineReact("swarm", SwarmPlugin);
})(GAH.jsxRuntime, GAH.React, GAH.ReactDOM, GAH);
