import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { DraftStore, setPayload } from '../static/drafts.mjs';

function storage() {
  const data = new Map();
  return {
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

const source = (await readFile(new URL('../static/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*\n/, '').replace(/\nload\(\);\s*$/, '');

function harness(disk = storage()) {
  const listeners = {};
  const forms = [];
  const timers = new Map();
  let timerId = 0;
  const status = { textContent: '', classList: { toggle() {} } };
  const nodes = { '#app': {}, '#toast': {}, '#sync-status': status, '#picker-results': {} };
  const context = vm.createContext({
    DraftStore, setPayload, AbortController,
    navigator: { onLine: true },
    window: { localStorage: disk, addEventListener() {}, confirm: () => true },
    document: {
      visibilityState: 'visible', addEventListener() {},
      querySelector: (selector) => nodes[selector] ?? null,
      querySelectorAll: (selector) => selector === '.set-form[data-dirty="true"]'
        ? forms.filter((form) => form.dataset.dirty === 'true') : [],
    },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval() {},
    fetch: async () => { throw new Error('Network disconnected'); },
  });
  vm.runInContext(source, context);
  vm.runInContext('state.data = { active_workout: {id: 1}, gyms: [], workout_exercises: [{id: 3, sets: [{id: 2}]}] }', context);
  function form() {
    const fieldset = { disabled: false };
    const setStatus = { textContent: '', classList: { toggle() {} } };
    const result = {
      dataset: { setId: '2', entryId: '3' }, isConnected: true,
      elements: {
        weight: { value: '' }, result: { value: '', required: false },
        assistance: { checked: false }, completed: { checked: false, addEventListener() {} },
      },
      addEventListener: (event, callback) => { listeners[event] = callback; },
      querySelector: (selector) => selector === 'fieldset' ? fieldset : selector === '.set-status' ? setStatus : { addEventListener() {} },
      classList: { toggle() {} }, scrollIntoView() {},
      checkValidity: () => !result.elements.result.required || result.elements.result.value !== '',
      reportValidity: () => result.checkValidity(),
    };
    forms.push(result);
    context.form = result;
    vm.runInContext('bindSet(form)', context);
    return result;
  }
  return { context, form, listeners, timers, status, nodes, run: (code) => vm.runInContext(code, context) };
}

test('typing saves locally immediately, and a page reload restores unsynced inputs', () => {
  const disk = storage();
  const first = harness(disk);
  const form = first.form();
  form.elements.weight.value = '12.5';
  form.elements.result.value = '8';
  form.elements.assistance.checked = true;
  first.listeners.input();
  assert.equal(new DraftStore(() => disk).get(1, 2).weight, '12.5');
  const second = harness(disk);
  const restored = second.form();
  assert.equal(restored.elements.weight.value, '12.5');
  assert.equal(restored.elements.assistance.checked, true);
  assert.equal(restored.dataset.dirty, 'true');
});

test('lost connection keeps the draft, reconnect retries a PUT and clears only after acknowledgement', async () => {
  const disk = storage();
  const app = harness(disk);
  const form = app.form();
  form.elements.weight.value = '12.5';
  form.elements.result.value = '8';
  form.elements.assistance.checked = true;
  app.listeners.input();
  assert.equal(await app.run('saveSet(form)'), false);
  assert.equal(form.dataset.dirty, 'true');
  assert.equal(form.querySelector('fieldset').disabled, false);
  assert.equal(new DraftStore(() => disk).get(1, 2).result, '8');
  const sent = [];
  app.context.fetch = async (path, options) => {
    if (options.method === 'PUT') sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => options.method === 'PUT' ? { id: 2, ...JSON.parse(options.body) } : {} };
  };
  await app.run('retryPendingSets()');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].weight, -12.5);
  assert.equal(form.dataset.dirty, undefined);
  assert.equal(new DraftStore(() => disk).get(1, 2), null);
  assert.equal(new DraftStore(() => disk).cachedWorkout().workout_exercises[0].sets[0].weight, -12.5);
});

test('invalid completed sets stay local and prevent finishing', async () => {
  const app = harness();
  const form = app.form();
  form.elements.completed.checked = true;
  app.listeners.input();
  let requests = 0;
  app.context.fetch = async () => { requests++; throw new Error('Unexpected request'); };
  assert.equal(await app.run('saveAllSets()'), false);
  assert.equal(requests, 0);
  assert.equal(form.dataset.dirty, 'true');
});

test('server rejection retains the draft without an endless automatic retry', async () => {
  const app = harness();
  const form = app.form();
  app.listeners.input();
  let requests = 0;
  app.context.fetch = async () => { requests++; return { ok: false, status: 404, json: async () => ({error: 'Set no longer active'}) }; };
  assert.equal(await app.run('saveSet(form)'), false);
  await app.run('retryPendingSets()');
  assert.equal(requests, 1);
  assert.equal(form.dataset.blocked, 'true');
  assert.equal(form.dataset.dirty, 'true');
});

test('a stalled save times out and retains its draft without disabling entry', async () => {
  const app = harness();
  const form = app.form();
  app.listeners.input();
  app.context.fetch = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const pending = app.run('saveSet(form)');
  [...app.timers.values()].find((timer) => timer.delay === 8000).callback();
  assert.equal(await pending, false);
  assert.equal(form.querySelector('fieldset').disabled, false);
  assert.equal(form.dataset.dirty, 'true');
});

test('filtering search updates only the results container', () => {
  const app = harness();
  app.run('state.picker = {recent: [], catalog: [{id: 1, exercise_name: "Bench Press", variation_name: "Standard", equipment: ["Barbell"]}]}');
  app.run('renderPickerResults("Bench")');
  assert.match(app.nodes['#picker-results'].innerHTML, /Bench Press/);
  app.run('renderPickerResults("no match")');
  assert.match(app.nodes['#picker-results'].innerHTML, /No matches/);
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

test('edits during an in-flight save remain editable and survive its acknowledgement', async () => {
  const disk = storage();
  const app = harness(disk);
  const form = app.form();
  form.elements.result.value = '8';
  app.listeners.input();
  let acknowledge;
  app.context.fetch = () => new Promise((resolve) => { acknowledge = resolve; });
  const pending = app.run('saveSet(form)');
  assert.equal(form.querySelector('fieldset').disabled, false);
  form.elements.result.value = '12';
  app.listeners.input();
  acknowledge({ok: true, json: async () => ({id: 2, result: 8, weight: null, completed: false})});
  assert.equal(await pending, false);
  assert.equal(form.elements.result.value, '12');
  assert.equal(form.dataset.dirty, 'true');
  assert.equal(new DraftStore(() => disk).get(1, 2).result, '12');
  app.context.fetch = async (_, options) => ({ok: true, json: async () => ({id: 2, ...JSON.parse(options.body)})});
  await app.run('retryPendingSets()');
  assert.equal(form.dataset.dirty, undefined);
  assert.equal(new DraftStore(() => disk).cachedWorkout().workout_exercises[0].sets[0].result, 12);
});
