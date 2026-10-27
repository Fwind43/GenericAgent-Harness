(function(react, sdk) {
  "use strict";
  const MARK = "gah-wl";
  function button(label, title, onClick, disabled = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gah-wl-btn";
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return b;
  }
  async function act(api, path, body) {
    try {
      await api.post(path, body);
    } catch (error) {
      sdk.host.report(error);
    }
  }
  function bar(api, sid, index, text, info, busy) {
    const box = document.createElement("div");
    box.className = "gah-wl-bar";
    box.append(button("✎", sdk.T("编辑并重发", "Edit and resend"), async () => {
      const value = await sdk.promptDialog({ title: sdk.T("编辑消息", "Edit message"), value: text, confirm: sdk.T("发送", "Send") });
      if (value !== null && value.trim()) await act(api, "fork", { session_id: sid, index, text: value });
    }, busy));
    box.append(button("↻", sdk.T("重新生成", "Regenerate"), () => act(api, "fork", { session_id: sid, index }), busy));
    if (info && info.branches.length) {
      const ids = info.branches;
      const nav = document.createElement("span");
      nav.className = "gah-wl-nav";
      nav.append(
        button("‹", sdk.T("上一条世界线", "Previous worldline"), () => act(api, "switch", { session_id: sid, branch_id: ids[0] }), busy),
        Object.assign(document.createElement("span"), { className: "gah-wl-count", textContent: `${info.current}/${info.count}` }),
        button("›", sdk.T("下一条世界线", "Next worldline"), () => act(api, "switch", { session_id: sid, branch_id: ids[ids.length - 1] }), busy)
      );
      box.append(nav);
    }
    return box;
  }
  const BRANCH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 3-12 8"/></svg>';
  function branchButton(api, sid, index, busy) {
    const label = sdk.T("在新对话中分支", "Branch in new chat");
    const b = button("", label, () => act(api, "branch", { session_id: sid, index }), busy);
    b.className = "output-copy gah-wl-branch";
    b.setAttribute("aria-label", label);
    b.innerHTML = BRANCH_SVG;
    return b;
  }
  function textOf(message) {
    const m = message;
    const content = typeof (m == null ? void 0 : m.text) === "string" ? m.text : m == null ? void 0 : m.content;
    return typeof content === "string" ? content : "";
  }
  function Worldline({ api }) {
    const { state } = sdk.useHost();
    react.useEffect(() => {
      const thread = document.getElementById("thread");
      const sid = state.session_id;
      if (!thread || !sid) return;
      const variants = state.worldline || {};
      const paint = () => {
        observer.disconnect();
        let lastUser = -1;
        Array.from(thread.children).forEach((node, index) => {
          var _a, _b;
          (_a = node.querySelector(":scope > .gah-wl-bar")) == null ? void 0 : _a.remove();
          (_b = node.querySelector(".gah-wl-branch")) == null ? void 0 : _b.remove();
          const message = state.messages[index];
          if ((message == null ? void 0 : message.role) === "assistant" && lastUser >= 0 && !state.running) {
            const actions = node.querySelector(".message-actions");
            if (actions) actions.append(branchButton(api, sid, lastUser, state.running));
            return;
          }
          if (!node.classList.contains("user") || (message == null ? void 0 : message.role) !== "user") return;
          lastUser = index;
          node.classList.add(MARK);
          node.append(bar(api, sid, index, textOf(message), variants[String(index)], state.running));
        });
        observer.observe(thread, { childList: true, subtree: !state.running });
      };
      const observer = new MutationObserver(paint);
      paint();
      return () => observer.disconnect();
    }, [api, state]);
    return null;
  }
  sdk.defineReact("worldline", Worldline);
})(GAH.React, GAH);
