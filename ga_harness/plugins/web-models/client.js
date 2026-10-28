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
    return config.reason || sdk.T("当前配置只读", "This configuration is read-only");
  }
  function Field({ label, wide, children }) {
    return /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "model-field" + (wide ? " wide" : ""), children: [
      label,
      children
    ] });
  }
  function useDraft(value, onDirtyChange) {
    const initial = react.useRef(JSON.stringify(value));
    const dirty = initial.current !== JSON.stringify(value);
    react.useLayoutEffect(() => {
      onDirtyChange(dirty);
    }, [dirty, onDirtyChange]);
    react.useLayoutEffect(() => () => {
      onDirtyChange(false);
    }, [onDirtyChange]);
    return dirty;
  }
  function Credentials({ base, secret, hasKey, hiddenURL, disabled, onBase, onSecret }) {
    const [show, setShow] = react.useState(false);
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: "API Base URL", wide: true, children: [
        /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, disabled, value: base, autoComplete: "off", spellCheck: false, placeholder: "https://api.example.com/v1", onChange: (event) => onBase(event.target.value) }),
        hiddenURL && /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("原 URL 含敏感信息已隐藏，请重新填写。", "The original URL contained sensitive data and is hidden. Enter it again.") })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-field wide", children: [
        /* @__PURE__ */ jsxRuntime.jsx("label", { htmlFor: "model-api-key", children: "API Key" }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-secret-input", children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              id: "model-api-key",
              type: show ? "text" : "password",
              autoComplete: "new-password",
              spellCheck: false,
              required: !hasKey,
              disabled,
              value: secret,
              placeholder: hasKey ? sdk.T("已配置，留空不修改", "Configured; leave empty to keep") : sdk.T("密钥或 ${ENV_NAME}", "API key or ${ENV_NAME}"),
              onChange: (event) => onSecret(event.target.value)
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled, "aria-pressed": show, onClick: () => setShow(!show), children: show ? sdk.T("隐藏", "Hide") : sdk.T("显示", "Show") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("支持 ${ENV_NAME}；已保存的密钥不会回显。", "Supports ${ENV_NAME}; stored keys are never displayed.") })
      ] })
    ] });
  }
  function Protocol({ value, disabled, onChange }) {
    return /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("接口协议", "Protocol"), children: /* @__PURE__ */ jsxRuntime.jsxs("select", { value, disabled, onChange: (event) => onChange(event.target.value), children: [
      /* @__PURE__ */ jsxRuntime.jsx("option", { value: "oai", children: "OpenAI compatible" }),
      /* @__PURE__ */ jsxRuntime.jsx("option", { value: "claude", children: "Anthropic Claude" })
    ] }) });
  }
  function FormActions({ dirty, existing, disabled, canDelete = true, onReset, onDelete }) {
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-actions", children: [
      existing && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "danger model-delete", disabled: disabled || !canDelete, onClick: onDelete, children: sdk.T("删除", "Delete") }),
      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "model-draft-state", role: "status", children: dirty ? sdk.T("有未保存的更改", "Unsaved changes") : "" }),
      /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: disabled || !dirty, onClick: onReset, children: sdk.T("撤销更改", "Reset changes") }),
      /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", disabled: disabled || existing && !dirty, children: sdk.T("保存并生效", "Save and apply") })
    ] });
  }
  function ModelForm({ entry, config, initialProvider = "", disabled, onSave, onDirtyChange, onReset, onProvider }) {
    var _a;
    const defaultProtocol = ((_a = config.providers.find((item) => item.id === initialProvider)) == null ? void 0 : _a.values.protocol) || "oai";
    const [protocol, setProtocol] = react.useState((entry == null ? void 0 : entry.protocol) || defaultProtocol);
    const [id, setId] = react.useState((entry == null ? void 0 : entry.key) || "native_" + protocol + "_config_" + Date.now());
    const [provider, setProvider] = react.useState(entry ? entry.provider || "" : initialProvider);
    const [name, setName] = react.useState((entry == null ? void 0 : entry.values.name) || ""), [model, setModel] = react.useState((entry == null ? void 0 : entry.values.model) || "");
    const [base, setBase] = react.useState((entry == null ? void 0 : entry.values.apibase) || ""), [secret, setSecret] = react.useState("");
    const [context, setContext] = react.useState(String((entry == null ? void 0 : entry.values.context_win) ?? ""));
    const shared = config.providers.find((item) => item.id === provider);
    const dirty = useDraft([protocol, id, provider, name, model, base, secret, context], onDirtyChange);
    const changeProtocol = (value) => {
      setProtocol(value);
      setId("native_" + value + "_config_" + Date.now());
    };
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "model-form", onInvalidCapture: (event) => {
      var _a2;
      return (_a2 = event.target.closest("details")) == null ? void 0 : _a2.setAttribute("open", "");
    }, onSubmit: (event) => {
      event.preventDefault();
      if (disabled) return;
      const values = provider ? { name: name.trim(), model: model.trim(), provider } : { name: name.trim(), model: model.trim(), provider: "", apibase: base.trim(), apikey: secret };
      if (context) values.context_win = Number(context);
      onSave("save", id.trim(), values);
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-form-content", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-grid", children: [
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("模型 ID", "Model ID"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, value: model, disabled, autoFocus: !entry, placeholder: "gpt-4.1 / claude-sonnet-4", spellCheck: false, onChange: (event) => setModel(event.target.value) }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("显示名称", "Display name"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { value: name, disabled, maxLength: 120, placeholder: sdk.T("可选，默认使用模型 ID", "Optional; defaults to model ID"), onChange: (event) => setName(event.target.value) }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("服务商", "Provider"), children: /* @__PURE__ */ jsxRuntime.jsxs("select", { value: provider, disabled, onChange: (event) => {
            var _a2;
            const value = event.target.value;
            setProvider(value);
            if (!entry && value) changeProtocol(((_a2 = config.providers.find((item) => item.id === value)) == null ? void 0 : _a2.values.protocol) || "oai");
          }, children: [
            /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("独立配置", "Independent configuration") }),
            config.providers.map((item) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: item.id, children: item.values.name || item.id }, item.id))
          ] }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Protocol, { value: protocol, disabled: disabled || !!entry, onChange: changeProtocol }),
          shared ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-connection wide", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
              /* @__PURE__ */ jsxRuntime.jsx("strong", { children: shared.values.name || shared.id }),
              /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
                endpoint(shared.values.apibase) || sdk.T("地址已隐藏", "URL hidden"),
                " · ",
                shared.has_key ? sdk.T("密钥已配置", "Key configured") : sdk.T("未配置密钥", "No key")
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled, onClick: () => onProvider(shared.id), children: sdk.T("编辑服务商", "Edit provider") }),
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("地址和密钥由服务商统一管理，协议仍属于此模型。", "The provider manages the URL and key; this model keeps its own protocol.") })
          ] }) : /* @__PURE__ */ jsxRuntime.jsx(Credentials, { base, secret, hasKey: entry == null ? void 0 : entry.has_key, hiddenURL: entry == null ? void 0 : entry.url_hidden, disabled, onBase: setBase, onSecret: setSecret })
        ] }),
        !shared && /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "model-help", children: [
          sdk.T("多个模型共用地址和密钥？", "Sharing a URL and key across models?"),
          " ",
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "model-text-button", disabled, onClick: () => onProvider(""), children: sdk.T("去管理服务商", "Manage providers") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "model-advanced", children: [
          /* @__PURE__ */ jsxRuntime.jsx("summary", { children: sdk.T("高级设置", "Advanced settings") }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-grid", children: [
            /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T("上下文窗口", "Context window"), children: [
              /* @__PURE__ */ jsxRuntime.jsx("input", { type: "number", min: 1024, step: 1, value: context, disabled, placeholder: sdk.T("默认", "Default"), onChange: (event) => setContext(event.target.value) }),
              /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("留空沿用现有值或默认值。", "Leave empty to keep the existing value or default.") })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T("配置标识", "Config key"), children: [
              /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, value: id, readOnly: !!entry, disabled, spellCheck: false, onChange: (event) => setId(event.target.value) }),
              /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("内部标识，通常无需修改。", "Internal identifier; usually no changes are needed.") })
            ] })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(FormActions, { dirty, existing: !!entry, disabled, onReset, onDelete: async () => {
        if (await sdk.confirmDialog({ title: sdk.T("删除这个模型？", "Delete this model?"), message: (entry == null ? void 0 : entry.values.name) || (entry == null ? void 0 : entry.values.model) || id, danger: true, confirm: sdk.T("删除", "Delete") })) onSave("delete", id);
      } })
    ] });
  }
  function ProviderForm({ entry, used, disabled, onSave, onDirtyChange, onReset, onModels }) {
    const [id, setId] = react.useState((entry == null ? void 0 : entry.id) || ""), [name, setName] = react.useState((entry == null ? void 0 : entry.values.name) || "");
    const [protocol, setProtocol] = react.useState((entry == null ? void 0 : entry.values.protocol) || "oai");
    const [base, setBase] = react.useState((entry == null ? void 0 : entry.values.apibase) || ""), [secret, setSecret] = react.useState("");
    const dirty = useDraft([id, name, protocol, base, secret], onDirtyChange);
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "model-provider-form", onSubmit: (event) => {
      event.preventDefault();
      if (!disabled) onSave("provider_save", id.trim(), { name: name.trim(), protocol, apibase: base.trim(), apikey: secret });
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-form-content", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-grid", children: [
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("显示名称", "Display name"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { disabled, value: name, maxLength: 120, placeholder: sdk.T("例如 OpenAI", "For example, OpenAI"), onChange: (event) => setName(event.target.value), autoFocus: !entry }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("服务商标识", "Provider ID"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, pattern: "[a-z0-9_-]+", disabled: disabled || !!entry, value: id, placeholder: "openai", spellCheck: false, onChange: (event) => setId(event.target.value) }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Protocol, { value: protocol, disabled, onChange: setProtocol }),
          /* @__PURE__ */ jsxRuntime.jsx(Credentials, { base, secret, hasKey: entry == null ? void 0 : entry.has_key, hiddenURL: entry == null ? void 0 : entry.url_hidden, disabled, onBase: setBase, onSecret: setSecret })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help", children: sdk.T("地址和密钥会同步到引用此服务商的模型；默认协议只用于新模型。", "URL and key updates apply to models using this provider; the default protocol is only for new models.") }),
        entry && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-provider-usage", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "secondary", disabled, onClick: onModels, children: [
            sdk.T("查看模型", "View models"),
            " (",
            used,
            ")"
          ] }),
          used > 0 && /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("有模型引用时不能删除服务商", "Providers in use cannot be deleted") })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(FormActions, { dirty, existing: !!entry, disabled, canDelete: used === 0, onReset, onDelete: async () => {
        if (await sdk.confirmDialog({ title: sdk.T("删除这个服务商？", "Delete this provider?"), message: (entry == null ? void 0 : entry.values.name) || id, danger: true, confirm: sdk.T("删除", "Delete") })) onSave("provider_delete", id);
      } })
    ] });
  }
  function Models({ api }) {
    var _a, _b;
    const { state, changing } = sdk.useHost(), { busy, working, run } = sdk.useOperation(api);
    const [config, setConfig] = react.useState(null), [error, setError] = react.useState("");
    const [query, setQuery] = react.useState(""), [section, setSection] = react.useState("");
    const [edit, setEdit] = react.useState({ kind: "model", serial: 0 }), [detail, setDetail] = react.useState(false);
    const draft = react.useRef(false), blocked = react.useRef(false), leaving = react.useRef(false), alive = react.useRef(true);
    const heading = react.useRef(null);
    const onDirtyChange = react.useCallback((value) => {
      draft.current = value;
    }, []);
    react.useLayoutEffect(() => {
      blocked.current = working || changing;
    }, [working, changing]);
    react.useEffect(() => {
      alive.current = true;
      const beforeUnload = (event) => {
        if (draft.current) {
          event.preventDefault();
          event.returnValue = "";
        }
      };
      window.addEventListener("beforeunload", beforeUnload);
      return () => {
        alive.current = false;
        window.removeEventListener("beforeunload", beforeUnload);
      };
    }, []);
    react.useLayoutEffect(() => {
      var _a2;
      if (detail && window.matchMedia("(max-width: 700px)").matches) (_a2 = heading.current) == null ? void 0 : _a2.focus();
    }, [detail, edit.serial]);
    const canLeave = react.useCallback(async () => {
      if (blocked.current || leaving.current) return false;
      if (!draft.current) return true;
      leaving.current = true;
      try {
        return await sdk.confirmDialog({
          title: sdk.T("放弃未保存的更改？", "Discard unsaved changes?"),
          message: sdk.T("当前输入还没有保存。", "Your current edits have not been saved."),
          confirm: sdk.T("放弃更改", "Discard changes"),
          cancel: sdk.T("继续编辑", "Keep editing"),
          danger: true
        });
      } finally {
        leaving.current = false;
      }
    }, []);
    const navigate = async (change2) => {
      if (await canLeave() && alive.current) change2();
    };
    const groups = config ? sections(config) : [], group = groups.find((item) => item.id === section);
    const entries = ((group == null ? void 0 : group.entries) || (config == null ? void 0 : config.entries) || []).filter((item) => sdk.matches(query, item.key, item.values.name, item.values.model, item.values.apibase));
    const providers = ((config == null ? void 0 : config.providers) || []).filter((item) => sdk.matches(query, item.id, item.values.name, item.values.apibase));
    const entry = config == null ? void 0 : config.entries.find((item) => item.key === edit.id), provider = config == null ? void 0 : config.providers.find((item) => item.id === edit.id);
    const select = (kind, id, showDetail = true) => {
      draft.current = false;
      setError("");
      setDetail(showDetail);
      setEdit((old) => ({ kind, id, serial: old.serial + 1 }));
    };
    const choose = (kind, id) => {
      void navigate(() => select(kind, id));
    };
    const switchView = (kind) => {
      if (kind === edit.kind) return;
      void navigate(() => {
        var _a2, _b2;
        setQuery("");
        setSection("");
        select(kind, kind === "model" ? (_a2 = config == null ? void 0 : config.entries[0]) == null ? void 0 : _a2.key : (_b2 = config == null ? void 0 : config.providers[0]) == null ? void 0 : _b2.id, false);
      });
    };
    const filter = (id) => {
      void navigate(() => {
        var _a2, _b2;
        setSection(id);
        const items = ((_a2 = groups.find((item) => item.id === id)) == null ? void 0 : _a2.entries) || (config == null ? void 0 : config.entries) || [];
        select("model", (_b2 = items.find((item) => sdk.matches(query, item.key, item.values.name, item.values.model, item.values.apibase))) == null ? void 0 : _b2.key, false);
      });
    };
    const openProvider = (id) => {
      void navigate(() => {
        var _a2;
        setQuery("");
        setSection("");
        select("provider", id || ((_a2 = config == null ? void 0 : config.providers[0]) == null ? void 0 : _a2.id));
      });
    };
    const viewModels = () => {
      if (!provider) return;
      void navigate(() => {
        var _a2;
        setQuery("");
        setSection("provider:" + provider.id);
        select("model", (_a2 = config == null ? void 0 : config.entries.find((item) => item.provider === provider.id)) == null ? void 0 : _a2.key, false);
      });
    };
    async function load() {
      setConfig(null);
      setError("");
      setQuery("");
      setSection("");
      draft.current = false;
      await run(async () => {
        var _a2;
        const next = await api.host.get("/api/models/config");
        setConfig(next);
        select("model", (_a2 = next.entries[0]) == null ? void 0 : _a2.key, false);
      }, setError, true);
    }
    const change = (action, id, values) => {
      if (!(config == null ? void 0 : config.writable) || busy) return;
      setError("");
      void run(async () => {
        var _a2, _b2;
        const next = await api.host.post("/api/models/config", { action, revision: config.revision, [action.startsWith("provider_") ? "id" : "key"]: id, ...values ? { values } : {} });
        setConfig(next.config);
        api.setState(next.state);
        setQuery("");
        if (action.startsWith("provider_")) {
          setSection("");
          select("provider", action === "provider_save" ? id : (_a2 = next.config.providers[0]) == null ? void 0 : _a2.id, action === "provider_save");
        } else {
          const saved = next.config.entries.find((item) => item.key === id);
          const candidate = saved && section ? sectionKey(saved) : section;
          const nextSection = sections(next.config).some((item) => item.id === candidate) ? candidate : "";
          setSection(nextSection);
          select("model", (saved == null ? void 0 : saved.key) || ((_b2 = next.config.entries.find((item) => !nextSection || sectionKey(item) === nextSection)) == null ? void 0 : _b2.key), !!saved);
        }
        api.notice(sdk.T("配置已保存并生效", "Configuration saved and applied"));
      }, setError);
    };
    const ungrouped = (config == null ? void 0 : config.entries.filter((item) => !item.provider).length) ?? 0;
    const autoGroup = async () => {
      if (!(config == null ? void 0 : config.writable) || busy || !ungrouped) return;
      if (!await sdk.confirmDialog({ title: sdk.T("按地址和密钥自动归组？", "Group models by URL and key?"), message: sdk.T("地址和密钥完全相同的未归组模型将合并为服务商，模型实际连接不变。", "Ungrouped models with an identical URL and key become providers. Model connections stay the same."), confirm: sdk.T("归组", "Group") })) return;
      setError("");
      void run(async () => {
        var _a2;
        const next = await api.host.post("/api/models/config", { action: "provider_group", revision: config.revision });
        setConfig(next.config);
        api.setState(next.state);
        setQuery("");
        setSection("");
        select("provider", (_a2 = next.config.providers[0]) == null ? void 0 : _a2.id, false);
        api.notice(sdk.T("已归组为 ", "Grouped into ") + next.config.providers.length + sdk.T(" 个服务商", " providers"));
      }, setError);
    };
    const locked = busy || !(config == null ? void 0 : config.writable), browsing = working || changing;
    const isModel = edit.kind === "model";
    const title = isModel ? (entry == null ? void 0 : entry.values.name) || (entry == null ? void 0 : entry.values.model) || (entry == null ? void 0 : entry.key) : (provider == null ? void 0 : provider.values.name) || (provider == null ? void 0 : provider.id);
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(ModelPicker, { api }),
      state.models && /* @__PURE__ */ jsxRuntime.jsx(sdk.SettingsPanel, { api, label: sdk.T("模型", "Models"), icon: "cpu", order: 10, className: "gah-model-dialog", onOpen: load, onBeforeLeave: canLeave, children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-content model-workspace" + (detail ? " is-detail" : ""), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-workspace-head", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-view-switch", role: "group", "aria-label": sdk.T("模型与服务商", "Models and providers"), children: [
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", "aria-pressed": isModel, disabled: browsing, onClick: () => switchView("model"), children: [
              sdk.T("模型", "Models"),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: (config == null ? void 0 : config.entries.length) ?? 0 })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", "aria-pressed": !isModel, disabled: browsing, onClick: () => switchView("provider"), children: [
              sdk.T("服务商", "Providers"),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: (config == null ? void 0 : config.providers.length) ?? 0 })
            ] })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary model-refresh", disabled: browsing, onClick: () => {
            void navigate(() => {
              void load();
            });
          }, children: sdk.T("刷新", "Refresh") })
        ] }),
        error && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-error", role: "alert", children: error }),
        !config && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-empty", role: "status", children: working ? sdk.T("加载中...", "Loading...") : sdk.T("加载失败，请重试刷新。", "Unable to load configuration. Try refreshing.") }),
        config && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          !config.writable && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-readonly", role: "status", children: /* @__PURE__ */ jsxRuntime.jsx("span", { children: readonlyText(config) }) }),
          state.running && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help model-running", children: sdk.T("任务运行中，可查看配置，结束后可编辑。", "A run is active. You can browse; editing is available when it finishes.") }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-layout" + (detail ? " is-detail" : ""), children: [
            /* @__PURE__ */ jsxRuntime.jsxs("aside", { className: "model-list-pane", children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-browser-tools", children: [
                /* @__PURE__ */ jsxRuntime.jsx("input", { className: "model-search", type: "search", value: query, disabled: browsing, placeholder: isModel ? sdk.T("搜索模型...", "Search models...") : sdk.T("搜索服务商...", "Search providers..."), "aria-label": isModel ? sdk.T("搜索模型", "Search models") : sdk.T("搜索服务商", "Search providers"), onChange: (event) => setQuery(event.target.value) }),
                isModel && /* @__PURE__ */ jsxRuntime.jsxs("select", { className: "model-provider-filter", value: section, disabled: browsing, "aria-label": sdk.T("按服务商筛选", "Filter by provider"), onChange: (event) => filter(event.target.value), children: [
                  /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("全部模型", "All models") }),
                  groups.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("option", { value: item.id, children: [
                    item.title,
                    " (",
                    item.entries.length,
                    ")"
                  ] }, item.id))
                ] }),
                !isModel && ungrouped > 0 && /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "secondary model-group", disabled: locked, title: sdk.T("按相同地址+密钥归组未归属模型", "Group unassigned models by identical URL + key"), onClick: () => {
                  void autoGroup();
                }, children: [
                  sdk.T("自动归组", "Auto-group"),
                  " (",
                  ungrouped,
                  ")"
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "model-add", disabled: locked, onClick: () => choose(edit.kind), children: isModel ? sdk.T("+ 新增模型", "+ Add model") : sdk.T("+ 新增服务商", "+ Add provider") })
              ] }),
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-list", "aria-label": isModel ? sdk.T("模型列表", "Model list") : sdk.T("服务商列表", "Provider list"), children: [
                isModel ? entries.map((item) => {
                  var _a2;
                  return /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "model-list-item", disabled: browsing, "aria-pressed": edit.id === item.key, onClick: () => {
                    if (edit.id !== item.key || !detail) choose("model", item.key);
                  }, children: [
                    /* @__PURE__ */ jsxRuntime.jsx("strong", { children: item.values.name || item.values.model || item.key }),
                    /* @__PURE__ */ jsxRuntime.jsx("small", { children: item.values.model || item.key }),
                    /* @__PURE__ */ jsxRuntime.jsx("small", { children: (_a2 = groups.find((candidate) => candidate.id === sectionKey(item))) == null ? void 0 : _a2.title })
                  ] }, item.key);
                }) : providers.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "model-list-item", disabled: browsing, "aria-pressed": edit.id === item.id, onClick: () => {
                  if (edit.id !== item.id || !detail) choose("provider", item.id);
                }, children: [
                  /* @__PURE__ */ jsxRuntime.jsx("strong", { children: item.values.name || item.id }),
                  /* @__PURE__ */ jsxRuntime.jsx("small", { children: endpoint(item.values.apibase) }),
                  /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
                    config.entries.filter((model) => model.provider === item.id).length,
                    " ",
                    sdk.T("个模型", "models")
                  ] })
                ] }, item.id)),
                !(isModel ? entries.length : providers.length) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-empty", children: query ? sdk.T("没有匹配项，试试其他关键词。", "No matches. Try another search.") : isModel ? sdk.T("还没有模型，点击上方新增。", "No models yet. Add one above.") : sdk.T("还没有服务商。新增后可在多个模型间共用地址和密钥。", "No providers yet. Add one to share a URL and key across models.") })
              ] }),
              /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "model-source", children: [
                /* @__PURE__ */ jsxRuntime.jsxs("summary", { children: [
                  sdk.T("配置来源", "Configuration source"),
                  config.format ? " · " + config.format : ""
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("p", { children: config.source || sdk.T("当前运行配置", "Current runtime configuration") })
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "model-editor", "aria-label": isModel ? sdk.T("模型编辑器", "Model editor") : sdk.T("服务商编辑器", "Provider editor"), "aria-busy": working, children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-editor-head", children: [
                /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary model-back", disabled: browsing, onClick: () => {
                  void navigate(() => select(edit.kind, edit.id, false));
                }, children: sdk.T("返回列表", "Back to list") }),
                /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
                  /* @__PURE__ */ jsxRuntime.jsx("span", { className: "model-eyebrow", children: isModel ? sdk.T("模型", "Model") : sdk.T("服务商", "Provider") }),
                  /* @__PURE__ */ jsxRuntime.jsx("h3", { ref: heading, tabIndex: -1, children: title || (isModel ? sdk.T("新增模型", "Add model") : sdk.T("新增服务商", "Add provider")) })
                ] })
              ] }),
              isModel ? /* @__PURE__ */ jsxRuntime.jsx(ModelForm, { entry, config, initialProvider: ((_a = group == null ? void 0 : group.provider) == null ? void 0 : _a.id) || (!section ? (_b = config.providers[0]) == null ? void 0 : _b.id : ""), disabled: locked, onSave: change, onDirtyChange, onReset: () => choose("model", edit.id), onProvider: openProvider }, edit.serial) : /* @__PURE__ */ jsxRuntime.jsx(ProviderForm, { entry: provider, used: provider ? config.entries.filter((item) => item.provider === provider.id).length : 0, disabled: locked, onSave: change, onDirtyChange, onReset: () => choose("provider", edit.id), onModels: viewModels }, edit.serial)
            ] })
          ] })
        ] })
      ] }) })
    ] });
  }
  sdk.defineReact("web-models", Models);
  exports.Models = Models;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH, GAH.ReactDOM);
