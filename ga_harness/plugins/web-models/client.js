var GAHPlugin_web_models = (function(exports, jsxRuntime, react, sdk, reactDom) {
  "use strict";
  const providerId = (model) => model.provider_id || model.provider || "__standalone";
  function ModelPicker({ api }) {
    const { state } = sdk.useHost(), { busy, run } = sdk.useOperation(api);
    const [open, setOpen] = react.useState(false), [query, setQuery] = react.useState(""), [provider, setProvider] = react.useState("");
    const trigger = react.useRef(null), popup = react.useRef(null), search = react.useRef(null);
    const catalog = state.models, effort = state.effort;
    const current = catalog == null ? void 0 : catalog.items.find((item) => item.id === catalog.current);
    const groups = /* @__PURE__ */ new Map();
    for (const item of (catalog == null ? void 0 : catalog.items) || []) {
      const id = providerId(item), group = groups.get(id) || { name: item.provider || sdk.T("独立配置", "Standalone"), count: 0 };
      group.count++;
      groups.set(id, group);
    }
    const filter = groups.has(provider) ? provider : "";
    const items = (catalog == null ? void 0 : catalog.items.filter((item) => (!filter || filter === providerId(item)) && sdk.matches(query, item.name, item.model, item.provider))) || [];
    const close = (focus = false) => {
      var _a;
      setOpen(false);
      if (focus) (_a = trigger.current) == null ? void 0 : _a.focus();
    };
    react.useEffect(() => {
      if (busy || !catalog) setOpen(false);
    }, [busy, catalog]);
    react.useLayoutEffect(() => {
      var _a;
      if (!open || !popup.current) return;
      const node = popup.current;
      const position = () => {
        var _a2;
        const rect = (_a2 = trigger.current) == null ? void 0 : _a2.getBoundingClientRect();
        if (!rect) return;
        const w = node.offsetWidth, h = node.offsetHeight;
        node.style.left = Math.max(12, Math.min(rect.right - w, window.innerWidth - w - 12)) + "px";
        node.style.top = Math.max(12, Math.min(rect.top - h - 8, window.innerHeight - h - 12)) + "px";
      };
      node.showPopover();
      position();
      (_a = search.current) == null ? void 0 : _a.focus();
      window.addEventListener("resize", position);
      return () => {
        window.removeEventListener("resize", position);
        if (node.matches(":popover-open")) node.hidePopover();
      };
    }, [open]);
    const select = (path, body) => {
      close(true);
      void run(async () => api.setState(await api.host.post(path, body)));
    };
    if (!catalog) return null;
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "composer", children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-models", children: /* @__PURE__ */ jsxRuntime.jsxs("button", { ref: trigger, type: "button", className: "gah-model-trigger", disabled: busy, "aria-haspopup": "dialog", "aria-controls": "gah-model-picker", "aria-expanded": open, onClick: () => {
        setQuery("");
        setProvider("");
        setOpen((value) => !value);
      }, children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-model-name", children: (current == null ? void 0 : current.name) || (current == null ? void 0 : current.model) || sdk.T("选择模型", "Choose model") }),
        effort && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-model-effort", children: effort.current || "default" }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-model-caret", "aria-hidden": "true", children: "⌃" })
      ] }) }) }),
      open && reactDom.createPortal(/* @__PURE__ */ jsxRuntime.jsxs("div", { ref: popup, popover: "auto", role: "dialog", "aria-label": sdk.T("模型与思考强度", "Model and reasoning effort"), id: "gah-model-picker", className: "gah-model-popover", onToggle: (event) => {
        if (event.newState === "closed") setOpen(false);
      }, onKeyDown: (event) => {
        if (event.key === "Escape") close(true);
      }, children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-picker-toolbar", children: [
          /* @__PURE__ */ jsxRuntime.jsx("input", { ref: search, type: "search", className: "gah-picker-search", value: query, placeholder: sdk.T("搜索模型或服务商", "Search models or providers"), "aria-label": sdk.T("搜索模型或服务商", "Search models or providers"), onChange: (event) => setQuery(event.target.value) }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-picker-filters", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("select", { className: "gah-picker-filter", value: filter, "aria-label": sdk.T("筛选服务商", "Filter providers"), onChange: (event) => setProvider(event.target.value), children: [
              /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("全部服务商", "All providers") }),
              [...groups].map(([id, group]) => /* @__PURE__ */ jsxRuntime.jsxs("option", { value: id, children: [
                group.name,
                " (",
                group.count,
                ")"
              ] }, id))
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-picker-count", children: [
              items.length,
              " / ",
              catalog.items.length
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-picker-models", children: [
          items.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "gah-picker-option", "data-model-id": item.id, "aria-pressed": item.id === catalog.current, disabled: busy, onClick: () => select("/api/models/select", { id: item.id }), children: [
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "gah-picker-option-copy", children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.name || item.model }),
              /* @__PURE__ */ jsxRuntime.jsx("small", { children: [item.provider || sdk.T("独立配置", "Standalone"), item.name && item.model !== item.name ? item.model : ""].filter(Boolean).join(" · ") })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-picker-check", "aria-hidden": "true", children: item.id === catalog.current ? "✓" : "" })
          ] }, item.id)),
          !items.length && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "gah-picker-empty", children: sdk.T("没有匹配的模型", "No matching models") })
        ] }),
        effort && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-picker-effort", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-picker-label", children: [
            sdk.T("推理强度", "Reasoning effort"),
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("仅当前对话", "This chat only") })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-effort-options", role: "group", "aria-label": sdk.T("推理强度", "Reasoning effort"), children: ["", ...effort.options].map((option) => /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", "aria-pressed": option === (effort.current || ""), disabled: busy, onClick: () => select("/api/effort", { value: option }), children: option || "default" }, option)) })
        ] })
      ] }), document.body)
    ] });
  }
  function Field({ label, wide, children }) {
    return /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "model-field" + (wide ? " wide" : ""), children: [
      label,
      children
    ] });
  }
  function Credentials({ base, secret, hasKey, hiddenURL, disabled, onBase, onSecret }) {
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: "API Base URL", wide: true, children: [
        /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, disabled, value: base, autoComplete: "off", onChange: (e) => onBase(e.target.value) }),
        /* @__PURE__ */ jsxRuntime.jsx("small", { children: hiddenURL ? sdk.T("原 URL 含敏感信息已隐藏，请重新填写。", "The original URL contained sensitive data and is hidden. Enter it again.") : sdk.T("支持 ${ENV_NAME} 环境变量引用。", "Supports ${ENV_NAME} environment variable references.") })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: "API Key", wide: true, children: [
        /* @__PURE__ */ jsxRuntime.jsx("input", { type: "password", autoComplete: "new-password", required: !hasKey, disabled, value: secret, placeholder: hasKey ? "******" : "", onChange: (e) => onSecret(e.target.value) }),
        /* @__PURE__ */ jsxRuntime.jsx("small", { children: hasKey ? sdk.T("留空保留原密钥或环境变量引用。", "Leave empty to keep the existing key or environment variable reference.") : sdk.T("填写密钥或 ${ENV_NAME}。", "Enter a key or ${ENV_NAME}.") })
      ] })
    ] });
  }
  function Protocol({ value, disabled, onChange }) {
    return /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("协议", "Protocol"), children: /* @__PURE__ */ jsxRuntime.jsxs("select", { value, disabled, onChange: (e) => onChange(e.target.value), children: [
      /* @__PURE__ */ jsxRuntime.jsx("option", { value: "oai", children: "OpenAI compatible" }),
      /* @__PURE__ */ jsxRuntime.jsx("option", { value: "claude", children: "Anthropic Claude" })
    ] }) });
  }
  function ModelForm({ entry, config, initialProvider = "", disabled, onSave }) {
    const [protocol, setProtocol] = react.useState((entry == null ? void 0 : entry.protocol) || "oai");
    const [id, setId] = react.useState((entry == null ? void 0 : entry.key) || "native_oai_config_" + Date.now());
    const [provider, setProvider] = react.useState((entry == null ? void 0 : entry.provider) || initialProvider);
    const [name, setName] = react.useState((entry == null ? void 0 : entry.values.name) || ""), [model, setModel] = react.useState((entry == null ? void 0 : entry.values.model) || "");
    const [base, setBase] = react.useState((entry == null ? void 0 : entry.values.apibase) || ""), [secret, setSecret] = react.useState("");
    const [context, setContext] = react.useState(String((entry == null ? void 0 : entry.values.context_win) ?? ""));
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "model-form", onSubmit: (event) => {
      event.preventDefault();
      if (disabled) return;
      const values = provider ? { name: name.trim(), model: model.trim(), provider } : { name: name.trim(), model: model.trim(), apibase: base.trim(), apikey: secret };
      if (context) values.context_win = Number(context);
      onSave("save", id.trim(), values);
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsx("h3", { children: entry ? sdk.T("模型详情", "Model details") : sdk.T("新增模型", "Add model") }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-grid", children: [
        /* @__PURE__ */ jsxRuntime.jsx(Protocol, { value: protocol, disabled: disabled || !!entry, onChange: (value) => {
          setProtocol(value);
          setId("native_" + value + "_config_" + Date.now());
        } }),
        /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("配置标识", "Config key"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, value: id, disabled: disabled || !!entry, onChange: (event) => setId(event.target.value) }) }),
        /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T("服务商", "Provider"), wide: true, children: [
          /* @__PURE__ */ jsxRuntime.jsxs("select", { disabled, value: provider, onChange: (event) => setProvider(event.target.value), children: [
            /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("独立配置", "Standalone") }),
            config.providers.map((item) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: item.id, children: item.values.name || item.id }, item.id))
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("协议属于模型，服务商共享 URL 和密钥。", "Protocol belongs to the model; providers share the URL and key.") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("显示名称", "Display name"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { value: name, disabled, onChange: (event) => setName(event.target.value) }) }),
        /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("模型名", "Model name"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, value: model, disabled, onChange: (event) => setModel(event.target.value) }) }),
        /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("上下文窗口", "Context window"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { type: "number", min: 1, step: 1, value: context, disabled, onChange: (event) => setContext(event.target.value) }) }),
        !provider && /* @__PURE__ */ jsxRuntime.jsx(Credentials, { base, secret, hasKey: entry == null ? void 0 : entry.has_key, hiddenURL: entry == null ? void 0 : entry.url_hidden, disabled, onBase: setBase, onSecret: setSecret })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-actions", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", disabled, children: sdk.T("保存并生效", "Save and apply") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "danger", disabled: disabled || !entry, onClick: async () => {
          if (await sdk.confirmDialog({ title: sdk.T("删除这个模型？", "Delete this model?"), danger: true, confirm: sdk.T("删除", "Delete") })) onSave("delete", id);
        }, children: sdk.T("删除", "Delete") })
      ] })
    ] });
  }
  function ProviderForm({ entry, used, disabled, onSave }) {
    const [id, setId] = react.useState((entry == null ? void 0 : entry.id) || ""), [name, setName] = react.useState((entry == null ? void 0 : entry.values.name) || "");
    const [protocol, setProtocol] = react.useState((entry == null ? void 0 : entry.values.protocol) || "oai");
    const [base, setBase] = react.useState((entry == null ? void 0 : entry.values.apibase) || ""), [secret, setSecret] = react.useState("");
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "model-provider-form", onSubmit: (event) => {
      event.preventDefault();
      if (!disabled) onSave("provider_save", id.trim(), { name: name.trim(), protocol, apibase: base.trim(), apikey: secret });
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-grid", children: [
        /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("服务商标识", "Provider ID"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, pattern: "[a-z0-9_-]+", disabled: disabled || !!entry, value: id, onChange: (event) => setId(event.target.value), autoFocus: !entry }) }),
        /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("显示名称", "Display name"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { disabled, value: name, onChange: (event) => setName(event.target.value) }) }),
        /* @__PURE__ */ jsxRuntime.jsx(Protocol, { value: protocol, disabled, onChange: setProtocol }),
        /* @__PURE__ */ jsxRuntime.jsx(Credentials, { base, secret, hasKey: entry == null ? void 0 : entry.has_key, hiddenURL: entry == null ? void 0 : entry.url_hidden, disabled, onBase: setBase, onSecret: setSecret })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help", children: used ? sdk.T("仍有模型引用此服务商，不能删除。", "This provider is still used by models and cannot be deleted.") : sdk.T("默认协议仅用于新模型，不会改变已有模型。", "The default protocol is for new models and does not change existing models.") }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-actions", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", disabled, children: sdk.T("保存并生效", "Save and apply") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "danger", disabled: disabled || !entry || used > 0, onClick: async () => {
          if (await sdk.confirmDialog({ title: sdk.T("删除这个服务商？", "Delete this provider?"), danger: true, confirm: sdk.T("删除", "Delete") })) onSave("provider_delete", id);
        }, children: sdk.T("删除", "Delete") })
      ] })
    ] });
  }
  const sectionKey = (entry) => entry.provider ? "provider:" + entry.provider : "legacy:" + JSON.stringify([entry.protocol, entry.values.apibase || (entry.url_hidden ? entry.key : "")]);
  function endpoint(value) {
    try {
      const url = new URL(value || "");
      return url.host + url.pathname.replace(/\/$/, "");
    } catch {
      return value || sdk.T("未设置 API 地址", "No API URL set");
    }
  }
  function sections(config) {
    const groups = /* @__PURE__ */ new Map();
    for (const provider of config.providers || []) groups.set("provider:" + provider.id, {
      id: "provider:" + provider.id,
      title: provider.values.name || provider.id,
      provider,
      entries: []
    });
    for (const entry of config.entries) {
      const id = sectionKey(entry);
      if (!groups.has(id)) groups.set(id, { id, title: endpoint(entry.values.apibase) + " / " + entry.protocol, entries: [] });
      groups.get(id).entries.push(entry);
    }
    return [...groups.values()];
  }
  function readonlyText(config) {
    var _a;
    return (config.reason || sdk.T("当前配置只读", "This configuration is read-only")) + (((_a = config.convert) == null ? void 0 : _a.blocked) ? "\n" + config.convert.target + sdk.T(" 已存在，不会覆盖。", " already exists and will not be overwritten.") : "");
  }
  function Models({ api }) {
    var _a;
    const { state } = sdk.useHost(), { busy, working, run } = sdk.useOperation(api);
    const [open, setOpen] = react.useState(false), [config, setConfig] = react.useState(null), [error, setError] = react.useState("");
    const [query, setQuery] = react.useState(""), [section, setSection] = react.useState("");
    const [edit, setEdit] = react.useState({ kind: "model", serial: 0 });
    const groups = config ? sections(config) : [], group = groups.find((item) => item.id === section);
    const entries = ((group == null ? void 0 : group.entries) || (config == null ? void 0 : config.entries) || []).filter((item) => sdk.matches(query, item.key, item.values.name, item.values.model, item.values.apibase));
    const entry = config == null ? void 0 : config.entries.find((item) => item.key === edit.id), provider = config == null ? void 0 : config.providers.find((item) => item.id === edit.id);
    const choose = (kind, id) => {
      setError("");
      setEdit((old) => ({ kind, id, serial: old.serial + 1 }));
    };
    const filter = (id) => {
      var _a2, _b;
      setSection(id);
      const items = ((_a2 = groups.find((item) => item.id === id)) == null ? void 0 : _a2.entries) || (config == null ? void 0 : config.entries) || [];
      choose("model", (_b = items.find((item) => sdk.matches(query, item.key, item.values.name, item.values.model, item.values.apibase))) == null ? void 0 : _b.key);
    };
    async function load() {
      if (busy) return;
      setOpen(true);
      setConfig(null);
      setError("");
      setQuery("");
      setSection("");
      await run(async () => {
        var _a2;
        const next = await api.host.get("/api/models/config");
        setConfig(next);
        choose("model", (_a2 = next.entries[0]) == null ? void 0 : _a2.key);
      }, setError);
    }
    const change = (action, id, values) => {
      if (!(config == null ? void 0 : config.writable) || busy) return;
      setError("");
      void run(async () => {
        var _a2;
        const next = await api.host.post("/api/models/config", { action, revision: config.revision, [action.startsWith("provider_") ? "id" : "key"]: id, ...values ? { values } : {} });
        setConfig(next.config);
        api.setState(next.state);
        const saved = next.config.entries.find((item) => item.key === id);
        const nextSection = action === "provider_save" ? "provider:" + id : saved && section ? sectionKey(saved) : section;
        setSection(sections(next.config).some((item) => item.id === nextSection) ? nextSection : "");
        setQuery("");
        choose("model", (saved == null ? void 0 : saved.key) || ((_a2 = next.config.entries.find((item) => !nextSection || sectionKey(item) === nextSection)) == null ? void 0 : _a2.key));
        api.notice(sdk.T("配置已保存并生效", "Configuration saved and applied"));
      }, setError);
    };
    const convert = () => {
      if (!(config == null ? void 0 : config.convert) || config.convert.blocked) return;
      setError("");
      void run(async () => {
        var _a2;
        const next = await api.host.post("/api/models/config", { action: "convert" });
        setConfig(next.config);
        api.setState(next.state);
        setSection("");
        choose("model", (_a2 = next.config.entries[0]) == null ? void 0 : _a2.key);
        api.notice(sdk.T("已转换为可编辑配置", "Converted to an editable configuration"));
      }, setError);
    };
    const locked = busy || !(config == null ? void 0 : config.writable);
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(ModelPicker, { api }),
      state.models && /* @__PURE__ */ jsxRuntime.jsx(sdk.PluginSlot, { api, name: "sidebar-foot", children: /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "side-item", disabled: busy, onClick: () => void load(), children: [
        /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "cpu" }),
        sdk.T("模型配置", "Models")
      ] }) }),
      open && /* @__PURE__ */ jsxRuntime.jsxs(sdk.Modal, { className: "gah-model-dialog", label: sdk.T("模型配置", "Models"), busy: working, onClose: () => setOpen(false), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-head", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h2", { children: sdk.T("模型配置", "Models") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: working, onClick: () => setOpen(false), children: sdk.T("关闭", "Close") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-content", children: [
          error && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-error", role: "alert", children: error }),
          !config && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help", children: working ? sdk.T("加载中...", "Loading...") : sdk.T("加载失败", "Unable to load configuration") }),
          config && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
            !config.writable && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help", children: readonlyText(config) }),
            config.convert && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-convert", children: [
              /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help", children: config.convert.target }),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: busy || config.convert.blocked, onClick: convert, children: sdk.T("转换为可编辑配置", "Convert to editable configuration") })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-layout", children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-browser-tools", children: [
                /* @__PURE__ */ jsxRuntime.jsx("input", { type: "search", className: "model-search", value: query, disabled: busy, placeholder: sdk.T("搜索模型", "Search models"), "aria-label": sdk.T("搜索模型", "Search models"), onChange: (event) => setQuery(event.target.value) }),
                /* @__PURE__ */ jsxRuntime.jsxs("select", { className: "model-provider-filter", "aria-label": sdk.T("服务商筛选", "Filter by provider"), value: section, disabled: busy, onChange: (event) => filter(event.target.value), children: [
                  /* @__PURE__ */ jsxRuntime.jsxs("option", { value: "", children: [
                    sdk.T("全部模型", "All models"),
                    " (",
                    config.entries.length,
                    ")"
                  ] }),
                  groups.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("option", { value: item.id, children: [
                    item.title,
                    " (",
                    item.entries.length,
                    ")"
                  ] }, item.id))
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: locked, onClick: () => choose("provider"), children: sdk.T("新增服务商", "Add provider") })
              ] }),
              /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "model-section-body", children: [
                /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-section-head", children: [
                  /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-section-heading", children: [
                    /* @__PURE__ */ jsxRuntime.jsx("h3", { children: (group == null ? void 0 : group.title) || sdk.T("全部模型", "All models") }),
                    /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "model-help", children: [
                      entries.length,
                      " / ",
                      config.entries.length
                    ] })
                  ] }),
                  /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-section-actions", children: [
                    (group == null ? void 0 : group.provider) && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: busy, onClick: () => choose("provider", group.provider.id), children: sdk.T("编辑服务商", "Edit provider") }),
                    /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: locked, onClick: () => choose("model"), children: sdk.T("新增模型", "Add model") })
                  ] })
                ] }),
                /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-area", children: [
                  /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-list", "aria-label": sdk.T("模型列表", "Model list"), children: [
                    entries.map((item) => {
                      var _a2;
                      return /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "model-list-item", disabled: busy, "aria-pressed": edit.kind === "model" && edit.id === item.key, onClick: () => choose("model", item.key), children: [
                        /* @__PURE__ */ jsxRuntime.jsx("strong", { children: item.values.name || item.values.model || item.key }),
                        /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
                          item.values.model || item.key,
                          " · ",
                          (_a2 = groups.find((candidate) => candidate.id === sectionKey(item))) == null ? void 0 : _a2.title
                        ] })
                      ] }, item.key);
                    }),
                    !entries.length && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-empty", children: sdk.T("没有匹配的模型", "No matching models") })
                  ] }),
                  /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-editor", children: edit.kind === "provider" ? /* @__PURE__ */ jsxRuntime.jsx(ProviderForm, { entry: provider, used: provider ? config.entries.filter((item) => item.provider === provider.id).length : 0, disabled: locked, onSave: change }, edit.serial) : /* @__PURE__ */ jsxRuntime.jsx(ModelForm, { entry, config, initialProvider: (_a = group == null ? void 0 : group.provider) == null ? void 0 : _a.id, disabled: locked, onSave: change }, edit.serial) })
                ] })
              ] })
            ] })
          ] })
        ] })
      ] })
    ] });
  }
  sdk.defineReact("web-models", Models);
  exports.Models = Models;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH, GAH.ReactDOM);
