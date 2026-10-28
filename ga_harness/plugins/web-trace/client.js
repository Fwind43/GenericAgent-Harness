var GAHPlugin_web_trace = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const SLOW = 10;
  const secs = (value) => value == null ? "" : value < 1 ? Math.round(value * 1e3) + "ms" : value < 60 ? value.toFixed(1) + "s" : Math.floor(value / 60) + "m" + Math.round(value % 60) + "s";
  const num = (value) => value == null ? "" : value >= 1e3 ? (value / 1e3).toFixed(1) + "k" : String(value);
  const text = (value) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const compact = (value) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const line = (value, size = 240) => {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > size ? flat.slice(0, size) + "…" : flat;
  };
  const usageText = (usage) => usage ? [usage.input != null && sdk.T("输入 ", "in ") + num(usage.input), usage.output != null && sdk.T("输出 ", "out ") + num(usage.output), usage.cache_read ? sdk.T("缓存 ", "cache ") + num(usage.cache_read) : ""].filter(Boolean).join(" · ") : "";
  const section = (title, body) => body ? title + "\n" + body : "";
  const join = (...parts) => parts.filter(Boolean).join("\n\n");
  function buildTrace(messages) {
    const runs = [];
    let input = "";
    messages.forEach((message, index) => {
      var _a, _b, _c;
      if (message.role === "user") {
        input = message.text || "";
        return;
      }
      const run = runs.length + 1;
      const events = [];
      const push = (event) => events.push({
        ...event,
        run,
        haystack: [event.name, event.args, event.result, event.text].filter(Boolean).join(" ").toLowerCase()
      });
      if (input) push({ key: index + ":in", lane: "input", kind: "input", text: line(input), detail: input });
      const notes = message.notes || [];
      const pushNotes = (turn) => notes.filter((note) => note.turn === turn).forEach((note, n) => push({
        key: index + ":n" + turn + ":" + n,
        lane: "input",
        kind: "context",
        name: note.kind === "steer" ? sdk.T("引导", "steer") : note.kind,
        text: line(note.text),
        detail: note.text
      }));
      pushNotes(0);
      let seconds = 0, tools = 0, lastReply = "";
      for (const turn of message.turns || []) {
        const said = turn.reply || turn.summary || "";
        if (turn.reply) lastReply = turn.reply;
        seconds += ((_a = turn.llm) == null ? void 0 : _a.seconds) || 0;
        push({
          key: index + ":m" + turn.turn,
          lane: "model",
          kind: "model",
          text: line(said) || sdk.T("第 ", "Turn ") + turn.turn + sdk.T(" 轮", ""),
          seconds: (_b = turn.llm) == null ? void 0 : _b.seconds,
          detail: join(
            [sdk.T("第 ", "Turn ") + turn.turn + sdk.T(" 轮", ""), ((_c = turn.llm) == null ? void 0 : _c.ttft) != null ? sdk.T("首字 ", "TTFT ") + secs(turn.llm.ttft) : "", usageText(turn.usage)].filter(Boolean).join(" · "),
            section(sdk.T("摘要：", "Summary:"), turn.summary),
            section(sdk.T("思考：", "Thinking:"), turn.thinking),
            section(sdk.T("回复：", "Reply:"), turn.reply)
          )
        });
        for (const [n, tool] of (turn.tools || []).entries()) {
          tools += 1;
          seconds += tool.seconds || 0;
          const failed = tool.ok === false || tool.status === "error";
          const result = compact(tool.data);
          push({
            key: index + ":t" + turn.turn + ":" + n,
            lane: "tool",
            kind: "tool",
            name: tool.name,
            args: line(compact(tool.args), 160),
            result: line(result),
            text: "",
            seconds: tool.seconds,
            failed,
            detail: join(section(sdk.T("参数：", "Arguments:"), text(tool.args)), section(sdk.T("结果：", "Result:"), text(tool.data)) || (tool.status === "running" ? sdk.T("运行中…", "Running…") : ""))
          });
        }
        pushNotes(turn.turn);
      }
      if (message.error) push({ key: index + ":err", lane: "model", kind: "error", text: line(message.error), failed: true, detail: message.error });
      else if (message.text && message.text.trim() !== lastReply.trim()) push({ key: index + ":out", lane: "model", kind: "output", text: line(message.text), detail: message.text });
      runs.push({ run, input, status: message.status, model: message.model, seconds, tools, usage: message.usage, events });
      input = "";
    });
    return runs;
  }
  function layout(events, mode) {
    const total = events.reduce((sum, event) => sum + (event.seconds || 0), 0);
    const floor = mode === "duration" && total > 0 ? total * 4e-3 : 1;
    const widths = events.map((event) => mode === "duration" && total > 0 ? Math.max(event.seconds || 0, floor) : 1);
    const span = widths.reduce((sum, width) => sum + width, 0) || 1;
    let x = 0;
    return events.map((event, n) => {
      const left = x / span * 100;
      x += widths[n];
      return { event, left, width: widths[n] / span * 100 };
    });
  }
  const LANES = [["input", () => sdk.T("输入", "Input")], ["model", () => sdk.T("模型", "Model")], ["tool", () => sdk.T("工具", "Tool")]];
  const CHIP = {
    input: () => sdk.T("用户", "User"),
    context: () => sdk.T("上下文", "Context"),
    model: () => sdk.T("助手", "Assistant"),
    output: () => sdk.T("输出", "Output"),
    tool: () => sdk.T("工具", "Tool"),
    error: () => sdk.T("错误", "Error")
  };
  const statusLabel = (status) => ({ running: sdk.T("运行中", "Running"), done: sdk.T("完成", "Done"), error: sdk.T("出错", "Error"), aborted: sdk.T("已中止", "Aborted"), interrupted: sdk.T("已中断", "Interrupted") })[status || ""] || status || "";
  const domId = (key) => "gah-trace-" + key.replace(/[^\w-]/g, "_");
  function Timeline({ events, mode, query, focus, onPick }) {
    const blocks = react.useMemo(() => layout(events, mode), [events, mode]);
    const starts = react.useMemo(() => {
      const seen = /* @__PURE__ */ new Set();
      return blocks.filter((block) => !seen.has(block.event.run) && seen.add(block.event.run) && block.event.run > 1);
    }, [blocks]);
    return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-tl", role: "group", "aria-label": sdk.T("时间轴", "Timeline"), children: LANES.map(([lane, label]) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-tl-lane", children: [
      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-tl-label", children: label() }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-tl-track", children: [
        starts.map((block) => /* @__PURE__ */ jsxRuntime.jsx("i", { className: "gah-tl-run", style: { left: block.left + "%" } }, "s" + block.event.run)),
        blocks.filter((block) => block.event.lane === lane).map(({ event, left, width }) => {
          const dim = !!query && !event.haystack.includes(query);
          const tip = [CHIP[event.kind](), event.name, event.seconds != null && secs(event.seconds), event.text && line(event.text, 60)].filter(Boolean).join(" · ");
          return /* @__PURE__ */ jsxRuntime.jsx(
            "button",
            {
              type: "button",
              title: tip,
              "aria-label": tip,
              className: "gah-tl-block k-" + event.kind + (event.failed ? " failed" : "") + (dim ? " dim" : "") + (focus === event.key ? " on" : ""),
              style: { left: left + "%", width: width + "%" },
              onClick: () => onPick(event.key)
            },
            event.key
          );
        })
      ] })
    ] }, lane)) });
  }
  function Row({ event, open, focus, onToggle }) {
    return /* @__PURE__ */ jsxRuntime.jsxs("li", { id: domId(event.key), className: "gah-tr k-" + event.kind + (event.failed ? " failed" : "") + (focus ? " on" : ""), children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-tr-head", "aria-expanded": open, onClick: onToggle, children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-tr-chip", children: CHIP[event.kind]() }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-tr-body", children: [
          event.name ? /* @__PURE__ */ jsxRuntime.jsx("b", { className: "gah-tr-name", children: event.name }) : null,
          event.args ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-tr-args", children: event.args }) : null,
          event.kind === "tool" && event.result ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-tr-arrow", "aria-hidden": "true", children: "→" }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-tr-result", children: event.result })
          ] }) : null,
          event.text ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-tr-text", children: event.text }) : null
        ] }),
        event.seconds != null ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-tr-secs" + (event.seconds >= SLOW ? " slow" : ""), children: secs(event.seconds) }) : null
      ] }),
      open ? /* @__PURE__ */ jsxRuntime.jsx("pre", { className: "gah-tr-detail", children: event.detail || sdk.T("（无内容）", "(empty)") }) : null
    ] });
  }
  function Trace() {
    const { state } = sdk.useHost();
    const runs = react.useMemo(() => buildTrace(state.messages || []), [state.messages]);
    const events = react.useMemo(() => runs.flatMap((run) => run.events), [runs]);
    const [mode, setMode] = react.useState(() => localStorage.getItem("gah-trace-mode") === "calls" ? "calls" : "duration");
    const [search, setSearch] = react.useState("");
    const [open, setOpen] = react.useState(() => /* @__PURE__ */ new Set());
    const [focus, setFocus] = react.useState("");
    const query = search.trim().toLowerCase();
    const shown = query ? events.filter((event) => event.haystack.includes(query)) : events;
    const pickMode = (value) => {
      setMode(value);
      localStorage.setItem("gah-trace-mode", value);
    };
    const toggle = (key) => setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    const pick = (key) => {
      var _a;
      setFocus(key);
      setOpen((prev) => new Set(prev).add(key));
      if (query && !((_a = events.find((event) => event.key === key)) == null ? void 0 : _a.haystack.includes(query))) setSearch("");
      requestAnimationFrame(() => {
        var _a2;
        return (_a2 = document.getElementById(domId(key))) == null ? void 0 : _a2.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    };
    if (!events.length) return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-trace-empty", children: [
      /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("还没有轨迹", "No trace yet") }),
      sdk.T("发送一条消息后，这里会按时间线展示输入、模型调用和工具调用。", "After you send a message, inputs, model calls and tool calls appear here as a timeline.")
    ] });
    const total = runs.reduce((sum, run) => sum + run.seconds, 0);
    const toolCount = runs.reduce((sum, run) => sum + run.tools, 0);
    const visibleRuns = runs.filter((run) => shown.some((event) => event.run === run.run));
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-trace", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-trace-top", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-trace-bar", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-seg", role: "group", "aria-label": sdk.T("时间轴刻度", "Timeline scale"), children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", "aria-pressed": mode === "duration", onClick: () => pickMode("duration"), children: sdk.T("时长", "Duration") }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", "aria-pressed": mode === "calls", onClick: () => pickMode("calls"), children: sdk.T("调用", "Calls") })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-sum", children: [runs.length + sdk.T(" 个任务", " runs"), toolCount + sdk.T(" 次工具", " tools"), secs(total)].join(" · ") }),
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              className: "gah-trace-search",
              type: "search",
              value: search,
              onChange: (event) => setSearch(event.target.value),
              placeholder: sdk.T("搜索工具、参数、结果…", "Search tools, args, results…"),
              "aria-label": sdk.T("搜索轨迹", "Search trace")
            }
          )
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx(Timeline, { events, mode, query, focus, onPick: pick }),
        mode === "duration" ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-trace-hint", children: sdk.T("按各步耗时依次排列，不含步骤之间的等待时间。", "Steps are laid out by their own durations; idle gaps between steps are not shown.") }) : null
      ] }),
      !shown.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-trace-none", children: sdk.T("没有匹配的事件", "No matching events") }) : null,
      visibleRuns.map((run) => /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "gah-trace-run", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("header", { className: "gah-trace-sep", children: [
          /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("任务 ", "Run ") + run.run }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-sep-input", title: run.input || void 0, children: line(run.input, 80) || sdk.T("（无输入）", "(no input)") }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-sep-meta", children: [statusLabel(run.status), run.model, secs(run.seconds)].filter(Boolean).join(" · ") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "gah-trace-list", children: shown.filter((event) => event.run === run.run).map((event) => /* @__PURE__ */ jsxRuntime.jsx(Row, { event, open: open.has(event.key), focus: focus === event.key, onToggle: () => {
          setFocus(event.key);
          toggle(event.key);
        } }, event.key)) })
      ] }, run.run))
    ] });
  }
  function TraceView({ api }) {
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.ViewPanel, { api, label: sdk.T("轨迹", "Trace"), order: 10, className: "gah-trace-view", children: /* @__PURE__ */ jsxRuntime.jsx(Trace, {}) });
  }
  sdk.defineReact("web-trace", TraceView);
  exports.buildTrace = buildTrace;
  exports.layout = layout;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
