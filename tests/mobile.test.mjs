import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { DraftStore, setPayload } from '../static/drafts.mjs';

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
  const nodes = { '#app': {}, '#toast': {}, '#sync-status': status, '#picker-results': {}, main: { inert: false } };
  const context = vm.createContext({
    DraftStore, setPayload, AbortController,
    navigator: { onLine: true },
    window: { localStorage: disk, addEventListener() {}, confirm: () => true },
    document: {
      visibilityState: 'visible', addEventListener() {},
      querySelector: (selector) => nodes[selector] ?? null,
      querySelectorAll: (selector) => selector === '.set-form[data-dirty="true"]'
        ? forms.filter((form) => form.isConnected && form.dataset.dirty === 'true')
        : selector === '.set-form' ? forms.filter((form) => form.isConnected) : [],
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('finish freezes entry through saving and completion, including a newer in-flight draft', async () => {
  const disk = storage();
  const app = harness(disk);
  const form = app.form();
  const saving = deferred();
  const completing = deferred();
  const completeStarted = deferred();
  const requests = [];
  app.context.fetch = async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    if (requests.length === 1) return saving.promise;
    if (path.endsWith('/complete')) {
      completeStarted.resolve();
      return completing.promise;
    }
    return response({ id: 2, ...JSON.parse(options.body) });
  };
  app.run('load = async () => { form.isConnected = false; }');
  form.elements.result.value = '8';
  app.listeners.input();
  const save = app.run('saveSet(form)');
  form.elements.result.value = '12';
  app.listeners.input();
  const finish = app.run('finishWorkout()');
  assert.equal(app.nodes.main.inert, true);
  assert.equal(app.timers.has(form.saveTimer), false);
  saving.resolve(response({ id: 2, result: 8, completed: false }));
  await save;
  await completeStarted.promise;
  assert.equal(app.nodes.main.inert, true);
  assert.deepEqual(requests.map(({path}) => path), ['/api/sets/2', '/api/sets/2', '/api/workouts/1/complete']);
  assert.equal(requests[1].body.result, 12);
  assert.equal(new DraftStore(() => disk).get(1, 2), null);
  completing.resolve(response({ ok: true }));
  await finish;
  assert.equal(app.nodes.main.inert, false);
});

test('invalid input, declined finish, and completion failure unlock the workout', async () => {
  for (const mode of ['invalid', 'declined', 'failed']) {
    const app = harness();
    const form = app.form();
    form.elements.completed.checked = true;
    form.elements.result.value = mode === 'invalid' ? '' : '8';
    app.listeners.input();
    const methods = [];
    app.context.window.confirm = () => mode !== 'declined';
    app.context.fetch = async (_, options) => {
      methods.push(options.method);
      if (options.method === 'POST') throw new Error('offline');
      return response({ id: 2, ...JSON.parse(options.body) });
    };
    await app.run('finishWorkout()');
    assert.equal(app.nodes.main.inert, false);
    assert.equal(app.run('state.workoutBusy'), false);
    assert.equal(app.run('state.data.active_workout.id'), 1);
    assert.deepEqual(methods, mode === 'invalid' ? [] : mode === 'declined' ? ['PUT'] : ['PUT', 'POST']);
  }
});

test('cancel stops timers and retries, clears only its drafts, and survives a failed refresh', async () => {
  const disk = storage();
  const store = new DraftStore(() => disk);
  store.put(1, 99, values); // A draft from an earlier page, absent from the current form list.
  store.put(10, 2, values);
  const app = harness(disk);
  const form = app.form();
  app.listeners.input();
  const timer = app.timers.get(form.saveTimer);
  const deleting = deferred();
  const deleteStarted = deferred();
  const methods = [];
  app.context.fetch = async (_, options) => {
    methods.push(options.method ?? 'GET');
    if (options.method === 'DELETE') {
      deleteStarted.resolve();
      return deleting.promise;
    }
    throw new Error('refresh unavailable');
  };
  // Keep the real load/cached fallback path; only replace DOM rendering.
  app.run('render = () => { form.isConnected = Boolean(state.data.active_workout); }');
  const cancel = app.run('cancelWorkout()');
  await deleteStarted.promise;
  assert.equal(app.nodes.main.inert, true);
  assert.equal(app.timers.has(form.saveTimer), false);
  await timer.callback(); // Even a callback already queued must be harmless.
  await app.run('retryPendingSets()');
  assert.deepEqual(methods, ['DELETE']);
  deleting.resolve(response({ ok: true }));
  await cancel;
  const reloaded = new DraftStore(() => disk);
  assert.equal(reloaded.get(1, 2), null);
  assert.equal(reloaded.get(1, 99), null);
  assert.equal(reloaded.get(10, 2).result, values.result);
  assert.equal(reloaded.cachedWorkout().active_workout, null);
  assert.equal(app.run('state.data.active_workout'), null);
  assert.equal(app.nodes.main.inert, false);
});

test('cancel waits for in-flight saving and preserves drafts when deletion fails', async () => {
  const disk = storage();
  const app = harness(disk);
  const form = app.form();
  form.elements.result.value = '8';
  app.listeners.input();
  const saving = deferred();
  const methods = [];
  app.context.fetch = async (_, options) => {
    methods.push(options.method);
    if (options.method === 'PUT') return saving.promise;
    throw new Error('connection lost during DELETE');
  };
  const save = app.run('saveSet(form)');
  form.elements.result.value = '12';
  app.listeners.input();
  const cancel = app.run('cancelWorkout()');
  assert.deepEqual(methods, ['PUT']);
  saving.resolve(response({ id: 2, result: 8, completed: false }));
  await save;
  await cancel;
  assert.deepEqual(methods, ['PUT', 'DELETE']);
  assert.equal(app.timers.has(form.saveTimer), false);
  assert.equal(new DraftStore(() => disk).get(1, 2).result, '12');
  assert.equal(app.run('state.data.active_workout.id'), 1);
  assert.equal(app.nodes.main.inert, false);
  app.context.fetch = async (_, options) => response({ id: 2, ...JSON.parse(options.body ?? '{}') });
  await app.run('retryPendingSets()');
  assert.equal(new DraftStore(() => disk).get(1, 2), null);
});

test('worker upgrade installs the current shell and removes the previous offline version', async () => {
  const handlers = {};
  const cachesByName = new Map([
    ['gymdex-shell-v1', new Map([['/app.js', 'old app']])],
    ['unrelated-cache', new Map()],
  ]);
  const assets = new Map(await Promise.all(['/', '/index.html', '/styles.css', '/app.js', '/drafts.mjs', '/manifest.webmanifest'].map(async (path) =>
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
  assert.ok([...cachesByName.keys()].some(name => name.startsWith('gymdex-shell-') && name !== 'gymdex-shell-v1'));
  handlers.activate({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.equal(cachesByName.has('gymdex-shell-v1'), false);
  assert.equal(cachesByName.has('unrelated-cache'), true);
  assert.equal(claimed, true);
  handlers.fetch({ request: { url: 'https://gym.test/app.js', method: 'GET' }, respondWith: (promise) => { pending = promise; } });
  assert.equal(await pending, assets.get('/app.js'));
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
