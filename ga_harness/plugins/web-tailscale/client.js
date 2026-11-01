var GAHPlugin_web_tailscale = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  function TailscalePanel({ api }) {
    const { changing } = sdk.useHost();
    const { working, run } = sdk.useOperation(api, true);
    const [data, setData] = react.useState(null);
    const [error, setError] = react.useState("");
    const [pick, setPick] = react.useState(0);
    const busy = working || changing;
    const load = () => run(async () => {
      setError("");
      setData(await api.get(""));
    }, setError, true);
    const act = (action) => run(async () => {
      setError("");
      setData(await api.post("", { action }));
    }, setError, true);
    const resetToken = async () => {
      if (!await sdk.confirmDialog({
        title: sdk.T("重置访问 token", "Reset access token"),
        danger: true,
        message: sdk.T(
          "旧链接和所有已登录的设备都会失效，需要用新链接重新打开。继续？",
          "Old links and every signed-in device will stop working until reopened with the new link. Continue?"
        )
      })) return;
      void act("reset_token");
    };
    const ts = data == null ? void 0 : data.tailscale;
    const entries = (data == null ? void 0 : data.entries) || [], urls = (data == null ? void 0 : data.urls) || [];
    const index = Math.min(pick, Math.max(entries.length - 1, 0));
    const entry = entries[index] || "";
    const state = !data ? sdk.T("加载中…", "Loading…") : data.active ? sdk.T("转发中", "Forwarding") : !(ts == null ? void 0 : ts.installed) ? sdk.T("未找到 tailscale", "tailscale not found") : !ts.running ? sdk.T(`Tailscale 未连接（${ts.backend || "未知"}）`, `Tailscale not connected (${ts.backend || "unknown"})`) : sdk.T("未开启", "Off");
    return /* @__PURE__ */ jsxRuntime.jsxs(sdk.SettingsPanel, { api, label: sdk.T("远程访问", "Remote access"), icon: "globe", order: 40, className: "ts-dialog", onOpen: load, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-head ts-head", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("h2", { children: "Tailscale" }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: sdk.T(
            "通过 tailnet 从手机或其他电脑访问本机网页界面；只监听 tailnet IP，强制 token。",
            "Open this web UI from phones or other computers on your tailnet. Listens on tailnet IPs only; a token is always required."
          ) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: busy, onClick: () => void load(), children: sdk.T("刷新", "Refresh") })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ts-body", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "ts-card", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ts-row", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: `ts-dot${(data == null ? void 0 : data.active) ? " on" : ""}` }),
            /* @__PURE__ */ jsxRuntime.jsx("b", { children: state }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ts-spacer" }),
            (data == null ? void 0 : data.active) ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: busy, onClick: () => void act("stop"), children: sdk.T("停止", "Stop") }) : /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", disabled: busy || !(ts == null ? void 0 : ts.running), onClick: () => void act("start"), children: sdk.T("开启远程访问", "Enable remote access") })
          ] }),
          ts && /* @__PURE__ */ jsxRuntime.jsxs("dl", { className: "ts-meta", children: [
            ts.hostname && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("设备", "Device") }),
              /* @__PURE__ */ jsxRuntime.jsx("dd", { children: ts.hostname })
            ] }),
            ts.dns && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: "MagicDNS" }),
              /* @__PURE__ */ jsxRuntime.jsx("dd", { children: ts.dns })
            ] }),
            ts.ips.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: "Tailnet IP" }),
              /* @__PURE__ */ jsxRuntime.jsx("dd", { children: ts.ips.join(" · ") })
            ] }),
            (data == null ? void 0 : data.port) && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("端口", "Port") }),
              /* @__PURE__ */ jsxRuntime.jsxs("dd", { children: [
                data.port,
                data.web_port && data.port !== data.web_port ? ` → 127.0.0.1:${data.web_port}` : ""
              ] })
            ] })
          ] }),
          (error || (data == null ? void 0 : data.error)) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "ts-error", children: error || (data == null ? void 0 : data.error) })
        ] }),
        (data == null ? void 0 : data.active) && entry && /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "ts-card ts-entry", children: [
          /* @__PURE__ */ jsxRuntime.jsx(sdk.QrCode, { value: entry, className: "ts-qr", label: sdk.T("入口二维码", "Entry QR code") }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ts-links", children: [
            urls.length > 1 && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "ts-tabs", children: urls.map((u, i) => /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: `btn${i === index ? " primary" : ""}`, onClick: () => setPick(i), children: u.replace(/^http:\/\/|\/$/g, "") }, u)) }),
            /* @__PURE__ */ jsxRuntime.jsx("code", { className: "ts-url", children: entry }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ts-actions", children: [
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", onClick: () => void sdk.copyText(entry).then((ok) => api.notice(ok ? sdk.T("已复制入口链接", "Entry link copied") : sdk.T("复制失败", "Copy failed"))), children: sdk.T("复制链接", "Copy link") }),
              /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn danger", disabled: busy, onClick: () => void resetToken(), children: sdk.T("重置 token", "Reset token") })
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T(
              "用同一 tailnet 内的设备扫码或打开链接；链接含 token，请勿外传。",
              "Scan or open from a device on the same tailnet. The link contains the token; do not share it."
            ) })
          ] })
        ] })
      ] })
    ] });
  }
  sdk.defineReact("web-tailscale", TailscalePanel);
  exports.TailscalePanel = TailscalePanel;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
