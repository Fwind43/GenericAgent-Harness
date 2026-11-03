(function(jsxRuntime, react, sdk) {
  "use strict";
  const KINDS = ["text", "thinking", "tool_use", "tool_result", "image", "other"];
  const kindLabel = (k) => ({
    text: sdk.T("文本", "Text"),
    thinking: sdk.T("思考", "Thinking"),
    tool_use: sdk.T("工具调用", "Tool call"),
    tool_result: sdk.T("工具结果", "Tool result"),
    image: sdk.T("图片", "Image"),
    other: sdk.T("其他", "Other")
  })[k];
  const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "K" : String(n);
  const estTokens = (chars) => Math.round(chars / 3);
  const PREVIEW = 4e3;
  function Bar({ parts, total }) {
    return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-ctx-bar", children: parts.filter(([, n]) => n > 0).map(([k, n]) => /* @__PURE__ */ jsxRuntime.jsx("i", { className: "k-" + k, style: { width: `${n / Math.max(1, total) * 100}%` }, title: `${kindLabel(k)} ${n.toLocaleString()}` }, k)) });
  }
  function Text({ text }) {
    const [all, setAll] = react.useState(false);
    const long = text.length > PREVIEW;
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx("pre", { className: "gah-ctx-pre", children: all || !long ? text : text.slice(0, PREVIEW) }),
      long && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-ctx-more", onClick: () => setAll(!all), children: all ? sdk.T("收起", "Collapse") : sdk.T(`展开全部（${fmt(text.length)} 字符）`, `Show all (${fmt(text.length)} chars)`) })
    ] });
  }
  function BlockRow({ block }) {
    const [open, setOpen] = react.useState(false);
    const title = block.type === "tool_use" || block.type === "tool_result" ? block.name || "" : "";
    const head = block.type === "image" ? `${block.media || "image"} · ${fmt(block.bytes || 0)}B` : (block.text || "").replace(/\s+/g, " ").slice(0, 140);
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ctx-block k-" + block.type + (block.error ? " err" : ""), children: [
      /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-ctx-bhead", "aria-expanded": open, onClick: () => setOpen(!open), disabled: block.type === "image", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "tag", children: [
          kindLabel(block.type),
          title && /* @__PURE__ */ jsxRuntime.jsx("b", { children: title })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "peek", children: open ? "" : head }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "size", children: [
          fmt(block.chars),
          block.images ? ` +${block.images}🖼` : ""
        ] })
      ] }),
      open && block.type !== "image" && /* @__PURE__ */ jsxRuntime.jsx(Text, { text: block.text || (block.redacted ? sdk.T("（已加密的思考）", "(redacted thinking)") : "") })
    ] });
  }
  function Context({ api }) {
    const { state } = sdk.useHost();
    const sid = state.session_id || "";
    const running = !!state.running;
    const [data, setData] = react.useState(null);
    const [error, setError] = react.useState("");
    const [loading, setLoading] = react.useState(false);
    const [filter, setFilter] = react.useState("");
    const load = react.useCallback(() => {
      setLoading(true);
      setError("");
      api.get(sid ? `?sid=${encodeURIComponent(sid)}` : "").then(setData, (e) => setError(sdk.errorText(e))).finally(() => setLoading(false));
    }, [api, sid]);
    react.useEffect(load, [load, running]);
    const msgs = react.useMemo(() => !data ? [] : !filter ? data.messages : data.messages.map((m) => ({ ...m, blocks: m.blocks.filter((b) => b.type === filter) })).filter((m) => m.blocks.length), [data, filter]);
    const extra = data ? Object.values(data.working).reduce((s, v) => s + v.length, 0) + data.history.reduce((s, v) => s + v.length, 0) : 0;
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ctx", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ctx-top", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ctx-head", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-ctx-sum", children: data ? [
            data.model,
            data.effort,
            `${data.messages.length} ${sdk.T("条消息", "messages")}`,
            `${fmt(data.chars)} ${sdk.T("字符", "chars")}`,
            `≈${fmt(estTokens(data.chars + extra))} tokens`
          ].filter(Boolean).join(" · ") : "" }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-ctx-refresh", disabled: loading, onClick: load, children: loading ? sdk.T("加载中…", "Loading…") : sdk.T("刷新", "Refresh") })
        ] }),
        data && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx(Bar, { parts: KINDS.map((k) => [k, data.totals[k]]), total: data.chars }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ctx-legend", children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", "aria-pressed": !filter, onClick: () => setFilter(""), children: sdk.T("全部", "All") }),
            KINDS.filter((k) => data.counts[k]).map((k) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", "aria-pressed": filter === k, onClick: () => setFilter(filter === k ? "" : k), children: [
              /* @__PURE__ */ jsxRuntime.jsx("i", { className: "k-" + k }),
              kindLabel(k),
              " ",
              /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
                data.counts[k],
                " · ",
                fmt(data.totals[k]),
                " (",
                (data.totals[k] / Math.max(1, data.chars) * 100).toFixed(0),
                "%)"
              ] })
            ] }, k))
          ] })
        ] }),
        running && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-ctx-note", children: sdk.T("任务运行中：显示的是本轮开始前保存的上下文，结束后自动刷新。", "A run is in progress: showing the context saved before it; refreshes when it ends.") }),
        error && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-ctx-error", children: error })
      ] }),
      data && !data.messages.length && !data.history.length && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ctx-empty", children: [
        /* @__PURE__ */ jsxRuntime.jsx("b", { children: sdk.T("上下文为空", "Context is empty") }),
        sdk.T("发送一条消息后，这里会显示模型实际收到的上下文。", "After you send a message, the context the model receives appears here.")
      ] }),
      data && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        (Object.keys(data.working).length > 0 || data.history.length > 0) && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "gah-ctx-sec", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T("工作记忆与历史摘要", "Working memory & history") }),
          Object.entries(data.working).filter(([, v]) => v).map(([k, v]) => /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "gah-ctx-card", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("summary", { children: [
              k,
              " ",
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: fmt(v.length) })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx(Text, { text: v })
          ] }, k)),
          data.history.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "gah-ctx-card", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("summary", { children: [
              "history ",
              /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
                data.history.length,
                " ",
                sdk.T("条", "lines")
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "gah-ctx-hist", children: data.history.map((h, i) => /* @__PURE__ */ jsxRuntime.jsx("li", { children: h }, i)) })
          ] })
        ] }),
        data.tools.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "gah-ctx-sec", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T("按工具占用", "By tool") }),
          /* @__PURE__ */ jsxRuntime.jsx("table", { className: "gah-ctx-tools", children: /* @__PURE__ */ jsxRuntime.jsx("tbody", { children: data.tools.map((t) => /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("td", { children: t.name }),
            /* @__PURE__ */ jsxRuntime.jsxs("td", { children: [
              t.calls,
              "×"
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("td", { className: "w", children: /* @__PURE__ */ jsxRuntime.jsx("i", { style: { width: `${t.chars / Math.max(1, data.tools[0].chars) * 100}%` } }) }),
            /* @__PURE__ */ jsxRuntime.jsx("td", { children: fmt(t.chars) })
          ] }, t.name)) }) })
        ] }),
        msgs.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "gah-ctx-sec", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T("消息", "Messages") }),
          /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "gah-ctx-msgs", children: msgs.map((m) => /* @__PURE__ */ jsxRuntime.jsxs("li", { className: "role-" + m.role, children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-ctx-mhead", children: [
              /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "role", children: [
                "#",
                m.index + 1,
                " ",
                m.role
              ] }),
              /* @__PURE__ */ jsxRuntime.jsx(Bar, { parts: KINDS.map((k) => [k, m.blocks.filter((b) => b.type === k).reduce((s, b) => s + b.chars, 0)]), total: m.chars }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "size", children: fmt(m.chars) })
            ] }),
            m.blocks.map((b, i) => /* @__PURE__ */ jsxRuntime.jsx(BlockRow, { block: b }, i))
          ] }, m.index)) })
        ] })
      ] })
    ] });
  }
  function ContextView({ api }) {
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.ViewPanel, { api, label: sdk.T("上下文", "Context"), order: 20, className: "gah-ctx-view", children: /* @__PURE__ */ jsxRuntime.jsx(Context, { api }) });
  }
  sdk.defineReact("web-context", ContextView);
})(GAH.jsxRuntime, GAH.React, GAH);
