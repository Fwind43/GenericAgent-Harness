import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { plugins } from './plugin-runtime';
import { saved, save, T } from './i18n';
import type { PluginAPI } from './sdk';
import { Sessions } from './plugins/Sessions';
import { Workspaces } from './plugins/Workspaces';
import { Models } from './plugins/Models';
import { PluginManager } from './plugins/PluginManager';

const themes = ['light', 'dark', 'warm'] as const;
function Theme({ api }: { api: PluginAPI }) {
  const [container] = useState(() => document.createElement('span'));
  const [theme, setTheme] = useState(() => {
    const value = saved('gah-theme') || document.documentElement.dataset.theme || 'light';
    return themes.includes(value as typeof themes[number]) ? value : 'light';
  });
  useLayoutEffect(() => {
    api.slot('header', container);
    return () => { container.remove(); delete document.documentElement.dataset.theme; };
  }, [api, container]);
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return createPortal(<select id="theme" aria-label={T('主题', 'Theme')} value={theme} onChange={event => {
    setTheme(event.target.value); save('gah-theme', event.target.value);
  }}><option value="light">{T('浅色', 'Light')}</option><option value="dark">{T('深色', 'Dark')}</option><option value="warm">{T('暖色', 'Warm')}</option></select>, container);
}
export function registerBuiltins() {
  // Backend registration still controls availability, styles and revisions.
  plugins.register('web-theme', Theme);
  plugins.register('web-sessions', Sessions);
  plugins.register('web-workspaces', Workspaces);
  plugins.register('web-models', Models);
  plugins.register('web-plugins', PluginManager);
}
