(function(jsxRuntime, react, sdk) {
  "use strict";
  const RANGES = [7, 30, 90, 0];
  const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n));
  const full = (n) => Math.round(n).toLocaleString();
  const rangeLabel = (d) => d ? sdk.T(`近 ${d} 天`, `Last ${d} days`) : sdk.T("全部", "All time");
  const hitRate = (r) => r.input + r.cache_read ? r.cache_read / (r.input + r.cache_read) : 0;
  const tip = (r) => [
    `${sdk.T("输入", "Input")} ${full(r.input)}`,
    `${sdk.T("输出", "Output")} ${full(r.output)}`,
    `${sdk.T("缓存读", "Cache read")} ${full(r.cache_read)}`,
    `${sdk.T("缓存写", "Cache write")} ${full(r.cache_write)}`,
    `${sdk.T("任务", "Runs")} ${r.runs}`,
    `${sdk.T("调用", "Calls")} ${r.calls}`
  ].join("\n");
  function Cards({ t }) {
    const cards = [
      [sdk.T("输入", "Input"), fmt(t.input), full(t.input)],
      [sdk.T("输出", "Output"), fmt(t.output), full(t.output)],
      [sdk.T("缓存读", "Cache read"), fmt(t.cache_read), `${sdk.T("命中率", "Hit rate")} ${(hitRate(t) * 100).toFixed(1)}%`],
      [sdk.T("缓存写", "Cache write"), fmt(t.cache_write), full(t.cache_write)],
      [sdk.T("任务 / 调用", "Runs / calls"), `${t.runs} / ${t.calls}`]
    ];
    return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-usage-cards", children: cards.map(([k, v, s]) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-usage-card", children: [
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "k", children: k }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "v", children: v }),
      s && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "s", children: s })
    ] }, k)) });
  }
  function Daily({ rows }) {
    const max = Math.max(1, ...rows.map((r) => r.input + r.output + r.cache_read));
    return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-usage-daily", children: rows.map((r) => {
      const h = (n) => `${n / max * 100}%`;
      return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "col", title: `${r.day}
${tip(r)}`, children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "bar", children: [
          /* @__PURE__ */ jsxRuntime.jsx("i", { className: "cr", style: { height: h(r.cache_read) } }),
          /* @__PURE__ */ jsxRuntime.jsx("i", { className: "in", style: { height: h(r.input) } }),
          /* @__PURE__ */ jsxRuntime.jsx("i", { className: "out", style: { height: h(r.output) } })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: r.day.slice(5) })
      ] }, r.day);
    }) });
  }
  function Table({ head, rows }) {
    const max = Math.max(1, ...rows.map((r) => r.row.input + r.row.output));
    return /* @__PURE__ */ jsxRuntime.jsxs("table", { className: "gah-usage-table", children: [
      /* @__PURE__ */ jsxRuntime.jsx("thead", { children: /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
        /* @__PURE__ */ jsxRuntime.jsx("th", { children: head }),
        /* @__PURE__ */ jsxRuntime.jsx("th", { children: sdk.T("输入", "Input") }),
        /* @__PURE__ */ jsxRuntime.jsx("th", { children: sdk.T("输出", "Output") }),
        /* @__PURE__ */ jsxRuntime.jsx("th", { children: sdk.T("缓存读", "Cache read") }),
        /* @__PURE__ */ jsxRuntime.jsx("th", { children: sdk.T("任务", "Runs") })
      ] }) }),
      /* @__PURE__ */ jsxRuntime.jsx("tbody", { children: rows.map(({ key, label, row, onClick }) => /* @__PURE__ */ jsxRuntime.jsxs("tr", { title: tip(row), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("td", { className: "name", children: [
          onClick ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "link", onClick, children: label }) : label,
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "share", style: { width: `${(row.input + row.output) / max * 100}%` } })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("td", { children: fmt(row.input) }),
        /* @__PURE__ */ jsxRuntime.jsx("td", { children: fmt(row.output) }),
        /* @__PURE__ */ jsxRuntime.jsx("td", { children: fmt(row.cache_read) }),
        /* @__PURE__ */ jsxRuntime.jsx("td", { children: row.runs })
      ] }, key)) })
    ] });
  }
  function Overview({ api }) {
    const [days, setDays] = react.useState(30);
    const [data, setData] = react.useState(null);
    const [error, setError] = react.useState("");
    const [loading, setLoading] = react.useState(false);
    const load = react.useCallback(() => {
      setLoading(true);
      setError("");
      api.get(`?days=${days}`).then(setData, (e) => setError(sdk.errorText(e))).finally(() => setLoading(false));
    }, [api, days]);
    react.useEffect(load, [load]);
    const open = async (id) => {
      try {
        const next = await api.host.post("/api/sessions", { action: "select", id });
        api.setState(next, true);
        sdk.pages.home();
      } catch (e) {
        setError(sdk.errorText(e));
      }
    };
    const t = data == null ? void 0 : data.totals;
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-usage", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-usage-bar", children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-usage-ranges", role: "group", children: RANGES.map((d) => /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: d === days ? "active" : "", onClick: () => setDays(d), children: rangeLabel(d) }, d)) }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-usage-refresh", disabled: loading, onClick: load, children: loading ? sdk.T("加载中…", "Loading…") : sdk.T("刷新", "Refresh") })
      ] }),
      error && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-usage-error", children: error }),
      t && !t.runs && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-usage-empty", children: sdk.T("这段时间没有记录到用量。", "No usage recorded in this range.") }),
      data && t && t.runs > 0 && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        /* @__PURE__ */ jsxRuntime.jsx(Cards, { t }),
        /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T("每日用量", "Daily usage") }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-usage-legend", children: [
          /* @__PURE__ */ jsxRuntime.jsx("i", { className: "in" }),
          sdk.T("输入", "Input"),
          /* @__PURE__ */ jsxRuntime.jsx("i", { className: "out" }),
          sdk.T("输出", "Output"),
          /* @__PURE__ */ jsxRuntime.jsx("i", { className: "cr" }),
          sdk.T("缓存读", "Cache read")
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx(Daily, { rows: data.daily }),
        /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T("按模型", "By model") }),
        /* @__PURE__ */ jsxRuntime.jsx(Table, { head: sdk.T("模型", "Model"), rows: data.models.map((m) => ({ key: m.model || "-", label: m.model || sdk.T("（未记录）", "(unknown)"), row: m })) }),
        /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T(`用量最多的会话（共 ${data.session_count} 个）`, `Top chats (${data.session_count} total)`) }),
        /* @__PURE__ */ jsxRuntime.jsx(Table, { head: sdk.T("会话", "Chat"), rows: data.sessions.map((s) => ({ key: s.id, label: s.title || sdk.T("新会话", "New chat"), row: s, onClick: () => void open(s.id) })) }),
        data.undated > 0 && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-usage-note", children: sdk.T(`${data.undated} 次较早的任务没有时间记录，按所在会话的最后更新时间计入。`, `${data.undated} older runs have no timestamp and are dated by their chat's last update.`) })
      ] })
    ] });
  }
  function UsagePage({ api }) {
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.PagePanel, { api, label: sdk.T("用量总览", "Usage"), icon: "usage", order: 10, children: /* @__PURE__ */ jsxRuntime.jsx(Overview, { api }) });
  }
  sdk.defineReact("web-usage", UsagePage);
})(GAH.jsxRuntime, GAH.React, GAH);
