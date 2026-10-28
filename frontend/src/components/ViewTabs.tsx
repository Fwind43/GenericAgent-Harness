import { useEffect, useRef, useState } from 'react';
import { T } from '../i18n';
import { host } from '../store';
import { settings } from '../settings';
import { CHAT_VIEW, views, useViews } from '../views';

// Prompt handed to the composer by "Create your plugin"; the agent then scaffolds it in the workspace.
const CREATE_PROMPT = () => T(
  '帮我创建一个 ga-harness 插件：\n- 用途：\n- 放在 ga_harness/plugins/<名称>/（plugin.toml + main.py，如需界面再加 src/index.tsx）\n请先阅读已有插件和 frontend/MIGRATION.md 了解插件 SDK。',
  'Help me create a ga-harness plugin:\n- Purpose:\n- Location: ga_harness/plugins/<name>/ (plugin.toml + main.py, plus src/index.tsx for UI)\nRead the existing plugins and frontend/MIGRATION.md for the plugin SDK first.');

// Session view tabs: "Chat" is built in; plugins add views via ViewPanel. The "..." menu links to plugins.
export function ViewTabs() {
  const { active, views: list } = useViews();
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!(event.target instanceof Node && box.current?.contains(event.target))) setMenu(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menu]);
  const tab = (id: string, label: string) => <button key={id} type="button" role="tab" id={'gah-view-tab-' + id}
    aria-selected={active === id} aria-controls={id === CHAT_VIEW ? 'scroll' : 'gah-view-' + id}
    className={'gah-view-tab' + (active === id ? ' active' : '')} onClick={() => views.select(id)}>{label}</button>;
  function browse() { setMenu(false); settings.show(); settings.select('web-plugins'); }
  function create() { setMenu(false); views.select(CHAT_VIEW); host.emit('draft', CREATE_PROMPT()); }
  return <div className="gah-view-tabs" role="tablist" aria-label={T('会话视图', 'Session views')}>
    {tab(CHAT_VIEW, T('对话', 'Chat'))}{list.map(view => tab(view.id, view.label))}
    <div className="gah-view-more" ref={box}>
      <button type="button" className="gah-view-tab gah-view-dots" aria-haspopup="menu" aria-expanded={menu} title={T('更多', 'More')} aria-label={T('更多视图', 'More views')} onClick={() => setMenu(open => !open)}>···</button>
      {menu ? <div className="gah-view-menu" role="menu">
        <button type="button" role="menuitem" onClick={browse}><span aria-hidden="true">✣</span>{T('浏览更多插件', 'Browse more plugins')}</button>
        <button type="button" role="menuitem" onClick={create}><span aria-hidden="true">＋</span>{T('创建你的插件', 'Create your plugin')}</button>
      </div> : null}
    </div>
  </div>;
}
