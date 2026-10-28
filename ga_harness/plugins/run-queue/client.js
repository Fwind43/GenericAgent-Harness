(function(jsxRuntime, react, sdk) {
  "use strict";
  function QueueList({ api }) {
    const { state } = sdk.useHost();
    const [pending, setPending] = react.useState("");
    const items = state.queue || [];
    const sid = state.session_id;
    if (!sid || !items.length) return null;
    const act = async (path, body) => {
      setPending(String(body.id || ""));
      try {
        await api.post(path, { session_id: sid, ...body });
      } catch (error) {
        api.notice(String((error == null ? void 0 : error.message) || error));
      } finally {
        setPending("");
      }
    };
    const edit = async (item) => {
      const value = await sdk.promptDialog({ title: sdk.T("编辑排队消息", "Edit queued message"), value: item.text, confirm: sdk.T("保存", "Save") });
      if (value != null && value.trim() && value !== item.text) await act("edit", { id: item.id, text: value });
    };
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-queue", "aria-label": sdk.T("消息队列", "Message queue"), children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-queue-head", children: [
        sdk.T("排队中", "Queued"),
        " · ",
        items.length,
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-queue-hint", children: state.running ? sdk.T("当前任务结束后依次发送", "Sent in order after the current task") : sdk.T("任务已停止，可手动发送", "Task stopped; send manually") })
      ] }),
      items.map((item) => {
        const steering = item.state === "steering";
        const busy = pending === item.id;
        return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-queue-item" + (steering ? " steering" : ""), children: [
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "gah-queue-text", title: item.text, children: item.text }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "gah-queue-actions", children: [
            steering ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "gah-queue-tag", children: sdk.T("引导中…", "Steering…") }) : /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              state.running ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: busy, title: sdk.T("在当前任务的下一轮注入，不打断运行", "Inject at the next turn without interrupting"), onClick: () => act("steer", { id: item.id }), children: sdk.T("引导", "Steer") }) : /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: busy, onClick: () => act("send", { id: item.id }), children: sdk.T("发送", "Send") }),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", disabled: busy, onClick: () => edit(item), children: sdk.T("编辑", "Edit") })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "danger", disabled: busy || steering, onClick: () => act("remove", { id: item.id }), children: sdk.T("取消", "Cancel") })
          ] })
        ] }, item.id);
      })
    ] });
  }
  function RunQueue({ api }) {
    react.useEffect(() => api.intercept(async (text) => {
      const state = api.state();
      if (!state.running || !state.session_id) return false;
      await api.post("add", { session_id: state.session_id, text });
      return true;
    }), [api]);
    react.useEffect(() => api.mount("composer-top", /* @__PURE__ */ jsxRuntime.jsx(QueueList, { api })), [api]);
    return null;
  }
  sdk.defineReact("run-queue", RunQueue);
})(GAH.jsxRuntime, GAH.React, GAH);
