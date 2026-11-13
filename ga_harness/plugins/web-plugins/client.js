var GAHPlugin_web_plugins = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const categories = [
    ["core", sdk.T("核心", "Core")],
    ["extension", sdk.T("GA 扩展", "GA extensions")],
    ["observe", sdk.T("观测记录", "Observability")],
    ["service", sdk.T("数据与服务", "Data & services")],
    ["ui", sdk.T("界面", "Interface")],
    ["other", sdk.T("其他", "Other")]
  ];
  const filters = [["all", sdk.T("全部", "All")], ["active", sdk.T("运行中", "Running")], ["off", sdk.T("未加载", "Not loaded")], ["issue", sdk.T("需处理", "Needs attention")]];
  const states = { active: sdk.T("运行中", "Running"), pending: sdk.T("等待依赖", "Waiting for dependencies"), disabled: sdk.T("未加载", "Not loaded"), error: sdk.T("加载失败", "Failed to load"), removed: sdk.T("已移除", "Removed"), missing_packages: sdk.T("缺少 Python 依赖", "Missing Python packages") };
  const sources = [["all", sdk.T("全部来源", "All sources")], ["user", sdk.T("我的插件", "My plugins")], ["builtin", sdk.T("内置", "Built-in")]];
  const inSource = (plugin, source) => source === "all" || (plugin.source || "builtin") === source;
  const stateLabel = (plugin) => states[plugin.state] || plugin.state;
  const categoryOf = (plugin) => categories.find(([key]) => key === plugin.category) || categories[categories.length - 1];
  const descriptionOf = (item) => sdk.T(item.description_zh || item.description || "", item.description || "");
  const inFilter = (plugin, filter) => {
    var _a, _b;
    return filter === "all" || (filter === "active" ? plugin.state === "active" : filter === "off" ? ["disabled", "removed"].includes(plugin.state) : ["error", "pending", "missing_packages"].includes(plugin.state) || !!((_a = plugin.missing) == null ? void 0 : _a.length) || !!((_b = plugin.missing_packages) == null ? void 0 : _b.length) || !!plugin.error);
  };
  function Switch({ checked, disabled, label, onToggle }) {
    return /* @__PURE__ */ jsxRuntime.jsx(
      "button",
      {
        type: "button",
        role: "switch",
        className: "plugin-switch",
        "aria-checked": checked,
        "aria-label": label,
        title: label,
        disabled,
        onClick: (event) => {
          event.stopPropagation();
          onToggle(!checked);
        },
        children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-switch-knob" })
      }
    );
  }
  function PluginTags({ plugin, compact }) {
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      plugin.source === "user" ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "user", children: sdk.T("我的插件", "My plugin") }) : !compact && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "builtin", children: sdk.T("内置", "Built-in") }),
      plugin.protected && !compact && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "protected", children: sdk.T("受保护", "Protected") }),
      plugin.hot && !compact && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "hot", children: sdk.T("热插拔", "Hot-pluggable") }),
      plugin.restart_required && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "pending", children: sdk.T("待重启", "Restart pending") }),
      plugin.overridden && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "override", children: sdk.T("网页覆盖", "Web override") }),
      !plugin.enabled && plugin.state === "active" && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "pending", children: sdk.T("下次停用", "Off next start") })
    ] });
  }
  const MIRRORS = [
    ["https://pypi.tuna.tsinghua.edu.cn/simple", "清华 Tsinghua"],
    ["https://mirrors.aliyun.com/pypi/simple/", "阿里云 Aliyun"],
    ["https://mirrors.cloud.tencent.com/pypi/simple", "腾讯云 Tencent"],
    ["https://pypi.mirrors.ustc.edu.cn/simple", "中科大 USTC"]
  ];
  function PluginDetails({ plugin, busy, running, error, onChange, onToggle, onInstall, job, installing = false, packageIndex = "" }) {
    var _a, _b, _c, _d;
    const [enabled, setEnabled] = react.useState(plugin.enabled);
    const [mirror, setMirror] = react.useState(packageIndex);
    const [values, setValues] = react.useState({ ...plugin.config });
    const locked = busy || running || plugin.protected;
    const update = (key, value) => setValues((previous) => ({ ...previous, [key]: value }));
    const warning = [
      ((_a = plugin.missing) == null ? void 0 : _a.length) ? sdk.T("当前缺少：", "Missing: ") + plugin.missing.join(", ") : "",
      ((_b = plugin.missing_packages) == null ? void 0 : _b.length) ? sdk.T("缺少 Python 包：", "Missing Python packages: ") + plugin.missing_packages.join(", ") : "",
      plugin.error
    ].filter(Boolean).join("; ");
    const submit = () => {
      if (locked) return;
      const config = {};
      for (const [key, spec] of Object.entries(plugin.fields)) {
        const value = values[key] ?? "";
        if (spec.type === "boolean") config[key] = !!value;
        else if (value !== "" || spec.type === "string") config[key] = spec.type === "integer" ? Number(value) : value;
      }
      onChange("save", enabled, config);
    };
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-detail-card", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-detail-head", children: [
        /* @__PURE__ */ jsxRuntime.jsx("h3", { className: "plugin-title", children: plugin.name }),
        plugin.version && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-version", children: "v" + plugin.version.replace(/^v/i, "") }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-badge plugin-status", "data-state": plugin.state, children: stateLabel(plugin) })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-tags", children: /* @__PURE__ */ jsxRuntime.jsx(PluginTags, { plugin }) }),
      /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-description", children: descriptionOf(plugin) || sdk.T("暂无说明", "No description") }),
      /* @__PURE__ */ jsxRuntime.jsxs("dl", { className: "plugin-deps", children: [
        [
          ["requires", sdk.T("依赖能力", "Requires")],
          ["provides", sdk.T("提供能力", "Provides")],
          ["dependents", sdk.T("被插件依赖", "Required by")],
          ["packages", sdk.T("Python 依赖", "Python packages")]
        ].map(([key, label]) => {
          var _a2;
          return /* @__PURE__ */ jsxRuntime.jsxs(react.Fragment, { children: [
            /* @__PURE__ */ jsxRuntime.jsx("dt", { children: label }),
            /* @__PURE__ */ jsxRuntime.jsx("dd", { children: ((_a2 = plugin[key]) == null ? void 0 : _a2.join(sdk.T("、", ", "))) || sdk.T("无", "None") })
          ] }, key);
        }),
        plugin.source_meta && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("安装来源", "Install source") }),
          /* @__PURE__ */ jsxRuntime.jsx("dd", { children: [
            plugin.source_meta.type === "git" ? plugin.source_meta.url || "git" : plugin.source_meta.filename || "zip",
            plugin.source_meta.commit ? plugin.source_meta.commit.slice(0, 7) : "",
            plugin.source_meta.built_frontend ? sdk.T("已编译前端", "frontend built") : ""
          ].filter(Boolean).join(" · ") })
        ] })
      ] }),
      !!((_c = plugin.workers) == null ? void 0 : _c.length) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-note plugin-workers", children: sdk.T("依赖 ", "Depends on ") + plugin.workers.join(sdk.T("、", ", ")) + sdk.T("（任务进程内自动加载）", " (loaded automatically inside task workers)") }),
      warning && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-note plugin-warning", children: warning }),
      !!((_d = plugin.missing_packages) == null ? void 0 : _d.length) && onInstall && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-actions plugin-install", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "plugin-mirror", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("镜像源", "Package index") }),
          /* @__PURE__ */ jsxRuntime.jsx("input", { type: "url", list: "gah-pip-mirrors", value: mirror, placeholder: sdk.T("默认（PyPI / pip 配置）", "Default (PyPI / pip config)"), disabled: busy || installing, onChange: (event) => setMirror(event.target.value.trim()) }),
          /* @__PURE__ */ jsxRuntime.jsx("datalist", { id: "gah-pip-mirrors", children: MIRRORS.map(([url, label]) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: url, children: label }, url)) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary plugin-install-button", disabled: busy || running || installing, onClick: () => onInstall(mirror), children: installing && job ? sdk.T("安装中...", "Installing...") : sdk.T("安装依赖（pip）", "Install packages (pip)") }),
        /* @__PURE__ */ jsxRuntime.jsx("small", { children: installing && !job ? sdk.T("另一个插件正在安装依赖", "Another plugin is installing packages") : sdk.T("后台安装，可关闭面板；完成后重新启用或下次启动生效", "Runs in the background; you can close this panel. Re-enable or restart to apply") })
      ] }),
      job && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-install-log", "data-state": job.state, children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-install-status", children: [
          job.state === "running" ? sdk.T("正在安装：", "Installing: ") : job.ok ? sdk.T("已安装：", "Installed: ") : sdk.T("安装失败：", "Failed: "),
          job.packages.join(" "),
          job.index_url && /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
            " (",
            job.index_url,
            ")"
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("pre", { ref: (node) => {
          if (node) node.scrollTop = node.scrollHeight;
        }, children: job.log || "..." })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("form", { onSubmit: (event) => {
        event.preventDefault();
        submit();
      }, children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-toggle plugin-enable", children: [
          /* @__PURE__ */ jsxRuntime.jsx(Switch, { checked: enabled, disabled: locked, label: sdk.T("启用", "Enabled"), onToggle: (next) => {
            setEnabled(next);
            if (plugin.hot) onToggle == null ? void 0 : onToggle(next);
          } }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: plugin.hot ? sdk.T("启用（立即生效）", "Enabled (applies immediately)") : sdk.T("下次启动时启用", "Enable on next start") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-grid plugin-fields", hidden: !Object.keys(plugin.fields).length, children: Object.entries(plugin.fields).map(([key, spec]) => {
          var _a2;
          const label = sdk.T(spec.label_zh || spec.label || key, spec.label || key);
          const common = { "data-plugin-field": key, disabled: locked };
          const text = String(values[key] ?? "");
          return /* @__PURE__ */ jsxRuntime.jsxs("label", { className: spec.type === "boolean" ? "plugin-toggle" : "model-field", children: [
            spec.type !== "boolean" && /* @__PURE__ */ jsxRuntime.jsx("span", { children: label }),
            spec.type === "boolean" ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("input", { ...common, type: "checkbox", checked: !!values[key], onChange: (event) => update(key, event.target.checked) }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: label })
            ] }) : spec.type === "choice" ? /* @__PURE__ */ jsxRuntime.jsx("select", { ...common, value: text, onChange: (event) => update(key, event.target.value), children: (_a2 = spec.options) == null ? void 0 : _a2.map((option) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: option.value, children: sdk.T(option.label_zh || option.label || option.value, option.label || option.value) }, option.value)) }) : spec.multiline && spec.type === "string" ? /* @__PURE__ */ jsxRuntime.jsx("textarea", { ...common, rows: 4, value: text, onChange: (event) => update(key, event.target.value) }) : /* @__PURE__ */ jsxRuntime.jsx("input", { ...common, type: spec.type === "integer" ? "number" : "text", step: spec.type === "integer" ? 1 : void 0, min: spec.min, max: spec.max, value: text, onChange: (event) => update(key, event.target.value) }),
            descriptionOf(spec) && /* @__PURE__ */ jsxRuntime.jsx("small", { children: descriptionOf(spec) })
          ] }, key);
        }) }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-note", children: running ? sdk.T("任务运行中，仅可查看。", "A task is running; view only.") : plugin.protected ? sdk.T("基础能力与前端受保护，请通过启动配置调整。", "Core and frontend plugins are protected; change them in the startup config.") : sdk.T("仅显示公开配置；密钥请到模型配置中管理。", "Only public settings are shown; manage keys in Models.") }),
        error && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-error", role: "status", children: error }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-actions plugin-actions", children: [
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary plugin-reset", disabled: locked || !plugin.overridden, onClick: () => onChange("reset"), children: sdk.T("恢复启动配置", "Restore startup settings") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", disabled: locked, children: plugin.hot ? sdk.T("保存并立即生效", "Save and apply now") : sdk.T("保存，下次启动生效", "Save (applies on next start)") })
        ] })
      ] })
    ] });
  }
  async function send(path, init) {
    const response = await fetch(path, { method: "POST", ...init });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data ? String(data.error) : `HTTP ${response.status}`);
    if (!data || !data.imported) throw new Error("Invalid JSON response");
    return data;
  }
  function ImportPlugin({ disabled, run, onError, onDone }) {
    const [open, setOpen] = react.useState(false), [mode, setMode] = react.useState("zip");
    const [file, setFile] = react.useState(null), [url, setUrl] = react.useState(""), [ref, setRef] = react.useState("");
    const [subdir, setSubdir] = react.useState(""), [replace, setReplace] = react.useState(false);
    const submit = (event) => {
      event.preventDefault();
      if (disabled) return;
      if (mode === "zip" && !file) return onError(sdk.T("请选择 zip 文件", "Choose a zip file"));
      if (mode === "git" && !url.trim()) return onError(sdk.T("请输入 Git 地址", "Enter a git URL"));
      onError("");
      void run(async () => {
        let result;
        if (mode === "zip" && file) {
          const query = new URLSearchParams();
          if (replace) query.set("replace", "1");
          if (subdir.trim()) query.set("subdir", subdir.trim());
          result = await send("/api/plugins/import" + (query.size ? "?" + query : ""), {
            headers: { "Content-Type": "application/zip", "X-File-Name": encodeURIComponent(file.name) },
            body: file
          });
        } else {
          result = await send("/api/plugins/import", {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url.trim(), ref: ref.trim() || void 0, subdir: subdir.trim() || void 0, replace })
          });
        }
        setOpen(false);
        setFile(null);
        setUrl("");
        setRef("");
        setSubdir("");
        setReplace(false);
        onDone(result);
      }, onError);
    };
    const [dragging, setDragging] = react.useState(false);
    const pick = (next) => {
      if (next) {
        setFile(next);
        onError("");
      }
    };
    if (!open) return /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary plugin-import-toggle", disabled, onClick: () => setOpen(true), children: sdk.T("导入", "Import") });
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary plugin-import-toggle", "aria-pressed": "true", disabled, onClick: () => {
        setOpen(false);
        onError("");
      }, children: sdk.T("导入", "Import") }),
      /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "plugin-import", onSubmit: submit, "aria-label": sdk.T("导入插件", "Import plugin"), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-import-head", children: [
          /* @__PURE__ */ jsxRuntime.jsx("strong", { children: sdk.T("导入插件", "Import plugin") }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-import-modes", role: "tablist", children: ["zip", "git"].map((key) => /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "tab", "aria-selected": mode === key, disabled, onClick: () => setMode(key), children: key === "zip" ? sdk.T("ZIP 文件", "ZIP file") : sdk.T("Git 地址", "Git URL") }, key)) })
        ] }),
        mode === "zip" ? /* @__PURE__ */ jsxRuntime.jsxs(
          "label",
          {
            className: "plugin-import-drop",
            "data-dragging": dragging || void 0,
            "data-filled": file ? true : void 0,
            onDragOver: (event) => {
              event.preventDefault();
              setDragging(true);
            },
            onDragLeave: () => setDragging(false),
            onDrop: (event) => {
              var _a;
              event.preventDefault();
              setDragging(false);
              pick((_a = event.dataTransfer.files) == null ? void 0 : _a[0]);
            },
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("input", { type: "file", accept: ".zip,application/zip", disabled, onChange: (event) => {
                var _a;
                return pick((_a = event.target.files) == null ? void 0 : _a[0]);
              } }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-import-drop-title", children: file ? file.name : sdk.T("点击选择或拖入 .zip 文件", "Click to choose or drop a .zip file") }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-import-drop-hint", children: file ? `${(file.size / 1024).toFixed(1)} KB · ${sdk.T("点击更换", "click to change")}` : sdk.T("压缩包内需含 plugin.toml", "The archive must contain plugin.toml") })
            ]
          }
        ) : /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-import-row", children: [
          /* @__PURE__ */ jsxRuntime.jsx("input", { className: "plugin-import-input", type: "text", value: url, placeholder: "https://github.com/owner/repo.git", "aria-label": sdk.T("Git 地址", "Git URL"), disabled, onChange: (event) => setUrl(event.target.value) }),
          /* @__PURE__ */ jsxRuntime.jsx("input", { className: "plugin-import-input", type: "text", value: ref, placeholder: sdk.T("分支/标签（可选）", "Branch/tag (optional)"), "aria-label": sdk.T("分支/标签", "Branch/tag"), disabled, onChange: (event) => setRef(event.target.value) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("input", { className: "plugin-import-input", type: "text", value: subdir, placeholder: sdk.T("子目录（可选，包含多个插件时指定）", "Subdirectory (optional; when the source holds several plugins)"), "aria-label": sdk.T("子目录", "Subdirectory"), disabled, onChange: (event) => setSubdir(event.target.value) }),
        /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "plugin-import-check", children: [
          /* @__PURE__ */ jsxRuntime.jsx("input", { type: "checkbox", checked: replace, disabled, onChange: (event) => setReplace(event.target.checked) }),
          sdk.T("覆盖同名的已停用用户插件", "Replace a disabled user plugin with the same name")
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-import-foot", children: [
          /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-import-warn", children: sdk.T("仅导入可信来源的插件：插件代码以当前用户权限运行。导入后默认未启用。", "Only import plugins you trust: plugin code runs with your user permissions. Imported plugins start disabled.") }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-import-actions", children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled, onClick: () => {
              setOpen(false);
              onError("");
            }, children: sdk.T("取消", "Cancel") }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", className: "plugin-import-submit", disabled: disabled || (mode === "zip" ? !file : !url.trim()), children: sdk.T("导入", "Import") })
          ] })
        ] })
      ] })
    ] });
  }
  const cleanVer = (v) => (v || "").trim().replace(/^v/i, "");
  function hasNewerVersion(localVer, remoteVer) {
    const a = cleanVer(localVer), b = cleanVer(remoteVer);
    if (!b) return false;
    if (!a) return true;
    if (a === b) return false;
    const pa = a.split(".").map((s) => parseInt(s, 10)), pb = b.split(".").map((s) => parseInt(s, 10));
    if (pa.every((n) => !Number.isNaN(n)) && pb.every((n) => !Number.isNaN(n))) {
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (nb !== na) return nb > na;
      }
      return false;
    }
    return a !== b;
  }
  async function request(path, init) {
    const response = await fetch(path, init);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data ? String(data.error) : `HTTP ${response.status}`);
    if (!data || typeof data !== "object") throw new Error("Invalid JSON response");
    return data;
  }
  const guessName = (item) => item.plugin_name || item.name.replace(/^gah-plugin-/, "");
  function MarketReadme({ text }) {
    const ref = react.useRef(null);
    react.useEffect(() => {
      var _a;
      const node = ref.current;
      if (!node) return;
      if ((_a = window.GAHOutput) == null ? void 0 : _a.setMarkdown) window.GAHOutput.setMarkdown(node, text);
      else node.textContent = text;
    }, [text]);
    return /* @__PURE__ */ jsxRuntime.jsx("div", { ref, className: "plugin-market-readme md" });
  }
  function Market({ api, disabled, catalog, ensureCatalog, run, onDone }) {
    const [list, setList] = react.useState(null);
    const [loading, setLoading] = react.useState(false), [failure, setFailure] = react.useState(""), [query, setQuery] = react.useState("");
    const [expanded, setExpanded] = react.useState({});
    const load = async (refresh) => {
      setLoading(true);
      setFailure("");
      try {
        setList(await request("/api/plugins/market" + (refresh ? "?refresh=1" : "")));
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    };
    const open = () => {
      ensureCatalog();
      if (!list && !loading) void load(false);
    };
    const install = async (item, replace = false) => {
      if (disabled) return;
      const ok = await sdk.confirmDialog({
        title: (replace ? sdk.T("更新插件", "Update plugin") : sdk.T("安装插件", "Install plugin")) + " " + item.full_name,
        message: replace ? sdk.T("将从 GitHub 拉取最新代码覆盖当前插件（若含前端源码将自动打包）；已启用的热插拔插件会立即热重载生效。", "Pull the latest code from GitHub and replace the installed plugin (frontend sources are built automatically); active hot-pluggable plugins hot-reload immediately.") : sdk.T("市场条目来自 GitHub 上的第三方仓库，未经审核；插件代码以当前用户权限运行。仅安装你信任的来源。安装后默认未启用。", "Market entries are unreviewed third-party GitHub repositories; plugin code runs with your user permissions. Only install sources you trust. Installed plugins start disabled.")
      });
      if (!ok) return;
      setFailure("");
      void run(async () => {
        const result = await request("/api/plugins/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: item.clone_url, replace }) });
        if (!result.imported) throw new Error("Invalid JSON response");
        onDone(result);
      }, setFailure);
    };
    const shown = ((list == null ? void 0 : list.items) || []).filter((item) => sdk.matches(query, item.full_name, item.plugin_name, item.version, item.description, item.description_zh, item.category, item.readme));
    return /* @__PURE__ */ jsxRuntime.jsxs(sdk.SettingsPanel, { api, label: sdk.T("插件市场", "Plugin market"), icon: "download", order: 31, className: "gah-plugin-market-dialog", onOpen: open, children: [
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "dialog-head", children: /* @__PURE__ */ jsxRuntime.jsx("h2", { children: sdk.T("插件市场", "Plugin market") }) }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-content", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "plugin-note plugin-profile", children: [
          sdk.T("数据来自 GitHub topic ", "Listed from the GitHub topic "),
          /* @__PURE__ */ jsxRuntime.jsx("code", { children: (list == null ? void 0 : list.topic) || "ga-harness-plugin" }),
          sdk.T("，未经审核。给自己的插件仓库打上该 topic 即可出现在这里；安装后请到“插件”页启用。", ", unreviewed. Tag your plugin repository with this topic to list it here; enable installed plugins under Plugins.")
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-toolbar", children: [
          /* @__PURE__ */ jsxRuntime.jsx("input", { className: "plugin-search", type: "search", value: query, placeholder: sdk.T("搜索市场插件名称或说明", "Search market plugin names or descriptions"), "aria-label": sdk.T("搜索市场插件", "Search market plugins"), onChange: (event) => setQuery(event.target.value) }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: loading, onClick: () => void load(true), children: sdk.T("刷新", "Refresh") })
        ] }),
        failure && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-error", role: "status", children: failure }),
        loading && !list && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-empty", children: sdk.T("加载中...", "Loading...") }),
        list && !shown.length && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-empty", children: list.items.length ? sdk.T("没有符合条件的插件", "No matching plugins") : sdk.T("市场里还没有插件", "No plugins in the market yet") }),
        /* @__PURE__ */ jsxRuntime.jsx("ul", { className: "plugin-market-list", "aria-label": sdk.T("插件市场列表", "Plugin market list"), children: shown.map((item) => {
          var _a, _b, _c, _d, _e, _f;
          const pluginId = guessName(item);
          const local = catalog.find((plugin) => plugin.name === pluginId);
          const conflict = !!local && !local.hot;
          const have = !!local && !!local.hot;
          const localVer = cleanVer(local == null ? void 0 : local.version);
          const remoteVer = cleanVer(item.version);
          const outdated = have && hasNewerVersion(localVer, remoteVer);
          const desc = descriptionOf(item);
          const isOpen = !!expanded[item.full_name];
          return /* @__PURE__ */ jsxRuntime.jsxs("li", { className: "plugin-market-item", "data-expanded": isOpen || void 0, children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-market-top", children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-market-main", children: [
                /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-market-head", children: [
                  /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-market-title", children: pluginId }),
                  remoteVer && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-version", children: "v" + remoteVer }),
                  item.category && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-badge", children: categoryOf(item)[1] }),
                  have && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": outdated ? "pending" : "override", children: outdated ? localVer ? sdk.T("已装 v", "Installed v") + localVer + " → v" + remoteVer : sdk.T("可更新 v", "Update v") + remoteVer : localVer ? sdk.T("已安装 v", "Installed v") + localVer : sdk.T("已安装", "Installed") }),
                  /* @__PURE__ */ jsxRuntime.jsx("a", { className: "plugin-market-name", href: item.url, target: "_blank", rel: "noreferrer noopener", children: item.full_name })
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-market-desc", children: desc || sdk.T("暂无说明", "No description") }),
                /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-market-foot", children: [
                  /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "plugin-market-meta", children: [
                    "★ " + item.stars,
                    item.license && item.license !== "NOASSERTION" ? " · " + item.license : "",
                    item.updated_at ? " · " + item.updated_at.slice(0, 10) : "",
                    item.fork ? " · fork" : ""
                  ] }),
                  !!(((_a = item.requires) == null ? void 0 : _a.length) || ((_b = item.provides) == null ? void 0 : _b.length) || ((_c = item.packages) == null ? void 0 : _c.length)) && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-market-caps", children: [
                    !!((_d = item.requires) == null ? void 0 : _d.length) && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", children: sdk.T("依赖: ", "Requires: ") + item.requires.join(", ") }),
                    !!((_e = item.provides) == null ? void 0 : _e.length) && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", children: sdk.T("提供: ", "Provides: ") + item.provides.join(", ") }),
                    !!((_f = item.packages) == null ? void 0 : _f.length) && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", children: "pip: " + item.packages.join(", ") })
                  ] })
                ] })
              ] }),
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-market-actions", children: [
                item.readme && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary plugin-market-detail-btn", "aria-expanded": isOpen, onClick: () => setExpanded((prev) => ({ ...prev, [item.full_name]: !isOpen })), children: isOpen ? sdk.T("收起说明", "Hide details") : sdk.T("详细说明", "Details") }),
                /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: have && !outdated ? "secondary" : "plugin-import-submit", disabled: disabled || conflict, title: conflict ? sdk.T("与内置受保护插件同名，不可覆盖", "Conflicts with a protected builtin plugin") : have ? sdk.T("从 GitHub 拉取最新代码覆盖并热重载", "Pull latest code from GitHub and hot-reload") : void 0, onClick: () => void install(item, have), children: conflict ? sdk.T("内置同名", "Builtin") : have ? outdated ? sdk.T("更新 v", "Update v") + remoteVer : localVer && remoteVer ? sdk.T("重新安装", "Reinstall") : sdk.T("更新", "Update") : sdk.T("安装", "Install") })
              ] })
            ] }),
            item.readme && isOpen && /* @__PURE__ */ jsxRuntime.jsx(MarketReadme, { text: item.readme })
          ] }, item.full_name);
        }) })
      ] })
    ] });
  }
  function PluginManager({ api }) {
    const { state, changing } = sdk.useHost();
    const { busy, working, run } = sdk.useOperation(api, true);
    const runLock = !!state.running && !state.parallel_runs;
    const lockedByRun = (plugin) => runLock && !plugin.run_safe;
    const [config, setConfig] = react.useState(null);
    const [marketApi] = react.useState(() => ({ ...api, name: "web-plugins-market" }));
    const [editing, setEditing] = react.useState(null), [error, setError] = react.useState("");
    const [query, setQuery] = react.useState(""), [filter, setFilter] = react.useState("all"), [source, setSource] = react.useState("all"), [category, setCategory] = react.useState("all");
    const cards = react.useRef(null), back = react.useRef(null);
    const selected = config == null ? void 0 : config.items.find((plugin) => plugin.name === editing);
    const visible = ((config == null ? void 0 : config.items) || []).filter((plugin) => !plugin.worker_only);
    const base = visible.filter((plugin) => {
      var _a, _b;
      return inFilter(plugin, filter) && inSource(plugin, source) && sdk.matches(query, plugin.name, descriptionOf(plugin), categoryOf(plugin)[1], (_a = plugin.requires) == null ? void 0 : _a.join(" "), (_b = plugin.provides) == null ? void 0 : _b.join(" "));
    });
    const inCategory = (plugin, key) => key === "all" || categoryOf(plugin)[0] === key;
    const shown = base.filter((plugin) => inCategory(plugin, category));
    const present = categories.filter(([key]) => visible.some((plugin) => categoryOf(plugin)[0] === key));
    const toGrid = () => {
      if (working) return;
      setEditing(null);
      setError("");
      requestAnimationFrame(() => {
        var _a, _b;
        if (editing) (_b = (_a = cards.current) == null ? void 0 : _a.querySelector('[data-plugin="' + CSS.escape(editing) + '"]')) == null ? void 0 : _b.focus();
      });
    };
    const load = async () => {
      setError("");
      await run(async () => {
        setConfig(await api.host.get("/api/plugins"));
      }, setError, true);
    };
    const toggle = (plugin, enabled) => {
      if (plugin.protected || busy || lockedByRun(plugin) || !config) return;
      setError("");
      void run(async () => {
        const next = await api.host.post("/api/plugins", { action: "save", name: plugin.name, revision: config.revision, enabled, config: plugin.config });
        setConfig(next);
        const item = next.items.find((p) => p.name === plugin.name);
        if (item == null ? void 0 : item.error) setError(plugin.name + ": " + item.error);
        else api.notice((item == null ? void 0 : item.restart_required) ? sdk.T("已保存；下次启动时生效", "Saved; applies on next start") : enabled ? sdk.T("已启用 ", "Enabled ") + plugin.name : sdk.T("已停用 ", "Disabled ") + plugin.name);
      }, setError);
    };
    const change = async (action, enabled, values) => {
      if (!selected || selected.protected || busy || lockedByRun(selected) || !config) return;
      if (action === "reset" && !await sdk.confirmDialog({ title: sdk.T("恢复启动配置", "Restore startup settings"), danger: true, message: sdk.T("清除网页覆盖并恢复启动配置？下次启动生效。", "Clear web overrides and restore startup settings? Applies on next start.") })) return;
      setError("");
      void run(async () => {
        var _a;
        const next = await api.host.post("/api/plugins", { action, name: selected.name, revision: config.revision, ...action === "save" ? { enabled, config: values } : {} });
        setConfig(next);
        const live = !((_a = next.items.find((plugin) => plugin.name === selected.name)) == null ? void 0 : _a.restart_required);
        api.notice(live ? sdk.T("插件配置已保存并已即时生效", "Plugin settings saved and applied") : sdk.T("插件配置已保存；下次启动时生效", "Plugin settings saved; they apply on next start"));
      }, setError);
    };
    const job = config == null ? void 0 : config.install_job, installing = (job == null ? void 0 : job.state) === "running";
    const reported = react.useRef(null);
    react.useEffect(() => {
      if (!installing) return;
      let alive = true;
      const timer = window.setInterval(async () => {
        try {
          const next = await api.host.get("/api/plugins");
          if (!alive) return;
          setConfig(next);
          const done = next.install_job;
          if (done && done.state !== "running" && reported.current !== done.started) {
            reported.current = done.started;
            if (done.ok) api.notice(done.name + sdk.T("：依赖已安装", ": packages installed"));
            else setError(done.name + sdk.T("：依赖安装失败，见下方日志", ": package installation failed; see the log below"));
          }
        } catch {
        }
      }, 1e3);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [installing]);
    const install = (indexUrl) => {
      var _a;
      if (!((_a = selected == null ? void 0 : selected.missing_packages) == null ? void 0 : _a.length) || busy || installing || lockedByRun(selected)) return;
      setError("");
      void run(async () => {
        const result = await api.host.post("/api/plugins", { action: "install", name: selected.name, index_url: indexUrl });
        setConfig(result.catalog);
      }, setError);
    };
    const imported = (result, openDetail = true) => {
      setConfig(result);
      const { name, version, replaced, hot_reloaded, restart_required } = result.imported;
      const label = name + (version ? " v" + version.replace(/^v/i, "") : "");
      const suffix = restart_required ? sdk.T("；重启后生效", "; applies after restart") : hot_reloaded ? sdk.T("，已热重载生效", "; hot-reloaded") : replaced ? "" : sdk.T("，默认未启用", "; it starts disabled");
      api.notice((replaced ? sdk.T("已更新 ", "Updated ") : sdk.T("已导入 ", "Imported ")) + label + suffix);
      if (openDetail && result.items.some((plugin) => plugin.name === name)) {
        setEditing(name);
        requestAnimationFrame(() => {
          var _a;
          return (_a = back.current) == null ? void 0 : _a.focus();
        });
      }
    };
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      state.plugins_enabled && /* @__PURE__ */ jsxRuntime.jsxs(sdk.SettingsPanel, { api, label: sdk.T("插件", "Plugins"), icon: "puzzle", order: 30, className: "gah-plugin-dialog", onOpen: load, children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "dialog-head", children: /* @__PURE__ */ jsxRuntime.jsx("h2", { children: sdk.T("插件管理", "Plugins") }) }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-content", children: [
          (config == null ? void 0 : config.restart_required) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-note", role: "status", children: sdk.T("已保存，下次启动生效", "Saved; applies on next start") }),
          /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "plugin-catalog", hidden: !!selected, children: [
            /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-note plugin-profile", hidden: !config, children: config ? sdk.T("配置方案：", "Profile: ") + config.profile + sdk.T("。更改保存到本地；支持热插拔的插件立即生效，其余下次启动生效。", ". Changes are saved locally; hot-pluggable plugins apply immediately, others on next start.") : "" }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-toolbar", children: [
              /* @__PURE__ */ jsxRuntime.jsx("input", { className: "plugin-search", type: "search", value: query, placeholder: sdk.T("搜索插件名称或说明", "Search plugin names or descriptions"), "aria-label": sdk.T("搜索插件", "Search plugins"), disabled: working, onChange: (event) => setQuery(event.target.value) }),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: working || changing, onClick: () => void load(), children: sdk.T("刷新", "Refresh") }),
              /* @__PURE__ */ jsxRuntime.jsx(ImportPlugin, { disabled: working || changing || runLock, run, onError: setError, onDone: imported })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-categories", role: "tablist", "aria-label": sdk.T("按分类筛选", "Filter by category"), children: [["all", sdk.T("全部分类", "All categories")], ...present].map(([key, label]) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "tab", className: "plugin-category", "data-category": key, "aria-selected": category === key, onClick: () => setCategory(key), children: [
              label,
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-count", children: base.filter((plugin) => inCategory(plugin, key)).length })
            ] }, key)) }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-filter-bar", children: [
              /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-filters", role: "tablist", "aria-label": sdk.T("按状态筛选", "Filter by status"), children: filters.map(([key, label]) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "tab", className: "plugin-filter", "data-filter": key, "aria-selected": filter === key, onClick: () => setFilter(key), children: [
                label,
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-count", children: visible.filter((plugin) => inFilter(plugin, key)).length })
              ] }, key)) }),
              /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-filters plugin-sources", role: "tablist", "aria-label": sdk.T("按来源筛选", "Filter by source"), children: sources.map(([key, label]) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "tab", className: "plugin-filter", "data-source": key, "aria-selected": source === key, onClick: () => setSource(key), children: [
                label,
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-count", children: visible.filter((plugin) => inSource(plugin, key)).length })
              ] }, key)) })
            ] }),
            error && !selected && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-error", role: "status", children: error }),
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-groups", ref: cards, "aria-label": sdk.T("插件列表", "Plugin list"), children: categories.map(([key, label]) => {
              const items = shown.filter((plugin) => categoryOf(plugin)[0] === key);
              return items.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "plugin-group", "data-category": key, children: [
                /* @__PURE__ */ jsxRuntime.jsxs("h3", { className: "plugin-group-title", children: [
                  label,
                  /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-count", children: items.length })
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("ul", { className: "plugin-grid", "aria-label": label, children: items.map((plugin) => /* @__PURE__ */ jsxRuntime.jsxs("li", { children: [
                  /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "plugin-card", "data-plugin": plugin.name, "data-state": plugin.state, "aria-label": plugin.name + sdk.T("，", ", ") + stateLabel(plugin), disabled: working, onClick: () => {
                    setEditing(plugin.name);
                    setError("");
                    requestAnimationFrame(() => {
                      var _a;
                      return (_a = back.current) == null ? void 0 : _a.focus();
                    });
                  }, children: [
                    /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "plugin-card-head", children: [
                      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-name", title: plugin.name, children: plugin.name }),
                      plugin.version && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-version", children: "v" + plugin.version.replace(/^v/i, "") }),
                      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-badge", "data-state": plugin.state, children: stateLabel(plugin) }),
                      (plugin.protected || plugin.hot) && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-switch-slot" })
                    ] }),
                    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-card-desc", title: descriptionOf(plugin) || void 0, children: descriptionOf(plugin) || sdk.T("暂无说明", "No description") }),
                    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-card-foot", children: /* @__PURE__ */ jsxRuntime.jsx(PluginTags, { plugin, compact: true }) })
                  ] }),
                  plugin.hot && !plugin.protected && /* @__PURE__ */ jsxRuntime.jsx(Switch, { checked: plugin.enabled, disabled: working || changing || lockedByRun(plugin), label: (plugin.enabled ? sdk.T("停用 ", "Disable ") : sdk.T("启用 ", "Enable ")) + plugin.name, onToggle: (next) => toggle(plugin, next) }),
                  plugin.protected && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-lock", title: sdk.T("受保护：必须加载，不可停用", "Protected: always loaded"), "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx("svg", { viewBox: "0 0 16 16", width: "14", height: "14", children: /* @__PURE__ */ jsxRuntime.jsx("path", { fill: "currentColor", d: "M8 1.5a3.5 3.5 0 0 0-3.5 3.5v2H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.5V5A3.5 3.5 0 0 0 8 1.5Zm2 5.5H6V5a2 2 0 1 1 4 0v2Z" }) }) })
                ] }, plugin.name)) })
              ] }, key);
            }) }),
            !shown.length && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-empty", children: working ? sdk.T("加载中...", "Loading...") : (config == null ? void 0 : config.items.length) ? sdk.T("没有符合条件的插件", "No matching plugins") : sdk.T("没有发现可管理的插件", "No manageable plugins found") })
          ] }),
          selected && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "plugin-detail", children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { ref: back, type: "button", className: "secondary plugin-back", disabled: working, onClick: toGrid, children: sdk.T("← 全部插件", "← All plugins") }),
            /* @__PURE__ */ jsxRuntime.jsx(PluginDetails, { plugin: selected, busy: working || changing, running: lockedByRun(selected), error, onChange: change, onToggle: (next) => toggle(selected, next), job: (job == null ? void 0 : job.name) === selected.name ? job : null, installing, packageIndex: (config == null ? void 0 : config.package_index) || "", onInstall: install }, selected.name + ":" + (config == null ? void 0 : config.revision))
          ] })
        ] })
      ] }),
      state.plugins_enabled && /* @__PURE__ */ jsxRuntime.jsx(Market, { api: marketApi, disabled: working || changing || runLock, catalog: (config == null ? void 0 : config.items) || [], ensureCatalog: () => {
        if (!config) void load();
      }, run, onDone: (result) => imported(result, false) })
    ] });
  }
  sdk.defineReact("web-plugins", PluginManager);
  exports.PluginManager = PluginManager;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
