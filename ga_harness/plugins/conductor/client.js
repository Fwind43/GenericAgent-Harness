(function(jsxRuntime, react, sdk) {
  "use strict";
  const STATUS = {
    running: ["运行中", "Running"],
    done: ["已完成", "Done"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"]
  };
  const REVIEW = {
    verified: ["已验收", "Verified"],
    needs_work: ["需返工", "Needs work"]
  };
  const label = (map, key) => key ? map[key] ? sdk.T(map[key][0], map[key][1]) : key : "";
  function useConductor(api) {
    const { state } = sdk.useHost();
    const [busy, setBusy] = react.useState(false);
    const data = state.conductor;
    const sid = state.session_id;
    const run = async (path, body) => {
      if (!sid) return;
      setBusy(true);
      try {
        await api.post(path, { session_id: sid, ...body });
      } catch (error) {
        api.notice(String((error == null ? void 0 : error.message) || error));
      } finally {
        setBusy(false);
      }
    };
    return { data, sid, busy, run };
  }
  function TaskRow({ task, busy, act }) {
    const [open, setOpen] = react.useState(false);
    const terminal = task.status !== "running";
    const canResolve = terminal && !task.resolved && (task.status !== "done" || task.review === "verified");
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-cd-task ${task.status}${task.resolved ? " resolved" : ""}`, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-cd-head", "aria-expanded": open, onClick: () => setOpen(!open), children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-cd-dot ${task.status}` }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-title", title: task.objective, children: task.title || task.id }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag", children: label(STATUS, task.status) }),
        task.review ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-cd-tag review ${task.review}`, children: label(REVIEW, task.review) }) : null,
        task.resolved ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag", children: sdk.T("已结案", "Resolved") }) : null
      ] }),
      open ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("目标", "Objective") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: task.objective })
        ] }),
        task.result ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("结果", "Result") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: task.result })
        ] }) : null,
        task.error ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field error", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("错误", "Error") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: task.error })
        ] }) : null,
        task.basis ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("验收依据", "Review basis") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: task.basis })
        ] }) : null,
        !terminal || canResolve ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-actions", children: [
          !terminal ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "danger", disabled: busy, onClick: () => act("cancel", task), children: sdk.T("取消", "Cancel") }) : null,
          canResolve ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: busy, onClick: () => act("resolve", task), children: sdk.T("结案", "Resolve") }) : null
        ] }) : null
      ] }) : null
    ] });
  }
  function Panel({ api }) {
    var _a;
    const { data, sid, busy, run } = useConductor(api);
    const [open, setOpen] = react.useState(false);
    const box = react.useRef(null);
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
      document.addEventListener("keydown", key);
      return () => {
        document.removeEventListener("mousedown", down);
        document.removeEventListener("keydown", key);
      };
    }, [open]);
    react.useEffect(() => {
      setOpen(false);
    }, [sid]);
    if (!data || !sid) return null;
    if ((_a = data.children) == null ? void 0 : _a[sid]) {
      return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-cd-chip child", title: sdk.T("本会话由指挥家派发，结果会自动回报父会话", "Dispatched by a conductor; the result is reported back to the parent session"), children: [
        /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("子任务", "Subtask") })
      ] });
    }
    const on = data.enabled.includes(sid);
    const tasks = data.tasks.filter((t) => {
      var _a2, _b;
      return ((_b = (_a2 = data.children) == null ? void 0 : _a2[t.child]) == null ? void 0 : _b.parent) === sid;
    });
    if (!on && !tasks.length) return null;
    const running = tasks.filter((t) => t.status === "running").length;
    const done = tasks.filter((t) => t.status !== "running").length;
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-anchor", ref: box, children: [
      /* @__PURE__ */ jsxRuntime.jsxs(
        "button",
        {
          type: "button",
          className: `gah-cd-chip${on ? " on" : ""}${open ? " open" : ""}`,
          "aria-expanded": open,
          "aria-haspopup": "dialog",
          onClick: () => setOpen(!open),
          title: sdk.T("指挥家任务", "Conductor tasks"),
          children: [
            running ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-dot running" }) : /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: tasks.length ? `${done}/${tasks.length}` : sdk.T("指挥家", "Conductor") }),
            /* @__PURE__ */ jsxRuntime.jsx("svg", { className: "gah-cd-caret", viewBox: "0 0 10 10", width: "9", height: "9", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M2 3.5l3 3 3-3", stroke: "currentColor", strokeWidth: "1.4", fill: "none", strokeLinecap: "round" }) })
          ]
        }
      ),
      open ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd", role: "dialog", "aria-label": sdk.T("指挥家", "Conductor"), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-bar", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-cd-badge", children: [
            /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
            sdk.T("指挥家模式", "Conductor mode")
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-hint", children: tasks.length ? sdk.T(`任务 ${tasks.length} · 运行中 ${running}/${data.limits.running}`, `${tasks.length} tasks · ${running}/${data.limits.running} running`) : sdk.T("只拆分、分派、验收，不亲自执行", "Splits, dispatches and reviews; does not execute itself") }),
          on ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-cd-off", disabled: busy, onClick: () => run("toggle", { enabled: false }), children: sdk.T("关闭", "Turn off") }) : null
        ] }),
        tasks.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-list", children: tasks.map((task) => /* @__PURE__ */ jsxRuntime.jsx(TaskRow, { task, busy, act: (path, t) => run(path, { task_id: t.id }) }, task.id)) }) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-empty", children: sdk.T("还没有子任务", "No tasks yet") })
      ] }) : null
    ] });
  }
  const Icon = () => /* @__PURE__ */ jsxRuntime.jsxs("svg", { className: "gah-cd-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M3 3.5h4M3 8h10M3 12.5h6", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", fill: "none" }),
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "11", cy: "3.5", r: "1.6", fill: "currentColor" }),
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "12", cy: "12.5", r: "1.6", fill: "currentColor" })
  ] });
  function Toggle({ api }) {
    var _a;
    const { data, sid, busy, run } = useConductor(api);
    if (!data || !sid || ((_a = data.children) == null ? void 0 : _a[sid])) return null;
    const on = data.enabled.includes(sid);
    return /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        className: `gah-cd-pill${on ? " on" : ""}`,
        "aria-pressed": on,
        disabled: busy,
        onClick: () => run("toggle", { enabled: !on }),
        title: sdk.T("指挥家模式：本会话只拆分并分派子任务，每个子任务在独立会话中执行", "Conductor mode: this session only splits and dispatches tasks; each task runs in its own session"),
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("指挥家", "Conductor") })
        ]
      }
    );
  }
  function ConductorPlugin({ api }) {
    react.useEffect(() => api.mount("composer", /* @__PURE__ */ jsxRuntime.jsx(Toggle, { api })), [api]);
    react.useEffect(() => api.mount("header", /* @__PURE__ */ jsxRuntime.jsx(Panel, { api })), [api]);
    return null;
  }
  sdk.defineReact("conductor", ConductorPlugin);
})(GAH.jsxRuntime, GAH.React, GAH);
