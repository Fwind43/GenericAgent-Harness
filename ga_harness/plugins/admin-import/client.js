var GAHPlugin_admin_import = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const when = (t) => t ? new Date(t * 1e3).toLocaleString() : "";
  function ImportPanel({ api }) {
    const { changing } = sdk.useHost();
    const { working, run } = sdk.useOperation(api, true);
    const [path, setPath] = react.useState("");
    const [scan, setScan] = react.useState(null);
    const [picked, setPicked] = react.useState(/* @__PURE__ */ new Set());
    const [result, setResult] = react.useState(null);
    const [error, setError] = react.useState("");
    const [log, setLog] = react.useState([]);
    const logRef = react.useRef(null);
    const busy = working || changing;
    react.useEffect(() => {
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [log]);
    const follow = async (kind, body) => {
      const { job } = await api.post(kind, body);
      for (let since = 0; ; ) {
        await new Promise((done) => setTimeout(done, 300));
        const state = await api.get(`job?id=${encodeURIComponent(job)}&since=${since}`);
        since = state.next;
        if (state.log.length) setLog((prev) => [...prev, ...state.log]);
        if (state.status === "error") throw new Error(state.error || "failed");
        if (state.status === "done") return state.result;
      }
    };
    const load = (dir = path) => run(async () => {
      setError("");
      setResult(null);
      setLog([]);
      const data = await follow("scan", { path: dir.trim() });
      setScan(data);
      setPicked(/* @__PURE__ */ new Set());
    }, setError, true);
    const start = () => run(async () => {
      if (!scan) return;
      setError("");
      setLog([]);
      const res = await follow("import", { path: scan.dir, ids: [...picked] });
      setResult(res);
      const done = /* @__PURE__ */ new Set([...res.imported, ...res.existing]);
      setScan((prev) => prev && { ...prev, chats: prev.chats.map((c) => done.has(c.id) ? { ...c, imported: true } : c) });
      setPicked((prev) => new Set([...prev].filter((id) => !done.has(id))));
    }, setError, true);
    const fresh = (scan == null ? void 0 : scan.chats.filter((c) => !c.imported)) || [];
    const all = fresh.length > 0 && fresh.every((c) => picked.has(c.id));
    const toggle = (id) => setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    const toggleAll = () => setPicked(all ? /* @__PURE__ */ new Set() : new Set(fresh.map((c) => c.id)));
    return /* @__PURE__ */ jsxRuntime.jsxs(sdk.SettingsPanel, { api, label: sdk.T("导入 Admin 聊天", "Import Admin chats"), icon: "folder-open", order: 60, className: "ai-dialog", children: [
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "dialog-head", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
        /* @__PURE__ */ jsxRuntime.jsx("h2", { children: sdk.T("导入 GA Admin 聊天记录", "Import GA Admin chats") }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { children: sdk.T(
          "填写 GA Admin 的安装/数据目录或其中的 chat_sessions 目录。只读取 Admin 文件；导入后的会话可以接着聊，附件只保留文字说明。",
          "Enter the GA Admin install/data folder or its chat_sessions folder. Admin files are only read; imported chats can be continued, and attachments are kept as text notes only."
        ) })
      ] }) }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ai-body", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "ai-path", onSubmit: (e) => {
          e.preventDefault();
          void load();
        }, children: [
          /* @__PURE__ */ jsxRuntime.jsx("input", { className: "ai-input", value: path, onChange: (e) => setPath(e.target.value), placeholder: sdk.T("例如 D:\\ga-admin", "e.g. D:\\ga-admin"), disabled: busy }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", className: "btn", disabled: busy || !path.trim(), children: sdk.T("扫描", "Scan") })
        ] }),
        error && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "ai-error", children: error }),
        log.length > 0 && /* @__PURE__ */ jsxRuntime.jsx("pre", { ref: logRef, className: "ai-log", "aria-live": "polite", children: log.map((line) => sdk.T(line.zh, line.en)).join("\n") }),
        scan && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "ai-row ai-muted", children: /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
            sdk.T(`${scan.dir}：${scan.chats.length} 个聊天`, `${scan.dir}: ${scan.chats.length} chats`),
            scan.skipped > 0 && sdk.T(`，${scan.skipped} 个文件无法读取已跳过`, `, ${scan.skipped} unreadable skipped`)
          ] }) }),
          scan.chats.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "ai-check", children: [
            /* @__PURE__ */ jsxRuntime.jsx("input", { type: "checkbox", checked: all, disabled: busy || !fresh.length, onChange: toggleAll }),
            sdk.T("全选未导入", "Select all not imported")
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "ai-list", children: scan.chats.map((c) => /* @__PURE__ */ jsxRuntime.jsxs("label", { className: `ai-item${c.imported ? " done" : ""}`, children: [
            /* @__PURE__ */ jsxRuntime.jsx("input", { type: "checkbox", checked: c.imported || picked.has(c.id), disabled: busy || c.imported, onChange: () => toggle(c.id) }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ai-title", title: c.title, children: c.title || c.id }),
            c.project && /* @__PURE__ */ jsxRuntime.jsx("small", { className: "ai-project", title: sdk.T("Admin 项目", "Admin project"), children: c.project }),
            /* @__PURE__ */ jsxRuntime.jsx("small", { className: "ai-muted", children: c.imported ? sdk.T("已导入", "Imported") : `${c.messages} · ${when(c.updated)}` })
          ] }, c.id)) }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ai-row", children: [
            result && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ai-muted", children: sdk.T(
              `已导入 ${result.imported.length}，已存在 ${result.existing.length}，失败 ${result.failed.length}`,
              `Imported ${result.imported.length}, existing ${result.existing.length}, failed ${result.failed.length}`
            ) }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ai-spacer" }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", disabled: busy || !picked.size, onClick: () => void start(), children: sdk.T(`导入所选（${picked.size}）`, `Import selected (${picked.size})`) })
          ] }),
          result == null ? void 0 : result.failed.map((f) => /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "ai-error", children: [
            f.id,
            ": ",
            f.error
          ] }, f.id))
        ] })
      ] })
    ] });
  }
  sdk.defineReact("admin-import", ImportPanel);
  exports.ImportPanel = ImportPanel;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
