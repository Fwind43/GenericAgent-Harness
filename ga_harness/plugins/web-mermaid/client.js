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
  // ---- export: serialize the live SVG (well-formed XML), rasterize via canvas at 2x ----
  function svgSource(view) {
    var el = view.querySelector("svg");
    if (!el) return null;
    var c = el.cloneNode(true);
    var vb = (el.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    var r = el.getBoundingClientRect();
    var w = vb.length === 4 && vb[2] > 0 ? vb[2] : r.width, h = vb.length === 4 && vb[3] > 0 ? vb[3] : r.height;
    c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    c.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    c.setAttribute("width", w); c.setAttribute("height", h);
    c.style.maxWidth = "none";
    return { xml: new XMLSerializer().serializeToString(c), w: Math.ceil(w), h: Math.ceil(h) };
  }
  function background(view) {
    for (var n = view; n && n.nodeType === 1; n = n.parentElement) {
      var bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return theme() === "dark" ? "#1e1e1e" : "#ffffff";
  }
  function png(view) {
    var s = svgSource(view);
    if (!s) return Promise.reject(new Error("no svg"));
    return new Promise(function (ok, bad) {
      var img = new Image();
      img.onload = function () {
        try {
          var k = Math.min(2, 16000 / Math.max(s.w, s.h, 1));
          var cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(s.w * k)); cv.height = Math.max(1, Math.round(s.h * k));
          var g = cv.getContext("2d");
          g.fillStyle = background(view); g.fillRect(0, 0, cv.width, cv.height);
          g.drawImage(img, 0, 0, cv.width, cv.height);
          cv.toBlob(function (b) { b ? ok(b) : bad(new Error("toBlob failed")); }, "image/png");
        } catch (e) { bad(e); }
      };
      img.onerror = function () { bad(new Error("svg image load failed")); };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.xml);
    });
  }
  function save(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return "mermaid-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function flash(btn, text) {
    var keep = btn.dataset.label;
    btn.textContent = text; btn.disabled = true;
    setTimeout(function () { btn.textContent = keep; btn.disabled = false; }, 1400);
  }
  function tool(label, title, run) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "mm-btn mm-act"; b.textContent = label; b.dataset.label = label; b.title = title;
    b.onclick = function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (b.disabled) return;
      Promise.resolve().then(run).then(function (msg) { flash(b, msg || "\u2713"); }, function (e) {
        console.error("[web-mermaid]", e); flash(b, T("失败", "Failed"));
      });
    };
    return b;
  }
  function attach(card, svg) {
    if (!card.isConnected || card.classList.contains("mm-ok")) return;
    var view = document.createElement("div");
    view.className = "mm-view";
    view.innerHTML = svg;
    var head = card.querySelector(".md-code-head");
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "mm-btn mm-toggle";
    var label = function () { btn.textContent = card.classList.contains("mm-src") ? T("图表", "Diagram") : T("源码", "Source"); };
    btn.onclick = function () { card.classList.toggle("mm-src"); label(); };
    label();
    var copy = tool(T("复制图片", "Copy image"), T("复制为 PNG 图片", "Copy as PNG image"), function () {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error("clipboard image unsupported");
      // Pass the promise so the clipboard write starts inside the click gesture.
      return navigator.clipboard.write([new ClipboardItem({ "image/png": png(view) })]).then(function () { return T("已复制", "Copied"); });
    });
    var dlPng = tool("PNG", T("下载 PNG 图片", "Download PNG"), function () {
      return png(view).then(function (b) { save(b, stamp() + ".png"); return T("已下载", "Saved"); });
    });
    var dlSvg = tool("SVG", T("下载 SVG 矢量图", "Download SVG"), function () {
      var s = svgSource(view);
      if (!s) throw new Error("no svg");
      save(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + s.xml], { type: "image/svg+xml" }), stamp() + ".svg");
      return T("已下载", "Saved");
    });
    if (head) [btn, copy, dlPng, dlSvg].forEach(function (b) { head.insertBefore(b, head.lastChild); });
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
