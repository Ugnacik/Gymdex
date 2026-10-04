import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { DraftStore, effortText, setPayload } from '../static/drafts.mjs';

function storage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
const values = { weight: '12.5', result: '8', assistance: true, completed: true };

test('drafts survive a new page instance and stay scoped to their workout and set', () => {
  const disk = storage();
  new DraftStore(() => disk).put(1, 2, values);
  const reloaded = new DraftStore(() => disk);
  assert.equal(reloaded.get(1, 2).weight, '12.5');
  assert.equal(reloaded.get(2, 2), null);
  assert.equal(reloaded.get(1, 3), null);
});

test('acknowledging one revision never clears a newer draft or another set', () => {
  const disk = storage();
  const store = new DraftStore(() => disk);
  const first = store.put(1, 2, values);
  store.put(1, 3, values);
  const newer = store.put(1, 2, { ...values, result: '9' });
  store.remove(1, 2, first.revision);
  assert.equal(store.get(1, 2).result, '9');
  store.remove(1, 2, newer.revision);
  assert.equal(store.get(1, 2), null);
  assert.equal(store.get(1, 3).result, '8');
});

test('storage failures keep an in-memory draft and report that it is not durable', () => {
  const store = new DraftStore(() => { throw new Error('Storage denied'); });
  store.put(1, 2, values);
  assert.equal(store.error, true);
  assert.equal(store.get(1, 2).weight, '12.5');
});

test('a failed update keeps the latest draft ahead of readable stale storage', () => {
  const disk = storage();
  const store = new DraftStore(() => disk);
  const first = store.put(1, 2, values);
  disk.setItem = () => { throw new Error('Quota exceeded'); };
  store.put(1, 2, { ...values, result: '12' });
  assert.equal(store.get(1, 2).result, '12');
  store.remove(1, 2, first.revision);
  assert.equal(store.get(1, 2).result, '12');
  assert.equal(store.error, true);
});

test('corrupt storage does not prevent startup', () => {
  const disk = storage();
  disk.setItem('gymdex:workout:v1', '{broken');
  const store = new DraftStore(() => disk);
  assert.equal(store.cachedWorkout(), null);
  assert.equal(store.error, true);
});

test('assistance uses a positive keyboard entry and preserves optional weight', () => {
  assert.equal(setPayload(values).weight, -12.5);
  assert.equal(setPayload({ ...values, assistance: false }).weight, 12.5);
  assert.equal(setPayload({ ...values, weight: '' }).weight, null);
  assert.equal(setPayload({ ...values, result: '' }).result, null);
});

test('weights accept a decimal comma as well as a decimal point', () => {
  assert.equal(setPayload({ ...values, assistance: false, weight: '62,5' }).weight, 62.5);
  assert.equal(setPayload({ ...values, assistance: false, weight: ' 62.5 ' }).weight, 62.5);
  assert.equal(setPayload({ ...values, weight: '7,5' }).weight, -7.5);
});

test('a payload sends Effort only when the values carry it, so older drafts keep the saved one', () => {
  assert.equal('effort' in setPayload(values), false);
  assert.equal(setPayload({ ...values, effort: null }).effort, null);
  assert.equal(setPayload({ ...values, effort: 'failure' }).effort, 'failure');
});

test('drafts from before Effort existed still restore, and an unknown Effort is rejected', () => {
  const disk = storage();
  const store = new DraftStore(() => disk);
  store.put(1, 2, values);
  store.put(1, 3, { ...values, effort: '4+' });
  store.put(1, 4, { ...values, effort: null });
  store.put(1, 5, { ...values, effort: '5' });
  const reloaded = new DraftStore(() => disk);
  assert.equal(reloaded.get(1, 2).weight, '12.5');
  assert.equal(reloaded.get(1, 3).effort, '4+');
  assert.equal(reloaded.get(1, 4).effort, null);
  assert.equal(reloaded.get(1, 5), null);
});

test('Effort reads as Failure or the repetitions left', () => {
  assert.deepEqual(['failure', '0', '1', '4+'].map((effort) => effortText(effort)), ['Failure', '0 reps left', '1 rep left', '4+ reps left']);
  assert.deepEqual(['failure', '2'].map((effort) => effortText(effort, { short: true })), ['Failure', '2 left']);
});

test('worker upgrade installs the current shell and removes the previous offline version', async () => {
  const handlers = {};
  const cachesByName = new Map([
    ['gymdex-shell-v1', new Map([['/app.js', 'old app']])],
    ['unrelated-cache', new Map()],
  ]);
  const assets = new Map(await Promise.all(['/', '/index.html', '/styles.css', '/app.js', '/app.mjs', '/workout-editor.mjs', '/drafts.mjs', '/rest-timer.mjs', '/keyboard.mjs', '/confirm-sheet.mjs', '/choice-field.mjs', '/routines.mjs', '/exercise-reorder.mjs', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/fonts/Geist-Variable.woff2'].map(async (path) =>
    [path, await readFile(new URL('../static/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url), 'utf8')])));
  let claimed = false;
  const context = vm.createContext({
    URL, Response, AbortController, setTimeout, clearTimeout,
    self: {
      location: { origin: 'https://gym.test' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { claim: async () => { claimed = true; } },
    },
    fetch: async () => { throw new Error('offline'); },
    caches: {
      open: async (name) => {
        if (!cachesByName.has(name)) cachesByName.set(name, new Map());
        return { addAll: async (paths) => { for (const path of paths) cachesByName.get(name).set(path, assets.get(path)); } };
      },
      keys: async () => [...cachesByName.keys()],
      delete: async (name) => cachesByName.delete(name),
      match: async (path) => [...cachesByName.values()].map(cache => cache.get(path)).find(Boolean),
    },
  });
  vm.runInContext(await readFile(new URL('../static/sw.js', import.meta.url), 'utf8'), context);
  let pending;
  handlers.install({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  const current = [...cachesByName.keys()].find(name => name.startsWith('gymdex-shell-') && name !== 'gymdex-shell-v1');
  assert.ok(current);
  assert.deepEqual([...cachesByName.get(current).keys()].filter(path => !assets.has(path)), []);
  handlers.activate({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.equal(cachesByName.has('gymdex-shell-v1'), false);
  assert.equal(cachesByName.has('unrelated-cache'), true);
  assert.equal(claimed, true);
  handlers.fetch({ request: { url: 'https://gym.test/app.js', method: 'GET' }, respondWith: (promise) => { pending = promise; } });
  assert.equal(await pending, assets.get('/app.js'));
});

test('service worker falls back to the app shell but never intercepts API requests', async () => {
  const handlers = {};
  const cached = { cached: true };
  const context = vm.createContext({
    URL, Response, AbortController, setTimeout, clearTimeout,
    self: { location: { origin: 'https://gym.test' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    fetch: async () => { throw new Error('offline'); },
    caches: { match: async () => cached },
  });
  vm.runInContext(await readFile(new URL('../static/sw.js', import.meta.url), 'utf8'), context);
  let response;
  handlers.fetch({ request: {url: 'https://gym.test/', method: 'GET'}, respondWith: (promise) => { response = promise; } });
  assert.equal(await response, cached);
  for (const [path, method] of [['/api/bootstrap', 'GET'], ['/api/sets/2', 'PUT']]) {
    handlers.fetch({request: {url: `https://gym.test${path}`, method}, respondWith() { assert.fail('API intercepted'); }});
  }
});
