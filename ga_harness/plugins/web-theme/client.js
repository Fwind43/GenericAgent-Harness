GAH.define('web-theme', api => {
  const root = document.documentElement;
  const themes = [['light', '\u6d45\u8272'], ['dark', '\u6df1\u8272'], ['warm', '\u6696\u8272']];
  if (!themes.some(t => t[0] === root.dataset.theme)) root.dataset.theme = 'light';
  const sel = api.h('select', {
    id: 'theme', 'aria-label': '\u4e3b\u9898',
    onchange: () => { root.dataset.theme = sel.value; try { localStorage.setItem('gah-theme', sel.value); } catch (e) {} },
  }, themes.map(([v, label]) => api.h('option', { value: v }, label)));
  sel.value = root.dataset.theme;
  api.slot('header', sel);
  // withdrawn: fall back to the host's base palette
  return () => { delete root.dataset.theme; };
});
