/* Local, framework-free Markdown renderer. Model output is always untrusted. */
(() => {
  'use strict';
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const parser = window.marked && new window.marked.Marked({
    gfm: true, breaks: true,
    renderer: { html: token => escapeHTML(token.text) }
  });
  const tags = ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em',
    'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'img', 'table',
    'thead', 'tbody', 'tr', 'th', 'td', 'input'];
  const icon = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor"/><path d="M10 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" stroke="currentColor"/></svg>';
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) { /* fallback */ }
    }
    const active = document.activeElement;
    const input = make('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    Object.assign(input.style, { position: 'fixed', left: '-9999px', top: '0' });
    document.body.append(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    if (active && active.isConnected) active.focus({ preventScroll: true });
    if (!ok) throw new Error('Clipboard unavailable');
  }
  function copyButton(getText, label = T('\u590d\u5236','Copy')) {
    const button = make('button', 'output-copy');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    const text = make('span', null, label);
    text.setAttribute('aria-live', 'polite');
    button.append(text);
    let timer;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await copyText(String(getText() || ''));
        text.textContent = T('\u5df2\u590d\u5236','Copied');
        button.classList.add('copied');
      } catch (_) { text.textContent = T('\u590d\u5236\u5931\u8d25','Copy failed'); }
      finally { button.disabled = false; }
      clearTimeout(timer);
      timer = setTimeout(() => { text.textContent = label; button.classList.remove('copied'); }, 2000);
    });
    return button;
  }
  function allowedURL(raw, image) {
    try {
      const url = new URL(raw, document.baseURI);
      return (image ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:', 'tel:']).includes(url.protocol);
    } catch (_) { return false; }
  }
  // ---- local file references: [name](E:/a/b.png), ./src/x.ts, file:///... ----
  const fileKinds = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
    code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
      'rb', 'php', 'sh', 'bat', 'cmd', 'ps1', 'css', 'scss', 'html', 'vue', 'svelte', 'json', 'toml', 'yaml', 'yml',
      'xml', 'sql', 'swift', 'lua', 'ini', 'cfg'],
    doc: ['md', 'markdown', 'mdx', 'txt', 'rst', 'log', 'csv', 'pdf']
  };
  const fileIcons = {
    image: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor"/><circle cx="6" cy="6.5" r="1.2" fill="currentColor"/><path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5L13 12" stroke="currentColor" stroke-linejoin="round"/></svg>',
    code: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    doc: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5h-8.5A.5.5 0 0 1 3.5 14V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor"/><path d="M6 8h4.5M6 10.5h4.5" stroke="currentColor" stroke-linecap="round"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5h-8.5A.5.5 0 0 1 3.5 14V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor"/><path d="M9.5 1.5V5H13" stroke="currentColor"/></svg>'
  };
  function localPath(raw) {
    raw = String(raw || '').trim();
    if (raw.startsWith('api/file?')) return new URLSearchParams(raw.slice(9)).get('path') || '';
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) return '';
    let path = raw;
    if (/^file:/i.test(raw)) {
      try { path = decodeURIComponent(new URL(raw).pathname).replace(/^\/([A-Za-z]:[\\/])/, '$1'); } catch (_) { return ''; }
    } else if (!/^[A-Za-z]:[\\/]/.test(raw) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return '';
    else { try { path = decodeURI(raw); } catch (_) { /* keep raw */ } }
    path = path.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/[?#].*$/, '');
    return path;
  }
  function fileRef(path) {
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const kind = Object.keys(fileKinds).find(k => fileKinds[k].includes(ext)) || 'file';
    return Object.freeze({ path, name, ext, kind, url: fileURL(path) });
  }
  function fileURL(path, opts = {}) {
    const query = new URLSearchParams({ path });
    if (opts.download) query.set('download', '1');
    if (opts.info) query.set('info', '1');
    return 'api/file?' + query;
  }
  // Click handling is a plugin hook: the newest opener that returns true wins, else open in a new tab.
  const openers = [];
  function addOpener(fn) {
    if (typeof fn !== 'function') throw new TypeError('opener must be a function');
    openers.unshift(fn);
    return () => { const i = openers.indexOf(fn); if (i >= 0) openers.splice(i, 1); };
  }
  async function openFile(ref, event) {
    if (typeof ref === 'string') ref = fileRef(ref);
    for (const fn of openers.slice()) {
      try { if (await fn(ref, event)) return true; } catch (error) { console.error('[GAHFiles opener]', error); }
    }
    window.open(ref.url, '_blank', 'noopener');
    return false;
  }
  let preview;
  function showPreview(link, ref) {
    if (!preview) {
      preview = make('div', 'md-file-preview');
      preview.setAttribute('role', 'tooltip');
      preview.append(make('img'), make('div', 'md-file-preview-name'));
      preview.firstChild.addEventListener('error', () => preview.classList.add('failed'));
    }
    const [img, label] = preview.children;
    preview.classList.remove('failed');
    if (img.getAttribute('src') !== ref.url) img.src = ref.url;
    img.alt = ref.name;
    label.textContent = ref.name;
    document.body.append(preview);
    const box = link.getBoundingClientRect();
    const width = 260, below = box.bottom + 8 + 220 < innerHeight;
    preview.style.left = Math.max(8, Math.min(box.left, innerWidth - width - 8)) + 'px';
    preview.style.top = (below ? box.bottom + 6 : Math.max(8, box.top - 226)) + 'px';
  }
  function hidePreview() { if (preview) preview.remove(); }
  function decorateFileLink(link, path) {
    const ref = fileRef(path);
    const raw = link.getAttribute('href') || '';
    const text = link.textContent.trim();
    if (!text || text === raw || text === path) link.textContent = ref.name;
    const glyph = make('span', 'md-file-icon');
    glyph.innerHTML = fileIcons[ref.kind];
    link.prepend(glyph);
    link.classList.add('md-file', 'md-file-' + ref.kind);
    link.href = ref.url;
    link.title = ref.path;
    link.removeAttribute('target');
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      hidePreview();
      openFile(ref, event);
    });
    if (ref.kind === 'image') {
      link.addEventListener('mouseenter', () => showPreview(link, ref));
      link.addEventListener('focus', () => showPreview(link, ref));
      link.addEventListener('mouseleave', hidePreview);
      link.addEventListener('blur', hidePreview);
    }
  }
  function setMarkdown(node, text) {
    text = String(text || '');
    if (node._markdown === text) return;
    node._markdown = text;
    node.classList.add('md');
    node.classList.remove('md-plain');
    if (!parser || !window.DOMPurify) {
      node.textContent = text;
      node.classList.add('md-plain');
      return;
    }
    // DOMPurify treats "E:/x" and "file://" as unsafe schemes and drops them, so rewrite local
    // references to the same-origin file endpoint before its URI check runs.
    const keepLocal = (_node, data) => {
      if (data.attrName !== 'href' && data.attrName !== 'src') return;
      const path = localPath(data.attrValue);
      if (path) data.attrValue = fileURL(path);
    };
    window.DOMPurify.addHook('uponSanitizeAttribute', keepLocal);
    try {
      node.replaceChildren(window.DOMPurify.sanitize(parser.parse(text), {
        ALLOWED_TAGS: tags,
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'align', 'start', 'type', 'checked', 'disabled'],
        ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true
      }));
    } catch (_) {
      node.textContent = text;
      node.classList.add('md-plain');
      return;
    } finally {
      window.DOMPurify.removeHook('uponSanitizeAttribute', keepLocal);
    }
    node.querySelectorAll('a').forEach(link => {
      const raw = link.getAttribute('href') || '';
      const path = localPath(raw);
      if (path) decorateFileLink(link, path);
      else if (!allowedURL(raw, false)) link.removeAttribute('href');
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    });
    node.querySelectorAll('img').forEach(image => {
      const raw = image.getAttribute('src') || '';
      const path = localPath(raw);
      if (path) { image.src = fileURL(path); image.loading = 'lazy'; image.title = image.title || path; }
      else if (!allowedURL(raw, true)) image.replaceWith(document.createTextNode(image.alt));
      else { image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; }
    });
    node.querySelectorAll('input').forEach(input => { input.type = 'checkbox'; input.disabled = true; });
    node.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      const card = make('div', 'md-code');
      const head = make('div', 'md-code-head');
      const lang = Array.from(code.classList).find(c => c.startsWith('language-'));
      head.append(make('span', null, lang ? lang.slice(9) : 'text'), copyButton(() => code.textContent, T('\u590d\u5236\u4ee3\u7801','Copy code')));
      pre.replaceWith(card);
      card.append(head, pre);
    });
    node.querySelectorAll('table').forEach(table => {
      const wrap = make('div', 'md-table');
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', T('\u8868\u683c','Table'));
      table.replaceWith(wrap);
      wrap.append(table);
    });
  }
  function markdown(text, cls = '') {
    const node = make('div', cls);
    setMarkdown(node, text);
    return node;
  }
  // ask_user returns an interrupt payload, not an ordinary tool receipt.
  const isAskUser = name => String(name || '').split('.').filter(Boolean).pop() === 'ask_user';
  function askPayload(value, depth = 0) {
    if (depth > 6 || value == null) return null;
    if (typeof value === 'string') {
      const source = value.trim();
      try { return askPayload(JSON.parse(source), depth + 1); } catch (_) { /* fenced/verbose JSON */ }
      // Find complete JSON objects without mistaking braces inside quoted questions for delimiters.
      let start = -1, level = 0, quoted = false, escaped = false;
      for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (start < 0) { if (c === '{') { start = i; level = 1; } continue; }
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
          continue;
        }
        if (c === '"') quoted = true;
        else if (c === '{') level++;
        else if (c === '}' && --level === 0) {
          try {
            const parsed = askPayload(JSON.parse(source.slice(start, i + 1)), depth + 1);
            if (parsed) return parsed;
          } catch (_) { /* Keep looking; plain waiting text is not a structured question. */ }
          start = -1;
        }
      }
      return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = {};
    if (typeof value.question === 'string' && value.question.trim()) payload.question = value.question;
    if (Array.isArray(value.candidates)) payload.candidates = value.candidates.filter(x => typeof x === 'string' && x.trim());
    if (Object.keys(payload).length) return payload;
    for (const key of ['data', 'result', 'arguments', 'args']) {
      const parsed = askPayload(value[key], depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }
  function askUserPayload(name, args, result) {
    if (!isAskUser(name)) return null;
    const payload = { ...(askPayload(args) || {}), ...(askPayload(result) || {}) };
    return { question: payload.question || '', candidates: payload.candidates || [] };
  }
  // Quiet, semantic tool receipts: details stay in the expandable body.
  function toolSummary(name, value) {
    const tool = String(name || 'tool').split('.').filter(Boolean).pop() || 'tool';
    let args = value;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const basename = value => text(value).split(/[\\/]/).filter(Boolean).pop() || '';
    const path = text(args.path || args.file);
    let kind = T('\u5de5\u5177', 'Tool'), target = basename(path || args.cwd), detail = path || text(args.cwd);
    if (tool === 'file_read') {
      kind = T('\u8bfb\u53d6', 'Read');
      const start = Number(args.start), count = args.count == null ? 200 : Number(args.count);
      const lines = Number.isSafeInteger(start) && start > 0
        ? ' \u00b7 L' + start + (Number.isSafeInteger(count) && count > 1 ? '\u2013' + (start + count - 1) : '') : '';
      target = basename(path) + lines; detail = path + lines;
    } else if (tool === 'file_patch') kind = T('\u7f16\u8f91', 'Edit');
    else if (tool === 'file_write') kind = T('\u5199\u5165', 'Write');
    else if (tool === 'code_run') {
      kind = T('\u6267\u884c', 'Run');
      const type = text(args.type).toLowerCase();
      target = type === 'powershell' ? 'PowerShell' : type === 'python' || !type ? 'Python' : text(args.type);
      detail = [target, text(args.cwd)].filter(Boolean).join(' \u00b7 ');
    } else if (tool === 'web_scan') {
      kind = T('\u6d4f\u89c8', 'Browse');
      target = args.tabs_only ? T('\u6807\u7b7e\u9875', 'Tabs') : T('\u9875\u9762\u5185\u5bb9', 'Page content'); detail = target;
    } else if (tool === 'web_execute_js') {
      kind = T('\u6d4f\u89c8', 'Browse'); target = detail = 'JavaScript';
    } else if (tool === 'ask_user') {
      kind = T('\u8be2\u95ee', 'Ask'); target = detail = text(args.question) || T('\u7b49\u5f85\u56de\u590d', 'Awaiting reply');
    } else if (!target) target = detail = text(args.query || args.pattern || args.url || args.command);
    return { kind, tool, target, detail };
  }
  window.GAHFiles = Object.freeze({ ref: fileRef, url: fileURL, localPath, open: openFile, addOpener });
  window.GAHOutput = Object.freeze({ markdown, setMarkdown, copyButton, toolSummary, isAskUser, askUserPayload });
})();
