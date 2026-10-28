var GAHPlugin_web_trace = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const secs = (value) => value == null ? "" : value < 1 ? Math.round(value * 1e3) + "ms" : value < 60 ? value.toFixed(1) + "s" : Math.floor(value / 60) + "m" + Math.round(value % 60) + "s";
  const num = (value) => value == null ? "" : value >= 1e3 ? (value / 1e3).toFixed(1) + "k" : String(value);
  const text = (value) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const clip = (value, size = 120) => {
    const line = value.replace(/\s+/g, " ").trim();
    return line.length > size ? line.slice(0, size) + "…" : line;
  };
  const usageMeta = (usage) => usage ? [usage.input != null && sdk.T("输入 ", "in ") + num(usage.input), usage.output != null && sdk.T("输出 ", "out ") + num(usage.output), usage.cache_read ? sdk.T("缓存 ", "cache ") + num(usage.cache_read) : ""].filter(Boolean).join(" · ") : "";
  function toolHint(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return clip(text(args), 90);
    for (const key of ["path", "file", "url", "command", "cmd", "script", "query", "pattern", "code"]) if (typeof args[key] === "string") return clip(args[key], 90);
    return clip(text(args), 90);
  }
  function buildRuns(messages) {
    const runs = [];
    let input = "";
    messages.forEach((message, index) => {
      var _a, _b;
      if (message.role === "user") {
        input = message.text || "";
        return;
      }
      const rows = [{ key: index + ":in", kind: "input", title: sdk.T("用户输入", "User input"), meta: clip(input, 80), detail: input }];
      const notes = message.notes || [];
      let seconds = 0, tools = 0;
      const pushNotes = (turn) => notes.filter((note) => note.turn === turn).forEach((note, n) => rows.push({
        key: index + ":n" + turn + ":" + n,
        kind: "note",
        title: note.kind === "steer" ? sdk.T("引导消息", "Steering message") : note.kind,
        meta: clip(note.text, 80),
        detail: note.text
      }));
      pushNotes(0);
      for (const turn of message.turns || []) {
        const llm = (_a = turn.llm) == null ? void 0 : _a.seconds;
        seconds += llm || 0;
        const meta = [((_b = turn.llm) == null ? void 0 : _b.ttft) != null && sdk.T("首字 ", "TTFT ") + secs(turn.llm.ttft), usageMeta(turn.usage)].filter(Boolean).join(" · ");
        rows.push({
          key: index + ":m" + turn.turn,
          kind: "model",
          title: sdk.T("模型调用 · 第 ", "Model call · turn ") + turn.turn + sdk.T(" 轮", ""),
          meta: meta || clip(turn.summary || "", 80),
          seconds: llm,
          detail: [turn.summary && sdk.T("摘要：", "Summary: ") + turn.summary, turn.thinking && sdk.T("思考：\n", "Thinking:\n") + turn.thinking, turn.reply && sdk.T("回复：\n", "Reply:\n") + turn.reply].filter(Boolean).join("\n\n")
        });
        for (const [n, tool] of (turn.tools || []).entries()) {
          tools += 1;
          seconds += tool.seconds || 0;
          const failed = tool.ok === false || tool.status === "error";
          rows.push({
            key: index + ":t" + turn.turn + ":" + n,
            kind: "tool",
            title: tool.name,
            meta: toolHint(tool.args),
            seconds: tool.seconds,
            failed,
            detail: sdk.T("参数：\n", "Arguments:\n") + text(tool.args) + (tool.data != null ? sdk.T("\n\n结果：\n", "\n\nResult:\n") + text(tool.data) : "")
          });
        }
        pushNotes(turn.turn);
      }
      if (message.error) rows.push({ key: index + ":err", kind: "error", title: sdk.T("错误", "Error"), meta: clip(message.error, 80), failed: true, detail: message.error });
      else if (message.text) rows.push({ key: index + ":out", kind: "output", title: sdk.T("最终输出", "Final output"), meta: clip(message.text, 80), detail: message.text });
      runs.push({ key: String(index), index: runs.length + 1, input, status: message.status, model: message.model, rows, seconds, tools, usage: message.usage });
      input = "";
    });
    return runs;
  }
  const statusLabel = (status) => ({ running: sdk.T("运行中", "Running"), done: sdk.T("完成", "Done"), error: sdk.T("出错", "Error"), aborted: sdk.T("已中止", "Aborted"), interrupted: sdk.T("已中断", "Interrupted") })[status || ""] || status || "";
  function TraceRow({ row }) {
    const [open, setOpen] = react.useState(false);
    return /* @__PURE__ */ jsxRuntime.jsxs("li", { className: "gah-trace-row k-" + row.kind + (row.failed ? " failed" : ""), children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-trace-head", "aria-expanded": open, disabled: !row.detail, onClick: () => setOpen((value) => !value), children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-dot", "aria-hidden": "true" }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-title", children: row.title }),
        row.meta ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-meta", children: row.meta }) : null,
        row.seconds != null ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-secs", children: secs(row.seconds) }) : null
      ] }),
      open && row.detail ? /* @__PURE__ */ jsxRuntime.jsx("pre", { className: "gah-trace-detail", children: row.detail }) : null
    ] });
  }
  function TraceRun({ run, last }) {
    const [open, setOpen] = react.useState(last);
    return /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "gah-trace-run", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-trace-run-head", "aria-expanded": open, onClick: () => setOpen((value) => !value), children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-caret", "aria-hidden": "true", children: open ? "▾" : "▸" }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-trace-run-title", children: [
          sdk.T("任务 ", "Run ") + run.index,
          /* @__PURE__ */ jsxRuntime.jsx("em", { children: clip(run.input, 60) || sdk.T("（无输入）", "(no input)") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-trace-run-meta", children: [statusLabel(run.status), run.model, run.tools + sdk.T(" 次工具", " tools"), secs(run.seconds), usageMeta(run.usage)].filter(Boolean).join(" · ") })
      ] }),
      open ? /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "gah-trace-list", children: run.rows.map((row) => /* @__PURE__ */ jsxRuntime.jsx(TraceRow, { row }, row.key)) }) : null
    ] });
  }
  function Trace() {
    const { state } = sdk.useHost();
    const runs = react.useMemo(() => buildRuns(state.messages || []), [state.messages]);
    if (!runs.length) return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-trace-empty", children: [
      /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("还没有轨迹", "No trace yet") }),
      sdk.T("发送一条消息后，这里会按时间线展示模型调用、工具调用和耗时。", "After you send a message, model calls, tool calls and timings appear here as a timeline.")
    ] });
    return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-trace", children: runs.map((run, n) => /* @__PURE__ */ jsxRuntime.jsx(TraceRun, { run, last: n === runs.length - 1 }, run.key + ":" + runs.length)) });
  }
  function TraceView({ api }) {
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.ViewPanel, { api, label: sdk.T("轨迹", "Trace"), order: 10, className: "gah-trace-view", children: /* @__PURE__ */ jsxRuntime.jsx(Trace, {}) });
  }
  sdk.defineReact("web-trace", TraceView);
  exports.buildRuns = buildRuns;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
