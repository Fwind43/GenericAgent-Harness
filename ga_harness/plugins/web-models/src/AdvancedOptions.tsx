import { useState } from 'react';
import { T } from '@gah/sdk';
import { Field } from './ModelForm';

export type OptionValue = string | number | boolean;
export type Options = Record<string, OptionValue>;
type Kind = 'int' | 'float' | 'bool' | 'enum' | 'str' | 'text' | 'verify';
interface Spec { key: string; kind: Kind; zh: string; en: string; hint?: [string, string]; ph?: string; choices?: string[]; min?: number; max?: number; only?: 'oai' | 'claude' }

const GROUPS: { zh: string; en: string; items: Spec[] }[] = [
  { zh: '\u751f\u6210', en: 'Generation', items: [
    { key: 'max_tokens', kind: 'int', zh: '\u6700\u5927\u8f93\u51fa token', en: 'Max output tokens', min: 1, ph: 'Claude 8192' },
    { key: 'temperature', kind: 'float', zh: '\u6e29\u5ea6', en: 'Temperature', min: 0, max: 2, ph: '1' },
    { key: 'reasoning_effort', kind: 'enum', zh: '\u63a8\u7406\u5f3a\u5ea6', en: 'Reasoning effort', choices: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { key: 'service_tier', kind: 'enum', zh: '\u670d\u52a1\u7b49\u7ea7', en: 'Service tier', choices: ['auto', 'default', 'priority', 'flex'] },
    { key: 'thinking_type', kind: 'enum', zh: '\u601d\u8003\u6a21\u5f0f', en: 'Thinking mode', choices: ['adaptive', 'enabled', 'disabled'] },
    { key: 'thinking_budget_tokens', kind: 'int', zh: '\u601d\u8003\u9884\u7b97 token', en: 'Thinking budget tokens', min: 0 },
    { key: 'stream', kind: 'bool', zh: '\u6d41\u5f0f\u8f93\u51fa', en: 'Streaming', hint: ['\u9ed8\u8ba4\u5f00\u542f', 'On by default'] },
    { key: 'omit_thinking', kind: 'bool', zh: '\u5386\u53f2\u4e2d\u7701\u7565\u601d\u8003', en: 'Omit thinking from history', hint: ['\u9ed8\u8ba4\u5173\u95ed', 'Off by default'] },
  ] },
  { zh: '\u8bf7\u6c42', en: 'Request', items: [
    { key: 'api_mode', kind: 'enum', zh: 'API \u6a21\u5f0f', en: 'API mode', choices: ['chat_completions', 'responses'], only: 'oai' },
    { key: 'api_key_header', kind: 'enum', zh: '\u5bc6\u94a5\u8bf7\u6c42\u5934', en: 'API key header', choices: ['auto', 'x-api-key', 'bearer'], only: 'claude' },
    { key: 'user_agent', kind: 'str', zh: 'User-Agent', en: 'User-Agent', only: 'claude', ph: 'claude-cli/\u2026' },
    { key: 'fake_cc_system_prompt', kind: 'bool', zh: '\u6a21\u62df Claude Code \u7cfb\u7edf\u63d0\u793a', en: 'Claude Code system prompt', only: 'claude' },
    { key: 'proxy', kind: 'str', zh: '\u4ee3\u7406', en: 'Proxy', ph: 'http://127.0.0.1:7890', hint: ['\u652f\u6301 http(s):// \u4e0e socks5://', 'http(s):// or socks5://'] },
    { key: 'verify', kind: 'verify', zh: 'TLS \u6821\u9a8c', en: 'TLS verify', ph: 'true', hint: ['true / false\uff0c\u6216 CA \u8bc1\u4e66\u8def\u5f84', 'true / false, or a CA bundle path'] },
  ] },
  { zh: '\u8d85\u65f6\u4e0e\u91cd\u8bd5', en: 'Timeouts & retries', items: [
    { key: 'timeout', kind: 'int', zh: '\u8fde\u63a5\u8d85\u65f6\uff08\u79d2\uff09', en: 'Connect timeout (s)', min: 1 },
    { key: 'read_timeout', kind: 'int', zh: '\u8bfb\u53d6\u8d85\u65f6\uff08\u79d2\uff09', en: 'Read timeout (s)', min: 5 },
    { key: 'max_retries', kind: 'int', zh: '\u6700\u5927\u91cd\u8bd5\u6b21\u6570', en: 'Max retries', min: 0, max: 100, ph: '4' },
    { key: 'max_retry_after', kind: 'float', zh: '\u6700\u957f\u91cd\u8bd5\u7b49\u5f85\uff08\u79d2\uff09', en: 'Max retry wait (s)', min: 0, ph: '60' },
  ] },
  { zh: '\u4e0a\u4e0b\u6587\u4e0e\u63d0\u793a\u8bcd', en: 'Context & prompt', items: [
    { key: 'trim_keep_prefix', kind: 'int', zh: '\u88c1\u526a\u65f6\u4fdd\u7559\u524d\u7f00\u6d88\u606f\u6570', en: 'Messages kept when trimming', min: 0, ph: '0' },
    { key: 'extra_sys_prompt_file', kind: 'str', zh: '\u9644\u52a0\u7cfb\u7edf\u63d0\u793a\u6587\u4ef6', en: 'Extra system prompt file', hint: ['\u76f8\u5bf9\u8def\u5f84\u57fa\u4e8e GA \u76ee\u5f55', 'Relative to the GA directory'] },
    { key: 'extra_sys_prompt', kind: 'text', zh: '\u9644\u52a0\u7cfb\u7edf\u63d0\u793a', en: 'Extra system prompt' },
  ] },
];
export const ADVANCED_KEYS = GROUPS.flatMap(group => group.items.map(item => item.key));

const toText = (value: OptionValue | undefined) => value === undefined ? '' : String(value);
export function useOptions(initial: Options = {}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, toText(v)])));
  const set = (key: string, value: string) => setDraft(prev => ({ ...prev, [key]: value }));
  /** Only changed keys are sent; null clears the key so GA falls back to its default. */
  const diff = () => {
    const out: Record<string, OptionValue | null> = {};
    for (const group of GROUPS) for (const spec of group.items) {
      const now = (draft[spec.key] ?? '').trim(), was = toText(initial[spec.key]);
      if (now === was && (draft[spec.key] ?? '') === was) continue;
      if (now === '') { if (spec.key in initial) out[spec.key] = null; continue; }
      if (spec.kind === 'int' || spec.kind === 'float') out[spec.key] = Number(now);
      else if (spec.kind === 'bool') out[spec.key] = now === 'true';
      else if (spec.kind === 'verify') out[spec.key] = now === 'true' ? true : now === 'false' ? false : now;
      else out[spec.key] = spec.kind === 'text' ? draft[spec.key] : now;
    }
    return out;
  };
  return { draft, set, diff };
}

export function AdvancedOptions({ protocol, draft, hidden = [], disabled, onChange }: {
  protocol: string; draft: Record<string, string>; hidden?: string[]; disabled: boolean; onChange: (key: string, value: string) => void;
}) {
  const defaultText = T('\u9ed8\u8ba4', 'Default');
  const input = (spec: Spec) => {
    const value = draft[spec.key] ?? '', change = (v: string) => onChange(spec.key, v);
    if (hidden.includes(spec.key)) return <input value={T('\u5df2\u5728 mykey.py \u4e2d\u8bbe\u7f6e\uff08\u6b64\u5904\u4e0d\u663e\u793a\uff09', 'Set in mykey.py (not shown here)')} disabled readOnly />;
    if (spec.kind === 'enum' || spec.kind === 'bool') {
      const choices = spec.kind === 'bool' ? [['true', T('\u5f00\u542f', 'On')], ['false', T('\u5173\u95ed', 'Off')]] : spec.choices!.map(c => [c, c]);
      return <select value={value} disabled={disabled} onChange={event => change(event.target.value)}>
        <option value="">{defaultText}</option>{choices.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>;
    }
    if (spec.kind === 'text') return <textarea rows={4} value={value} disabled={disabled} maxLength={50000} placeholder={defaultText} onChange={event => change(event.target.value)} />;
    const numeric = spec.kind === 'int' || spec.kind === 'float';
    return <input type={numeric ? 'number' : 'text'} step={spec.kind === 'float' ? 'any' : numeric ? 1 : undefined} min={spec.min} max={spec.max}
      value={value} disabled={disabled} spellCheck={false} autoComplete="off" placeholder={spec.ph ? defaultText + ' ' + spec.ph : defaultText} onChange={event => change(event.target.value)} />;
  };
  return <>{GROUPS.map(group => {
    const items = group.items.filter(spec => !spec.only || spec.only === protocol);
    return <div className="model-advanced-group" key={group.en}>
      <h4>{T(group.zh, group.en)}</h4>
      <div className="model-grid">{items.map(spec => <Field key={spec.key} label={T(spec.zh, spec.en)} wide={spec.kind === 'text'}>
        {input(spec)}<small><code>{spec.key}</code>{spec.hint ? ' \u00b7 ' + T(spec.hint[0], spec.hint[1]) : ''}</small>
      </Field>)}</div>
    </div>;
  })}<p className="model-advanced-note">{T('\u7559\u7a7a\u8868\u793a\u4f7f\u7528 GA \u9ed8\u8ba4\u503c\uff1b\u6e05\u7a7a\u5df2\u6709\u7684\u503c\u4f1a\u4ece mykey.py \u5220\u9664\u8be5\u9879\u3002', 'Leave empty to use the GA default; clearing a value removes it from mykey.py.')}</p></>;
}
