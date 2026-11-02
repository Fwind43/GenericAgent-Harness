(function () {
  "use strict";
  var zh = /^zh/i.test(navigator.language || "");
  var T = function (a, b) { return zh ? a : b; };
  var src = "/web/web-mermaid/mermaid.min.js";
  var loading = null, seq = 0, cache = new Map(), timer = 0;

  function theme() {
    var t = document.documentElement.dataset.theme || "light";
    return t === "dark" ? "dark" : "default";
  }
  function load() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (!loading) loading = new Promise(function (ok, bad) {
      var s = document.createElement("script");
      s.src = src; s.onload = function () { window.mermaid ? ok(window.mermaid) : bad(new Error("mermaid missing")); };
      s.onerror = function () { loading = null; bad(new Error("mermaid load failed")); };
      document.head.appendChild(s);
    });
    return loading;
  }
  async function draw(code) {
    var key = theme() + "\u0000" + code;
    if (cache.has(key)) return cache.get(key);
    var m = await load();
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme() });
    var id = "gah-mm-" + (++seq);
    try {
      var out = await m.render(id, code);
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      cache.set(key, out.svg);
      return out.svg;
    } finally {
      var junk = document.getElementById("d" + id) || document.getElementById(id);
      if (junk && !junk.closest(".mm-view")) junk.remove();
    }
  }
  function attach(card, svg) {
    if (!card.isConnected || card.classList.contains("mm-ok")) return;
    var view = document.createElement("div");
    view.className = "mm-view";
    view.innerHTML = svg;
    var head = card.querySelector(".md-code-head");
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "mm-toggle";
    var label = function () { btn.textContent = card.classList.contains("mm-src") ? T("图表", "Diagram") : T("源码", "Source"); };
    btn.onclick = function () { card.classList.toggle("mm-src"); label(); };
    label();
    if (head) head.insertBefore(btn, head.lastChild);
    card.insertBefore(view, card.querySelector("pre"));
    card.classList.add("mm-ok");
  }
  function scan() {
    timer = 0;
    document.querySelectorAll(".md-code code.language-mermaid").forEach(function (code) {
      var card = code.closest(".md-code");
      var text = code.textContent || "";
      if (!card || card.classList.contains("mm-ok") || card._mmText === text || !text.trim()) return;
      card._mmText = text;
      draw(text).then(function (svg) { if (card._mmText === text) attach(card, svg); }, function () { /* partial or invalid: keep the source */ });
    });
  }
  function schedule() { if (!timer) timer = setTimeout(scan, 350); }

  var obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
})();
