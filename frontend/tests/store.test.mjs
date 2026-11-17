// Run with: node --test tests/store.test.mjs (from frontend/ after npm ci).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Compile the real store and request layer; only React/i18n are irrelevant here.
const built = await build({
  stdin: { contents: "export { HostStore } from './store'; export { setViewing, viewing } from './api';", resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'ui-stubs', setup(b) {
    b.onResolve({ filter: /^(react|\.\/i18n)$/ }, args => ({ path: args.path, namespace: 'ui-stubs' }));
    b.onLoad({ filter: /.*/, namespace: 'ui-stubs' }, () => ({ contents: 'export const useSyncExternalStore = () => {}; export const T = (zh, en) => en; export const errorText = e => String(e);' }));
  } }],
});
const { HostStore, setViewing, viewing } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
let requests, timers, nextTimer, sources, originals;
const drain = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve(); };
const state = (id = 'a', extra = {}) => ({ session_id: id, running: false, parallel_runs: true, messages: [], runs: [], ...extra });
const answer = async (i, data) => { requests[i].resolve({ ok: true, json: async () => data }); await drain(); };
function tick(delay) {
  for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
}
function connect() {
  const store = new HostStore(); store.setState(state());
  return { store, off: store.connect(), source: sources.at(-1) };
}
beforeEach(() => {
  requests = []; timers = new Map(); nextTimer = 0; sources = [];
  originals = new Map(['fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'window', 'document', 'EventSource'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.setInterval = () => ++nextTimer;
  globalThis.clearInterval = () => {};
  globalThis.window = { setTimeout, setInterval, addEventListener() {}, removeEventListener() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  globalThis.EventSource = class {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    readyState = 1; listeners = new Map();
    constructor() { sources.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    close() { this.readyState = 2; }
    emit(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data), lastEventId: '' }); }
  };
  setViewing('a');
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test('session-switch feedback is immediate without changing the viewed chat or its draft key', () => {
  const store = new HostStore(); store.setState(state());
  let updates = 0; const off = store.subscribe(() => ++updates);
  const previous = store.getSnapshot().state;
  const finish = store.beginSessionSwitch({ id: 'b', title: 'Chat B' });
  assert.equal(updates, 1);
  assert.deepEqual(store.getSnapshot().switchingSession, { id: 'b', title: 'Chat B' });
  assert.equal(store.getSnapshot().state, previous);
  assert.equal(viewing(), 'a');
  assert.equal(store.getSnapshot().changing, false);
  // Failure/abort just removes feedback; the previous transcript stays available.
  finish(); finish();
  assert.equal(updates, 2);
  assert.equal(store.getSnapshot().switchingSession, undefined);
  assert.equal(store.getSnapshot().state, previous);
  off();
});

test('only the newest switch owns feedback, including across intermediate snapshots', () => {
  const store = new HostStore(); store.setState(state());
  const finishB = store.beginSessionSwitch({ id: 'b', title: 'Chat B' });
  const finishC = store.beginSessionSwitch({ id: 'c', title: 'Chat C' });
  finishB();
  store.setState(state('b'));
  assert.deepEqual(store.getSnapshot().switchingSession, { id: 'c', title: 'Chat C' });
  store.setState(state('c'));
  assert.equal(store.getSnapshot().switchingSession.id, 'c');
  finishC();
  assert.equal(store.getSnapshot().switchingSession, undefined);
  assert.equal(store.getSnapshot().state.session_id, 'c');
  finishB();
  assert.equal(store.getSnapshot().state.session_id, 'c');
});

test('session-switch cleanup leaves unrelated operation locks intact', () => {
  const store = new HostStore(); store.setState(state());
  const unlock = store.lock();
  const finish = store.beginSessionSwitch({ id: 'b', title: 'Chat B' });
  finish();
  assert.equal(store.getSnapshot().changing, true);
  unlock();
  assert.equal(store.getSnapshot().changing, false);
});

test('same-view refreshes share one request and promise', async () => {
  const store = new HostStore(); store.setState(state());
  const first = store.refresh();
  for (let i = 0; i < 20; ++i) assert.equal(store.refresh(), first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers['X-GAH-Session'], 'a');
  await answer(0, state('a', { messages: [{ role: 'user', text: 'fresh' }] }));
  await first;
  assert.equal(store.getSnapshot().state.messages[0].text, 'fresh');
});

test('switching chats never waits for or accepts the old response', async () => {
  const store = new HostStore(); store.setState(state());
  const first = store.refresh();
  store.setState(state('b'));
  const second = store.refresh();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['X-GAH-Session'], 'b');
  await answer(0, state('a'));
  await first;
  assert.equal(store.getSnapshot().state.session_id, 'b');
  assert.equal(store.refresh(), second);
  await answer(1, state('b')); await second;
});

test('newer same-chat state invalidates an in-flight refresh', async () => {
  const store = new HostStore(); store.setState(state());
  const first = store.refresh();
  store.setState(state('a', { messages: [{ role: 'user', text: 'newer' }] }));
  await answer(0, state()); await first;
  assert.equal(store.getSnapshot().state.messages[0].text, 'newer');
});

test('foreign snapshots coalesce and schedule only one trailing refresh', async () => {
  const { store, source, off } = connect();
  for (let i = 0; i < 20; ++i) source.emit('snapshot', state('foreign'));
  assert.equal(requests.length, 0);
  tick(250); assert.equal(requests.length, 1);
  for (let i = 0; i < 20; ++i) source.emit('snapshot', state('foreign'));
  tick(250); assert.equal(requests.length, 1);
  await answer(0, state());
  assert.equal([...timers.values()].filter(t => t.delay === 250).length, 1);
  tick(250); assert.equal(requests.length, 2);
  await answer(1, state());
  tick(250); assert.equal(requests.length, 2);
  assert.equal(store.getSnapshot().state.session_id, 'a');
  off();
});

test('failed refresh clears its flight so it can be retried', async () => {
  const store = new HostStore(); store.setState(state());
  const first = store.refresh();
  const rejected = assert.rejects(first, /offline/);
  requests[0].reject(new Error('offline')); await rejected;
  const second = store.refresh(); assert.equal(requests.length, 2);
  await answer(1, state()); await second;
});

test('disconnect cancels queued and trailing foreign refreshes', async () => {
  const one = connect(); one.source.emit('snapshot', state('foreign')); one.off();
  tick(250); assert.equal(requests.length, 0);
  const two = connect(); two.source.emit('snapshot', state('foreign')); tick(250);
  two.source.emit('snapshot', state('foreign')); two.off();
  await answer(0, state()); tick(250);
  assert.equal(requests.length, 1);
});

test('gap recovery cannot restore the previously viewed chat', async () => {
  const { store, source, off } = connect();
  source.emit('run.event', { run_id: 'r1', session_id: 'a', seq: 2, name: 'chunk', data: { text: 'old' } });
  assert.equal(requests.length, 1);
  store.setState(state('b'));
  source.emit('run.started', { run_id: 'r2', session_id: 'b', seq: 1, run: { id: 'r2', session_id: 'b', seq: 1, status: 'running' }, messages: [{ role: 'assistant', run_id: 'r2', text: 'new chat' }] });
  await answer(0, state('a'));
  assert.equal(store.getSnapshot().state.session_id, 'b');
  assert.equal(store.getSnapshot().state.messages[0].text, 'new chat');
  assert.equal(requests.length, 1);
  off();
});

test('gap recovery preserves newer same-chat snapshots', async () => {
  const { store, source, off } = connect();
  source.emit('run.event', { run_id: 'r1', session_id: 'a', seq: 2, name: 'chunk', data: { text: 'old' } });
  store.setState(state('a', { runs: [{ id: 'r1', session_id: 'a', status: 'running', seq: 3 }], messages: [{ role: 'assistant', run_id: 'r1', text: 'newer' }] }));
  await answer(0, state());
  assert.equal(store.getSnapshot().state.messages[0].text, 'newer');
  assert.equal(requests.length, 1);
  off();
});
