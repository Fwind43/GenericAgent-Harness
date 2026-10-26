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
  const states = { active: sdk.T("运行中", "Running"), pending: sdk.T("等待依赖", "Waiting for dependencies"), disabled: sdk.T("未加载", "Not loaded"), error: sdk.T("加载失败", "Failed to load"), removed: sdk.T("已移除", "Removed") };
  const stateLabel = (plugin) => states[plugin.state] || plugin.state;
  const categoryOf = (plugin) => categories.find(([key]) => key === plugin.category) || categories[categories.length - 1];
  const descriptionOf = (item) => sdk.T(item.description_zh || item.description || "", item.description || "");
  const inFilter = (plugin, filter) => {
    var _a;
    return filter === "all" || (filter === "active" ? plugin.state === "active" : filter === "off" ? ["disabled", "removed"].includes(plugin.state) : ["error", "pending"].includes(plugin.state) || !!((_a = plugin.missing) == null ? void 0 : _a.length) || !!plugin.error);
  };
  function PluginTags({ plugin }) {
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      plugin.protected && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "protected", children: sdk.T("受保护", "Protected") }),
      plugin.restart_required && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "pending", children: sdk.T("待重启", "Restart pending") }),
      plugin.overridden && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "override", children: sdk.T("网页覆盖", "Web override") }),
      !plugin.enabled && plugin.state === "active" && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-tag", "data-tag": "pending", children: sdk.T("下次停用", "Off next start") })
    ] });
  }
  function PluginDetails({ plugin, busy, running, error, onChange }) {
    var _a;
    const [enabled, setEnabled] = react.useState(plugin.enabled);
    const [values, setValues] = react.useState({ ...plugin.config });
    const locked = busy || running || plugin.protected;
    const update = (key, value) => setValues((previous) => ({ ...previous, [key]: value }));
    const warning = [((_a = plugin.missing) == null ? void 0 : _a.length) ? sdk.T("当前缺少：", "Missing: ") + plugin.missing.join(", ") : "", plugin.error].filter(Boolean).join("; ");
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
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-badge plugin-status", "data-state": plugin.state, children: stateLabel(plugin) })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-tags", children: /* @__PURE__ */ jsxRuntime.jsx(PluginTags, { plugin }) }),
      /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-description", children: descriptionOf(plugin) || sdk.T("暂无说明", "No description") }),
      /* @__PURE__ */ jsxRuntime.jsx("dl", { className: "plugin-deps", children: [
        ["requires", sdk.T("依赖能力", "Requires")],
        ["provides", sdk.T("提供能力", "Provides")],
        ["dependents", sdk.T("被插件依赖", "Required by")]
      ].map(([key, label]) => {
        var _a2;
        return /* @__PURE__ */ jsxRuntime.jsxs(react.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx("dt", { children: label }),
          /* @__PURE__ */ jsxRuntime.jsx("dd", { children: ((_a2 = plugin[key]) == null ? void 0 : _a2.join(sdk.T("、", ", "))) || sdk.T("无", "None") })
        ] }, key);
      }) }),
      warning && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-note plugin-warning", children: warning }),
      /* @__PURE__ */ jsxRuntime.jsxs("form", { onSubmit: (event) => {
        event.preventDefault();
        submit();
      }, children: [
        /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "plugin-toggle plugin-enable", children: [
          /* @__PURE__ */ jsxRuntime.jsx("input", { type: "checkbox", role: "switch", checked: enabled, disabled: locked, onChange: (event) => setEnabled(event.target.checked) }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("下次启动时启用", "Enable on next start") })
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
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", disabled: locked, children: sdk.T("保存，下次启动生效", "Save (applies on next start)") })
        ] })
      ] })
    ] });
  }
  function PluginManager({ api }) {
    const { state, changing } = sdk.useHost();
    const { busy, working, run } = sdk.useOperation(api);
    const [open, setOpen] = react.useState(false), [config, setConfig] = react.useState(null);
    const [editing, setEditing] = react.useState(null), [error, setError] = react.useState("");
    const [query, setQuery] = react.useState(""), [filter, setFilter] = react.useState("all");
    const cards = react.useRef(null), back = react.useRef(null);
    const selected = config == null ? void 0 : config.items.find((plugin) => plugin.name === editing);
    const shown = ((config == null ? void 0 : config.items) || []).filter((plugin) => {
      var _a, _b;
      return inFilter(plugin, filter) && sdk.matches(query, plugin.name, descriptionOf(plugin), categoryOf(plugin)[1], (_a = plugin.requires) == null ? void 0 : _a.join(" "), (_b = plugin.provides) == null ? void 0 : _b.join(" "));
    });
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
      setOpen(true);
      setError("");
      await run(async () => {
        setConfig(await api.host.get("/api/plugins"));
      }, setError, true);
    };
    const change = async (action, enabled, values) => {
      if (!selected || selected.protected || busy || !config) return;
      if (action === "reset" && !await sdk.confirmDialog({ title: sdk.T("恢复启动配置", "Restore startup settings"), danger: true, message: sdk.T("清除网页覆盖并恢复启动配置？下次启动生效。", "Clear web overrides and restore startup settings? Applies on next start.") })) return;
      setError("");
      void run(async () => {
        setConfig(await api.host.post("/api/plugins", { action, name: selected.name, revision: config.revision, ...action === "save" ? { enabled, config: values } : {} }));
        api.notice(sdk.T("插件配置已保存；下次启动时生效", "Plugin settings saved; they apply on next start"));
      }, setError);
    };
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      state.plugins_enabled && /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "sidebar-foot", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-plugins", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "side-item", disabled: working || changing, onClick: () => void load(), children: [
          /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "puzzle" }),
          sdk.T("插件管理", "Plugins")
        ] }),
        (config == null ? void 0 : config.restart_required) && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-note", children: sdk.T("已保存，下次启动生效", "Saved; applies on next start") })
      ] }) }),
      open && /* @__PURE__ */ jsxRuntime.jsxs(sdk.Modal, { className: "gah-plugin-dialog", label: sdk.T("插件管理", "Plugins"), busy: working, onClose: () => selected ? toGrid() : setOpen(false), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-head", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h2", { children: sdk.T("插件管理", "Plugins") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: working, onClick: () => setOpen(false), children: sdk.T("关闭", "Close") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-content", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "plugin-catalog", hidden: !!selected, children: [
            /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-note plugin-profile", hidden: !config, children: config ? sdk.T("配置方案：", "Profile: ") + config.profile + sdk.T("。更改仅保存到本地，下次启动生效，不中断当前插件。", ". Changes are saved locally and apply on next start without interrupting running plugins.") : "" }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "plugin-toolbar", children: [
              /* @__PURE__ */ jsxRuntime.jsx("input", { className: "plugin-search", type: "search", value: query, placeholder: sdk.T("搜索插件名称或说明", "Search plugin names or descriptions"), "aria-label": sdk.T("搜索插件", "Search plugins"), disabled: working, onChange: (event) => setQuery(event.target.value) }),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: working || changing, onClick: () => void load(), children: sdk.T("刷新", "Refresh") })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-filters", role: "tablist", "aria-label": sdk.T("按状态筛选", "Filter by status"), children: filters.map(([key, label]) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", role: "tab", className: "plugin-filter", "data-filter": key, "aria-selected": filter === key, onClick: () => setFilter(key), children: [
              label,
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-count", children: (config == null ? void 0 : config.items.filter((plugin) => inFilter(plugin, key)).length) || 0 })
            ] }, key)) }),
            error && !selected && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-error", role: "status", children: error }),
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "plugin-groups", ref: cards, "aria-label": sdk.T("插件列表", "Plugin list"), children: categories.map(([key, label]) => {
              const items = shown.filter((plugin) => categoryOf(plugin)[0] === key);
              return items.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "plugin-group", "data-category": key, children: [
                /* @__PURE__ */ jsxRuntime.jsxs("h3", { className: "plugin-group-title", children: [
                  label,
                  /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-count", children: items.length })
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("ul", { className: "plugin-grid", "aria-label": label, children: items.map((plugin) => {
                  var _a;
                  return /* @__PURE__ */ jsxRuntime.jsx("li", { children: /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "plugin-card", "data-plugin": plugin.name, "data-state": plugin.state, "aria-label": plugin.name + sdk.T("，", ", ") + stateLabel(plugin), disabled: working, onClick: () => {
                    setEditing(plugin.name);
                    setError("");
                    requestAnimationFrame(() => {
                      var _a2;
                      return (_a2 = back.current) == null ? void 0 : _a2.focus();
                    });
                  }, children: [
                    /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "plugin-card-head", children: [
                      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-name", title: plugin.name, children: plugin.name }),
                      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-badge", "data-state": plugin.state, children: stateLabel(plugin) })
                    ] }),
                    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-card-desc", children: descriptionOf(plugin) || sdk.T("暂无说明", "No description") }),
                    /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "plugin-card-foot", children: [
                      /* @__PURE__ */ jsxRuntime.jsx(PluginTags, { plugin }),
                      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "plugin-card-meta", children: ((_a = plugin.provides) == null ? void 0 : _a.length) ? sdk.T("提供 ", "Provides ") + plugin.provides.length + sdk.T(" 项能力", " capabilities") : "" })
                    ] })
                  ] }) }, plugin.name);
                }) })
              ] }, key);
            }) }),
            !shown.length && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "plugin-empty", children: working ? sdk.T("加载中...", "Loading...") : (config == null ? void 0 : config.items.length) ? sdk.T("没有符合条件的插件", "No matching plugins") : sdk.T("没有发现可管理的插件", "No manageable plugins found") })
          ] }),
          selected && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "plugin-detail", children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { ref: back, type: "button", className: "secondary plugin-back", disabled: working, onClick: toGrid, children: sdk.T("← 全部插件", "← All plugins") }),
            /* @__PURE__ */ jsxRuntime.jsx(PluginDetails, { plugin: selected, busy: working || changing, running: state.running, error, onChange: change }, selected.name + ":" + (config == null ? void 0 : config.revision))
          ] })
        ] })
      ] })
    ] });
  }
  sdk.defineReact("web-plugins", PluginManager);
  exports.PluginManager = PluginManager;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
