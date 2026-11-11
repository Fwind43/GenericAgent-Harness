(function(jsxRuntime, react, sdk) {
  "use strict";
  const REFLECT_TERMINAL = /* @__PURE__ */ new Set(["done", "stopped", "error", "interrupted"]);
  const REFLECT_STATUS = {
    starting: ["启动中", "Starting"],
    sleeping: ["监听中", "Watching"],
    pending: ["等待唤醒", "Pending"],
    submitting: ["唤醒中", "Submitting"],
    waiting: ["等待回执", "Waiting for result"],
    callback: ["回调中", "Callback"],
    stopped: ["已停止", "Stopped"],
    done: ["已完成", "Done"],
    error: ["出错", "Error"],
    interrupted: ["已中断", "Interrupted"]
  };
  const PROGRESS_STATUS = {
    active: ["推进中", "Active"],
    waiting_children: ["等待子任务", "Waiting for tasks"],
    waiting_external: ["等待外部事件", "Waiting for event"],
    idle_backoff: ["空转退避", "Idle backoff"],
    paused: ["已暂停", "Paused"],
    blocked: ["需要用户处理", "Blocked"],
    done: ["已完成", "Done"]
  };
  const STATUS = {
    running: ["运行中", "Running"],
    done: ["已完成", "Done"],
    error: ["出错", "Error"],
    aborted: ["已取消", "Cancelled"],
    interrupted: ["已中断", "Interrupted"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"]
  };
  const REVIEW = {
    pending: ["待验收", "Awaiting review"],
    verified: ["已验收", "Verified"],
    needs_work: ["需返工", "Needs work"]
  };
  const label = (map, key) => key ? map[key] ? sdk.T(map[key][0], map[key][1]) : key : "";
  function formatRemaining(expires) {
    if (expires == null) return ["永久", "Permanent"];
    if (!expires) return null;
    const sec = Math.max(0, Math.round(expires - Date.now() / 1e3));
    if (sec <= 0) return ["已到期", "Expired"];
    if (sec < 60) return [`剩余 ${sec}s`, `${sec}s left`];
    const mins = Math.floor(sec / 60);
    if (mins < 60) return [`剩余 ${mins}m`, `${mins}m left`];
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 48) return [remMins ? `剩余 ${hours}h ${remMins}m` : `剩余 ${hours}h`, remMins ? `${hours}h ${remMins}m left` : `${hours}h left`];
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return [remHours ? `剩余 ${days}d ${remHours}h` : `剩余 ${days}d`, remHours ? `${days}d ${remHours}h left` : `${days}d left`];
  }
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
    const load = async (task) => {
      if (!sid) return null;
      try {
        return (await api.post("task", { session_id: sid, task_id: task.id })).task || null;
      } catch {
        return null;
      }
    };
    return { data, sid, busy, run, load };
  }
  function TaskRow({ task, busy, act, enter, load }) {
    var _a, _b, _c, _d;
    const [open, setOpen] = react.useState(false);
    const [full, setFull] = react.useState(null);
    const stamp = [task.id, task.status, task.review || "", task.runs || 0, ((_a = task.result) == null ? void 0 : _a.length) || 0, ((_b = task.basis) == null ? void 0 : _b.length) || 0, task.result_complete, task.result_source].join("|");
    react.useEffect(() => {
      if (!open || !task.partial) {
        setFull(null);
        return;
      }
      let live = true;
      setFull(null);
      load(task).then((value) => {
        if (live) setFull(value);
      });
      return () => {
        live = false;
      };
    }, [open, task.partial, stamp]);
    const text = { ...task, ...full || {} };
    const terminal = task.status !== "running";
    const canResolve = terminal && !task.resolved && (task.status !== "done" || task.review === "verified");
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-cd-task ${task.status}${task.resolved ? " resolved" : ""}`, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-row", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-cd-head", "aria-expanded": open, onClick: () => setOpen(!open), children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-cd-dot ${task.status}` }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-title", title: task.objective, children: task.title || task.id }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag", children: label(STATUS, task.status) }),
          task.review && task.status === "done" ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-cd-tag review ${task.review}`, children: label(REVIEW, task.review) }) : null,
          task.model || task.effort ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag model", title: sdk.T("子任务模型 / 推理强度", "Task model / reasoning effort"), children: [task.model, task.effort].filter(Boolean).join(" · ") }) : null,
          task.resolved ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag", children: sdk.T("已结案", "Resolved") }) : null
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx(
          "button",
          {
            type: "button",
            className: "gah-cd-enter",
            disabled: busy,
            onClick: () => enter(task),
            title: sdk.T("进入该子任务的会话", "Open this task's chat"),
            "aria-label": sdk.T("进入会话", "Open chat"),
            children: /* @__PURE__ */ jsxRuntime.jsx("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M6 3h7v7M13 3L4 12", stroke: "currentColor", strokeWidth: "1.6", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" }) })
          }
        )
      ] }),
      open ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("目标", "Objective") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: text.objective })
        ] }),
        task.metrics ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-meta", children: [
          sdk.T("本次运行 ", "Last run"),
          task.metrics.seconds == null ? "" : `${task.metrics.seconds.toFixed(1)}s · `,
          task.metrics.turns ?? 0,
          " ",
          sdk.T("轮", "turns"),
          " ",
          "·",
          " ",
          ((_c = task.metrics.usage) == null ? void 0 : _c.input) ?? 0,
          " in / ",
          ((_d = task.metrics.usage) == null ? void 0 : _d.output) ?? 0,
          " out"
        ] }) : null,
        task.failure_kind ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-field error", children: /* @__PURE__ */ jsxRuntime.jsxs("p", { children: [
          task.failure_kind,
          task.retryable ? sdk.T("（可重试的基础设施故障）", " (retryable infrastructure failure)") : ""
        ] }) }) : null,
        text.result ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("结果", "Result") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: text.result })
        ] }) : null,
        terminal && text.result_complete === false ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-field error", children: /* @__PURE__ */ jsxRuntime.jsx("p", { children: sdk.T("未收到完整最终交付；请补充报告或独立核对产物后再验收。", "No complete final delivery. Request a report or independently inspect artifacts before verifying.") }) }) : null,
        text.result_truncated || task.partial && !full ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-hint", children: sdk.T("当前为摘要；完整内容可在子任务会话中查看。", "Preview only; open the task chat for full details.") }) : null,
        task.stage ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-meta", children: sdk.T(`阶段 ${task.stage}`, `Stage ${task.stage}`) }) : null,
        text.error ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field error", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("错误", "Error") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: text.error })
        ] }) : null,
        text.basis ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("验收依据", "Review basis") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: text.basis })
        ] }) : null,
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-actions", children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            "button",
            {
              type: "button",
              className: "primary",
              disabled: busy,
              onClick: () => enter(task),
              title: sdk.T("进入该子任务的会话", "Open this task's chat"),
              children: sdk.T("进入会话", "Open chat")
            }
          ),
          !terminal ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "danger", disabled: busy, onClick: () => act("cancel", task), children: sdk.T("取消", "Cancel") }) : null,
          canResolve ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: busy, onClick: () => act("resolve", task), children: sdk.T("结案", "Resolve") }) : null
        ] })
      ] }) : null
    ] });
  }
  function ReflectRow({ item, busy, stop }) {
    const [open, setOpen] = react.useState(item.status === "error" || item.status === "interrupted");
    const active = !REFLECT_TERMINAL.has(item.status);
    const dotClass = active ? "running" : item.status;
    const cadence = item.once ? sdk.T("单次", "Once") : `${item.interval ?? 5}s`;
    const rem = active ? formatRemaining(item.expires) : null;
    const expText = item.expires ? new Date(item.expires * 1e3).toLocaleString() : "";
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `gah-cd-task${active ? "" : " resolved"}`, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-row", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-cd-head", "aria-expanded": open, onClick: () => setOpen(!open), children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: `gah-cd-dot ${dotClass}` }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-title", children: item.title || item.id }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-cd-tag model", title: sdk.T("检查周期 / 已触发次数", "Poll interval / trigger count"), children: [
            cadence,
            (item.triggers ?? 0) > 0 ? ` · #${item.triggers}` : ""
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag", children: label(REFLECT_STATUS, item.status) })
        ] }),
        active ? /* @__PURE__ */ jsxRuntime.jsx(
          "button",
          {
            type: "button",
            className: "gah-cd-enter stop",
            disabled: busy,
            onClick: () => stop(item),
            title: sdk.T("停止监听", "Stop source"),
            "aria-label": sdk.T("停止监听", "Stop source"),
            children: /* @__PURE__ */ jsxRuntime.jsx("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("rect", { x: "4", y: "4", width: "8", height: "8", rx: "1.5", fill: "currentColor" }) })
          }
        ) : null
      ] }),
      open ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-meta", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.once ? sdk.T("单次触发", "One-shot") : sdk.T(`每 ${item.interval ?? 5}s 检查`, `Every ${item.interval ?? 5}s`) }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T(`已触发 ${item.triggers ?? 0} 次`, `Triggered ${item.triggers ?? 0}x`) }),
          rem ? /* @__PURE__ */ jsxRuntime.jsx("span", { title: expText ? `${sdk.T("截止", "Expires")} ${expText}` : void 0, children: sdk.T(rem[0], rem[1]) }) : null,
          /* @__PURE__ */ jsxRuntime.jsx("code", { className: "gah-cd-id", children: item.id })
        ] }),
        item.instruction ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("触发动作", "Action") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: item.instruction })
        ] }) : null,
        item.error ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field error", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("异常", "Error") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: item.error })
        ] }) : null,
        active ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-actions", children: /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "danger", disabled: busy, onClick: () => stop(item), children: sdk.T("停止监听", "Stop source") }) }) : null
      ] }) : null
    ] });
  }
  function Panel({ api }) {
    var _a, _b;
    const { data, sid, busy, run, load } = useConductor(api);
    const [open, setOpen] = react.useState(null);
    const box = react.useRef(null);
    const pop = react.useRef(null);
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
        if (!((_a2 = box.current) == null ? void 0 : _a2.contains(event.target))) setOpen(null);
      };
      const key = (event) => {
        if (event.key === "Escape") setOpen(null);
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
      setOpen(null);
    }, [sid]);
    if (!data || !sid) return null;
    if ((_a = data.children) == null ? void 0 : _a[sid]) {
      return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-cd-chip child", title: sdk.T("本会话由指挥家派发，结果会自动回报父会话", "Dispatched by a conductor; the result is reported back to the parent session"), children: [
        /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("子任务", "Subtask") })
      ] });
    }
    const on = data.enabled.includes(sid);
    const active = !!((_b = data.active) == null ? void 0 : _b.includes(sid));
    const tasks = data.tasks.filter((t) => {
      var _a2, _b2;
      return ((_b2 = (_a2 = data.children) == null ? void 0 : _a2[t.child]) == null ? void 0 : _b2.parent) === sid;
    }).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    const reflections = (data.reflections || []).filter((r) => r.parent === sid).sort(
      (a, b) => Number(REFLECT_TERMINAL.has(a.status)) - Number(REFLECT_TERMINAL.has(b.status)) || (b.created ?? 0) - (a.created ?? 0)
    );
    const watching = reflections.filter((r) => !REFLECT_TERMINAL.has(r.status)).length;
    if (!on && !active && !tasks.length && !reflections.length) return null;
    const running = tasks.filter((t) => t.status === "running").length;
    const done = tasks.filter((t) => t.status !== "running").length;
    const progress = data.progress;
    const stageTotal = tasks.filter((t) => (t.stage ?? 1) === ((progress == null ? void 0 : progress.stage) ?? 1)).length;
    const showAutopilot = active;
    const showReflect = on || reflections.length > 0;
    const showTasks = on || tasks.length > 0;
    const enter = async (task) => {
      setOpen(null);
      try {
        api.setState(await api.host.post("/api/sessions", { action: "select", id: task.child }), true);
        sdk.pages.home();
      } catch (error) {
        api.notice(String((error == null ? void 0 : error.message) || error));
      }
    };
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-group", ref: box, children: [
      showAutopilot ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-anchor", children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            type: "button",
            className: `gah-cd-chip on${open === "autopilot" ? " open" : ""}`,
            "aria-expanded": open === "autopilot",
            "aria-haspopup": "dialog",
            onClick: () => setOpen(open === "autopilot" ? null : "autopilot"),
            title: sdk.T("自主推进状态", "Autopilot status"),
            children: [
              /* @__PURE__ */ jsxRuntime.jsx(AutopilotIcon, {}),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("自主推进", "Autopilot") }),
              progress ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag", children: label(PROGRESS_STATUS, progress.status) }) : null,
              /* @__PURE__ */ jsxRuntime.jsx(Caret, {})
            ]
          }
        ),
        open === "autopilot" ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd", ref: pop, role: "dialog", "aria-label": sdk.T("自主推进", "Autopilot"), children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-bar", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-cd-badge", children: [
              /* @__PURE__ */ jsxRuntime.jsx(AutopilotIcon, {}),
              sdk.T("自主推进", "Autopilot")
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-hint", children: sdk.T("未完成时自动续跑，直到完成或需你处理", "Continues across turns until done or awaiting your input") }),
            (progress == null ? void 0 : progress.status) === "paused" ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-cd-off", disabled: busy, onClick: () => run("active", { active: true }), children: sdk.T("恢复", "Resume") }) : (progress == null ? void 0 : progress.status) === "idle_backoff" ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-cd-off", disabled: busy, onClick: () => run("active", { active: true }), children: sdk.T("立即推进", "Continue now") }) : null,
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-cd-off", disabled: busy, onClick: () => run("active", { active: false }), children: sdk.T("关闭", "Turn off") })
          ] }),
          !showTasks && data.persistence_error ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body gah-cd-field error", role: "alert", children: [
            /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("状态尚未保存", "State is not saved") }),
            /* @__PURE__ */ jsxRuntime.jsx("p", { children: data.persistence_error })
          ] }) : null,
          progress ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-meta", children: [
              sdk.T("当前状态：", "Status: "),
              label(PROGRESS_STATUS, progress.status),
              progress.status === "idle_backoff" && progress.next_continue_at ? ` · ${sdk.T("下次推进 ", "Next ")}${new Date(progress.next_continue_at * 1e3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""
            ] }),
            progress.goal ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("总目标", "Goal") }),
              /* @__PURE__ */ jsxRuntime.jsx("p", { children: progress.goal })
            ] }) : null,
            progress.next_step ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("下一步", "Next step") }),
              /* @__PURE__ */ jsxRuntime.jsx("p", { children: progress.next_step })
            ] }) : null,
            progress.reason ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("状态原因", "Reason") }),
              /* @__PURE__ */ jsxRuntime.jsx("p", { children: progress.reason })
            ] }) : null
          ] }) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-empty", children: sdk.T("发送任务后将自动持续推进", "Send a message to start continuous execution") })
        ] }) : null
      ] }) : null,
      showReflect ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-anchor", children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            type: "button",
            className: `gah-cd-chip${watching ? " on" : ""}${open === "reflect" ? " open" : ""}`,
            "aria-expanded": open === "reflect",
            "aria-haspopup": "dialog",
            onClick: () => setOpen(open === "reflect" ? null : "reflect"),
            title: sdk.T("反射事件源", "Reflect event sources"),
            children: [
              watching ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-dot running" }) : /* @__PURE__ */ jsxRuntime.jsx(ReflectIcon, {}),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: reflections.length ? sdk.T(`事件源 ${watching}/${reflections.length}`, `Sources ${watching}/${reflections.length}`) : sdk.T("事件源", "Sources") }),
              /* @__PURE__ */ jsxRuntime.jsx(Caret, {})
            ]
          }
        ),
        open === "reflect" ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd", ref: pop, role: "dialog", "aria-label": sdk.T("反射事件源", "Reflect event sources"), children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-bar", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-cd-badge", children: [
              /* @__PURE__ */ jsxRuntime.jsx(ReflectIcon, {}),
              sdk.T("反射事件源", "Event sources")
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-hint", children: reflections.length ? sdk.T(`监听中 ${watching} · 共 ${reflections.length} 个`, `${watching} watching · ${reflections.length} total`) : sdk.T("循环监听外部条件，触发时唤醒指挥家", "Watches conditions in a loop and wakes the conductor") })
          ] }),
          reflections.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-list", children: reflections.map((r) => /* @__PURE__ */ jsxRuntime.jsx(ReflectRow, { item: r, busy, stop: (item) => run("reflect", { action: "stop", reflect_id: item.id }) }, r.id)) }) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-empty", children: sdk.T("还没有事件源", "No event sources yet") })
        ] }) : null
      ] }) : null,
      showTasks ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-anchor", children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            type: "button",
            className: `gah-cd-chip${on ? " on" : ""}${open === "tasks" ? " open" : ""}`,
            "aria-expanded": open === "tasks",
            "aria-haspopup": "dialog",
            onClick: () => setOpen(open === "tasks" ? null : "tasks"),
            title: sdk.T("指挥家子任务", "Conductor subtasks"),
            children: [
              running ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-dot running" }) : /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: tasks.length ? `${done}/${tasks.length}` : sdk.T("指挥家", "Conductor") }),
              on && !active && progress ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-tag", children: label(PROGRESS_STATUS, progress.status) }) : null,
              /* @__PURE__ */ jsxRuntime.jsx(Caret, {})
            ]
          }
        ),
        open === "tasks" ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd", ref: pop, role: "dialog", "aria-label": sdk.T("指挥家", "Conductor"), children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-bar", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-cd-badge", children: [
              /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
              sdk.T("指挥家模式", "Conductor mode")
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-cd-hint", children: tasks.length ? sdk.T(`任务 ${tasks.length} · 运行中 ${running}/${data.limits.running}`, `${tasks.length} tasks · ${running}/${data.limits.running} running`) : sdk.T("只拆分、分派、验收，不亲自执行", "Splits, dispatches and reviews; does not execute itself") }),
            on ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-cd-off", disabled: busy, onClick: () => run("toggle", { enabled: false }), children: sdk.T("关闭", "Turn off") }) : null
          ] }),
          data.persistence_error ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body gah-cd-field error", role: "alert", children: [
            /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("状态尚未保存", "State is not saved") }),
            /* @__PURE__ */ jsxRuntime.jsx("p", { children: data.persistence_error })
          ] }) : null,
          (data.deliveries || []).filter((d) => (d.attempts || 0) >= 5).map((d) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body gah-cd-field error", role: "alert", children: [
            /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("通知投递持续失败", "Notification delivery keeps failing") }),
            /* @__PURE__ */ jsxRuntime.jsxs("p", { children: [
              d.error,
              " (",
              d.attempts,
              ")"
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("p", { children: [
              sdk.T("下次重试：", "Retry scheduled: "),
              d.retry_at ? new Date(d.retry_at * 1e3).toLocaleString() : "-"
            ] })
          ] }, d.id)),
          progress ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-body", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-meta", children: [
              sdk.T(`阶段 ${progress.stage} · 额度 ${stageTotal}/${data.limits.total}`, `Stage ${progress.stage} · quota ${stageTotal}/${data.limits.total}`),
              " ",
              "·",
              " ",
              label(PROGRESS_STATUS, progress.status),
              progress.status === "idle_backoff" && progress.next_continue_at ? ` · ${sdk.T("下次推进 ", "Next ")}${new Date(progress.next_continue_at * 1e3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""
            ] }),
            progress.goal ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("总目标", "Goal") }),
              /* @__PURE__ */ jsxRuntime.jsx("p", { children: progress.goal })
            ] }) : null,
            progress.next_step ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("下一步", "Next step") }),
              /* @__PURE__ */ jsxRuntime.jsx("p", { children: progress.next_step })
            ] }) : null,
            progress.reason ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-cd-field", children: [
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("状态原因", "Reason") }),
              /* @__PURE__ */ jsxRuntime.jsx("p", { children: progress.reason })
            ] }) : null
          ] }) : null,
          tasks.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-list", children: tasks.map((task) => /* @__PURE__ */ jsxRuntime.jsx(TaskRow, { task, busy, act: (path, t) => run(path, { task_id: t.id }), enter, load }, task.id)) }) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-cd-empty", children: sdk.T("还没有子任务", "No tasks yet") })
        ] }) : null
      ] }) : null
    ] });
  }
  const Caret = () => /* @__PURE__ */ jsxRuntime.jsx("svg", { className: "gah-cd-caret", viewBox: "0 0 10 10", width: "9", height: "9", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M2 3.5l3 3 3-3", stroke: "currentColor", strokeWidth: "1.4", fill: "none", strokeLinecap: "round" }) });
  const ReflectIcon = () => /* @__PURE__ */ jsxRuntime.jsxs("svg", { className: "gah-cd-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "8", cy: "8", r: "5.5", stroke: "currentColor", strokeWidth: "1.5", fill: "none" }),
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M8 5v3.2l2.2 1.3", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", fill: "none" })
  ] });
  const AutopilotIcon = () => /* @__PURE__ */ jsxRuntime.jsxs("svg", { className: "gah-cd-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M12.8 6.2A5.3 5.3 0 1 0 13 9.8", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", fill: "none" }),
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M10.4 6.4h2.6V3.8", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", fill: "none" }),
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M6.8 6l3 2-3 2V6Z", fill: "currentColor" })
  ] });
  const Icon = () => /* @__PURE__ */ jsxRuntime.jsxs("svg", { className: "gah-cd-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M3 3.5h4M3 8h10M3 12.5h6", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", fill: "none" }),
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "11", cy: "3.5", r: "1.6", fill: "currentColor" }),
    /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "12", cy: "12.5", r: "1.6", fill: "currentColor" })
  ] });
  const Check = () => /* @__PURE__ */ jsxRuntime.jsx("svg", { className: "gah-menu-check", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "m3.5 8.5 3 3 6-7", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }) });
  function Toggle({ api }) {
    var _a, _b;
    const { data, sid, busy, run } = useConductor(api);
    if (!data || !sid || ((_a = data.children) == null ? void 0 : _a[sid])) return null;
    const on = data.enabled.includes(sid);
    const active = !!((_b = data.active) == null ? void 0 : _b.includes(sid));
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsxs(
        "button",
        {
          type: "button",
          role: "menuitemcheckbox",
          className: "gah-menu-item",
          "aria-checked": active,
          disabled: busy,
          onClick: () => run("active", { active: !active }),
          title: sdk.T("自主推进：当前轮结束后若任务未完成会自动续跑，直到声明完成或需要你处理", "Autopilot: keep working across turns until the task is done or needs your input"),
          children: [
            /* @__PURE__ */ jsxRuntime.jsx(AutopilotIcon, {}),
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("自主推进", "Autopilot") }),
            active ? /* @__PURE__ */ jsxRuntime.jsx(Check, {}) : null
          ]
        }
      ),
      /* @__PURE__ */ jsxRuntime.jsxs(
        "button",
        {
          type: "button",
          role: "menuitemcheckbox",
          className: "gah-menu-item",
          "aria-checked": on,
          disabled: busy,
          onClick: () => run("toggle", { enabled: !on }),
          title: sdk.T("指挥家模式：本会话只拆分并分派子任务，每个子任务在独立会话中执行", "Conductor mode: this session only splits and dispatches tasks; each task runs in its own session"),
          children: [
            /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("指挥家模式", "Conductor mode") }),
            on ? /* @__PURE__ */ jsxRuntime.jsx(Check, {}) : null
          ]
        }
      )
    ] });
  }
  function ConductorPlugin({ api }) {
    react.useEffect(() => api.mount("composer-menu", /* @__PURE__ */ jsxRuntime.jsx(Toggle, { api })), [api]);
    react.useEffect(() => api.mount("header", /* @__PURE__ */ jsxRuntime.jsx(Panel, { api })), [api]);
    return null;
  }
  sdk.defineReact("conductor", ConductorPlugin);
})(GAH.jsxRuntime, GAH.React, GAH);
