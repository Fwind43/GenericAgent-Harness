(function(jsxRuntime, react, sdk) {
  "use strict";
  const errText = (error) => error instanceof Error ? error.message : String(error);
  const Icon = () => /* @__PURE__ */ jsxRuntime.jsxs("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinejoin: "round", children: [
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M7 1.8 8.3 5.7 12.2 7 8.3 8.3 7 12.2 5.7 8.3 1.8 7 5.7 5.7Z" }),
    /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M12.6 10.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6Z" })
  ] });
  function MenuItem({ api }) {
    const { state } = sdk.useHost();
    const sid = state.session_id;
    const [busy, setBusy] = react.useState(false);
    if (!sid) return null;
    const generate = async () => {
      setBusy(true);
      try {
        await api.post("generate", { session_id: sid });
      } catch (error) {
        api.notice(errText(error));
      } finally {
        setBusy(false);
      }
    };
    return /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        role: "menuitem",
        className: "gah-menu-item",
        disabled: busy,
        onClick: () => void generate(),
        title: sdk.T("用 AI 为当前会话重新生成标题", "Regenerate this session's title with AI"),
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: busy ? sdk.T("正在生成标题…", "Generating title…") : sdk.T("AI 生成标题", "AI title") })
        ]
      }
    );
  }
  function SessionTitlePlugin({ api }) {
    react.useEffect(() => api.mount("composer-menu", /* @__PURE__ */ jsxRuntime.jsx(MenuItem, { api })), [api]);
    return null;
  }
  sdk.defineReact("session-title", SessionTitlePlugin);
})(GAH.jsxRuntime, GAH.React, GAH);
