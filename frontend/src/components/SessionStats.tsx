import { T } from '../i18n';
import type { Message } from '../types';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function duration(seconds: number) {
  const s = Math.round(seconds);
  if (s < 60) return seconds < 10 ? `${seconds.toFixed(1)}s` : `${s}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${m}m${r}s` : `${m}m${r}s`;
}

export function tokens(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** Session totals from the persisted turns; segments without data are omitted. */
export function sessionStats(messages: Message[]) {
  let runs = 0, steps = 0, llm = 0, tools = 0, ttft = 0, ttftN = 0, genOut = 0, genSec = 0;
  let input = 0, output = 0, cached = 0, usageSeen = false;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    runs += 1;
    const turns = m.turns ?? [];
    steps += turns.length;
    let turnUsage = false;
    for (const t of turns) {
      for (const tool of t.tools ?? []) tools += num(tool.seconds);
      const sec = num(t.llm?.seconds), first = t.llm?.ttft;
      llm += sec;
      if (typeof first === 'number') { ttft += first; ttftN += 1; }
      if (t.usage) {
        turnUsage = usageSeen = true;
        input += num(t.usage.input); output += num(t.usage.output); cached += num(t.usage.cache_read);
        const gen = sec - (typeof first === 'number' ? first : 0);
        if (sec > 0 && gen > 0) { genOut += num(t.usage.output); genSec += gen; }
      }
    }
    if (!turnUsage && m.usage) {
      usageSeen = true;
      input += num(m.usage.input); output += num(m.usage.output); cached += num(m.usage.cache_read);
    }
  }
  const groups: string[][] = [];
  if (runs) groups.push([T(`${runs} 轮`, `${runs} runs`), T(`${steps} 步`, `${steps} steps`)]);
  const time: string[] = [];
  if (llm > 0) time.push(`LLM ${duration(llm)}`);
  if (tools > 0) time.push(T(`工具调用 ${duration(tools)}`, `Tools ${duration(tools)}`));
  if (time.length) groups.push(time);
  const model: string[] = [];
  if (ttftN) model.push(`TTFT ${(ttft / ttftN).toFixed(1)}s`);
  if (genSec > 0) model.push(`${(genOut / genSec).toFixed(1)} tok/s`);
  if (model.length) { model[0] = T('模型 ', 'Model ') + model[0]; groups.push(model); }
  if (usageSeen && input > 0) groups.push([T(`缓存命中 ${Math.round((cached / input) * 100)}%`, `Cache hit ${Math.round((cached / input) * 100)}%`)]);
  if (usageSeen) groups.push([T(`输入 ${tokens(input)}`, `In ${tokens(input)}`), T(`输出 ${tokens(output)}`, `Out ${tokens(output)}`)]);
  return groups;
}

export function SessionStats({ messages }: { messages: Message[] }) {
  const groups = sessionStats(messages);
  if (!groups.length) return null;
  return (
    <div className="gah-stats" aria-label={T('会话统计', 'Session stats')}>
      {groups.map((g, i) => (
        <span key={i} className="gah-stats-group">
          {i > 0 && <span className="gah-stats-sep" aria-hidden="true">|</span>}
          <span>{g.join(' · ')}</span>
        </span>
      ))}
    </div>
  );
}
