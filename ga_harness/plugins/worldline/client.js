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
      return true;
    } catch (error) {
      sdk.host.report(error);
      return false;
    }
  }
  let editing = null;
  let repaint = () => {
  };
  function closeEditor() {
    editing = null;
    repaint();
  }
  function editor(api, current, busy) {
    const box = document.createElement("div");
    box.className = "gah-wl-edit";
    const area = document.createElement("textarea");
    area.className = "gah-wl-edit-input";
    area.value = current.draft;
    area.rows = 1;
    const fit = () => {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    };
    const actions = document.createElement("div");
    actions.className = "gah-wl-edit-actions";
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "gah-wl-edit-cancel", textContent: sdk.T("取消", "Cancel") });
    const send = Object.assign(document.createElement("button"), { type: "button", className: "gah-wl-edit-send", textContent: sdk.T("发送", "Send") });
    const sync = (running) => {
      send.disabled = running || current.sending || !area.value.trim();
    };
    const submit = async () => {
      if (send.disabled) return;
      current.sending = true;
      sync(busy);
      const ok = await act(api, "fork", { session_id: current.sid, index: current.index, text: area.value });
      current.sending = false;
      if (ok && editing === current) closeEditor();
      else sync(busy);
    };
    area.addEventListener("input", () => {
      current.draft = area.value;
      fit();
      sync(busy);
    });
    area.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEditor();
    });
    send.addEventListener("click", (event) => {
      event.stopPropagation();
      void submit();
    });
    actions.append(cancel, send);
    box.append(area, actions);
    box.gahSync = (running) => {
      busy = running;
      sync(running);
    };
    sync(busy);
    requestAnimationFrame(() => {
      fit();
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
    return box;
  }
  function bar(api, sid, index, text, info, busy) {
    const box = document.createElement("div");
    box.className = "gah-wl-bar";
    box.append(button("✎", sdk.T("编辑并重发", "Edit and resend"), () => {
      editing = { sid, index, draft: text, sending: false };
      repaint();
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
          var _a, _b, _c;
          (_a = node.querySelector(":scope > .gah-wl-bar")) == null ? void 0 : _a.remove();
          (_b = node.querySelector(".gah-wl-branch")) == null ? void 0 : _b.remove();
          const message = state.messages[index];
          const mine = !!editing && editing.sid === sid && editing.index === index && (message == null ? void 0 : message.role) === "user";
          const open = node.querySelector(":scope > .gah-wl-edit");
          if (!mine && open) open.remove();
          node.classList.toggle("gah-wl-editing", mine);
          if (mine && editing) {
            if (open) (_c = open.gahSync) == null ? void 0 : _c.call(open, state.running);
            else node.append(editor(api, editing, state.running));
          }
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
      repaint = paint;
      paint();
      return () => {
        observer.disconnect();
        if (repaint === paint) repaint = () => {
        };
      };
    }, [api, state]);
    return null;
  }
  sdk.defineReact("worldline", Worldline);
})(GAH.React, GAH);
