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
  const protocolLabel = (value) => value === "claude" ? "Claude" : "OpenAI";
  function providerNames(config) {
    const counts = /* @__PURE__ */ new Map(), names = /* @__PURE__ */ new Map();
    const base = (item) => item.values.name || item.id;
    for (const item of config.providers || []) counts.set(base(item), (counts.get(base(item)) || 0) + 1);
    for (const item of config.providers || []) {
      const name = base(item), host = endpoint(item.values.apibase).split("/")[0];
      names.set(item.id, (counts.get(name) || 0) > 1 ? name + " · " + (host || item.id) : name);
    }
    return names;
  }
  function sections(config) {
    const names = providerNames(config);
    const groups = /* @__PURE__ */ new Map();
    for (const provider of config.providers || []) groups.set("provider:" + provider.id, {
      id: "provider:" + provider.id,
      title: names.get(provider.id) || provider.id,
      provider,
      entries: []
    });
    for (const entry of config.entries) {
      const id = sectionKey(entry);
      if (!groups.has(id)) groups.set(id, { id, title: endpoint(entry.values.apibase) + " · " + protocolLabel(entry.protocol), entries: [] });
      groups.get(id).entries.push(entry);
    }
    return [...groups.values()];
  }
  function readonlyText(config) {
    return config.reason || sdk.T("当前配置只读", "This configuration is read-only");
  }
  const errorText = (e) => e instanceof Error ? e.message : String(e);
  function RemoteModels({ source, existing, disabled, fetchModels, onAdd }) {
    const [items, setItems] = react.useState(null), [loading, setLoading] = react.useState(false);
    const [error, setError] = react.useState(""), [query, setQuery] = react.useState(""), [picked, setPicked] = react.useState(/* @__PURE__ */ new Set());
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        setItems(await fetchModels(source));
        setPicked(/* @__PURE__ */ new Set());
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    };
    const shown = (items || []).filter((item) => sdk.matches(query, item.id, item.name));
    const fresh = shown.filter((item) => !existing.has(item.id));
    const toggle = (id) => {
      const next = new Set(picked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setPicked(next);
    };
    const allPicked = fresh.length > 0 && fresh.every((item) => picked.has(item.id));
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-remote wide", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-remote-head", children: [
        /* @__PURE__ */ jsxRuntime.jsx("strong", { children: sdk.T("服务商可用模型", "Available models") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: disabled || loading, onClick: () => {
          void load();
        }, children: loading ? sdk.T("获取中...", "Fetching...") : items ? sdk.T("重新获取", "Refetch") : sdk.T("获取模型列表", "Fetch model list") })
      ] }),
      error && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-error", role: "alert", children: error }),
      items && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        items.length > 8 && /* @__PURE__ */ jsxRuntime.jsx("input", { className: "model-search", type: "search", value: query, placeholder: sdk.T("筛选模型...", "Filter models..."), onChange: (event) => setQuery(event.target.value) }),
        !shown.length ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-empty", children: items.length ? sdk.T("没有匹配项", "No matches") : sdk.T("服务商未返回模型", "The provider returned no models") }) : /* @__PURE__ */ jsxRuntime.jsx("ul", { className: "model-remote-list", children: shown.map((item) => {
          const added = existing.has(item.id);
          return /* @__PURE__ */ jsxRuntime.jsx("li", { children: /* @__PURE__ */ jsxRuntime.jsxs("label", { className: added ? "is-added" : "", children: [
            /* @__PURE__ */ jsxRuntime.jsx("input", { type: "checkbox", disabled: disabled || added, checked: added || picked.has(item.id), onChange: () => toggle(item.id) }),
            /* @__PURE__ */ jsxRuntime.jsx("code", { children: item.id }),
            item.name && item.name !== item.id && /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.name }),
            added && /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("已添加", "Added") })
          ] }) }, item.id);
        }) }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-remote-actions", children: [
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "model-text-button", disabled: disabled || !fresh.length, onClick: () => {
            const next = new Set(picked);
            for (const item of fresh) {
              if (allPicked) next.delete(item.id);
              else next.add(item.id);
            }
            setPicked(next);
          }, children: allPicked ? sdk.T("取消全选", "Clear selection") : sdk.T("全选", "Select all") }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("共 ", "") + items.length + sdk.T(" 个，已添加 ", " models, ") + items.filter((item) => existing.has(item.id)).length + sdk.T("", " added") }),
          /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", disabled: disabled || !picked.size, onClick: () => onAdd([...picked]), children: [
            sdk.T("添加选中", "Add selected"),
            " (",
            picked.size,
            ")"
          ] })
        ] })
      ] })
    ] });
  }
  function useModelOptions(fetchModels) {
    const [items, setItems] = react.useState([]), [loading, setLoading] = react.useState(false), [error, setError] = react.useState("");
    const load = async (source) => {
      setLoading(true);
      setError("");
      try {
        const found = await fetchModels(source);
        setItems(found);
        if (!found.length) setError(sdk.T("服务商未返回模型", "The provider returned no models"));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    };
    return { items, loading, error, load };
  }
  const GROUPS = [
    { zh: "生成", en: "Generation", items: [
      { key: "max_tokens", kind: "int", zh: "最大输出 token", en: "Max output tokens", min: 1, ph: "Claude 8192" },
      { key: "temperature", kind: "float", zh: "温度", en: "Temperature", min: 0, max: 2, ph: "1" },
      { key: "reasoning_effort", kind: "enum", zh: "推理强度", en: "Reasoning effort", choices: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
      { key: "service_tier", kind: "enum", zh: "服务等级", en: "Service tier", choices: ["auto", "default", "priority", "flex"] },
      { key: "thinking_type", kind: "enum", zh: "思考模式", en: "Thinking mode", choices: ["adaptive", "enabled", "disabled"] },
      { key: "thinking_budget_tokens", kind: "int", zh: "思考预算 token", en: "Thinking budget tokens", min: 0 },
      { key: "stream", kind: "bool", zh: "流式输出", en: "Streaming", hint: ["默认开启", "On by default"] },
      { key: "omit_thinking", kind: "bool", zh: "历史中省略思考", en: "Omit thinking from history", hint: ["默认关闭", "Off by default"] }
    ] },
    { zh: "请求", en: "Request", items: [
      { key: "api_mode", kind: "enum", zh: "API 模式", en: "API mode", choices: ["chat_completions", "responses"], only: "oai" },
      { key: "api_key_header", kind: "enum", zh: "密钥请求头", en: "API key header", choices: ["auto", "x-api-key", "bearer"], only: "claude" },
      { key: "user_agent", kind: "str", zh: "User-Agent", en: "User-Agent", only: "claude", ph: "claude-cli/…" },
      { key: "fake_cc_system_prompt", kind: "bool", zh: "模拟 Claude Code 系统提示", en: "Claude Code system prompt", only: "claude" },
      { key: "proxy", kind: "str", zh: "代理", en: "Proxy", ph: "http://127.0.0.1:7890", hint: ["支持 http(s):// 与 socks5://", "http(s):// or socks5://"] },
      { key: "verify", kind: "verify", zh: "TLS 校验", en: "TLS verify", ph: "true", hint: ["true / false，或 CA 证书路径", "true / false, or a CA bundle path"] }
    ] },
    { zh: "超时与重试", en: "Timeouts & retries", items: [
      { key: "timeout", kind: "int", zh: "连接超时（秒）", en: "Connect timeout (s)", min: 1 },
      { key: "read_timeout", kind: "int", zh: "读取超时（秒）", en: "Read timeout (s)", min: 5 },
      { key: "max_retries", kind: "int", zh: "最大重试次数", en: "Max retries", min: 0, max: 100, ph: "4" },
      { key: "max_retry_after", kind: "float", zh: "最长重试等待（秒）", en: "Max retry wait (s)", min: 0, ph: "60" }
    ] },
    { zh: "上下文与提示词", en: "Context & prompt", items: [
      { key: "trim_keep_prefix", kind: "int", zh: "裁剪时保留前缀消息数", en: "Messages kept when trimming", min: 0, ph: "0" },
      { key: "extra_sys_prompt_file", kind: "str", zh: "附加系统提示文件", en: "Extra system prompt file", hint: ["相对路径基于 GA 目录", "Relative to the GA directory"] },
      { key: "extra_sys_prompt", kind: "text", zh: "附加系统提示", en: "Extra system prompt" }
    ] }
  ];
  GROUPS.flatMap((group) => group.items.map((item) => item.key));
  const toText = (value) => value === void 0 ? "" : String(value);
  function useOptions(initial = {}) {
    const [draft, setDraft] = react.useState(() => Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, toText(v)])));
    const set = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
    const diff = () => {
      const out = {};
      for (const group of GROUPS) for (const spec of group.items) {
        const now = (draft[spec.key] ?? "").trim(), was = toText(initial[spec.key]);
        if (now === was && (draft[spec.key] ?? "") === was) continue;
        if (now === "") {
          if (spec.key in initial) out[spec.key] = null;
          continue;
        }
        if (spec.kind === "int" || spec.kind === "float") out[spec.key] = Number(now);
        else if (spec.kind === "bool") out[spec.key] = now === "true";
        else if (spec.kind === "verify") out[spec.key] = now === "true" ? true : now === "false" ? false : now;
        else out[spec.key] = spec.kind === "text" ? draft[spec.key] : now;
      }
      return out;
    };
    return { draft, set, diff };
  }
  function AdvancedOptions({ protocol, draft, hidden = [], disabled, onChange }) {
    const defaultText = sdk.T("默认", "Default");
    const input = (spec) => {
      const value = draft[spec.key] ?? "", change = (v) => onChange(spec.key, v);
      if (hidden.includes(spec.key)) return /* @__PURE__ */ jsxRuntime.jsx("input", { value: sdk.T("已在 mykey.py 中设置（此处不显示）", "Set in mykey.py (not shown here)"), disabled: true, readOnly: true });
      if (spec.kind === "enum" || spec.kind === "bool") {
        const choices = spec.kind === "bool" ? [["true", sdk.T("开启", "On")], ["false", sdk.T("关闭", "Off")]] : spec.choices.map((c) => [c, c]);
        return /* @__PURE__ */ jsxRuntime.jsxs("select", { value, disabled, onChange: (event) => change(event.target.value), children: [
          /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: defaultText }),
          choices.map(([v, label]) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: v, children: label }, v))
        ] });
      }
      if (spec.kind === "text") return /* @__PURE__ */ jsxRuntime.jsx("textarea", { rows: 4, value, disabled, maxLength: 5e4, placeholder: defaultText, onChange: (event) => change(event.target.value) });
      const numeric = spec.kind === "int" || spec.kind === "float";
      return /* @__PURE__ */ jsxRuntime.jsx(
        "input",
        {
          type: numeric ? "number" : "text",
          step: spec.kind === "float" ? "any" : numeric ? 1 : void 0,
          min: spec.min,
          max: spec.max,
          value,
          disabled,
          spellCheck: false,
          autoComplete: "off",
          placeholder: spec.ph ? defaultText + " " + spec.ph : defaultText,
          onChange: (event) => change(event.target.value)
        }
      );
    };
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      GROUPS.map((group) => {
        const items = group.items.filter((spec) => !spec.only || spec.only === protocol);
        return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-advanced-group", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h4", { children: sdk.T(group.zh, group.en) }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-grid", children: items.map((spec) => /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T(spec.zh, spec.en), wide: spec.kind === "text", children: [
            input(spec),
            /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
              /* @__PURE__ */ jsxRuntime.jsx("code", { children: spec.key }),
              spec.hint ? " · " + sdk.T(spec.hint[0], spec.hint[1]) : ""
            ] })
          ] }, spec.key)) })
        ] }, group.en);
      }),
      /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-advanced-note", children: sdk.T("留空表示使用 GA 默认值；清空已有的值会从 mykey.py 删除该项。", "Leave empty to use the GA default; clearing a value removes it from mykey.py.") })
    ] });
  }
  function Field({ label, wide, children }) {
    return /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "model-field" + (wide ? " wide" : ""), children: [
      label,
      children
    ] });
  }
  function Section({ title, hint, children }) {
    return /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "model-section", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("header", { children: [
        /* @__PURE__ */ jsxRuntime.jsx("h4", { children: title }),
        hint && /* @__PURE__ */ jsxRuntime.jsx("p", { children: hint })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-grid", children })
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
  function ModelForm({ entry, config, initialProvider = "", disabled, onSave, onDirtyChange, onReset, onProvider, fetchModels }) {
    var _a;
    const options = useModelOptions(fetchModels), names = providerNames(config);
    const defaultProtocol = ((_a = config.providers.find((item) => item.id === initialProvider)) == null ? void 0 : _a.values.protocol) || "oai";
    const [protocol, setProtocol] = react.useState((entry == null ? void 0 : entry.protocol) || defaultProtocol);
    const [id, setId] = react.useState((entry == null ? void 0 : entry.key) || "native_" + protocol + "_config_" + Date.now());
    const [provider, setProvider] = react.useState(entry ? entry.provider || "" : initialProvider);
    const [name, setName] = react.useState((entry == null ? void 0 : entry.values.name) || ""), [model, setModel] = react.useState((entry == null ? void 0 : entry.values.model) || "");
    const [base, setBase] = react.useState((entry == null ? void 0 : entry.values.apibase) || ""), [secret, setSecret] = react.useState("");
    const [context, setContext] = react.useState(String((entry == null ? void 0 : entry.values.context_win) ?? ""));
    const [suggest, setSuggest] = react.useState(false);
    const opts = useOptions(entry == null ? void 0 : entry.options);
    const shared = config.providers.find((item) => item.id === provider);
    const dirty = useDraft([protocol, id, provider, name, model, base, secret, context, opts.draft], onDirtyChange);
    const changeProtocol = (value) => {
      setProtocol(value);
      setId("native_" + value + "_config_" + Date.now());
    };
    const canFetch = !!provider || !!base.trim() || !!entry;
    const fetchList = () => {
      setSuggest(true);
      void options.load(provider ? { provider } : { key: entry == null ? void 0 : entry.key, apibase: base.trim(), apikey: secret, protocol });
    };
    const exact = options.items.some((item) => item.id === model);
    const visible = options.items.filter((item) => !model || exact || sdk.matches(model, item.id, item.name)).slice(0, 50);
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "model-form", onInvalidCapture: (event) => {
      var _a2;
      return (_a2 = event.target.closest("details")) == null ? void 0 : _a2.setAttribute("open", "");
    }, onSubmit: (event) => {
      event.preventDefault();
      if (disabled) return;
      const values = provider ? { name: name.trim(), model: model.trim(), provider } : { name: name.trim(), model: model.trim(), provider: "", apibase: base.trim(), apikey: secret };
      if (context) values.context_win = Number(context);
      const changed = opts.diff();
      if (Object.keys(changed).length) values.options = changed;
      onSave("save", id.trim(), values);
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-form-content", children: [
        /* @__PURE__ */ jsxRuntime.jsxs(Section, { title: sdk.T("连接", "Connection"), hint: sdk.T("模型从哪里调用。选择服务商可共用地址和密钥。", "Where this model is called. Pick a provider to share its URL and key."), children: [
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("服务商", "Provider"), children: /* @__PURE__ */ jsxRuntime.jsxs("select", { value: provider, disabled, onChange: (event) => {
            var _a2;
            const value = event.target.value;
            setProvider(value);
            if (!entry && value) changeProtocol(((_a2 = config.providers.find((item) => item.id === value)) == null ? void 0 : _a2.values.protocol) || "oai");
          }, children: [
            /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("不使用服务商（单独填写）", "None (enter URL and key)") }),
            config.providers.map((item) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: item.id, children: names.get(item.id) }, item.id))
          ] }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Protocol, { value: protocol, disabled: disabled || !!entry, onChange: changeProtocol }),
          shared ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-connection wide", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
              /* @__PURE__ */ jsxRuntime.jsx("strong", { children: names.get(shared.id) }),
              /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
                endpoint(shared.values.apibase),
                " · ",
                shared.has_key ? sdk.T("密钥已配置", "Key configured") : sdk.T("未配置密钥", "No key")
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled, onClick: () => onProvider(shared.id), children: sdk.T("编辑服务商", "Edit provider") })
          ] }) : /* @__PURE__ */ jsxRuntime.jsx(Credentials, { base, secret, hasKey: entry == null ? void 0 : entry.has_key, hiddenURL: entry == null ? void 0 : entry.url_hidden, disabled, onBase: setBase, onSecret: setSecret })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs(Section, { title: sdk.T("模型", "Model"), children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-field wide", children: [
            /* @__PURE__ */ jsxRuntime.jsx("label", { htmlFor: "model-id-input", children: sdk.T("模型 ID", "Model ID") }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-id-row", children: [
              /* @__PURE__ */ jsxRuntime.jsx(
                "input",
                {
                  id: "model-id-input",
                  required: true,
                  value: model,
                  disabled,
                  autoFocus: !entry,
                  autoComplete: "off",
                  placeholder: "gpt-4.1 / claude-sonnet-4",
                  spellCheck: false,
                  onFocus: () => setSuggest(true),
                  onChange: (event) => {
                    setModel(event.target.value);
                    setSuggest(true);
                  }
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: disabled || options.loading || !canFetch, title: canFetch ? "" : sdk.T("先选择服务商或填写 API 地址", "Choose a provider or enter an API URL first"), onClick: fetchList, children: options.loading ? sdk.T("获取中…", "Fetching…") : options.items.length ? sdk.T("重新获取", "Refresh") : sdk.T("从服务商获取", "Fetch from provider") })
            ] }),
            options.error ? /* @__PURE__ */ jsxRuntime.jsx("small", { className: "model-error", children: options.error }) : options.items.length ? /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("服务商返回 " + options.items.length + " 个模型，输入可筛选，点击选用", options.items.length + " models available; type to filter, click to use") }) : /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("传给接口的 model 参数，可手动填写或从服务商获取。", "The model parameter sent to the API. Type it or fetch from the provider.") }),
            suggest && options.items.length > 0 && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-suggest", role: "listbox", "aria-label": sdk.T("可用模型", "Available models"), children: visible.length ? visible.map((item) => /* @__PURE__ */ jsxRuntime.jsxs(
              "button",
              {
                type: "button",
                role: "option",
                "aria-selected": item.id === model,
                disabled,
                onClick: () => {
                  setModel(item.id);
                  setSuggest(false);
                },
                children: [
                  /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.id }),
                  item.name && item.name !== item.id && /* @__PURE__ */ jsxRuntime.jsx("small", { children: item.name })
                ]
              },
              item.id
            )) : /* @__PURE__ */ jsxRuntime.jsx("p", { children: sdk.T("没有匹配的模型，将使用输入的 ID", "No match; the typed ID will be used") }) })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("显示名称", "Display name"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { value: name, disabled, maxLength: 120, placeholder: model || sdk.T("默认使用模型 ID", "Defaults to model ID"), onChange: (event) => setName(event.target.value) }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("上下文窗口", "Context window"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { type: "number", min: 1024, step: 1, value: context, disabled, placeholder: sdk.T("默认", "Default"), onChange: (event) => setContext(event.target.value) }) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "model-advanced", children: [
          /* @__PURE__ */ jsxRuntime.jsx("summary", { children: sdk.T("高级", "Advanced") }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-grid", children: /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T("配置标识", "Config key"), wide: true, children: [
            /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, value: id, readOnly: !!entry, disabled, spellCheck: false, onChange: (event) => setId(event.target.value) }),
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("mykey.py 中的变量名，创建后不可修改。", "Variable name in mykey.py; fixed after creation.") })
          ] }) }),
          /* @__PURE__ */ jsxRuntime.jsx(AdvancedOptions, { protocol, draft: opts.draft, hidden: entry == null ? void 0 : entry.options_hidden, disabled, onChange: opts.set })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(FormActions, { dirty, existing: !!entry, disabled, onReset, onDelete: async () => {
        if (await sdk.confirmDialog({ title: sdk.T("删除这个模型？", "Delete this model?"), message: (entry == null ? void 0 : entry.values.name) || (entry == null ? void 0 : entry.values.model) || id, danger: true, confirm: sdk.T("删除", "Delete") })) onSave("delete", id);
      } })
    ] });
  }
  function ProviderForm({ entry, used, existing, disabled, onSave, onDirtyChange, onReset, onModels, fetchModels, onAddModels }) {
    const [id, setId] = react.useState((entry == null ? void 0 : entry.id) || ""), [name, setName] = react.useState((entry == null ? void 0 : entry.values.name) || "");
    const [protocol, setProtocol] = react.useState((entry == null ? void 0 : entry.values.protocol) || "oai");
    const [base, setBase] = react.useState((entry == null ? void 0 : entry.values.apibase) || ""), [secret, setSecret] = react.useState("");
    const dirty = useDraft([id, name, protocol, base, secret], onDirtyChange);
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "model-provider-form", onInvalidCapture: (event) => {
      var _a;
      return (_a = event.target.closest("details")) == null ? void 0 : _a.setAttribute("open", "");
    }, onSubmit: (event) => {
      event.preventDefault();
      if (!disabled) onSave("provider_save", id.trim(), { name: name.trim(), protocol, apibase: base.trim(), apikey: secret });
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-form-content", children: [
        /* @__PURE__ */ jsxRuntime.jsxs(Section, { title: sdk.T("服务商", "Provider"), hint: sdk.T("地址和密钥会同步到使用此服务商的所有模型。", "URL and key are synced to every model that uses this provider."), children: [
          /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("显示名称", "Display name"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { disabled, value: name, maxLength: 120, placeholder: sdk.T("例如 OpenAI", "For example, OpenAI"), onChange: (event) => setName(event.target.value), autoFocus: !entry }) }),
          /* @__PURE__ */ jsxRuntime.jsx(Protocol, { value: protocol, disabled, onChange: setProtocol }),
          /* @__PURE__ */ jsxRuntime.jsx(Credentials, { base, secret, hasKey: entry == null ? void 0 : entry.has_key, hiddenURL: entry == null ? void 0 : entry.url_hidden, disabled, onBase: setBase, onSecret: setSecret })
        ] }),
        entry && /* @__PURE__ */ jsxRuntime.jsxs(Section, { title: sdk.T("模型", "Models"), hint: used ? sdk.T("此服务商下有 " + used + " 个模型，有模型时不能删除。", used + " models use this provider; it cannot be deleted while in use.") : sdk.T("还没有模型使用此服务商。", "No models use this provider yet."), children: [
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-provider-usage wide", children: /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "secondary", disabled: disabled || !used, onClick: onModels, children: [
            sdk.T("查看已有模型", "Show its models"),
            " (",
            used,
            ")"
          ] }) }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "wide", children: /* @__PURE__ */ jsxRuntime.jsx(
            RemoteModels,
            {
              source: { provider: entry.id, protocol, apibase: base.trim(), apikey: secret },
              existing,
              disabled,
              fetchModels,
              onAdd: (ids) => onAddModels(entry.id, protocol, ids)
            }
          ) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "model-advanced", children: [
          /* @__PURE__ */ jsxRuntime.jsx("summary", { children: sdk.T("高级", "Advanced") }),
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "model-grid", children: /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T("服务商标识", "Provider ID"), wide: true, children: [
            /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, pattern: "[a-z0-9_-]+", disabled: disabled || !!entry, value: id, placeholder: "openai", spellCheck: false, onChange: (event) => setId(event.target.value) }),
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("小写字母、数字、_ 或 -，创建后不可修改。", "Lowercase letters, digits, _ or -; fixed after creation.") })
          ] }) })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(FormActions, { dirty, existing: !!entry, disabled, canDelete: used === 0, onReset, onDelete: async () => {
        if (await sdk.confirmDialog({ title: sdk.T("删除这个服务商？", "Delete this provider?"), message: (entry == null ? void 0 : entry.values.name) || id, danger: true, confirm: sdk.T("删除", "Delete") })) onSave("provider_delete", id);
      } })
    ] });
  }
  function MixinForm({ entry, config, disabled, onSave, onDirtyChange, onReset }) {
    var _a;
    const [id, setId] = react.useState((entry == null ? void 0 : entry.key) || "mixin_config_" + Date.now());
    const [members, setMembers] = react.useState((entry == null ? void 0 : entry.indexed) ? [] : (entry == null ? void 0 : entry.members) || []);
    const [retries, setRetries] = react.useState(String((entry == null ? void 0 : entry.values.max_retries) ?? ""));
    const [delay, setDelay] = react.useState(String((entry == null ? void 0 : entry.values.base_delay) ?? ""));
    const [spring, setSpring] = react.useState(String((entry == null ? void 0 : entry.values.spring_back) ?? ""));
    const [error, setError] = react.useState("");
    const dirty = useDraft({ id, members, retries, delay, spring }, onDirtyChange);
    const models = config.entries.map((item) => ({ key: item.key, name: item.values.name || item.values.model || "" }));
    const unique = models.filter((item) => item.name && models.filter((other) => other.name === item.name).length === 1);
    const selected = members.map((name) => unique.find((item) => item.name === name));
    const native = (_a = selected.find((item) => item)) == null ? void 0 : _a.key.includes("native");
    const available = unique.filter((item) => !members.includes(item.name) && (native === void 0 || item.key.includes("native") === native));
    const invalid = selected.some((item) => !item) || new Set(members).size !== members.length || new Set(selected.filter((item) => item).map((item) => item.key.includes("native"))).size > 1;
    const move = (index, offset) => {
      setMembers((old) => {
        const next = [...old];
        [next[index], next[index + offset]] = [next[index + offset], next[index]];
        return next;
      });
    };
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "model-form", onInvalidCapture: (event) => {
      var _a2;
      return (_a2 = event.target.closest("details")) == null ? void 0 : _a2.setAttribute("open", "");
    }, onSubmit: (event) => {
      event.preventDefault();
      if (disabled) return;
      if (!id.includes("mixin") || !/(api|config|cookie)/.test(id)) {
        setError(sdk.T("标识必须包含 mixin，以及 api、config 或 cookie。", "The identifier must contain mixin and api, config or cookie."));
        return;
      }
      if (invalid || members.length < 2 || members.length > 20) {
        setError(sdk.T("请选择 2–20 个名称唯一、类型兼容的模型。", "Choose 2–20 uniquely named, compatible models."));
        return;
      }
      setError("");
      onSave("mixin_save", id, { llm_nos: members, max_retries: retries === "" ? null : Number(retries), base_delay: delay === "" ? null : Number(delay), spring_back: spring === "" ? null : Number(spring) });
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-form-content", children: [
        error && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-error", role: "alert", children: error }),
        /* @__PURE__ */ jsxRuntime.jsx(Section, { title: sdk.T("故障转移组", "Failover group"), hint: sdk.T("第一个模型优先使用，失败后依次切换到后续模型。配置直接保存到 mykey.py。", "The first model is preferred; failures fall back to later models in order. Saved directly to mykey.py."), children: /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T("配置标识", "Configuration identifier"), wide: true, children: [
          /* @__PURE__ */ jsxRuntime.jsx("input", { required: true, pattern: "[A-Za-z][A-Za-z0-9_]{0,99}", value: id, disabled: disabled || !!entry, onChange: (event) => setId(event.target.value), autoComplete: "off", spellCheck: false }),
          /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("例如 mixin_config_primary；保存后标识不可修改。", "For example, mixin_config_primary; the identifier cannot be changed after saving.") })
        ] }) }),
        /* @__PURE__ */ jsxRuntime.jsx(Section, { title: sdk.T("模型顺序", "Model order"), hint: sdk.T("使用模型名称引用，不使用易变的数字下标。Native 与非 Native 模型不能混在同一组。", "References use model names, not fragile numeric indices. Native and non-native models cannot be mixed in one group."), children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "wide mixin-members", children: [
          (entry == null ? void 0 : entry.indexed) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help", children: sdk.T("此组原来使用数字下标；请重新选择成员，保存后改用名称引用。", "This group uses numeric indices. Reselect its members to save name-based references.") }),
          invalid && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-error", role: "alert", children: sdk.T("成员缺失、重名或类型不兼容，请移除后重新选择。", "Some members are missing, ambiguous or incompatible. Remove and reselect them.") }),
          /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "mixin-member-list", children: members.map((name, index) => /* @__PURE__ */ jsxRuntime.jsxs("li", { children: [
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mixin-member-name", children: [
              /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
                index === 0 ? sdk.T("首选", "Primary") : sdk.T("备选", "Fallback"),
                " ",
                index + 1
              ] }),
              /* @__PURE__ */ jsxRuntime.jsx("strong", { children: name })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mixin-member-actions", children: [
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: disabled || index === 0, "aria-label": sdk.T("上移 ", "Move up ") + name, onClick: () => move(index, -1), children: "↑" }),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled: disabled || index === members.length - 1, "aria-label": sdk.T("下移 ", "Move down ") + name, onClick: () => move(index, 1), children: "↓" }),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary", disabled, "aria-label": sdk.T("移除 ", "Remove ") + name, onClick: () => setMembers((old) => old.filter((_, pos) => pos !== index)), children: sdk.T("移除", "Remove") })
            ] })
          ] }, index)) }),
          !members.length && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-help", children: sdk.T("先添加首选模型，再添加至少一个备选模型。", "Add a primary model, then at least one fallback.") }),
          /* @__PURE__ */ jsxRuntime.jsxs(Field, { label: sdk.T("添加成员", "Add member"), children: [
            /* @__PURE__ */ jsxRuntime.jsxs("select", { value: "", disabled: disabled || members.length >= 20 || !available.length, onChange: (event) => {
              if (event.target.value) setMembers((old) => [...old, event.target.value]);
            }, children: [
              /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("选择模型…", "Choose a model…") }),
              available.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("option", { value: item.name, children: [
                item.name,
                " · ",
                item.key
              ] }, item.key))
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("仅列出名称唯一且与当前组兼容的模型；重名模型请先在模型页改名。", "Only uniquely named, compatible models are listed. Rename duplicate models in the Models tab first.") })
          ] })
        ] }) }),
        /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "model-advanced", children: [
          /* @__PURE__ */ jsxRuntime.jsx("summary", { children: sdk.T("重试与回切参数", "Retry and return settings") }),
          /* @__PURE__ */ jsxRuntime.jsxs(Section, { title: sdk.T("可选参数", "Optional settings"), hint: sdk.T("留空使用 GA 默认值；回切设为 0 时，下次请求立即尝试首选模型。", "Leave empty for GA defaults; 0 retries the primary model on the next request."), children: [
            /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("重试次数", "Max retries"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { type: "number", min: 0, max: 20, step: 1, value: retries, disabled, onChange: (event) => setRetries(event.target.value) }) }),
            /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("基础延迟（秒）", "Base delay (seconds)"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { type: "number", min: 0, max: 120, step: "any", value: delay, disabled, onChange: (event) => setDelay(event.target.value) }) }),
            /* @__PURE__ */ jsxRuntime.jsx(Field, { label: sdk.T("回切间隔（秒）", "Return interval (seconds)"), children: /* @__PURE__ */ jsxRuntime.jsx("input", { type: "number", min: 0, max: 86400, step: 1, value: spring, disabled, onChange: (event) => setSpring(event.target.value) }) })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(FormActions, { dirty, existing: !!entry, disabled, onReset, onDelete: async () => {
        if (await sdk.confirmDialog({ title: sdk.T("删除此故障转移组？", "Delete this failover group?"), message: id, danger: true, confirm: sdk.T("删除", "Delete") })) onSave("mixin_delete", id);
      } })
    ] });
  }
  function Models({ api }) {
    var _a, _b, _c, _d;
    const { state, changing } = sdk.useHost(), { busy, working, run } = sdk.useOperation(api);
    const [config, setConfig] = react.useState(null), [error, setError] = react.useState("");
    const [query, setQuery] = react.useState(""), [section, setSection] = react.useState("");
    const [edit, setEdit] = react.useState({ kind: "provider", serial: 0 }), [detail, setDetail] = react.useState(false);
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
    const mixins = ((config == null ? void 0 : config.mixins) || []).filter((item) => sdk.matches(query, item.key, ...item.members));
    const mixin = (_a = config == null ? void 0 : config.mixins) == null ? void 0 : _a.find((item) => item.key === edit.id);
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
        var _a2, _b2, _c2, _d2;
        setQuery("");
        setSection("");
        select(kind, kind === "model" ? (_a2 = config == null ? void 0 : config.entries[0]) == null ? void 0 : _a2.key : kind === "mixin" ? (_c2 = (_b2 = config == null ? void 0 : config.mixins) == null ? void 0 : _b2[0]) == null ? void 0 : _c2.key : (_d2 = config == null ? void 0 : config.providers[0]) == null ? void 0 : _d2.id, false);
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
        select("provider", (_a2 = next.providers[0]) == null ? void 0 : _a2.id, false);
      }, setError, true);
    }
    const change = (action, id, values) => {
      if (!(config == null ? void 0 : config.writable) || busy) return;
      setError("");
      const { options, ...fields } = values || {};
      void run(async () => {
        var _a2, _b2, _c2, _d2;
        const next = await api.host.post("/api/models/config", {
          action,
          revision: config.revision,
          [action.startsWith("provider_") ? "id" : "key"]: id,
          ...values ? { values: fields } : {},
          ...options ? { options } : {}
        });
        setConfig(next.config);
        api.setState(next.state);
        setQuery("");
        if (action.startsWith("provider_")) {
          setSection("");
          select("provider", action === "provider_save" ? id : (_a2 = next.config.providers[0]) == null ? void 0 : _a2.id, action === "provider_save");
        } else if (action.startsWith("mixin_")) {
          setSection("");
          select("mixin", action === "mixin_save" ? id : (_c2 = (_b2 = next.config.mixins) == null ? void 0 : _b2[0]) == null ? void 0 : _c2.key, action === "mixin_save");
        } else {
          const saved = next.config.entries.find((item) => item.key === id);
          const candidate = saved && section ? sectionKey(saved) : section;
          const nextSection = sections(next.config).some((item) => item.id === candidate) ? candidate : "";
          setSection(nextSection);
          select("model", (saved == null ? void 0 : saved.key) || ((_d2 = next.config.entries.find((item) => !nextSection || sectionKey(item) === nextSection)) == null ? void 0 : _d2.key), !!saved);
        }
        api.notice(sdk.T("配置已保存并生效", "Configuration saved and applied"));
      }, setError);
    };
    const fetchModels = async (source) => (await api.host.post("/api/models/remote", source)).models || [];
    const addModels = (provider2, protocol, ids) => {
      if (!(config == null ? void 0 : config.writable) || busy || !ids.length) return;
      setError("");
      void run(async () => {
        const stamp = Date.now();
        const items = ids.map((model, index) => ({ key: "native_" + protocol + "_config_" + stamp + "_" + index, values: { name: model, model, provider: provider2 } }));
        const next = await api.host.post("/api/models/config", { action: "save_many", revision: config.revision, items });
        setConfig(next.config);
        api.setState(next.state);
        select("provider", provider2, true);
        api.notice(sdk.T("已添加 " + ids.length + " 个模型", "Added " + ids.length + " models"));
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
    const names = config ? providerNames(config) : /* @__PURE__ */ new Map();
    const isModel = edit.kind === "model", isMixin = edit.kind === "mixin";
    const title = isModel ? (entry == null ? void 0 : entry.values.name) || (entry == null ? void 0 : entry.values.model) || (entry == null ? void 0 : entry.key) : isMixin ? mixin == null ? void 0 : mixin.key : (provider == null ? void 0 : provider.values.name) || (provider == null ? void 0 : provider.id);
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(ModelPicker, { api }),
      state.models && /* @__PURE__ */ jsxRuntime.jsx(sdk.SettingsPanel, { api, label: sdk.T("模型", "Models"), icon: "cpu", order: 10, className: "gah-model-dialog", onOpen: load, onBeforeLeave: canLeave, children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-content model-workspace" + (detail ? " is-detail" : ""), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-workspace-head", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-view-switch", role: "group", "aria-label": sdk.T("模型与服务商", "Models and providers"), children: [
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", "aria-pressed": edit.kind === "provider", disabled: browsing, onClick: () => switchView("provider"), children: [
              sdk.T("服务商", "Providers"),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: (config == null ? void 0 : config.providers.length) ?? 0 })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", "aria-pressed": isModel, disabled: browsing, onClick: () => switchView("model"), children: [
              sdk.T("模型", "Models"),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: (config == null ? void 0 : config.entries.length) ?? 0 })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", "aria-pressed": isMixin, disabled: browsing, onClick: () => switchView("mixin"), children: [
              sdk.T("故障转移组", "Failover groups"),
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: ((_b = config == null ? void 0 : config.mixins) == null ? void 0 : _b.length) ?? 0 })
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
                /* @__PURE__ */ jsxRuntime.jsx("input", { className: "model-search", type: "search", value: query, disabled: browsing, placeholder: isModel ? sdk.T("搜索模型...", "Search models...") : isMixin ? sdk.T("搜索故障转移组...", "Search failover groups...") : sdk.T("搜索服务商...", "Search providers..."), "aria-label": sdk.T("搜索配置", "Search configurations"), onChange: (event) => setQuery(event.target.value) }),
                isModel && /* @__PURE__ */ jsxRuntime.jsxs("select", { className: "model-provider-filter", value: section, disabled: browsing, "aria-label": sdk.T("按服务商筛选", "Filter by provider"), onChange: (event) => filter(event.target.value), children: [
                  /* @__PURE__ */ jsxRuntime.jsx("option", { value: "", children: sdk.T("全部模型", "All models") }),
                  groups.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("option", { value: item.id, children: [
                    item.title,
                    " (",
                    item.entries.length,
                    ")"
                  ] }, item.id))
                ] }),
                edit.kind === "provider" && ungrouped > 0 && /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "secondary model-group", disabled: locked, title: sdk.T("按相同地址+密钥归组未归属模型", "Group unassigned models by identical URL + key"), onClick: () => {
                  void autoGroup();
                }, children: [
                  sdk.T("自动归组", "Auto-group"),
                  " (",
                  ungrouped,
                  ")"
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "model-add", disabled: locked, onClick: () => choose(edit.kind), children: isModel ? sdk.T("+ 新增模型", "+ Add model") : isMixin ? sdk.T("+ 新增故障转移组", "+ Add failover group") : sdk.T("+ 新增服务商", "+ Add provider") })
              ] }),
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-list", "aria-label": isModel ? sdk.T("模型列表", "Model list") : isMixin ? sdk.T("故障转移组列表", "Failover group list") : sdk.T("服务商列表", "Provider list"), children: [
                isModel ? entries.map((item) => {
                  var _a2;
                  return /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "model-list-item", disabled: browsing, "aria-pressed": edit.id === item.key, onClick: () => {
                    if (edit.id !== item.key || !detail) choose("model", item.key);
                  }, children: [
                    /* @__PURE__ */ jsxRuntime.jsx("strong", { children: item.values.name || item.values.model || item.key }),
                    item.values.name && item.values.model && item.values.name !== item.values.model && /* @__PURE__ */ jsxRuntime.jsx("small", { className: "model-list-id", children: item.values.model }),
                    /* @__PURE__ */ jsxRuntime.jsx("small", { children: (_a2 = groups.find((candidate) => candidate.id === sectionKey(item))) == null ? void 0 : _a2.title })
                  ] }, item.key);
                }) : isMixin ? mixins.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "model-list-item", disabled: browsing, "aria-pressed": edit.id === item.key, onClick: () => {
                  if (edit.id !== item.key || !detail) choose("mixin", item.key);
                }, children: [
                  /* @__PURE__ */ jsxRuntime.jsx("strong", { children: item.key }),
                  /* @__PURE__ */ jsxRuntime.jsx("small", { children: item.members.join(" → ") }),
                  /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
                    item.members.length,
                    " ",
                    sdk.T("个成员", "members"),
                    item.indexed ? sdk.T(" · 下标引用", " · index references") : ""
                  ] })
                ] }, item.key)) : providers.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "model-list-item", disabled: browsing, "aria-pressed": edit.id === item.id, onClick: () => {
                  if (edit.id !== item.id || !detail) choose("provider", item.id);
                }, children: [
                  /* @__PURE__ */ jsxRuntime.jsx("strong", { children: names.get(item.id) }),
                  /* @__PURE__ */ jsxRuntime.jsx("small", { children: endpoint(item.values.apibase) }),
                  /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
                    config.entries.filter((model) => model.provider === item.id).length,
                    " ",
                    sdk.T("个模型", "models")
                  ] })
                ] }, item.id)),
                !(isModel ? entries.length : isMixin ? mixins.length : providers.length) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "model-empty", children: query ? sdk.T("没有匹配项，试试其他关键词。", "No matches. Try another search.") : isModel ? sdk.T("还没有模型，点击上方新增。", "No models yet. Add one above.") : isMixin ? sdk.T("还没有故障转移组，添加首选和备选模型以自动切换。", "No failover groups yet. Add primary and fallback models for automatic switching.") : sdk.T("还没有服务商。新增后可在多个模型间共用地址和密钥。", "No providers yet. Add one to share a URL and key across models.") })
              ] }),
              /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "model-source", children: [
                /* @__PURE__ */ jsxRuntime.jsxs("summary", { children: [
                  sdk.T("配置文件", "Config file"),
                  config.format ? " · " + config.format : ""
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("p", { children: sdk.T("模型和服务商直接保存在 GA 的 mykey.py，保存后立即生效。", "Models and providers are saved directly to GA mykey.py and apply immediately.") }),
                /* @__PURE__ */ jsxRuntime.jsx("code", { children: config.source || sdk.T("当前运行配置", "Current runtime configuration") })
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "model-editor", "aria-label": isModel ? sdk.T("模型编辑器", "Model editor") : isMixin ? sdk.T("故障转移组编辑器", "Failover group editor") : sdk.T("服务商编辑器", "Provider editor"), "aria-busy": working, children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "model-editor-head", children: [
                /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "secondary model-back", disabled: browsing, onClick: () => {
                  void navigate(() => select(edit.kind, edit.id, false));
                }, children: sdk.T("返回列表", "Back to list") }),
                /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
                  /* @__PURE__ */ jsxRuntime.jsx("span", { className: "model-eyebrow", children: isModel ? entry ? sdk.T("编辑模型", "Edit model") : sdk.T("新模型", "New model") : isMixin ? mixin ? sdk.T("编辑故障转移组", "Edit failover group") : sdk.T("新故障转移组", "New failover group") : provider ? sdk.T("编辑服务商", "Edit provider") : sdk.T("新服务商", "New provider") }),
                  /* @__PURE__ */ jsxRuntime.jsx("h3", { ref: heading, tabIndex: -1, children: title || (isModel ? sdk.T("新增模型", "Add model") : isMixin ? sdk.T("新增故障转移组", "Add failover group") : sdk.T("新增服务商", "Add provider")) })
                ] })
              ] }),
              isModel ? /* @__PURE__ */ jsxRuntime.jsx(ModelForm, { entry, config, initialProvider: ((_c = group == null ? void 0 : group.provider) == null ? void 0 : _c.id) || (!section ? (_d = config.providers[0]) == null ? void 0 : _d.id : ""), disabled: locked, onSave: change, onDirtyChange, onReset: () => choose("model", edit.id), onProvider: openProvider, fetchModels }, edit.serial) : isMixin ? /* @__PURE__ */ jsxRuntime.jsx(MixinForm, { entry: mixin, config, disabled: locked, onSave: change, onDirtyChange, onReset: () => choose("mixin", edit.id) }, edit.serial) : /* @__PURE__ */ jsxRuntime.jsx(
                ProviderForm,
                {
                  entry: provider,
                  used: provider ? config.entries.filter((item) => item.provider === provider.id).length : 0,
                  disabled: locked,
                  onSave: change,
                  onDirtyChange,
                  onReset: () => choose("provider", edit.id),
                  onModels: viewModels,
                  existing: new Set(config.entries.filter((item) => item.provider === (provider == null ? void 0 : provider.id)).map((item) => item.values.model || "")),
                  fetchModels,
                  onAddModels: addModels
                },
                edit.serial
              )
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
