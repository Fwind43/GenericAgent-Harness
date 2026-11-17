(function(jsxRuntime, react, sdk) {
  "use strict";
  const K_OPEN = "gah.web-sidebar.open", K_WIDTH = "gah.web-sidebar.width";
  const MIN_W = 260, MAX_W = 960;
  const load = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const store = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  };
  const clampW = (w) => Math.round(Math.max(MIN_W, Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - 320), w)));
  const qs = (args) => Object.entries(args).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const baseName = (path) => path.replace(/\/$/, "").split("/").pop() || path;
  const dirName = (path) => {
    const p = path.replace(/\/$/, "");
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  };
  const fmtSize = (n) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";
  const STATUS = { M: "m", T: "m", A: "a", C: "a", R: "r", D: "d", U: "c", "?": "u" };
  const statusClass = (code) => code ? " st-" + (STATUS[code] || "m") : "";
  const statusTitle = (code) => ({
    m: sdk.T("已修改", "Modified"),
    a: sdk.T("已添加", "Added"),
    r: sdk.T("已重命名", "Renamed"),
    d: sdk.T("已删除", "Deleted"),
    c: sdk.T("冲突", "Conflict"),
    u: sdk.T("未跟踪", "Untracked")
  })[STATUS[code] || "m"] || "";
  const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);
  function Badge({ code }) {
    return code ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sb-badge" + statusClass(code), title: statusTitle(code), children: code === "?" ? "U" : code }) : null;
  }
  function Files({ api, sid, tick, active, onOpen }) {
    const [dirs, setDirs] = react.useState({});
    const [expanded, setExpanded] = react.useState(() => /* @__PURE__ */ new Set());
    const [error, setError] = react.useState("");
    const [query, setQuery] = react.useState("");
    const [found, setFound] = react.useState(null);
    const live = react.useRef(sid), opened = react.useRef(expanded);
    live.current = sid;
    opened.current = expanded;
    const fetchDir = react.useCallback((path) => api.get("tree?" + qs({ sid, path })).then((tree) => {
      if (live.current === sid) setDirs((prev) => ({ ...prev, [path]: tree }));
    }), [api, sid]);
    react.useEffect(() => {
      setDirs({});
      setExpanded(/* @__PURE__ */ new Set());
      setQuery("");
      setFound(null);
    }, [sid]);
    react.useEffect(() => {
      setError("");
      fetchDir("").catch((e) => {
        if (live.current === sid) {
          setDirs({});
          setError(sdk.errorText(e));
        }
      });
      opened.current.forEach((path) => {
        fetchDir(path).catch(() => setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        }));
      });
    }, [fetchDir, sid, tick]);
    react.useEffect(() => {
      const text = query.trim();
      if (!text) {
        setFound(null);
        return;
      }
      let stale = false;
      const timer = window.setTimeout(() => {
        api.get("search?" + qs({ sid, q: text })).then((result) => {
          if (!stale) setFound(result);
        }).catch((e) => {
          if (!stale) {
            setFound({ files: [], truncated: false });
            setError(sdk.errorText(e));
          }
        });
      }, 250);
      return () => {
        stale = true;
        window.clearTimeout(timer);
      };
    }, [api, sid, query, tick]);
    const toggle = (path) => {
      const next = new Set(expanded);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        fetchDir(path).catch((e) => setError(sdk.errorText(e)));
      }
      setExpanded(next);
    };
    const rows = (path, depth) => {
      const tree = dirs[path];
      if (!tree) return [/* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", style: { paddingLeft: 12 + depth * 14 }, children: sdk.T("加载中…", "Loading…") }, path + "/…")];
      const out = [];
      for (const entry of tree.entries) {
        const full = path ? `${path}/${entry.name}` : entry.name;
        const isDir = entry.type === "dir", isOpen = isDir && expanded.has(full);
        out.push(/* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            type: "button",
            title: full,
            className: "gah-sb-row" + statusClass(entry.status) + (!isDir && full === active ? " on" : ""),
            style: { paddingLeft: 8 + depth * 14 },
            "aria-expanded": isDir ? isOpen : void 0,
            onClick: () => isDir ? toggle(full) : onOpen(full),
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-sb-twist" + (isOpen ? " open" : ""), children: isDir ? "›" : "" }),
              isDir ? /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: isOpen ? "folder-open" : "folder" }) : null,
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "name", children: entry.name }),
              /* @__PURE__ */ jsxRuntime.jsx(Badge, { code: entry.status })
            ]
          },
          full
        ));
        if (isOpen) out.push(...rows(full, depth + 1));
      }
      if (tree.truncated) out.push(/* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", style: { paddingLeft: 12 + depth * 14 }, children: sdk.T("目录过大，仅显示前 2000 项", "Large directory: first 2000 entries shown") }, path + "/+"));
      if (!tree.entries.length) out.push(/* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", style: { paddingLeft: 12 + depth * 14 }, children: sdk.T("空目录", "Empty") }, path + "/0"));
      return out;
    };
    const root = dirs[""];
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-pane", children: [
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-search", children: /* @__PURE__ */ jsxRuntime.jsx(
        "input",
        {
          type: "search",
          value: query,
          placeholder: sdk.T("搜索文件名…", "Search files…"),
          "aria-label": sdk.T("搜索文件", "Search files"),
          onChange: (event) => setQuery(event.target.value)
        }
      ) }),
      root ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-root", title: root.root, children: root.root }) : null,
      error ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-error", children: error }) : null,
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-list", children: found ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        found.files.map((path) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", title: path, className: "gah-sb-row hit" + (path === active ? " on" : ""), onClick: () => onOpen(path), children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "name", children: baseName(path) }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "dir", children: dirName(path) })
        ] }, path)),
        !found.files.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("没有匹配的文件", "No matching files") }) : null,
        found.truncated ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("结果已截断，请缩小范围", "Results truncated; refine the search") }) : null
      ] }) : error && !root ? null : rows("", 0) })
    ] });
  }
  function Changes({ api, sid, tick, active, onOpen }) {
    const [data, setData] = react.useState(null);
    const [error, setError] = react.useState("");
    react.useEffect(() => {
      let stale = false;
      setError("");
      api.get("git?" + qs({ sid })).then((result) => {
        if (!stale) setData(result);
      }).catch((e) => {
        if (!stale) {
          setData(null);
          setError(sdk.errorText(e));
        }
      });
      return () => {
        stale = true;
      };
    }, [api, sid, tick]);
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-pane", children: [
      (data == null ? void 0 : data.git) ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-root", children: [
        /* @__PURE__ */ jsxRuntime.jsx("b", { children: data.branch || "HEAD" }),
        " · ",
        sdk.T(`${data.files.length} 处变更`, `${data.files.length} changed`)
      ] }) : null,
      error ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-error", children: error }) : null,
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-list", children: [
        data && !data.git ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("当前工作区不是 Git 仓库", "This workspace is not a Git repository") }) : null,
        (data == null ? void 0 : data.git) && !data.files.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("工作区干净，没有变更", "Working tree clean") }) : null,
        data == null ? void 0 : data.files.map((file) => {
          const isDir = file.path.endsWith("/");
          return /* @__PURE__ */ jsxRuntime.jsxs(
            "button",
            {
              type: "button",
              title: file.path,
              disabled: isDir,
              className: "gah-sb-row hit" + statusClass(file.status) + (file.path === active ? " on" : ""),
              onClick: () => onOpen(file.path),
              children: [
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "name", children: baseName(file.path) + (isDir ? "/" : "") }),
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "dir", children: dirName(file.path) }),
                /* @__PURE__ */ jsxRuntime.jsx(Badge, { code: file.status })
              ]
            },
            file.path
          );
        })
      ] })
    ] });
  }
  function Markdown({ text }) {
    const ref = react.useRef(null);
    react.useEffect(() => {
      const node = ref.current;
      if (!node) return;
      const output = window.GAHOutput;
      if (output == null ? void 0 : output.setMarkdown) output.setMarkdown(node, text);
      else node.textContent = text;
    }, [text]);
    return /* @__PURE__ */ jsxRuntime.jsx("div", { ref, className: "gah-sb-md md" });
  }
  function FileView({ api, sid, path, tick, onClose }) {
    const [data, setData] = react.useState(null);
    const [error, setError] = react.useState("");
    const [draft, setDraft] = react.useState(null);
    const [saving, setSaving] = react.useState(false);
    const [raw, setRaw] = react.useState(false);
    const editing = react.useRef(false);
    editing.current = draft !== null;
    const dirty = draft !== null && data !== null && draft !== data.text;
    react.useEffect(() => {
      setData(null);
      setDraft(null);
      setRaw(false);
    }, [sid, path]);
    react.useEffect(() => {
      if (editing.current) return;
      let stale = false;
      setError("");
      api.get("file?" + qs({ sid, path })).then((result) => {
        if (!stale && !editing.current) setData(result);
      }).catch((e) => {
        if (!stale) setError(sdk.errorText(e));
      });
      return () => {
        stale = true;
      };
    }, [api, sid, path, tick]);
    const save = () => {
      if (!data || draft === null || saving) return;
      setSaving(true);
      setError("");
      api.post("file", { sid, path, text: draft, mtime: data.mtime, eol: data.eol, bom: data.bom }).then((result) => {
        setData({ ...data, text: draft, mtime: result.mtime, size: result.size });
        setDraft(null);
      }).catch((e) => setError(sdk.errorText(e))).finally(() => setSaving(false));
    };
    const leave = (then) => {
      if (!dirty || window.confirm(sdk.T("放弃未保存的修改？", "Discard unsaved changes?"))) then();
    };
    const markdown = isMarkdown(path) && !raw;
    const editable = (data == null ? void 0 : data.kind) === "text" && !data.truncated;
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-view", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-vhead", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "name", title: (data == null ? void 0 : data.abs) || path, children: [
          baseName(path),
          dirty ? " ●" : ""
        ] }),
        data ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "meta", children: fmtSize(data.size) }) : null,
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "spacer" }),
        draft === null && (data == null ? void 0 : data.kind) === "text" && isMarkdown(path) ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sb-btn", onClick: () => setRaw(!raw), children: raw ? sdk.T("预览", "Preview") : sdk.T("源码", "Source") }) : null,
        draft === null && editable ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sb-btn", onClick: () => setDraft(data.text), children: sdk.T("编辑", "Edit") }) : null,
        draft !== null ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sb-btn", disabled: saving, onClick: () => leave(() => setDraft(null)), children: sdk.T("取消", "Cancel") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-sb-btn primary", disabled: saving || !dirty, onClick: save, children: saving ? sdk.T("保存中…", "Saving…") : sdk.T("保存", "Save") })
        ] }) : null,
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-icon-btn", "aria-label": sdk.T("关闭文件", "Close file"), title: sdk.T("关闭文件", "Close file"), onClick: () => leave(onClose), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "x" }) })
      ] }),
      error ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-error", children: error }) : null,
      !data ? error ? null : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("加载中…", "Loading…") }) : data.kind === "image" ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-image", children: /* @__PURE__ */ jsxRuntime.jsx("img", { src: api.fileURL(data.abs), alt: baseName(path) }) }) : data.kind === "binary" ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("二进制或非 UTF-8 文件，无法预览", "Binary or non-UTF-8 file; no preview") }) : draft !== null ? /* @__PURE__ */ jsxRuntime.jsx(
        "textarea",
        {
          className: "gah-sb-edit",
          value: draft,
          spellCheck: false,
          autoFocus: true,
          disabled: saving,
          "aria-label": sdk.T("编辑文件", "Edit file"),
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              save();
            }
            if (event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              const area = event.currentTarget, at = area.selectionStart;
              area.setRangeText("  ", at, area.selectionEnd, "end");
              setDraft(area.value);
            }
          }
        }
      ) : /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        data.truncated ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("文件超过 1 MB，仅显示开头且不可编辑", "File exceeds 1 MB: showing the beginning, read-only") }) : null,
        markdown ? /* @__PURE__ */ jsxRuntime.jsx(Markdown, { text: data.text }) : /* @__PURE__ */ jsxRuntime.jsx("pre", { className: "gah-sb-code", children: data.text })
      ] })
    ] });
  }
  function DiffView({ api, sid, path, tick, onClose }) {
    const [data, setData] = react.useState(null);
    const [error, setError] = react.useState("");
    react.useEffect(() => {
      let stale = false;
      setError("");
      api.get("diff?" + qs({ sid, path })).then((result) => {
        if (!stale) setData(result);
      }).catch((e) => {
        if (!stale) {
          setData(null);
          setError(sdk.errorText(e));
        }
      });
      return () => {
        stale = true;
      };
    }, [api, sid, path, tick]);
    const kind = (line) => line.startsWith("@@") ? " hunk" : /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line) ? " meta" : line.startsWith("+") ? " add" : line.startsWith("-") ? " del" : "";
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-view", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-vhead", children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "name", title: path, children: baseName(path) }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "meta", children: "diff" }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "spacer" }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-icon-btn", "aria-label": sdk.T("关闭", "Close"), title: sdk.T("关闭", "Close"), onClick: onClose, children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "x" }) })
      ] }),
      error ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-error", children: error }) : null,
      !data ? error ? null : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("加载中…", "Loading…") }) : !data.diff ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-note", children: sdk.T("没有文本差异", "No textual changes") }) : /* @__PURE__ */ jsxRuntime.jsxs("pre", { className: "gah-sb-diff", children: [
        data.diff.replace(/\n$/, "").split("\n").map((line, i) => /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "l" + kind(line), children: [
          line || " ",
          "\n"
        ] }, i)),
        data.truncated ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "l meta", children: sdk.T("… diff 过长，已截断", "… diff truncated") }) : null
      ] })
    ] });
  }
  function Sidebar({ api }) {
    const { state } = sdk.useHost();
    const sid = state.session_id || "";
    const running = !!state.running;
    const [open, setOpen] = react.useState(() => load(K_OPEN) === "1");
    const [tab, setTab] = react.useState("files");
    const [width, setWidth] = react.useState(() => clampW(Number(load(K_WIDTH)) || 400));
    const [view, setView] = react.useState(null);
    const [tick, setTick] = react.useState(0);
    const wasRunning = react.useRef(running);
    react.useEffect(() => {
      store(K_OPEN, open ? "1" : "0");
    }, [open]);
    react.useEffect(() => {
      setView(null);
    }, [sid]);
    react.useEffect(() => {
      if (wasRunning.current && !running) setTick((t) => t + 1);
      wasRunning.current = running;
    }, [running]);
    react.useEffect(() => {
      if (!open) return;
      const fit = () => setWidth((w) => clampW(w));
      window.addEventListener("resize", fit);
      return () => window.removeEventListener("resize", fit);
    }, [open]);
    const drag = (event) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      let last = width;
      const move = (e) => {
        last = clampW(window.innerWidth - e.clientX);
        setWidth(last);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        store(K_WIDTH, String(last));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    };
    const label = sdk.T("工作台", "Workbench");
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "header", children: /* @__PURE__ */ jsxRuntime.jsx(
        "button",
        {
          type: "button",
          className: "gah-icon-btn gah-sb-toggle" + (open ? " on" : ""),
          "aria-pressed": open,
          "aria-label": label,
          title: sdk.T("文件与 Git 工作台", "Files & Git workbench"),
          onClick: () => setOpen(!open),
          children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: open ? "folder-open" : "folder" })
        }
      ) }),
      open ? /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "right", children: /* @__PURE__ */ jsxRuntime.jsxs("aside", { className: "gah-sb", style: { width }, "aria-label": label, children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-sb-resize", role: "separator", "aria-orientation": "vertical", onPointerDown: drag }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-head", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-tabs", role: "tablist", children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "tab", "aria-selected": tab === "files", className: tab === "files" ? "on" : "", onClick: () => {
              setTab("files");
              if ((view == null ? void 0 : view.kind) === "diff") setView(null);
            }, children: sdk.T("文件", "Files") }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "tab", "aria-selected": tab === "git", className: tab === "git" ? "on" : "", onClick: () => {
              setTab("git");
              if ((view == null ? void 0 : view.kind) === "file") setView(null);
            }, children: sdk.T("变更", "Changes") })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "spacer" }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-icon-btn", "aria-label": sdk.T("刷新", "Refresh"), title: sdk.T("刷新", "Refresh"), onClick: () => setTick((t) => t + 1), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "refresh" }) }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "gah-icon-btn", "aria-label": sdk.T("关闭工作台", "Close workbench"), title: sdk.T("关闭工作台", "Close workbench"), onClick: () => setOpen(false), children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "x" }) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-sb-body" + (view ? " viewing" : ""), children: [
          tab === "files" ? /* @__PURE__ */ jsxRuntime.jsx(Files, { api, sid, tick, active: (view == null ? void 0 : view.kind) === "file" ? view.path : "", onOpen: (path) => setView({ kind: "file", path }) }) : /* @__PURE__ */ jsxRuntime.jsx(Changes, { api, sid, tick, active: (view == null ? void 0 : view.kind) === "diff" ? view.path : "", onOpen: (path) => setView({ kind: "diff", path }) }),
          (view == null ? void 0 : view.kind) === "file" ? /* @__PURE__ */ jsxRuntime.jsx(FileView, { api, sid, path: view.path, tick, onClose: () => setView(null) }, sid + "\n" + view.path) : null,
          (view == null ? void 0 : view.kind) === "diff" ? /* @__PURE__ */ jsxRuntime.jsx(DiffView, { api, sid, path: view.path, tick, onClose: () => setView(null) }, sid + "\n" + view.path) : null
        ] })
      ] }) }) : null
    ] });
  }
  sdk.defineReact("web-sidebar", Sidebar);
})(GAH.jsxRuntime, GAH.React, GAH);
