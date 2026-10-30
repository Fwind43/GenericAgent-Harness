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
    if (!data || !sid) return null;
    if ((_a = data.children) == null ? void 0 : _a[sid]) {
      return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd gah-cd-child", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-bar", children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-badge", children: sdk.T("指挥家子任务", "Conductor task") }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-hint", children: sdk.T("本会话由指挥家派发，结果会自动回报父会话", "Dispatched by a conductor; the result is reported back to the parent session") })
      ] }) });
    }
    const on = data.enabled.includes(sid);
    const tasks = data.tasks.filter((t) => {
      var _a2, _b;
      return ((_b = (_a2 = data.children) == null ? void 0 : _a2[t.child]) == null ? void 0 : _b.parent) === sid;
    });
    if (!on && !tasks.length) return null;
    const running = tasks.filter((t) => t.status === "running").length;
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd", "aria-label": sdk.T("指挥家", "Conductor"), children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-bar", children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-badge", children: sdk.T("指挥家模式", "Conductor mode") }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-hint", children: tasks.length ? sdk.T(`任务 ${tasks.length} · 运行中 ${running}/${data.limits.running}`, `${tasks.length} tasks · ${running}/${data.limits.running} running`) : sdk.T("只拆分、分派、验收，不亲自执行", "Splits, dispatches and reviews; does not execute itself") }),
        on ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: busy, onClick: () => run("toggle", { enabled: false }), children: sdk.T("关闭", "Turn off") }) : null
      ] }),
      tasks.map((task) => /* @__PURE__ */ jsxRuntime.jsx(TaskRow, { task, busy, act: (path, t) => run(path, { task_id: t.id }) }, task.id))
    ] });
  }
  function Toggle({ api }) {
    var _a;
    const { data, sid, busy, run } = useConductor(api);
    if (!data || !sid || ((_a = data.children) == null ? void 0 : _a[sid])) return null;
    const on = data.enabled.includes(sid);
    return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-group gah-cd-toggle", children: /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        className: on ? "on" : "",
        "aria-pressed": on,
        disabled: busy,
        onClick: () => run("toggle", { enabled: !on }),
        title: sdk.T("指挥家模式：本会话只拆分并分派子任务，每个子任务在独立会话中执行", "Conductor mode: this session only splits and dispatches tasks; each task runs in its own session"),
        children: [
          sdk.T("指挥家", "Conductor"),
          on ? " · ON" : ""
        ]
      }
    ) });
  }
  function ConductorPlugin({ api }) {
    react.useEffect(() => api.mount("toolbar", /* @__PURE__ */ jsxRuntime.jsx(Toggle, { api })), [api]);
    react.useEffect(() => api.mount("composer-top", /* @__PURE__ */ jsxRuntime.jsx(Panel, { api })), [api]);
    return null;
  }
  sdk.defineReact("conductor", ConductorPlugin);
})(GAH.jsxRuntime, GAH.React, GAH);
