import { T, type PluginInfo } from '@gah/sdk';

export const categories = [
  ['core', T('\u6838\u5fc3', 'Core')], ['extension', T('GA \u6269\u5c55', 'GA extensions')],
  ['observe', T('\u89c2\u6d4b\u8bb0\u5f55', 'Observability')], ['service', T('\u6570\u636e\u4e0e\u670d\u52a1', 'Data & services')],
  ['ui', T('\u754c\u9762', 'Interface')], ['other', T('\u5176\u4ed6', 'Other')],
] as const;
export const filters = [['all', T('\u5168\u90e8', 'All')], ['active', T('\u8fd0\u884c\u4e2d', 'Running')], ['off', T('\u672a\u52a0\u8f7d', 'Not loaded')], ['issue', T('\u9700\u5904\u7406', 'Needs attention')]] as const;
const states: Record<string, string> = { active: T('\u8fd0\u884c\u4e2d', 'Running'), pending: T('\u7b49\u5f85\u4f9d\u8d56', 'Waiting for dependencies'), disabled: T('\u672a\u52a0\u8f7d', 'Not loaded'), error: T('\u52a0\u8f7d\u5931\u8d25', 'Failed to load'), removed: T('\u5df2\u79fb\u9664', 'Removed'), missing_packages: T('\u7f3a\u5c11 Python \u4f9d\u8d56', 'Missing Python packages') };
export const stateLabel = (plugin: PluginInfo) => states[plugin.state] || plugin.state;
export const categoryOf = (plugin: PluginInfo) => categories.find(([key]) => key === plugin.category) || categories[categories.length - 1];
export const descriptionOf = (item: { description?: string; description_zh?: string }) => T(item.description_zh || item.description || '', item.description || '');
export const inFilter = (plugin: PluginInfo, filter: string) => filter === 'all' || (filter === 'active' ? plugin.state === 'active' : filter === 'off' ? ['disabled', 'removed'].includes(plugin.state) : ['error', 'pending', 'missing_packages'].includes(plugin.state) || !!plugin.missing?.length || !!plugin.missing_packages?.length || !!plugin.error);
export function Switch({ checked, disabled, label, onToggle }: { checked: boolean; disabled?: boolean; label: string; onToggle: (next: boolean) => void }) {
  return <button type="button" role="switch" className="plugin-switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled}
    onClick={event => { event.stopPropagation(); onToggle(!checked); }}><span className="plugin-switch-knob" /></button>;
}
export function PluginTags({ plugin }: { plugin: PluginInfo }) {
  return <>
    {plugin.protected && <span className="plugin-tag" data-tag="protected">{T('\u53d7\u4fdd\u62a4', 'Protected')}</span>}
    {plugin.hot && <span className="plugin-tag" data-tag="hot">{T('\u70ed\u63d2\u62d4', 'Hot-pluggable')}</span>}
    {plugin.restart_required && <span className="plugin-tag" data-tag="pending">{T('\u5f85\u91cd\u542f', 'Restart pending')}</span>}
    {plugin.overridden && <span className="plugin-tag" data-tag="override">{T('\u7f51\u9875\u8986\u76d6', 'Web override')}</span>}
    {!plugin.enabled && plugin.state === 'active' && <span className="plugin-tag" data-tag="pending">{T('\u4e0b\u6b21\u505c\u7528', 'Off next start')}</span>}
  </>;
}
