(function(jsxRuntime, react, sdk) {
  "use strict";
  const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  function KeychainPanel({ api }) {
    const [data, setData] = react.useState(null);
    const [name, setName] = react.useState("");
    const [value, setValue] = react.useState("");
    const [replacing, setReplacing] = react.useState("");
    const { working, run } = sdk.useOperation(api, true);
    async function load() {
      setData(await api.get(""));
    }
    const post = (body) => run(async () => {
      setData(await api.post("", body));
    });
    const names = new Set(((data == null ? void 0 : data.items) ?? []).map((i) => i.name));
    const nameOk = NAME_RE.test(name.trim());
    const blocked = !!(data == null ? void 0 : data.error);
    async function save() {
      const key = name.trim();
      if (names.has(key) && key !== replacing && !await sdk.confirmDialog({
        title: sdk.T("覆盖密钥", "Overwrite secret"),
        danger: true,
        message: sdk.T(`「${key}」已存在，确定用新值覆盖？`, `"${key}" already exists. Overwrite it with the new value?`)
      })) return;
      if (await post({ action: "set", name: key, value })) {
        setName("");
        setValue("");
        setReplacing("");
      }
    }
    async function remove(key) {
      if (!await sdk.confirmDialog({
        title: sdk.T("删除密钥", "Delete secret"),
        danger: true,
        message: sdk.T(`删除「${key}」后，使用它的插件和工具将无法读取。确定删除？`, `Plugins and tools that use "${key}" will no longer be able to read it. Delete it?`)
      })) return;
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
      await post({ action: "rename", name: key, new_name: next.trim() });
    }
    function startReplace(key) {
      setReplacing(key);
      setName(key);
      setValue("");
    }
    return /* @__PURE__ */ jsxRuntime.jsxs(sdk.SettingsPanel, { api, label: sdk.T("密钥串", "Keychain"), icon: "key", order: 43, className: "kc-dialog", onOpen: load, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-head", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T("GA 密钥串", "GA keychain") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { className: "kc-muted", children: sdk.T(
            "管理 GenericAgent 的密钥串，插件和工具可按名称读取密钥（例如生图插件的 key_name）。密钥值只写不读，不会显示在此页面。",
            "Manage the GenericAgent keychain. Plugins and tools read secrets by name (for example the image plugin's key_name). Values are write-only and never shown here."
          ) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: working, onClick: () => void run(load), children: sdk.T("刷新", "Refresh") })
      ] }),
      data && /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "kc-muted kc-path", children: [
        sdk.T("文件", "File"),
        ": ",
        /* @__PURE__ */ jsxRuntime.jsx("code", { children: data.path }),
        !data.exists && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          " · ",
          sdk.T("尚未创建，保存第一个密钥时创建", "not created yet; created on first save")
        ] })
      ] }),
      blocked && /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "kc-error", children: [
        data.error,
        /* @__PURE__ */ jsxRuntime.jsx("br", {}),
        sdk.T("为避免覆盖已有密钥，已禁止写入。", "Writes are disabled to avoid overwriting existing secrets.")
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-list", children: [
        data && !data.items.length && !blocked && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "kc-muted", children: sdk.T("还没有密钥。", "No secrets yet.") }),
        data == null ? void 0 : data.items.map((item) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-row", children: [
          /* @__PURE__ */ jsxRuntime.jsx("code", { className: "kc-name", children: item.name }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "kc-muted kc-len", children: [
            "•".repeat(Math.min(item.length, 12)),
            " ",
            sdk.T(`${item.length} 字符`, `${item.length} chars`)
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "kc-actions", children: [
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: working || blocked, onClick: () => startReplace(item.name), children: sdk.T("替换", "Replace") }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: working || blocked, onClick: () => void rename(item.name), children: sdk.T("重命名", "Rename") }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn danger", disabled: working || blocked, onClick: () => void remove(item.name), children: sdk.T("删除", "Delete") })
          ] })
        ] }, item.name))
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "kc-form", autoComplete: "off", onSubmit: (e) => {
        e.preventDefault();
        if (nameOk && value.trim()) void save();
      }, children: [
        /* @__PURE__ */ jsxRuntime.jsx("h4", { children: replacing ? sdk.T(`替换「${replacing}」`, `Replace "${replacing}"`) : sdk.T("添加密钥", "Add secret") }),
        /* @__PURE__ */ jsxRuntime.jsxs("label", { children: [
          sdk.T("名称", "Name"),
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              value: name,
              disabled: working || blocked || !!replacing,
              spellCheck: false,
              placeholder: "openai_key",
              onChange: (e) => setName(e.target.value)
            }
          )
        ] }),
        name.trim() && !nameOk && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "kc-error", children: sdk.T("字母开头，仅字母、数字和下划线，最多 64 个字符。", "Start with a letter; letters, digits and _ only; up to 64 chars.") }),
        /* @__PURE__ */ jsxRuntime.jsxs("label", { children: [
          sdk.T("值", "Value"),
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              type: "password",
              value,
              disabled: working || blocked,
              autoComplete: "new-password",
              spellCheck: false,
              onChange: (e) => setValue(e.target.value)
            }
          )
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "kc-buttons", children: [
          replacing && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: working, onClick: () => {
            setReplacing("");
            setName("");
            setValue("");
          }, children: sdk.T("取消", "Cancel") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", className: "btn primary", disabled: working || blocked || !nameOk || !value.trim(), children: sdk.T("保存", "Save") })
        ] })
      ] })
    ] });
  }
  sdk.defineReact("keychain", KeychainPanel);
})(GAH.jsxRuntime, GAH.React, GAH);
