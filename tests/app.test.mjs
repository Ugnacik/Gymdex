import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../static/app.mjs';
import { DraftStore } from '../static/drafts.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function storage() {
  const data = new Map();
  return { get length() { return data.size; }, key: (i) => [...data.keys()][i],
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key) };
}
function node() {
  return { innerHTML: '', textContent: '', hidden: false, disabled: false, events: {},
    classList: { toggle() {} }, addEventListener(event, callback) { this.events[event] = callback; },
    focus() { this.focused = true; }, setAttribute() {}, removeAttribute() {},
    querySelectorAll() {
      this.buttons = [...this.innerHTML.matchAll(/data-history-id="(\d+)"/g)].map((match) =>
        Object.assign(node(), { dataset: { historyId: match[1] } }));
      return this.buttons;
    },
  };
}

async function harness(disk = storage()) {
  const nodes = Object.fromEntries(['#app', '#toast', '#sync-status', '#picker-results', 'main',
    '#open-picker', '#open-history', '#cancel-workout', '#finish', '#add-gym-form', '#start-workout']
    .map((key) => [key, node()]));
  const timers = new Map();
  let timerId = 0;
  const formNodes = { fieldset: node(), '.set-status': node(), '.remove-set': node(), legend: node() };
  formNodes.legend.textContent = 'Set 1';
  const form = Object.assign(node(), {
    isConnected: true, dataset: { setId: '2', entryId: '3' },
    elements: { weight: { value: '' }, result: { value: '', required: false },
      assistance: { checked: false }, completed: Object.assign(node(), { checked: false }) },
    querySelector: (selector) => formNodes[selector],
    checkValidity: () => !form.elements.result.required || form.elements.result.value !== '',
    reportValidity: () => form.checkValidity(), scrollIntoView() {},
  });
  const data = { gyms: [], active_workout: { id: 1, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00' },
    workout_exercises: [{ id: 3, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
      previous_sets: [], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] }] };
  const env = {
    window: { localStorage: disk, addEventListener() {}, confirm: () => true },
    navigator: { onLine: true },
    document: {
      visibilityState: 'visible', addEventListener() {},
      querySelector: (selector) => selector === '.set-form[data-dirty="true"]'
        ? (form.dataset.dirty ? form : null) : nodes[selector] ?? null,
      querySelectorAll: (selector) => {
        if (selector === '.set-form') return form.isConnected ? [form] : [];
        if (selector === '.set-form[data-dirty="true"]') return form.isConnected && form.dataset.dirty ? [form] : [];
        if (selector === '[data-finish-workout]') return [nodes['#finish']];
        if (selector === '[data-finish-workout], #cancel-workout') return [nodes['#finish'], nodes['#cancel-workout']];
        return [];
      },
    },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval() {},
    fetch: async (path) => {
      if (path === '/api/bootstrap') return response(structuredClone(data));
      throw new Error('Offline');
    },
  };
  const app = createApp({ ...env, fetch: (...args) => env.fetch(...args) });
  await app.load();
  return { env, nodes, form, disk, timers, app };
}

function historyDOM(app) {
  const nodes = {};
  const dialog = node();
  dialog.querySelector = (selector) => nodes[selector] ??= node();
  dialog.showModal = () => { dialog.open = true; };
  dialog.remove = () => { dialog.removed = true; delete app.nodes['#history']; };
  dialog.close = () => { dialog.open = false; dialog.events.close(); };
  app.env.document.createElement = () => dialog;
  app.env.document.body = { append: () => { app.nodes['#history'] = dialog; } };
  return { dialog, nodes };
}

test('input events persist drafts and a new app restores them', async () => {
  const app = await harness();
  app.form.elements.weight.value = '12.5';
  app.form.elements.result.value = '8';
  app.form.elements.assistance.checked = true;
  app.form.events.input();
  const second = await harness(app.disk);
  assert.equal(second.form.elements.weight.value, '12.5');
  assert.equal(second.form.elements.assistance.checked, true);
  assert.equal(second.form.dataset.dirty, 'true');
});

test('finish and cancel keep an acknowledged terminal state when bootstrap fails', async () => {
  for (const button of ['#finish', '#cancel-workout']) {
    const app = await harness();
    const ending = deferred();
    app.env.fetch = async (path) => {
      if (path.startsWith('/api/workouts/')) return ending.promise;
      throw new Error('Refresh unavailable');
    };
    const pending = app.nodes[button].events.click();
    assert.equal(app.nodes.main.inert, true);
    assert.equal(app.nodes[button].disabled, true);
    ending.resolve(response({ ok: true }));
    await pending;
    assert.match(app.nodes['#app'].innerHTML, /No active workout/);
    assert.equal(new DraftStore(() => app.disk).cachedWorkout().active_workout, null);
    assert.equal(app.nodes.main.inert, false);
  }
});

test('a stalled HTTP save times out without disabling entry or discarding its draft', async () => {
  const app = await harness();
  app.form.elements.result.value = '8';
  app.form.events.input();
  app.env.fetch = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  app.form.events.submit({ preventDefault() {} });
  [...app.timers.values()].find((timer) => timer.delay === 8000).callback();
  await settle();
  assert.equal(app.form.querySelector('fieldset').disabled, false);
  assert.equal(app.form.dataset.dirty, 'true');
  assert.equal(new DraftStore(() => app.disk).get(1, 2).result, '8');
  assert.match(app.form.querySelector('.set-status').textContent, /Will retry automatically/);
});

test('history paginates and filters without replacing the active form or draft', async () => {
  const app = await harness();
  app.form.elements.result.value = '9';
  app.form.events.input();
  const { dialog, nodes } = historyDOM(app);
  const urls = [];
  app.env.fetch = async (url) => {
    urls.push(url);
    return response({ workouts: [], next_offset: urls.length === 1 ? 20 : null });
  };
  app.nodes['#open-history'].events.click();
  await settle();
  assert.equal(dialog.open, true);
  assert.equal(nodes['#history-next'].disabled, false);
  nodes['#history-next'].events.click();
  await settle();
  assert.equal(urls[1], '/api/history?offset=20');
  assert.equal(nodes['#history-previous'].disabled, false);
  // This Node form adapter supplies the same entries as a browser HTMLFormElement.
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class { constructor() { return [['gym_id', '2'], ['start', '2026-09-21'], ['end', '2026-09-22']]; } };
  try { nodes['#history-filters'].events.submit({ preventDefault() {} }); }
  finally { globalThis.FormData = originalFormData; }
  await settle();
  assert.equal(urls[2], '/api/history?gym_id=2&start=2026-09-21&end=2026-09-22&offset=0');
  assert.match(nodes['#history-message'].textContent, /No completed workouts/);
  nodes['#close-history'].events.click();
  assert.equal(dialog.removed, true);
  assert.equal(app.form.elements.result.value, '9');
  assert.equal(new DraftStore(() => app.disk).get(1, 2).result, '9');
  assert.ok(urls.every((url) => url.startsWith('/api/history?')));
});

test('history shows errors and ignores stale responses after filtering or closing', async () => {
  const app = await harness();
  const { dialog, nodes } = historyDOM(app);
  app.nodes['#open-history'].events.click();
  await settle();
  assert.match(nodes['#history-message'].textContent, /History requires a connection/);
  const old = deferred();
  app.env.fetch = () => old.promise;
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class { constructor() { return []; } };
  try {
    nodes['#history-filters'].events.submit({ preventDefault() {} });
    app.env.fetch = async () => response({ workouts: [], next_offset: null });
    nodes['#history-filters'].events.submit({ preventDefault() {} });
    await settle();
    old.resolve(response({ workouts: [{ id: 99 }], next_offset: 20 }));
    await settle();
    assert.match(nodes['#history-message'].textContent, /No completed workouts/);
    assert.equal(nodes['#history-next'].disabled, true);
    const closing = deferred();
    app.env.fetch = () => closing.promise;
    nodes['#history-filters'].events.submit({ preventDefault() {} });
    dialog.close();
    closing.resolve(response({ workouts: [{ id: 99 }], next_offset: 20 }));
    await settle();
    assert.equal(nodes['#history-results'].innerHTML, '');
  } finally { globalThis.FormData = originalFormData; }
});

test('history detail escapes saved text and shows duration, assistance and unfinished sets', async () => {
  const app = await harness();
  const { nodes } = historyDOM(app);
  const workout = { id: 1, gym_name: '<img src=x>', started_at: '2026-09-22 10:00:00', completed_at: '2026-09-22 11:00:00' };
  const entry = { exercise_name: 'Plank', variation_name: 'Front Plank', equipment: 'Bodyweight',
    manufacturer: '<script>', label: 'A&B', tracking_type: 'duration',
    sets: [{ result: 60, weight: -12.5, completed: 1 }, { result: null, weight: null, completed: 0 }] };
  const detail = { workout, workout_exercises: [entry] };
  app.env.fetch = async (path) => response(path.includes('?') ? { workouts: [workout], next_offset: null } : detail);
  app.nodes['#open-history'].events.click();
  await settle();
  const button = nodes['#history-results'].buttons[0];
  button.events.click();
  await settle();
  const html = nodes['#history-detail'].innerHTML;
  for (const text of ['60 seconds', '12.5 kg assistance', 'Not completed', 'No result recorded', 'No weight recorded', '&lt;img src=x&gt;', '&lt;script&gt;', 'A&amp;B']) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /<img|<script|set-form/);
  entry.tracking_type = 'repetitions';
  button.events.click();
  await settle();
  assert.match(nodes['#history-detail'].innerHTML, /60 reps/);
  entry.sets = [];
  button.events.click();
  await settle();
  assert.match(nodes['#history-detail'].innerHTML, /No sets recorded/);
  detail.workout_exercises = [];
  button.events.click();
  await settle();
  assert.match(nodes['#history-detail'].innerHTML, /No exercises recorded/);
  nodes['#history-back'].events.click();
  assert.equal(button.focused, true);
});

test('filtering exercise search changes only the results container', async () => {
  const app = await harness();
  const wrapper = node();
  wrapper.remove = () => { delete app.nodes['#picker']; };
  const search = Object.assign(node(), { value: '', setSelectionRange() {} });
  app.nodes['#exercise-search'] = search;
  app.nodes['#close-picker'] = node();
  app.env.document.createElement = () => wrapper;
  app.env.document.body = { append: () => { app.nodes['#picker'] = wrapper; } };
  app.env.fetch = async () => response({ recent: [], catalog: [{ id: 1, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: ['Barbell'] }] });
  await app.nodes['#open-picker'].events.click();
  const original = wrapper.innerHTML;
  search.events.input({ target: { value: 'Bench' } });
  assert.match(app.nodes['#picker-results'].innerHTML, /Bench Press/);
  search.events.input({ target: { value: 'no match' } });
  assert.match(app.nodes['#picker-results'].innerHTML, /No matches/);
  assert.equal(wrapper.innerHTML, original);
});
