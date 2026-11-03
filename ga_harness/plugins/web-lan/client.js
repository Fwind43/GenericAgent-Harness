var GAHPlugin_web_lan = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const ANY = "0.0.0.0";
  function LanPanel({ api }) {
    const { changing } = sdk.useHost();
    const { working, run } = sdk.useOperation(api, true);
    const [data, setData] = react.useState(null);
    const [error, setError] = react.useState("");
    const [pick, setPick] = react.useState(0);
    const [bind, setBind] = react.useState("");
    const busy = working || changing;
    const load = () => run(async () => {
      setError("");
      setData(await api.get(""));
    }, setError, true);
    const act = (action, extra = {}) => run(async () => {
      setError("");
      setData(await api.post("", { action, ...extra }));
    }, setError, true);
    const reconnecting = !!(data == null ? void 0 : data.reconnecting);
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
    const lan = data == null ? void 0 : data.lan;
    const chosen = (lan == null ? void 0 : lan.fixed) ? lan.binds[0] || "" : bind && (bind === ANY || (lan == null ? void 0 : lan.ips.includes(bind))) ? bind : (lan == null ? void 0 : lan.binds[0]) || "";
    const entries = (data == null ? void 0 : data.entries) || [], urls = (data == null ? void 0 : data.urls) || [];
    const index = Math.min(pick, Math.max(entries.length - 1, 0));
    const entry = entries[index] || "";
    const state = !data ? sdk.T("加载中…", "Loading…") : data.active ? sdk.T("转发中", "Forwarding") : data.reconnecting ? sdk.T(
      `正在自动重连${data.retry_in ? `（${data.retry_in} 秒后重试）` : "…"}`,
      `Reconnecting automatically${data.retry_in ? ` (retry in ${data.retry_in}s)` : "…"}`
    ) : !chosen ? sdk.T("未找到局域网地址", "No LAN address") : sdk.T("未开启", "Off");
    return /* @__PURE__ */ jsxRuntime.jsxs(sdk.SettingsPanel, { api, label: sdk.T("局域网访问", "LAN access"), icon: "globe", order: 41, className: "ts-dialog", onOpen: load, children: [
      /* @__PURE__ */ jsxRuntime.jsx(Poll, { api, fast: reconnecting, onData: setData }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-head ts-head", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("h2", { children: sdk.T("局域网", "LAN") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: sdk.T(
            "让同一 Wi-Fi / 局域网内的手机或电脑访问本机网页界面；只监听所选局域网 IP，仅放行内网地址，强制 token。",
            "Open this web UI from phones or computers on the same Wi-Fi/LAN. Listens on the chosen LAN IP, admits private addresses only; a token is always required."
          ) })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: busy, onClick: () => void load(), children: sdk.T("刷新", "Refresh") })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ts-body", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "ts-card", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ts-row", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: `ts-dot${(data == null ? void 0 : data.active) ? " on" : reconnecting ? " wait" : ""}` }),
            /* @__PURE__ */ jsxRuntime.jsx("b", { children: state }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ts-spacer" }),
            (data == null ? void 0 : data.active) || reconnecting ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: busy, onClick: () => void act("stop"), children: reconnecting ? sdk.T("停止重试", "Stop retrying") : sdk.T("停止", "Stop") }) : /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", disabled: busy || !chosen, onClick: () => void act("start", (lan == null ? void 0 : lan.fixed) ? {} : { bind: chosen }), children: sdk.T("开启局域网访问", "Enable LAN access") })
          ] }),
          lan && /* @__PURE__ */ jsxRuntime.jsxs("dl", { className: "ts-meta", children: [
            lan.hostname && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("设备", "Device") }),
              /* @__PURE__ */ jsxRuntime.jsx("dd", { children: lan.hostname })
            ] }),
            lan.ips.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("局域网 IP", "LAN IP") }),
              /* @__PURE__ */ jsxRuntime.jsx("dd", { children: (data == null ? void 0 : data.active) || lan.fixed ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
                ((data == null ? void 0 : data.active) ? urls.map((u) => u.replace(/^http:\/\/|:\d+\/?$/g, "")) : lan.hosts).join(" · "),
                lan.binds[0] === ANY && /* @__PURE__ */ jsxRuntime.jsx("small", { className: "ts-note", children: sdk.T("（监听 0.0.0.0，所有网卡）", " (listening on 0.0.0.0, all interfaces)") })
              ] }) : /* @__PURE__ */ jsxRuntime.jsxs("select", { className: "ts-select", value: chosen, disabled: busy, onChange: (e) => setBind(e.target.value), children: [
                lan.ips.map((ip) => /* @__PURE__ */ jsxRuntime.jsx("option", { value: ip, children: ip }, ip)),
                /* @__PURE__ */ jsxRuntime.jsx("option", { value: ANY, children: sdk.T("0.0.0.0（所有网卡）", "0.0.0.0 (all interfaces)") })
              ] }) })
            ] }),
            !!(data == null ? void 0 : data.restarts) && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("自动恢复", "Auto-recovered") }),
              /* @__PURE__ */ jsxRuntime.jsx("dd", { children: sdk.T(`${data.restarts} 次`, `${data.restarts}×`) })
            ] }),
            (data == null ? void 0 : data.port) && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("端口", "Port") }),
              /* @__PURE__ */ jsxRuntime.jsxs("dd", { children: [
                data.port,
                data.web_port && data.port !== data.web_port ? ` → 127.0.0.1:${data.web_port}` : ""
              ] })
            ] })
          ] }),
          chosen === ANY && !(data == null ? void 0 : data.active) && !(lan == null ? void 0 : lan.fixed) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "ts-hint", children: sdk.T(
            "监听所有网卡（含虚拟网卡）；仍只放行内网来源。",
            "Listens on every interface (virtual ones included); only private peers are still admitted."
          ) }),
          (error || (data == null ? void 0 : data.error) || (lan == null ? void 0 : lan.error)) && /* @__PURE__ */ jsxRuntime.jsx("p", { className: "ts-error", children: error || (data == null ? void 0 : data.error) || (lan == null ? void 0 : lan.error) })
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
              "用同一局域网内的设备扫码或打开链接；链接含 token，请勿外传。若打不开，检查系统防火墙是否放行该端口。",
              "Scan or open from a device on the same LAN. The link contains the token; do not share it. If it does not load, allow the port in the OS firewall."
            ) })
          ] })
        ] })
      ] })
    ] });
  }
  function Poll({ api, fast, onData }) {
    react.useEffect(() => {
      const timer = window.setInterval(() => {
        if (document.visibilityState === "visible") api.get("").then(onData, () => void 0);
      }, fast ? 3e3 : 15e3);
      return () => window.clearInterval(timer);
    }, [api, fast, onData]);
    return null;
  }
  sdk.defineReact("web-lan", LanPanel);
  exports.LanPanel = LanPanel;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
