(function(jsxRuntime, react, sdk) {
  "use strict";
  const Icon = () => /* @__PURE__ */ jsxRuntime.jsxs(
    "svg",
    {
      className: "gah-tr-icon",
      viewBox: "0 0 16 16",
      width: "16",
      height: "16",
      "aria-hidden": "true",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      children: [
        /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M13 8a5 5 0 1 1-1.5-3.5" }),
        /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M13 2.5v3h-3" })
      ]
    }
  );
  function RefreshButton({ api }) {
    const { state } = sdk.useHost();
    const [busy, setBusy] = react.useState(false);
    const sid = state.session_id;
    if (!sid) return null;
    const send = async () => {
      if (busy || state.running) return;
      setBusy(true);
      api.notice();
      try {
        await api.host.post("/api/run", { task: "/tools", session_id: sid, attachments: [] });
      } catch (error) {
        api.notice(error instanceof Error ? error.message : String(error));
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
        disabled: busy || state.running,
        onClick: send,
        title: sdk.T(
          "重新完整注入工具定义并继续任务（模型把工具调用写进正文时使用）",
          "Resend the full tool definitions and continue (use when the model writes tool calls as text)"
        ),
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(Icon, {}),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("刷新工具定义", "Refresh tool definitions") })
        ]
      }
    );
  }
  function ToolsRefreshPlugin({ api }) {
    react.useEffect(() => api.mount("composer-menu", /* @__PURE__ */ jsxRuntime.jsx(RefreshButton, { api })), [api]);
    return null;
  }
  sdk.defineReact("web-tools-refresh", ToolsRefreshPlugin);
})(GAH.jsxRuntime, GAH.React, GAH);
