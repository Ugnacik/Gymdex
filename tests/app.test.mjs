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

async function harness(disk = storage(), initialData = {}) {
  const nodes = Object.fromEntries(['#app', '#toast', '#sync-status', '#picker-results', 'main',
    '#open-picker', '#open-history', '#open-progress', '#cancel-workout', '#finish', '#add-gym-form', '#start-workout', '#create-exercise',
    '#rest-enabled', '#rest-controls', '#rest-duration', '#rest-clock', '#rest-status', '#rest-start', '#rest-pause', '#rest-stop']
    .map((key) => [key, node()]));
  const timers = new Map();
  let timerId = 0;
  const formNodes = { fieldset: node(), '.set-status': node(), '.remove-set': node(), '.set-retry': Object.assign(node(), { hidden: true }), legend: node() };
  formNodes.legend.textContent = 'Set 1';
  const form = Object.assign(node(), {
    isConnected: true, dataset: { setId: '2', entryId: '3' },
    elements: { weight: { value: '' }, result: { value: '', required: false },
      completed: Object.assign(node(), { checked: false }) },
    querySelector: (selector) => formNodes[selector],
    checkValidity: () => !form.elements.result.required || form.elements.result.value !== '',
    reportValidity: () => form.checkValidity(), scrollIntoView() {},
    requestSubmit: () => form.events.submit({ preventDefault() {} }),
  });
  const data = { gyms: [], active_workout: { id: 1, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00' },
    workout_exercises: [{ id: 3, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
      previous_sets: [], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] }], ...initialData };
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
  app.form.events.input();
  const second = await harness(app.disk);
  assert.equal(second.form.elements.weight.value, '12.5');
  assert.equal(new DraftStore(() => second.disk).get(1, 2).assistance, false);
  assert.equal(second.form.dataset.dirty, 'true');
});

test('assisted variations label the weight Assist kg and save it as negative', async () => {
  const assistedEntry = { id: 3, variation_id: 18, exercise_name: 'Pull-up', variation_name: 'Assisted', equipment: 'Machine', assisted: 1,
    tracking_type: 'repetitions', previous_sets: [{ weight: -25, result: 8 }], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] };
  const app = await harness(storage(), { workout_exercises: [assistedEntry] });
  const html = app.nodes['#app'].innerHTML;
  assert.match(html, /data-assisted="true"/);
  assert.match(html, /Assist kg <input name="weight"[^>]*aria-label="Assisted Pull-up, set 1 assistance in kilograms"/);
  assert.match(html, /Last workout: 25 kg assistance × 8 reps/);
  assert.match(html, /Assist kg is the counterweight/);
  assert.doesNotMatch(html, /name="assistance"|Select Assistance/);
  const bodies = [];
  app.env.fetch = async (path, options) => { bodies.push(JSON.parse(options.body)); return response({ id: 2, position: 1, weight: -20, result: 8, completed: true }); };
  app.form.dataset.assisted = 'true';
  app.form.elements.weight.value = '20';
  app.form.elements.result.value = '8';
  app.form.elements.completed.checked = true;
  app.form.elements.completed.events.change();
  await settle();
  assert.deepEqual(bodies, [{ weight: -20, result: 8, completed: true }]);
});

test('earlier negative sets and restored assistance drafts stay assisted on unassisted variations', async () => {
  const legacy = await harness(storage(), { workout_exercises: [{ id: 3, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell', assisted: 0,
    previous_sets: [], sets: [{ id: 2, position: 1, weight: -10, result: 5, completed: true }] }] });
  assert.match(legacy.nodes['#app'].innerHTML, /data-assisted="true"[\s\S]*Assist kg <input name="weight"[^>]*value="10"/);
  const disk = storage();
  new DraftStore(() => disk).put(1, 2, { weight: '7.5', result: '', completed: false, assistance: true });
  const restored = await harness(disk);
  assert.match(restored.nodes['#app'].innerHTML, /data-assisted="true"/);
  const plain = await harness();
  assert.match(plain.nodes['#app'].innerHTML, /data-assisted="false"[\s\S]*>kg <input name="weight"/);
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

test('a valid completed set starts the optional rest timer while offline', async () => {
  const disk = storage();
  disk.setItem('gymdex:rest:v1', JSON.stringify({ enabled: true, duration: 30 }));
  const app = await harness(disk);
  app.env.navigator.onLine = false;
  app.form.elements.completed.checked = true;
  app.form.elements.completed.events.change();
  assert.equal(app.nodes['#rest-clock'].textContent, '0:00');
  app.form.elements.result.value = '8';
  app.form.elements.completed.events.change();
  assert.equal(app.nodes['#rest-clock'].textContent, '0:30');
  assert.equal(app.nodes['#rest-status'].textContent, 'Resting');
  app.nodes['#rest-pause'].events.click();
  assert.equal(app.nodes['#rest-status'].textContent, 'Paused');
  app.nodes['#rest-pause'].events.click();
  assert.equal(app.nodes['#rest-status'].textContent, 'Resting');
});

test('custom exercise creation offers the new variation for the active workout', async () => {
  const app = await harness();
  const wrapper = node();
  wrapper.remove = () => { delete app.nodes['#picker']; };
  const sheet = node();
  const customForm = Object.assign(node(), { querySelector: () => node() });
  const entry = Object.assign(node(), { value: '' });
  const chips = node();
  const sheetNodes = {
    '#back-to-picker': node(), '#close-picker': node(), '#custom-exercise-form': customForm,
    '[name="name"]': node(), '#equipment-entry': entry, '#add-equipment': node(), '#equipment-chips': chips,
  };
  sheet.querySelector = (selector) => sheetNodes[selector];
  app.nodes['#picker .sheet'] = sheet;
  app.nodes['#exercise-search'] = Object.assign(node(), { value: '', setSelectionRange() {} });
  app.nodes['#close-picker'] = node();
  app.nodes['#back-to-picker'] = node();
  app.nodes['#configuration-form'] = node();
  app.env.document.createElement = () => wrapper;
  app.env.document.body = { append: () => { app.nodes['#picker'] = wrapper; } };
  const requests = [];
  app.env.fetch = async (path, options) => {
    requests.push([path, options]);
    if (path.startsWith('/api/catalog')) return response({ recent: [], catalog: [] });
    if (path === '/api/exercises') return response({ id: 17, exercise_name: 'Leg Press', variation_name: 'Single Leg', tracking_type: 'repetitions', equipment: ['Machine'] }, 201);
    throw new Error('Unexpected request');
  };
  await app.nodes['#open-picker'].events.click();
  app.nodes['#create-exercise'].events.click();
  assert.match(sheet.innerHTML, /Create custom exercise/);
  assert.match(sheet.innerHTML, /<input name="assisted" type="checkbox" \/> Assisted \(weight is counterweight\)/);
  assert.doesNotMatch(sheet.innerHTML, /commas/);
  assert.match(sheet.innerHTML, /<input id="equipment-entry"[^>]*maxlength="80"/);
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class { constructor() { return new Map([
    ['name', 'Leg Press'], ['variation_name', 'Single Leg'], ['tracking_type', 'repetitions'],
  ]); } };
  try {
    await customForm.events.submit({ preventDefault() {}, currentTarget: customForm });
    assert.equal(requests.length, 1);
    assert.equal(app.nodes['#toast'].textContent, 'Add at least one equipment option.');
    assert.equal(entry.focused, true);
    let prevented = false;
    entry.value = '  Plate-loaded,   45° ';
    entry.events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(entry.value, '');
    entry.value = 'Machine';
    sheetNodes['#add-equipment'].events.click();
    entry.value = 'machine';
    sheetNodes['#add-equipment'].events.click();
    assert.equal(app.nodes['#toast'].textContent, 'machine is already added.');
    assert.equal(entry.value, 'machine');
    assert.match(chips.innerHTML, /<span>Plate-loaded, 45°<\/span>.*aria-label="Remove Plate-loaded, 45°"/);
    assert.match(chips.innerHTML, /data-remove-equipment="1" aria-label="Remove Machine"/);
    const removeFirst = { dataset: { removeEquipment: '0' } };
    chips.events.click({ target: { closest: () => removeFirst } });
    assert.doesNotMatch(chips.innerHTML, /Plate-loaded/);
    entry.value = 'Cable';
    await customForm.events.submit({ preventDefault() {}, currentTarget: customForm });
  } finally { globalThis.FormData = originalFormData; }
  assert.equal(requests[1][0], '/api/exercises');
  assert.deepEqual(JSON.parse(requests[1][1].body), { name: 'Leg Press', variation_name: 'Single Leg', tracking_type: 'repetitions', equipment: ['Machine', 'Cable'], assisted: false });
  assert.match(sheet.innerHTML, /Single Leg Leg Press/);
  assert.match(sheet.innerHTML, /data-equipment="Machine"/);
});

test('progress shows a chart and numeric history for an exercise', async () => {
  const app = await harness(storage(), { gyms: [{ id: 1, name: 'Home' }] });
  const nodes = {};
  const dialog = node();
  dialog.querySelector = (selector) => nodes[selector] ??= node();
  dialog.showModal = () => { dialog.open = true; };
  dialog.remove = () => { delete app.nodes['#progress']; };
  dialog.close = () => { dialog.open = false; dialog.events.close(); };
  nodes['#progress-exercise'] = Object.assign(node(), { value: '17' });
  nodes['#progress-filters'] = Object.assign(node(), { elements: { gym_id: { value: '' } } });
  app.env.document.createElement = () => dialog;
  app.env.document.body = { append: () => { app.nodes['#progress'] = dialog; } };
  const urls = [];
  app.env.fetch = async (url) => {
    urls.push(url);
    if (url.startsWith('/api/catalog')) return response({ catalog: [{ id: 17, exercise_name: 'Leg Press', variation_name: 'Standard', equipment: ['Machine'] }] });
    return response({ variation_id: 17, exercise_name: 'Leg Press', variation_name: 'Standard', tracking_type: 'repetitions', points: [
      { workout_id: 1, completed_at: '2026-09-21 10:00:00', best_weight: 80, best_result: 8, completed_sets: 3 },
      { workout_id: 2, completed_at: '2026-09-22 10:00:00', best_weight: 90, best_result: 10, completed_sets: 3 },
    ] });
  };
  await app.nodes['#open-progress'].events.click();
  assert.equal(urls[1], '/api/progress?variation_id=17');
  assert.match(nodes['#progress-results'].innerHTML, /<svg/);
  assert.match(nodes['#progress-results'].innerHTML, /90 kg/);
  assert.match(nodes['#progress-results'].innerHTML, /10<\/td>/);
  assert.match(nodes['#progress-results'].innerHTML, /Completed workout progress/);
});

test('history repeats a completed workout when no workout is active', async () => {
  const gym = { id: 1, name: 'Home' };
  const app = await harness(storage(), { gyms: [gym], active_workout: null, workout_exercises: [] });
  const { dialog, nodes } = historyDOM(app);
  const workout = { id: 22, gym_id: 1, gym_name: 'Home', started_at: '2026-09-21 10:00:00', completed_at: '2026-09-21 11:00:00' };
  const requests = [];
  app.env.fetch = async (url, options) => {
    requests.push([url, options]);
    if (url.startsWith('/api/history?')) return response({ workouts: [{ ...workout, exercise_count: 1, completed_set_count: 3 }], next_offset: null });
    if (url === '/api/history/22') return response({ workout, workout_exercises: [] });
    if (url === '/api/history/22/repeat') return response({ id: 23, gym_id: 1, gym_name: 'Home', started_at: '2026-09-24 10:00:00' }, 201);
    if (url === '/api/bootstrap') return response({ gyms: [gym], active_workout: { id: 23, gym_id: 1, gym_name: 'Home', started_at: '2026-09-24 10:00:00' }, workout_exercises: [] });
    throw new Error('Unexpected request');
  };
  app.nodes['#open-history'].events.click();
  await settle();
  await nodes['#history-results'].buttons[0].events.click();
  assert.match(nodes['#history-detail'].innerHTML, /Repeat this workout/);
  const repeat = Object.assign(node(), { dataset: { repeatWorkout: '22' } });
  await nodes['#history-detail'].events.click({ target: { closest: (selector) => selector === '[data-repeat-workout]' ? repeat : null } });
  assert.equal(requests.find(([url]) => url.endsWith('/repeat'))[1].method, 'POST');
  assert.equal(dialog.removed, true);
  assert.match(app.nodes['#app'].innerHTML, /Workout active/);
});

test('correcting a completed set refreshes active references and the history count without losing a draft', async () => {
  const app = await harness();
  app.form.elements.result.value = '9';
  app.form.events.input();
  const { nodes } = historyDOM(app);
  const workout = { id: 22, gym_id: 1, gym_name: 'Home', started_at: '2026-09-21 10:00:00', completed_at: '2026-09-21 11:00:00' };
  const detail = { workout, workout_exercises: [{ id: 33, variation_id: 11, exercise_name: 'Bench Press', variation_name: 'Standard',
    equipment: 'Barbell', manufacturer: '', label: '', tracking_type: 'repetitions',
    sets: [{ id: 44, position: 1, weight: 80, result: 8, completed: 1 }] }] };
  const requests = [];
  app.env.fetch = async (url, options) => {
    requests.push([url, options]);
    if (url.startsWith('/api/history?')) return response({ workouts: [{ ...workout, exercise_count: 1, completed_set_count: 0 }], next_offset: null });
    if (url === '/api/history/22') return response(detail);
    if (url === '/api/history/22/sets/44') return response({ id: 44, position: 1, weight: -75, result: 10, completed: true });
    if (url === '/api/bootstrap') return response({ gyms: [], active_workout: { id: 1, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00' },
      workout_exercises: [{ id: 3, variation_id: 11, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
        tracking_type: 'repetitions', previous_sets: [{ result: 10, weight: -75 }], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] }] });
    throw new Error('Unexpected request');
  };
  app.nodes['#open-history'].events.click();
  await settle();
  await nodes['#history-results'].buttons[0].events.click();
  assert.match(nodes['#history-detail'].innerHTML, /Edit set 1/);
  const status = node();
  const submit = node();
  const form = Object.assign(node(), {
    dataset: { historySet: '44', assisted: 'true' },
    elements: { weight: { value: '75' }, result: { value: '10', required: false }, completed: { checked: true } },
    closest: () => form, reportValidity: () => true,
    querySelector: (selector) => selector === '.set-status' ? status : submit,
  });
  nodes['#history-detail'].querySelector = () => node();
  await nodes['#history-detail'].events.submit({ target: form, preventDefault() {} });
  const correction = requests.find(([url]) => url === '/api/history/22/sets/44');
  assert.deepEqual(JSON.parse(correction[1].body), { weight: -75, result: 10, completed: true });
  assert.match(app.nodes['#app'].innerHTML, /10 reps/);
  assert.equal(app.form.elements.result.value, '9');
  await nodes['#history-back'].events.click();
  assert.equal(requests.filter(([url]) => url.startsWith('/api/history?')).length, 2);
});

test('set card puts completion beside the inputs and has no separate save button', async () => {
  const app = await harness();
  const html = app.nodes['#app'].innerHTML;
  assert.match(html, /<div class="set-inputs">[\s\S]*name="result"[\s\S]*<label class="set-complete">Done <input name="completed"[\s\S]*?<\/div>/);
  assert.match(html, /aria-label="Mark Bench Press, set 1 completed and save"/);
  assert.match(html, /<button type="button" class="remove-set" aria-label="Remove Bench Press, set 1">/);
  assert.doesNotMatch(html, /Save changes|completion-hint/);
  assert.equal(app.form.querySelector('.set-retry').hidden, true);
});

test('a blocked set offers Retry, which saves it again', async () => {
  const app = await harness();
  const puts = [];
  app.env.fetch = async (path, options) => {
    puts.push(path);
    return puts.length === 1 ? response({ error: 'Set not found.' }, 404) : response({ id: 2, position: 1, weight: null, result: 8, completed: false });
  };
  app.form.elements.result.value = '8';
  app.form.events.input();
  app.form.events.submit({ preventDefault() {} });
  await settle();
  assert.match(app.form.querySelector('.set-status').textContent, /Set not found\. Review the set, then tap Retry\./);
  assert.equal(app.form.querySelector('.set-retry').hidden, false);
  app.form.querySelector('.set-retry').events.click();
  await settle();
  assert.deepEqual(puts, ['/api/sets/2', '/api/sets/2']);
  assert.equal(app.form.querySelector('.set-status').textContent, 'Saved to server');
  assert.equal(app.form.querySelector('.set-retry').hidden, true);
  assert.equal(app.form.dataset.dirty, undefined);
});

test('pressing Enter in a set input saves immediately', async () => {
  const app = await harness();
  const puts = [];
  app.env.fetch = async (path, options) => { puts.push(JSON.parse(options.body)); return response({ id: 2, position: 1, weight: 40, result: 8, completed: false }); };
  app.form.elements.weight.value = '40';
  app.form.elements.result.value = '8';
  let prevented = false;
  app.form.events.keydown({ key: 'Enter', target: { type: 'number', tagName: 'INPUT' }, preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.deepEqual(puts, [{ weight: 40, result: 8, completed: false }]);
  app.form.events.keydown({ key: 'Enter', target: { type: 'checkbox', tagName: 'INPUT' }, preventDefault() { assert.fail('checkbox Enter intercepted'); } });
});

test('Add exercise follows the exercise list and precedes Finish and Cancel without a fixed bar', async () => {
  const app = await harness();
  for (const empty of [false, true]) {
    if (empty) {
      app.form.isConnected = false;
      app.env.fetch = async () => response({ gyms: [], active_workout: { id: 1, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00' }, workout_exercises: [] });
      await app.app.load();
    }
    const html = app.nodes['#app'].innerHTML;
    const order = ['class="exercise-list"', 'id="open-picker"', 'class="secondary" data-finish-workout', 'id="cancel-workout"', '</main>']
      .map((marker) => html.indexOf(marker));
    assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), `unexpected order ${order}`);
    assert.doesNotMatch(html, /bottom-action/);
    if (empty) assert.match(html, /No exercises yet[\s\S]*?<\/section>\s*<button class="primary accent add-exercise" id="open-picker">/);
  }
});

const pressEntry = { id: 3, variation_id: 11, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
  tracking_type: 'repetitions', previous_sets: [], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] };
const plankEntry = { id: 4, variation_id: 12, exercise_name: 'Plank', variation_name: 'Front Plank', equipment: 'Bodyweight',
  tracking_type: 'duration', previous_sets: [], sets: [
    { id: 5, position: 1, weight: null, result: 60, completed: true }, { id: 6, position: 2, weight: null, result: null, completed: false }] };
function clickIn(app, selector, dataset) {
  const button = Object.assign(node(), { dataset });
  return app.nodes['#app'].events.click({ target: { closest: (wanted) => wanted === selector ? button : null } });
}

test('each exercise offers move up, move down and remove with the ends disabled', async () => {
  const app = await harness(storage(), { workout_exercises: [pressEntry, plankEntry] });
  const html = app.nodes['#app'].innerHTML;
  assert.match(html, /data-move-exercise="3" data-move-to="0" aria-label="Move Bench Press up" disabled>Move up/);
  assert.match(html, /data-move-exercise="3" data-move-to="2" aria-label="Move Bench Press down" >Move down/);
  assert.match(html, /data-move-exercise="4" data-move-to="1" aria-label="Move Front Plank up" >Move up/);
  assert.match(html, /data-move-exercise="4" data-move-to="3" aria-label="Move Front Plank down" disabled>Move down/);
  assert.match(html, /data-remove-exercise="4" aria-label="Remove Front Plank">Remove/);
});

test('removing an exercise asks first, then drops it and its drafts from the workout', async () => {
  const disk = storage();
  new DraftStore(() => disk).put(1, 6, { weight: '', result: '45', completed: false, assistance: false });
  const app = await harness(disk, { workout_exercises: [pressEntry, plankEntry] });
  const requests = [];
  const questions = [];
  app.env.fetch = async (url, options) => { requests.push(`${options.method} ${url}`); return response({ ok: true }); };
  app.env.window.confirm = (question) => { questions.push(question); return false; };
  await clickIn(app, '[data-remove-exercise]', { removeExercise: '4' });
  assert.deepEqual(requests, []);
  assert.deepEqual(questions, ['Remove Front Plank and its 2 sets from this workout? This cannot be undone.']);
  app.env.window.confirm = () => true;
  await clickIn(app, '[data-remove-exercise]', { removeExercise: '4' });
  assert.deepEqual(requests, ['DELETE /api/workout-exercises/4']);
  assert.doesNotMatch(app.nodes['#app'].innerHTML, /Plank/);
  assert.match(app.nodes['#app'].innerHTML, /<h2>Exercises<\/h2><span>1<\/span>/);
  assert.equal(app.nodes['#toast'].textContent, 'Front Plank removed.');
  assert.equal(new DraftStore(() => disk).get(1, 6), null);
  assert.deepEqual(new DraftStore(() => disk).cachedWorkout().workout_exercises.map((entry) => entry.id), [3]);
});

test('moving an exercise saves set drafts first and re-renders in the new order', async () => {
  const app = await harness(storage(), { workout_exercises: [pressEntry, plankEntry] });
  const requests = [];
  app.env.fetch = async (url, options) => {
    requests.push([`${options.method} ${url}`, JSON.parse(options.body)]);
    if (url === '/api/sets/2') return response({ id: 2, position: 1, weight: null, result: 8, completed: false });
    return response({ workout_exercises: [{ id: 4, position: 1 }, { id: 3, position: 2 }] });
  };
  app.form.elements.result.value = '8';
  app.form.events.input();
  await clickIn(app, '[data-move-exercise]', { moveExercise: '4', moveTo: '1' });
  assert.deepEqual(requests, [['PUT /api/sets/2', { weight: null, result: 8, completed: false }],
    ['PUT /api/workout-exercises/4', { position: 1 }]]);
  const html = app.nodes['#app'].innerHTML;
  assert.ok(html.indexOf('data-entry-id="4"') < html.indexOf('data-entry-id="3"'));
  assert.match(html, /data-move-exercise="4" data-move-to="0" aria-label="Move Front Plank up" disabled>/);
});
