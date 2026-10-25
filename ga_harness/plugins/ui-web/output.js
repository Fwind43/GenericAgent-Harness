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
    }
    node.querySelectorAll('a').forEach(link => {
      if (!allowedURL(link.getAttribute('href') || '', false)) link.removeAttribute('href');
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    });
    node.querySelectorAll('img').forEach(image => {
      if (!allowedURL(image.getAttribute('src') || '', true)) image.replaceWith(document.createTextNode(image.alt));
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
  window.GAHOutput = Object.freeze({ markdown, setMarkdown, copyButton });
})();
