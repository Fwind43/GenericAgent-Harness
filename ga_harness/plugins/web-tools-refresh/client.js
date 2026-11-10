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
    const running = !!state.running;
    const send = async () => {
      if (busy || !running) return;
      setBusy(true);
      api.notice();
      try {
        await api.post("refresh", { session_id: sid });
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
        disabled: busy || !running,
        onClick: send,
        title: running ? sdk.T(
          "让正在运行的任务下一次模型调用重新完整注入工具定义，不发送消息（模型把工具调用写进正文时使用）",
          "The running task's next model call resends the full tool definitions; no message is sent (use when the model writes tool calls as text)"
        ) : sdk.T(
          "仅在任务运行中可用；每次新任务开始时本来就会完整注入",
          "Only while a task is running; every new task already starts with the full definitions"
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
