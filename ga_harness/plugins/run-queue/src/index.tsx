import { useEffect, useState } from 'react';
import { useHost, T, defineReact, promptDialog, type PluginAPI } from '@gah/sdk';

type Item = { id: string; text: string; state: 'queued' | 'steering' };

function QueueList({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  const [pending, setPending] = useState('');
  const items = ((state as unknown as { queue?: Item[] }).queue) || [];
  const sid = state.session_id;
  if (!sid || !items.length) return null;
  const act = async (path: string, body: Record<string, unknown>) => {
    setPending(String(body.id || ''));
    try { await api.post(path, { session_id: sid, ...body }); }
    catch (error) { api.notice(String((error as Error)?.message || error)); }
    finally { setPending(''); }
  };
  const edit = async (item: Item) => {
    const value = await promptDialog({ title: T('\u7f16\u8f91\u6392\u961f\u6d88\u606f', 'Edit queued message'), value: item.text, confirm: T('\u4fdd\u5b58', 'Save') });
    if (value != null && value.trim() && value !== item.text) await act('edit', { id: item.id, text: value });
  };
  return (
    <div className="gah-queue" aria-label={T('\u6d88\u606f\u961f\u5217', 'Message queue')}>
      <div className="gah-queue-head">{T('\u6392\u961f\u4e2d', 'Queued')} · {items.length}
        <span className="gah-queue-hint">{state.running ? T('\u5f53\u524d\u4efb\u52a1\u7ed3\u675f\u540e\u4f9d\u6b21\u53d1\u9001', 'Sent in order after the current task') : T('\u4efb\u52a1\u5df2\u505c\u6b62\uff0c\u53ef\u624b\u52a8\u53d1\u9001', 'Task stopped; send manually')}</span>
      </div>
      {items.map(item => {
        const steering = item.state === 'steering';
        const busy = pending === item.id;
        return (
          <div key={item.id} className={'gah-queue-item' + (steering ? ' steering' : '')}>
            <div className="gah-queue-text" title={item.text}>{item.text}</div>
            <div className="gah-queue-actions">
              {steering ? <span className="gah-queue-tag">{T('\u5f15\u5bfc\u4e2d\u2026', 'Steering\u2026')}</span> : <>
                {state.running
                  ? <button type="button" disabled={busy} title={T('\u5728\u5f53\u524d\u4efb\u52a1\u7684\u4e0b\u4e00\u8f6e\u6ce8\u5165\uff0c\u4e0d\u6253\u65ad\u8fd0\u884c', 'Inject at the next turn without interrupting')} onClick={() => act('steer', { id: item.id })}>{T('\u5f15\u5bfc', 'Steer')}</button>
                  : <button type="button" disabled={busy} onClick={() => act('send', { id: item.id })}>{T('\u53d1\u9001', 'Send')}</button>}
                <button type="button" disabled={busy} onClick={() => edit(item)}>{T('\u7f16\u8f91', 'Edit')}</button>
              </>}
              <button type="button" className="danger" disabled={busy || steering} onClick={() => act('remove', { id: item.id })}>{T('\u53d6\u6d88', 'Cancel')}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RunQueue({ api }: { api: PluginAPI }) {
  useEffect(() => api.intercept(async text => {
    const state = api.state();
    if (!state.running || !state.session_id) return false;
    await api.post('add', { session_id: state.session_id, text });
    return true;
  }), [api]);
  useEffect(() => api.mount('composer-top', <QueueList api={api} />), [api]);
  return null;
}

defineReact('run-queue', RunQueue);
