(function(jsxRuntime, react, sdk) {
  "use strict";
  const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  const SEARCH_MIN = 6;
  function RowMenu({ disabled, onRename, onDelete }) {
    const [open, setOpen] = react.useState(false);
    const box = react.useRef(null);
    react.useEffect(() => {
      if (!open) return;
      const down = (event) => {
        var _a;
        if (!((_a = box.current) == null ? void 0 : _a.contains(event.target))) setOpen(false);
      };
      const key = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      };
      document.addEventListener("pointerdown", down, true);
      document.addEventListener("keydown", key, true);
      return () => {
        document.removeEventListener("pointerdown", down, true);
        document.removeEventListener("keydown", key, true);
      };
    }, [open]);
    const pick = (fn) => () => {
      setOpen(false);
      fn();
    };
    return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "kc-more", ref: box, children: [
      /* @__PURE__ */ jsxRuntime.jsx(
        "button",
        {
          type: "button",
          className: `kc-icon-btn${open ? " open" : ""}`,
          disabled,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-label": sdk.T("更多操作", "More actions"),
          title: sdk.T("更多操作", "More actions"),
          onClick: () => setOpen(!open),
          children: /* @__PURE__ */ jsxRuntime.jsxs("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true", children: [
            /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "3.5", cy: "8", r: "1.3" }),
            /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "8", cy: "8", r: "1.3" }),
            /* @__PURE__ */ jsxRuntime.jsx("circle", { cx: "12.5", cy: "8", r: "1.3" })
          ] })
        }
      ),
      open && /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "kc-menu", role: "menu", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", onClick: pick(onRename), children: sdk.T("重命名", "Rename") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", role: "menuitem", className: "kc-danger", onClick: pick(onDelete), children: sdk.T("删除", "Delete") })
      ] })
    ] });
  }
  function KeychainPanel({ api }) {
    const [data, setData] = react.useState(null);
    const [formOpen, setFormOpen] = react.useState(false);
    const [name, setName] = react.useState("");
    const [value, setValue] = react.useState("");
    const [replacing, setReplacing] = react.useState("");
    const [query, setQuery] = react.useState("");
    const valueRef = react.useRef(null);
    const nameRef = react.useRef(null);
    const { working, run } = sdk.useOperation(api, true);
    async function load() {
      setData(await api.get(""));
    }
    const post = (body) => run(async () => {
      setData(await api.post("", body));
    });
    const items = (data == null ? void 0 : data.items) ?? [];
    const names = new Set(items.map((i) => i.name));
    const nameOk = NAME_RE.test(name.trim());
    const blocked = !!(data == null ? void 0 : data.error);
    const q = query.trim().toLowerCase();
    const shown = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    react.useEffect(() => {
      var _a;
      if (!formOpen) return;
      (_a = (replacing ? valueRef : nameRef).current) == null ? void 0 : _a.focus();
    }, [formOpen, replacing]);
    function closeForm() {
      setFormOpen(false);
      setReplacing("");
      setName("");
      setValue("");
    }
    function openAdd() {
      setReplacing("");
      setName("");
      setValue("");
      setFormOpen(true);
    }
    function startReplace(key) {
      setReplacing(key);
      setName(key);
      setValue("");
      setFormOpen(true);
    }
    async function save() {
      const key = name.trim();
      if (names.has(key) && key !== replacing && !await sdk.confirmDialog({
        title: sdk.T("覆盖密钥", "Overwrite secret"),
        danger: true,
        message: sdk.T(`「${key}」已存在，确定用新值覆盖？`, `"${key}" already exists. Overwrite it with the new value?`)
      })) return;
      if (await post({ action: "set", name: key, value })) closeForm();
    }
    async function remove(key) {
      if (!await sdk.confirmDialog({
        title: sdk.T("删除密钥", "Delete secret"),
        danger: true,
        message: sdk.T(`删除「${key}」后，使用它的插件和工具将无法读取。确定删除？`, `Plugins and tools that use "${key}" will no longer be able to read it. Delete it?`)
      })) return;
      if (replacing === key) closeForm();
      await post({ action: "delete", name: key });
    }
    async function rename(key) {
      const next = await sdk.promptDialog({
        title: sdk.T("重命名密钥", "Rename secret"),
        value: key,
        message: sdk.T("新名称：字母开头，仅字母、数字和下划线。", "New name: starts with a letter; letters, digits and _ only.")
      });
      if (next === null || next.trim() === key) return;
      if (!NAME_RE.test(next.trim())) {
        api.notice(sdk.T("名称不合法", "Invalid name"));
        return;
      }
      if (replacing === key) closeForm();
      await post({ action: "rename", name: key, new_name: next.trim() });
    }
    const form = formOpen && /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "kc-form", autoComplete: "off", onSubmit: (e) => {
      e.preventDefault();
      if (nameOk && value.trim()) void save();
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "kc-form-title", children: replacing ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        sdk.T("替换", "Replace"),
        " ",
        /* @__PURE__ */ jsxRuntime.jsx("code", { children: replacing }),
        " ",
        sdk.T("的值", "value")
      ] }) : sdk.T("添加密钥", "Add secret") }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-fields", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("label", { children: [
          sdk.T("名称", "Name"),
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              ref: nameRef,
              value: name,
              disabled: working || blocked || !!replacing,
              spellCheck: false,
              placeholder: "openai_key",
              "aria-invalid": !!name.trim() && !nameOk,
              onChange: (e) => setName(e.target.value)
            }
          )
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("label", { children: [
          replacing ? sdk.T("新值", "New value") : sdk.T("值", "Value"),
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              ref: valueRef,
              type: "password",
              value,
              disabled: working || blocked,
              autoComplete: "new-password",
              spellCheck: false,
              placeholder: sdk.T("粘贴密钥值", "Paste the secret value"),
              onChange: (e) => setValue(e.target.value)
            }
          )
        ] })
      ] }),
      name.trim() && !nameOk ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "kc-error", children: sdk.T("字母开头，仅字母、数字和下划线，最多 64 个字符。", "Start with a letter; letters, digits and _ only; up to 64 chars.") }) : /* @__PURE__ */ jsxRuntime.jsx("span", { className: "kc-hint", children: replacing ? sdk.T("保存后旧值会被覆盖，无法恢复。", "The old value is overwritten on save and cannot be recovered.") : sdk.T("保存后值不可再查看，只能替换。", "Once saved, the value cannot be viewed again, only replaced.") }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-buttons", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: working, onClick: closeForm, children: sdk.T("取消", "Cancel") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", className: "btn primary", disabled: working || blocked || !nameOk || !value.trim(), children: sdk.T("保存", "Save") })
      ] })
    ] });
    return /* @__PURE__ */ jsxRuntime.jsx(sdk.SettingsPanel, { api, label: sdk.T("密钥串", "Keychain"), icon: "key", order: 43, className: "kc-dialog", onOpen: load, children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-content kc-body", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-head", children: [
        /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T("GA 密钥串", "GA keychain") }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { className: "kc-muted", children: sdk.T(
          "插件和工具按名称读取这里的密钥（例如生图插件的 key_name）。密钥值只写不读，不会在此显示。",
          "Plugins and tools read these secrets by name (for example the image plugin's key_name). Values are write-only and never shown here."
        ) }),
        data && /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "kc-muted kc-path", title: data.path, children: [
          /* @__PURE__ */ jsxRuntime.jsx("code", { children: data.path }),
          !data.exists && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
            " · ",
            sdk.T("尚未创建，保存第一个密钥时创建", "not created yet; created on first save")
          ] })
        ] })
      ] }),
      blocked && /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "kc-error kc-banner", children: [
        data.error,
        /* @__PURE__ */ jsxRuntime.jsx("br", {}),
        sdk.T("为避免覆盖已有密钥，已禁止写入。", "Writes are disabled to avoid overwriting existing secrets.")
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-toolbar", children: [
        items.length > SEARCH_MIN ? /* @__PURE__ */ jsxRuntime.jsx(
          "input",
          {
            type: "search",
            className: "kc-search",
            value: query,
            spellCheck: false,
            placeholder: sdk.T(`搜索 ${items.length} 个密钥`, `Search ${items.length} secrets`),
            "aria-label": sdk.T("搜索密钥", "Search secrets"),
            onChange: (e) => setQuery(e.target.value)
          }
        ) : /* @__PURE__ */ jsxRuntime.jsx("span", { className: "kc-count", children: data ? sdk.T(`${items.length} 个密钥`, `${items.length} secrets`) : "" }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "kc-icon-btn", disabled: working, "aria-label": sdk.T("刷新", "Refresh"), title: sdk.T("刷新", "Refresh"), onClick: () => void run(load), children: /* @__PURE__ */ jsxRuntime.jsxs("svg", { viewBox: "0 0 16 16", width: "15", height: "15", "aria-hidden": "true", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", children: [
          /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.7-4" }),
          /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M13.5 2.5v3h-3" })
        ] }) }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", disabled: working || blocked || formOpen && !replacing, onClick: openAdd, children: sdk.T("添加密钥", "Add secret") })
      ] }),
      form,
      data && !items.length && !blocked && !formOpen && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-empty", children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-ico", "data-i": "key", "aria-hidden": "true" }),
        /* @__PURE__ */ jsxRuntime.jsx("strong", { children: sdk.T("还没有密钥", "No secrets yet") }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "kc-muted", children: sdk.T("添加后，插件可以通过名称引用它，而无需把明文写进配置。", "Once added, plugins can refer to it by name instead of storing it in plain text.") })
      ] }),
      !!items.length && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-list", children: [
        !shown.length && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "kc-muted kc-nomatch", children: sdk.T(`没有名称包含「${query.trim()}」的密钥。`, `No secret names contain "${query.trim()}".`) }),
        shown.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: `kc-row${replacing === item.name ? " active" : ""}`, children: [
          /* @__PURE__ */ jsxRuntime.jsx("code", { className: "kc-name", title: item.name, children: item.name }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "kc-len", children: sdk.T(`${item.length} 字符`, `${item.length} chars`) }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "kc-actions", children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn ghost", disabled: working || blocked, onClick: () => startReplace(item.name), children: sdk.T("替换", "Replace") }),
            /* @__PURE__ */ jsxRuntime.jsx(RowMenu, { disabled: working || blocked, onRename: () => void rename(item.name), onDelete: () => void remove(item.name) })
          ] })
        ] }, item.name))
      ] })
    ] }) });
  }
  sdk.defineReact("keychain", KeychainPanel);
})(GAH.jsxRuntime, GAH.React, GAH);
