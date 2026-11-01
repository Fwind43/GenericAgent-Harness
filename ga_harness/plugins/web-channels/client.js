var GAHPlugin_web_channels = (function(exports, jsxRuntime, react, sdk) {
  "use strict";
  const label = (x) => sdk.T(x.label_zh || x.label, x.label);
  const time = (t) => new Date(t * 1e3).toLocaleTimeString();
  const STATES = {
    running: ["运行中", "Running"],
    starting: ["启动中", "Starting"],
    stopped: ["已停止", "Stopped"],
    error: ["出错", "Error"],
    unavailable: ["接入插件未加载", "Provider not loaded"]
  };
  const stateKind = (c) => c.available ? c.state : "unavailable";
  const stateText = (c) => {
    const state = stateKind(c), text = STATES[state];
    return text ? sdk.T(...text) : state;
  };
  function Status({ channel }) {
    return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "channel-state", "data-state": stateKind(channel), children: [
      /* @__PURE__ */ jsxRuntime.jsx("i", { "aria-hidden": "true" }),
      stateText(channel)
    ] });
  }
  function Logs({ api, id }) {
    const [lines, setLines] = react.useState([]);
    const box = react.useRef(null), last = react.useRef(0);
    react.useEffect(() => {
      let stop = false;
      last.current = 0;
      setLines([]);
      const tick = async () => {
        try {
          const res = await api.get(`?logs=${encodeURIComponent(id)}&after=${last.current}`);
          if (stop || !res.logs.length) return;
          last.current = res.logs[res.logs.length - 1].t;
          setLines((prev) => prev.concat(res.logs).slice(-500));
        } catch {
        }
      };
      void tick();
      const timer = window.setInterval(() => void tick(), 2e3);
      return () => {
        stop = true;
        window.clearInterval(timer);
      };
    }, [api, id]);
    react.useEffect(() => {
      const el = box.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [lines]);
    return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-logs", ref: box, role: "region", "aria-label": sdk.T("通道日志", "Channel logs"), tabIndex: 0, children: lines.length ? lines.map((line, index) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-log", "data-level": line.level, children: [
      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-log-time", children: time(line.t) }),
      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-log-text", children: line.text })
    ] }, index)) : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-log-empty", children: sdk.T("暂无日志", "No logs yet") }) });
  }
  function BindingsPanel({ api, id }) {
    const [view, setView] = react.useState(null);
    const [error, setError] = react.useState(""), [saving, setSaving] = react.useState(null);
    const load = async () => {
      try {
        setView(await api.get(`?bindings=${encodeURIComponent(id)}`));
        setError("");
      } catch (e) {
        setError(String((e == null ? void 0 : e.message) || e));
      }
    };
    react.useEffect(() => {
      setView(null);
      void load();
      const timer = window.setInterval(() => void load(), 5e3);
      return () => window.clearInterval(timer);
    }, [api, id]);
    const bind = async (chat, session) => {
      setSaving(chat);
      setError("");
      try {
        setView(await api.post("", { action: "bind", id, chat, session }));
      } catch (e) {
        setError(String((e == null ? void 0 : e.message) || e));
      } finally {
        setSaving(null);
      }
    };
    const name = (title) => (title || "").trim() || sdk.T("新会话", "New session");
    return /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "channel-bindings", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-bindings-head", children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("会话绑定", "Session bindings") }),
        /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("也可在聊天中发送 /sessions、/use <编号>", "Or send /sessions, /use <n> in the chat") })
      ] }),
      error && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-bindings-error", role: "alert", children: error }),
      !view ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-bindings-empty", children: sdk.T("加载中…", "Loading…") }) : !view.chats.length ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-bindings-empty", children: sdk.T("还没有聊天发过消息，收到第一条消息后会自动绑定新会话。", "No chat has messaged this channel yet; the first message creates and binds a session.") }) : view.chats.map((row) => /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "channel-binding", children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-binding-chat", title: row.chat, children: row.chat }),
        /* @__PURE__ */ jsxRuntime.jsxs(
          "select",
          {
            value: row.session_id,
            disabled: saving === row.chat || row.running,
            title: row.running ? sdk.T("任务运行中，结束后才能切换", "A task is running; switch after it ends") : void 0,
            onChange: (event) => void bind(row.chat, event.currentTarget.value),
            children: [
              row.missing && /* @__PURE__ */ jsxRuntime.jsx("option", { value: row.session_id, children: sdk.T("（会话已删除）", "(session deleted)") }),
              view.sessions.map((s) => /* @__PURE__ */ jsxRuntime.jsxs("option", { value: s.id, disabled: s.running && s.id !== row.session_id, children: [
                name(s.title),
                s.running ? sdk.T(" · 运行中", " · running") : ""
              ] }, s.id))
            ]
          }
        )
      ] }, row.chat))
    ] });
  }
  function LogPanel({ api, id }) {
    const [expanded, setExpanded] = react.useState(false);
    return /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "channel-log-panel", onToggle: (event) => setExpanded(event.currentTarget.open), children: [
      /* @__PURE__ */ jsxRuntime.jsxs("summary", { children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("运行日志", "Activity logs") }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-log-hint", children: expanded ? sdk.T("每 2 秒更新", "Updates every 2s") : sdk.T("展开查看", "Show logs") })
      ] }),
      expanded && /* @__PURE__ */ jsxRuntime.jsx(Logs, { api, id })
    ] });
  }
  const PAIR_STATES = {
    starting: ["正在获取二维码…", "Fetching QR code…"],
    wait: ["请用手机扫码", "Scan with your phone"],
    scaned: ["已扫码，请在手机上确认", "Scanned — confirm on your phone"],
    expired: ["二维码已过期，正在刷新…", "QR expired, refreshing…"],
    done: ["已连接", "Connected"],
    error: ["扫码失败", "Login failed"],
    cancelled: ["已取消", "Cancelled"]
  };
  const PAIR_FINAL = /* @__PURE__ */ new Set(["done", "error", "cancelled"]);
  function PairView({ api, provider, channel, id, onDone, onCancel }) {
    const [pairing, setPairing] = react.useState(null), [error, setError] = react.useState("");
    const [attempt, setAttempt] = react.useState(0);
    const live = react.useRef(null);
    react.useEffect(() => {
      let stop = false, timer = 0;
      setPairing(null);
      setError("");
      const body = channel ? { action: "pair_begin", channel: channel.id } : { action: "pair_begin", provider: provider.kind, ...id ? { id } : {} };
      const show = (view) => {
        if (stop) return;
        setPairing(view);
        if (PAIR_FINAL.has(view.status)) {
          live.current = null;
          if (view.status === "done" && view.result) onDone(view.result);
          return;
        }
        timer = window.setTimeout(() => void poll(view.id), 1500);
      };
      const poll = async (pid) => {
        try {
          show((await api.post("", { action: "pair_poll", pairing: pid })).pairing);
        } catch (e) {
          if (!stop) {
            setError(String((e == null ? void 0 : e.message) || e));
            live.current = null;
          }
        }
      };
      void (async () => {
        try {
          const view = (await api.post("", body)).pairing;
          live.current = view.id;
          show(view);
        } catch (e) {
          if (!stop) setError(String((e == null ? void 0 : e.message) || e));
        }
      })();
      return () => {
        stop = true;
        window.clearTimeout(timer);
        if (live.current) void api.post("", { action: "pair_cancel", pairing: live.current }).catch(() => void 0);
        live.current = null;
      };
    }, [api, provider.kind, channel == null ? void 0 : channel.id, id, attempt]);
    const status = error ? "error" : (pairing == null ? void 0 : pairing.status) || "starting";
    const text = PAIR_STATES[status];
    const failed = status === "error" || status === "cancelled";
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-pair", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-section-heading", children: [
        /* @__PURE__ */ jsxRuntime.jsx("h3", { children: sdk.T(`扫码连接${label(provider)}`, `Connect ${label(provider)} by QR`) }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { children: sdk.T("用手机扫描下方二维码并确认，完成后自动保存并启动通道。", "Scan the code below with your phone and confirm. The channel is saved and started automatically.") })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-pair-body", "data-status": status, children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-qr-box", children: (pairing == null ? void 0 : pairing.qr) && !failed ? /* @__PURE__ */ jsxRuntime.jsx(sdk.QrCode, { value: pairing.qr, className: "channel-qr", label: sdk.T("登录二维码", "Login QR code") }) : /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-qr-placeholder", children: failed ? "×" : /* @__PURE__ */ jsxRuntime.jsx("i", { className: "channel-spinner", "aria-hidden": "true" }) }) }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-pair-status", role: "status", "aria-live": "polite", children: [
          /* @__PURE__ */ jsxRuntime.jsx("strong", { children: text ? sdk.T(text[0], text[1]) : status }),
          (pairing == null ? void 0 : pairing.text) && !failed && /* @__PURE__ */ jsxRuntime.jsx("small", { children: pairing.text }),
          (pairing == null ? void 0 : pairing.qr) && !failed && /^https?:/.test(pairing.qr) && /* @__PURE__ */ jsxRuntime.jsx("a", { href: pairing.qr, target: "_blank", rel: "noreferrer", children: sdk.T("在浏览器中打开", "Open in browser") })
        ] })
      ] }),
      (error || (pairing == null ? void 0 : pairing.error)) && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-error", role: "alert", children: error || (pairing == null ? void 0 : pairing.error) }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-form-actions", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", onClick: onCancel, children: sdk.T("返回", "Back") }),
        failed && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", onClick: () => setAttempt((n) => n + 1), children: sdk.T("重新获取二维码", "Get a new QR code") })
      ] })
    ] });
  }
  function ChannelForm({ api, providers, channel, busy, onSave, onCancel, onPaired }) {
    var _a;
    const [kind, setKind] = react.useState((channel == null ? void 0 : channel.provider) || ((_a = providers[0]) == null ? void 0 : _a.kind) || "");
    const [id, setId] = react.useState("");
    const provider = providers.find((p) => p.kind === kind);
    const [values, setValues] = react.useState(() => ({ ...(channel == null ? void 0 : channel.config) || {} }));
    const set = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));
    const [pairing, setPairing] = react.useState(false);
    const submit = (event) => {
      event.preventDefault();
      const config = {};
      for (const field of (provider == null ? void 0 : provider.fields) || []) config[field.key] = values[field.key] ?? "";
      onSave(channel ? { action: "update", id: channel.id, config } : { action: "create", provider: kind, id: id.trim(), config });
    };
    if (pairing && provider) return /* @__PURE__ */ jsxRuntime.jsx(
      PairView,
      {
        api,
        provider,
        channel,
        id: id.trim() || void 0,
        onDone: onPaired,
        onCancel: () => setPairing(false)
      }
    );
    return /* @__PURE__ */ jsxRuntime.jsxs("form", { className: "channel-form", onSubmit: submit, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-section-heading", children: [
        /* @__PURE__ */ jsxRuntime.jsx("h3", { children: channel ? sdk.T("编辑通道", "Edit channel") : sdk.T("新建通道", "New channel") }),
        /* @__PURE__ */ jsxRuntime.jsx("p", { children: channel ? sdk.T("更新连接配置，已保存的密钥无需重新填写。", "Update the connection settings. Saved secrets can be left unchanged.") : sdk.T("选择接入类型并填写连接信息，保存后即可启动。", "Choose a provider and enter its connection settings, then save to get started.") })
      ] }),
      !channel && /* @__PURE__ */ jsxRuntime.jsxs("fieldset", { className: "channel-provider-picker", disabled: busy, children: [
        /* @__PURE__ */ jsxRuntime.jsx("legend", { children: sdk.T("接入类型", "Provider") }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-provider-options", children: providers.map((option) => /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "channel-provider-option", "data-selected": kind === option.kind, children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              type: "radio",
              name: "channel-provider",
              value: option.kind,
              checked: kind === option.kind,
              onChange: () => {
                setKind(option.kind);
                setValues({});
              }
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("strong", { children: label(option) }),
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: option.kind })
          ] })
        ] }, option.kind)) })
      ] }),
      (provider == null ? void 0 : provider.pairable) && /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-pair-offer", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("strong", { children: sdk.T("扫码一键连接", "One-tap QR login") }),
          /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("无需手动填写密钥，用手机扫码即可自动配置。", "Skip the credentials: scan with your phone to configure automatically.") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", disabled: busy, onClick: () => setPairing(true), children: channel ? sdk.T("重新扫码", "Scan again") : sdk.T("扫码连接", "Scan to connect") })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-fields", children: ((provider == null ? void 0 : provider.fields) || []).map((field) => {
        const stored = !!(channel == null ? void 0 : channel.secrets_set.includes(field.key));
        return /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "channel-field", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
            label(field),
            field.required && /* @__PURE__ */ jsxRuntime.jsx("em", { "aria-hidden": "true", children: "*" })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              type: field.secret ? "password" : "text",
              autoComplete: "off",
              spellCheck: false,
              disabled: busy,
              required: field.required && !(field.secret && stored),
              value: values[field.key] ?? "",
              placeholder: field.secret && stored ? sdk.T("已保存", "Saved") : field.default || "",
              onChange: (event) => set(field.key, event.target.value)
            }
          ),
          field.secret && stored && /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("留空即可保留现有密钥。", "Leave empty to keep the saved secret.") })
        ] }, field.key);
      }) }),
      !channel && /* @__PURE__ */ jsxRuntime.jsxs("details", { className: "channel-advanced", children: [
        /* @__PURE__ */ jsxRuntime.jsx("summary", { children: sdk.T("高级设置", "Advanced settings") }),
        /* @__PURE__ */ jsxRuntime.jsxs("label", { className: "channel-field", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
            sdk.T("通道 ID", "Channel ID"),
            " ",
            /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("可选", "Optional") })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx(
            "input",
            {
              value: id,
              disabled: busy,
              placeholder: `${kind}-xxxxxx`,
              pattern: "[a-z0-9][a-z0-9_\\-]{0,31}",
              maxLength: 32,
              autoComplete: "off",
              spellCheck: false,
              onChange: (event) => setId(event.target.value)
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsx("small", { children: sdk.T("留空自动生成。可使用小写字母、数字、下划线和短横线，以字母或数字开头。", "Generated automatically if empty. Use lowercase letters, digits, underscores or hyphens; start with a letter or digit.") })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-form-actions", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: busy, onClick: onCancel, children: sdk.T("取消", "Cancel") }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "submit", className: "btn primary", disabled: busy || !provider, children: channel ? sdk.T("保存更改", "Save changes") : sdk.T("创建通道", "Create channel") })
      ] })
    ] });
  }
  function ChannelDetail({ api, channel, provider, busy, onAct, onEdit, onRemove }) {
    const active = channel.state === "running" || channel.state === "starting";
    return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-profile", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-profile-heading", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("p", { className: "channel-eyebrow", children: provider ? label(provider) : channel.provider }),
            /* @__PURE__ */ jsxRuntime.jsx("h3", { children: channel.name || channel.id })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx(Status, { channel })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-controls", children: [
          active ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", disabled: busy, onClick: () => onAct("stop"), children: sdk.T("停止通道", "Stop channel") }) : /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn primary", disabled: busy || !channel.available, onClick: () => onAct("start"), children: sdk.T("启动通道", "Start channel") }),
          /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn", disabled: busy || !channel.available, onClick: () => onAct("restart"), children: sdk.T("重启", "Restart") }),
          channel.since && /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "channel-since", children: [
            sdk.T("状态更新于", "Updated"),
            " ",
            new Date(channel.since * 1e3).toLocaleString()
          ] })
        ] })
      ] }),
      !channel.available && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-notice", role: "status", children: sdk.T("接入插件尚未加载。请在插件管理中启用对应插件，即可编辑或启动此通道。", "This provider is not loaded. Enable it in Plugins to edit or start this channel.") }),
      channel.error && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-error", role: "alert", children: channel.error }),
      /* @__PURE__ */ jsxRuntime.jsxs("section", { className: "channel-config", "aria-label": sdk.T("连接配置", "Connection settings"), children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-section-title", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h4", { children: sdk.T("连接配置", "Connection settings") }),
          /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "btn channel-edit", disabled: busy || !channel.available, onClick: onEdit, children: [
            /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "pen" }),
            sdk.T("编辑", "Edit")
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("dl", { className: "channel-config-rows", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("dt", { children: sdk.T("通道 ID", "Channel ID") }),
            /* @__PURE__ */ jsxRuntime.jsx("dd", { children: /* @__PURE__ */ jsxRuntime.jsx("code", { children: channel.id }) })
          ] }),
          ((provider == null ? void 0 : provider.fields) || []).map((field) => /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("dt", { children: label(field) }),
            /* @__PURE__ */ jsxRuntime.jsx("dd", { children: field.secret ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-secret", children: channel.secrets_set.includes(field.key) ? sdk.T("已配置", "Configured") : sdk.T("未配置", "Not configured") }) : channel.config[field.key] || /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-value-empty", children: sdk.T("未设置", "Not set") }) })
          ] }, field.key))
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(BindingsPanel, { api, id: channel.id }),
      /* @__PURE__ */ jsxRuntime.jsx(LogPanel, { api, id: channel.id }, channel.id),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-detail-footer", children: /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "channel-delete", disabled: busy, onClick: onRemove, children: [
        /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "trash" }),
        sdk.T("删除通道", "Delete channel")
      ] }) })
    ] });
  }
  function ChannelManager({ api }) {
    const { changing } = sdk.useHost();
    const { working, run } = sdk.useOperation(api, true);
    const [data, setData] = react.useState(null);
    const [selected, setSelected] = react.useState(null), [editing, setEditing] = react.useState(null);
    const [error, setError] = react.useState("");
    const busy = working || changing;
    const load = () => run(async () => {
      setError("");
      setData(await api.get(""));
    }, (message) => {
      setError(message);
      api.notice(message);
    }, true);
    const act = (body, after) => run(async () => {
      setError("");
      const snapshot = await api.post("", body);
      setData(snapshot);
      after == null ? void 0 : after(snapshot);
    }, setError, true);
    const remove = async (channel) => {
      if (!await sdk.confirmDialog({
        title: sdk.T("删除通道", "Delete channel"),
        danger: true,
        message: sdk.T(`停止并删除通道 ${channel.id}？其配置和密钥将被清除。`, `Stop and delete channel ${channel.id}? Its config and secrets will be removed.`)
      })) return;
      void act({ action: "delete", id: channel.id }, () => setSelected(null));
    };
    const channels = (data == null ? void 0 : data.channels) || [], providers = (data == null ? void 0 : data.providers) || [];
    const current = channels.find((channel) => channel.id === selected) || channels[0] || null;
    const edited = (editing == null ? void 0 : editing.kind) === "edit" ? channels.find((channel) => channel.id === editing.id) : void 0;
    const running = channels.filter((channel) => channel.available && channel.state === "running").length;
    const create = () => {
      setEditing({ kind: "new" });
      setError("");
    };
    const save = (body) => void act(body, (snapshot) => {
      var _a;
      if ((editing == null ? void 0 : editing.kind) === "new") {
        setSelected(((_a = snapshot.channels.find((channel) => !channels.some((old) => old.id === channel.id))) == null ? void 0 : _a.id) || null);
      }
      setEditing(null);
    });
    return /* @__PURE__ */ jsxRuntime.jsx(jsxRuntime.Fragment, { children: /* @__PURE__ */ jsxRuntime.jsxs(sdk.SettingsPanel, { api, label: sdk.T("通道", "Channels"), icon: "channels", order: 20, className: "channel-dialog", onOpen: load, children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "dialog-head channel-dialog-head", children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-heading", children: [
          /* @__PURE__ */ jsxRuntime.jsx("h2", { children: sdk.T("通道管理", "Channels") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: channels.length ? sdk.T(`${channels.length} 个通道 · ${running} 个运行中`, `${channels.length} channels · ${running} running`) : sdk.T("管理消息接入与通道运行状态", "Manage your messaging connections") })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-header-actions", children: !editing && channels.length > 0 && /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "btn channel-refresh", disabled: busy, onClick: () => void load(), children: sdk.T("刷新", "Refresh") }) })
      ] }),
      error && /* @__PURE__ */ jsxRuntime.jsx("div", { className: "channel-error channel-page-error", role: "alert", children: error }),
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-body", "data-has-channels": channels.length > 0, children: [
        channels.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs("aside", { className: "channel-list", "aria-label": sdk.T("通道列表", "Channel list"), children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-list-heading", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: sdk.T("全部通道", "All channels") }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { children: channels.length })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx("nav", { className: "channel-items", "aria-label": sdk.T("选择通道", "Choose a channel"), children: channels.map((channel) => {
            const provider = providers.find((option) => option.kind === channel.provider);
            return /* @__PURE__ */ jsxRuntime.jsxs(
              "button",
              {
                type: "button",
                className: "channel-item",
                disabled: busy,
                "aria-pressed": !editing && (current == null ? void 0 : current.id) === channel.id,
                onClick: () => {
                  setSelected(channel.id);
                  setEditing(null);
                  setError("");
                },
                children: [
                  /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-item-name", children: channel.name || channel.id }),
                  /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-item-provider", children: provider ? label(provider) : channel.provider }),
                  /* @__PURE__ */ jsxRuntime.jsx(Status, { channel })
                ]
              },
              channel.id
            );
          }) }),
          /* @__PURE__ */ jsxRuntime.jsxs(
            "button",
            {
              type: "button",
              className: "btn channel-new",
              disabled: busy || !providers.length,
              title: !providers.length ? sdk.T("请先在插件管理中启用接入插件", "Enable a provider in Plugins first") : void 0,
              onClick: create,
              children: [
                /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "plus" }),
                sdk.T("新建通道", "New channel")
              ]
            }
          )
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("section", { className: "channel-detail", "aria-label": sdk.T("通道详情", "Channel details"), "aria-busy": busy, children: editing ? /* @__PURE__ */ jsxRuntime.jsx(
          ChannelForm,
          {
            api,
            providers,
            channel: edited,
            busy,
            onSave: save,
            onCancel: () => {
              setEditing(null);
              setError("");
            },
            onPaired: (cid) => {
              setEditing(null);
              setSelected(cid);
              void load();
            }
          },
          editing.kind === "new" ? "new" : `edit:${editing.id}`
        ) : current ? /* @__PURE__ */ jsxRuntime.jsx(
          ChannelDetail,
          {
            api,
            channel: current,
            provider: providers.find((provider) => provider.kind === current.provider),
            busy,
            onAct: (action) => void act({ action, id: current.id }),
            onEdit: () => {
              setSelected(current.id);
              setEditing({ kind: "edit", id: current.id });
              setError("");
            },
            onRemove: () => void remove(current)
          }
        ) : /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "channel-empty", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "channel-empty-icon", "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "cpu" }) }),
          /* @__PURE__ */ jsxRuntime.jsx("h3", { children: providers.length ? sdk.T("连接你的第一个通道", "Connect your first channel") : sdk.T("先启用一个接入插件", "Enable a messaging provider") }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { children: providers.length ? sdk.T("将消息平台连接到助手。在这里统一管理配置、启停和运行日志。", "Connect a messaging platform to your assistant. Manage settings, start or stop connections, and view logs here.") : sdk.T("在插件管理中启用飞书等接入插件，然后回到这里创建通道。", "Enable a provider such as Feishu in Plugins, then return here to create a channel.") }),
          providers.length > 0 && /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
            /* @__PURE__ */ jsxRuntime.jsxs("button", { type: "button", className: "btn primary", disabled: busy, onClick: create, children: [
              /* @__PURE__ */ jsxRuntime.jsx(sdk.Icon, { name: "plus" }),
              sdk.T("新建通道", "New channel")
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("small", { children: [
              sdk.T("可用接入：", "Available providers: "),
              providers.map(label).join(" / ")
            ] })
          ] })
        ] }) })
      ] })
    ] }) });
  }
  sdk.defineReact("web-channels", ChannelManager);
  exports.ChannelManager = ChannelManager;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({}, GAH.jsxRuntime, GAH.React, GAH);
