import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../static/app.mjs';
import { DraftStore } from '../static/drafts.mjs';

// Pin the device time zone so local-time assertions do not depend on the test machine.
// Central European Summer Time is UTC+2 until 25 October 2026, then UTC+1.
process.env.TZ = 'Europe/Prague';

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

function setForm(setId, position) {
  const formNodes = { fieldset: node(), '.set-status': node(), '.remove-set': node(), '.set-retry': Object.assign(node(), { hidden: true }),
    legend: node(), '.fill-previous': node() };
  formNodes.legend.textContent = `Set ${position}`;
  const form = Object.assign(node(), {
    isConnected: true, dataset: { setId: String(setId), entryId: '3' },
    elements: { weight: Object.assign(node(), { value: '' }), result: { value: '', required: false },
      completed: Object.assign(node(), { checked: false }) },
    querySelector: (selector) => formNodes[selector],
    checkValidity: () => !form.elements.result.required || form.elements.result.value !== '',
    reportValidity: () => form.checkValidity(), scrollIntoView() {},
    requestSubmit: () => form.events.submit({ preventDefault() {} }),
  });
  return form;
}

// Like a browser, expose the rendered Last workout button's data attributes as its dataset.
function readPreviousButton(form, html) {
  const match = html.match(/data-previous-weight="([^"]*)" data-previous-result="([^"]*)"/);
  if (match) form.querySelector('.fill-previous').dataset = { previousWeight: match[1], previousResult: match[2] };
}

// The harness workout started 2026-09-22 10:00 UTC; by default the clock reads 25 minutes later.
async function harness(disk = storage(), initialData = {}, { now = Date.parse('2026-09-22T10:25:00Z') } = {}) {
  const nodes = Object.fromEntries(['#app', '#toast', '#sync-status', '#picker-results', 'main',
    '#open-picker', '#open-history', '#open-progress', '#open-manage', '#cancel-workout', '#finish', '#add-gym-form', '#start-workout', '#create-exercise',
    '#rest-enabled', '#rest-controls', '#rest-duration', '#rest-clock', '#rest-status', '#rest-start', '#rest-pause', '#rest-stop',
    '#workout-elapsed', '#stale-banner', '#stale-finish', '#stale-keep']
    .map((key) => [key, node()]));
  const timers = new Map();
  const intervals = new Map();
  const clock = { now };
  let timerId = 0;
  const forms = [];
  const form = setForm(2, 1);
  forms.push(form);
  const list = { insertAdjacentHTML(_, html) {
    this.html = html;
    const [, id, position] = html.match(/data-set-id="(\d+)"[\s\S]*?<legend>Set (\d+)/);
    const added = setForm(Number(id), Number(position));
    added.elements.weight.value = html.match(/name="weight"[^>]*value="([^"]*)"/)[1];
    added.elements.result.value = html.match(/name="result"[^>]*value="([^"]*)"/)[1];
    readPreviousButton(added, html);
    forms.push(added);
    this.lastElementChild = added;
  } };
  // Like a browser, each render creates fresh note textareas with the rendered text as their value.
  const rendered = { html: null, fields: [] };
  const noteFields = (html) => {
    if (rendered.html !== html) {
      rendered.html = html;
      rendered.fields = [...html.matchAll(/<textarea data-note-target="([^"]+)"[^>]*>([^<]*)<\/textarea>/g)]
        .map(([, target, value]) => Object.assign(node(), { dataset: { noteTarget: target }, value }));
    }
    return rendered.fields;
  };
  // Like a browser, the workout's set forms exist only while the rendered workout contains them;
  // forms appended by Add set live in their exercise's list.
  const isRendered = (item) => item.isConnected
    && (item !== form || nodes['#app'].innerHTML.includes(`data-set-id="${item.dataset.setId}"`));
  const entryNode = { querySelector: (selector) => selector === '.sets-list' ? list : null };
  const addSetButton = Object.assign(node(), { dataset: { addSet: '3' }, closest: () => entryNode });
  const data = { gyms: [], active_workout: { id: 1, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00' },
    workout_exercises: [{ id: 3, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
      previous_sets: [], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] }], ...initialData };
  const env = {
    window: { localStorage: disk, addEventListener() {}, confirm: () => true },
    navigator: { onLine: true },
    document: {
      visibilityState: 'visible', addEventListener() {},
      querySelector: (selector) => selector === '.set-form[data-dirty="true"]'
        ? forms.find((item) => isRendered(item) && item.dataset.dirty) ?? null : nodes[selector] ?? null,
      querySelectorAll: (selector) => {
        if (selector === '.set-form') return forms.filter(isRendered);
        if (selector === '.set-form[data-dirty="true"]') return forms.filter((item) => isRendered(item) && item.dataset.dirty);
        if (selector === '[data-add-set]') return form.isConnected ? [addSetButton] : [];
        if (selector === '[data-finish-workout]') return [nodes['#finish']];
        if (selector === '[data-finish-workout], #cancel-workout') return [nodes['#finish'], nodes['#cancel-workout']];
        if (selector === '[data-note-target]') return noteFields(nodes['#app'].innerHTML);
        return [];
      },
    },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { intervals.set(++timerId, { callback, delay }); return timerId; },
    clearInterval: (id) => intervals.delete(id), now: () => clock.now,
    fetch: async (path) => {
      if (path === '/api/bootstrap') return response(structuredClone(data));
      throw new Error('Offline');
    },
  };
  const app = createApp({ ...env, fetch: (...args) => env.fetch(...args) });
  await app.load();
  readPreviousButton(form, nodes['#app'].innerHTML);
  const noteField = (target) => env.document.querySelectorAll('[data-note-target]').find((field) => field.dataset.noteTarget === target);
  return { env, nodes, form, forms, list, addSetButton, disk, timers, intervals, clock, app, noteField };
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
    const older = { id: 7, gym_name: 'Home', started_at: '2026-09-01 10:00:00', exercise_count: 1, completed_set_count: 1 };
    return response({ workouts: url.endsWith('offset=20') ? [older] : [], next_offset: urls.length === 1 ? 20 : null });
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
  // Local 21-22 September become the UTC instants of the phone's midnights.
  assert.equal(urls[2], '/api/history?gym_id=2&start=2026-09-20T22%3A00%3A00.000Z&end=2026-09-22T22%3A00%3A00.000Z&offset=0');
  assert.match(nodes['#history-message'].textContent, /No completed workouts/);
  nodes['#close-history'].events.click();
  assert.equal(dialog.removed, true);
  assert.equal(app.form.elements.result.value, '9');
  assert.equal(new DraftStore(() => app.disk).get(1, 2).result, '9');
  assert.ok(urls.every((url) => url.startsWith('/api/history?')));
});

test('history and the active workout show times in the device time zone', async () => {
  const app = await harness();
  // The harness workout started 2026-09-22 10:00 UTC, which is 12:00 in Prague.
  assert.match(app.nodes['#app'].innerHTML, /Started 12:00/);
  const { dialog, nodes } = historyDOM(app);
  // 23:30 UTC on 21 September is already 01:30 on 22 September in Prague.
  const workout = { id: 5, gym_id: 1, gym_name: 'Home', started_at: '2026-09-21 23:30:00', completed_at: '2026-09-22 10:00:00' };
  app.env.fetch = async (url) => response(url.includes('?')
    ? { workouts: [{ ...workout, exercise_count: 0, completed_set_count: 0 }], next_offset: null }
    : { workout, workout_exercises: [] });
  app.nodes['#open-history'].events.click();
  await settle();
  const listed = nodes['#history-results'].innerHTML;
  assert.match(listed, /22[^<]*1:30/);
  assert.doesNotMatch(listed, /11:30|23:30/);
  await nodes['#history-results'].buttons[0].events.click();
  const detail = nodes['#history-detail'].innerHTML;
  assert.match(detail, /Started [^<]*1:30[\s\S]*Finished [^<]*12:00/);
  assert.doesNotMatch(detail, /10:00|UTC/);
  assert.doesNotMatch(dialog.innerHTML, /UTC/);
});

test('history date filters cover whole local days across a daylight saving change', async () => {
  const app = await harness();
  const { nodes } = historyDOM(app);
  const urls = [];
  app.env.fetch = async (url) => { urls.push(url); return response({ workouts: [], next_offset: null }); };
  app.nodes['#open-history'].events.click();
  await settle();
  const originalFormData = globalThis.FormData;
  const submit = async (entries) => {
    globalThis.FormData = class { constructor() { return entries; } };
    try { nodes['#history-filters'].events.submit({ preventDefault() {} }); }
    finally { globalThis.FormData = originalFormData; }
    await settle();
    return new URLSearchParams(urls.at(-1).split('?')[1]);
  };
  // 25 October 2026 is 25 hours long in Prague: clocks go back from UTC+2 to UTC+1.
  let params = await submit([['gym_id', ''], ['start', '2026-10-25'], ['end', '2026-10-25']]);
  assert.equal(params.get('start'), '2026-10-24T22:00:00.000Z');
  assert.equal(params.get('end'), '2026-10-25T23:00:00.000Z');
  params = await submit([['gym_id', ''], ['start', ''], ['end', '2026-12-31']]);
  assert.equal(params.get('start'), '');
  assert.equal(params.get('end'), '2026-12-31T23:00:00.000Z');
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

// A stand-in for the browser's Web Audio API that records what was played.
function fakeAudio() {
  const audio = { contexts: 0, resumes: 0, beeps: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  audio.AudioContext = class {
    constructor() { audio.contexts += 1; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { audio.resumes += 1; this.state = 'running'; return Promise.resolve(); }
    createGain() { return { gain: param(), connect() {} }; }
    createOscillator() {
      return { frequency: param(), connect() {}, start: () => { audio.beeps += 1; }, stop() {} };
    }
  };
  return audio;
}

function runTimers(timers) {
  for (const [id, task] of [...timers]) { timers.delete(id); task.callback(); }
}

test('a finished rest plays a beep and vibrates after Done unlocks audio', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-22T10:30:00Z') });
  const disk = storage();
  disk.setItem('gymdex:rest:v1', JSON.stringify({ enabled: true, duration: 30 }));
  const app = await harness(disk);
  const audio = fakeAudio();
  const vibrations = [];
  app.env.window.AudioContext = audio.AudioContext;
  app.env.navigator.vibrate = (pattern) => { vibrations.push(pattern); return true; };
  app.env.navigator.onLine = false;
  app.form.elements.result.value = '8';
  app.form.elements.completed.checked = true;
  app.form.elements.completed.events.change();
  assert.equal(audio.resumes, 1);
  t.mock.timers.tick(29_000);
  runTimers(app.timers);
  assert.equal(audio.beeps, 0);
  assert.deepEqual(vibrations, []);
  t.mock.timers.tick(1_000);
  runTimers(app.timers);
  assert.equal(app.nodes['#rest-status'].textContent, 'Rest complete');
  assert.ok(audio.beeps > 0);
  assert.equal(vibrations.length, 1);
  assert.equal(audio.contexts, 1);
});

test('Start unlocks audio and a finished rest works without vibration support', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-22T10:30:00Z') });
  const disk = storage();
  disk.setItem('gymdex:rest:v1', JSON.stringify({ enabled: true, duration: 30 }));
  const app = await harness(disk);
  const audio = fakeAudio();
  app.env.window.webkitAudioContext = audio.AudioContext;
  app.nodes['#rest-start'].events.click();
  assert.equal(audio.resumes, 1);
  t.mock.timers.tick(30_000);
  runTimers(app.timers);
  assert.equal(app.nodes['#rest-status'].textContent, 'Rest complete');
  assert.ok(audio.beeps > 0);
});

test('a finished rest still completes when the browser has no Web Audio', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-22T10:30:00Z') });
  const disk = storage();
  disk.setItem('gymdex:rest:v1', JSON.stringify({ enabled: true, duration: 30 }));
  const app = await harness(disk);
  app.nodes['#rest-start'].events.click();
  t.mock.timers.tick(30_000);
  runTimers(app.timers);
  assert.equal(app.nodes['#rest-status'].textContent, 'Rest complete');
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

for (const [skipped, notice] of [[0, 'Workout repeated. Sets are ready to log.'],
  [1, 'Workout repeated. Sets are ready to log. 1 archived exercise skipped.'],
  [2, 'Workout repeated. Sets are ready to log. 2 archived exercises skipped.']]) {
  test(`repeating a workout with ${skipped} archived exercises says so`, async () => {
    const gym = { id: 1, name: 'Home' };
    const app = await harness(storage(), { gyms: [gym], active_workout: null, workout_exercises: [] });
    const { nodes } = historyDOM(app);
    const workout = { id: 22, gym_id: 1, gym_name: 'Home', started_at: '2026-09-21 10:00:00', completed_at: '2026-09-21 11:00:00' };
    const active = { id: 23, gym_id: 1, gym_name: 'Home', started_at: '2026-09-24 10:00:00' };
    app.env.fetch = async (url) => {
      if (url.startsWith('/api/history?')) return response({ workouts: [{ ...workout, exercise_count: 1, completed_set_count: 3 }], next_offset: null });
      if (url === '/api/history/22') return response({ workout, workout_exercises: [] });
      if (url === '/api/history/22/repeat') return response({ ...active, skipped }, 201);
      // The fake DOM always holds the set form of set 2.
      if (url === '/api/bootstrap') return response({ gyms: [gym], active_workout: active, workout_exercises: [{
        id: 3, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
        previous_sets: [], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] }] });
      throw new Error('Unexpected request');
    };
    app.nodes['#open-history'].events.click();
    await settle();
    await nodes['#history-results'].buttons[0].events.click();
    const repeat = Object.assign(node(), { dataset: { repeatWorkout: '22' } });
    await nodes['#history-detail'].events.click({ target: { closest: (selector) => selector === '[data-repeat-workout]' ? repeat : null } });
    assert.equal(app.nodes['#toast'].textContent, notice);
  });
}

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
  assert.match(app.nodes['#toast'].textContent, /^Workout repeated\. Sets are ready to log\.$/);
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
    closest: (selector) => selector === '[data-history-set]' ? form : null, reportValidity: () => true,
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

test('Add set first saves the set above, then shows its copied values as an unfinished set', async () => {
  const app = await harness();
  const requests = [];
  app.env.fetch = async (path, options) => {
    requests.push(`${options.method} ${path}`);
    if (path === '/api/sets/2') return response({ id: 2, position: 1, weight: 60, result: 8, completed: false });
    return response({ id: 5, position: 2, weight: 60, result: 8, completed: false }, 201);
  };
  app.form.elements.weight.value = '60';
  app.form.elements.result.value = '8';
  app.form.events.input();
  await app.addSetButton.events.click();
  assert.deepEqual(requests, ['PUT /api/sets/2', 'POST /api/workout-exercises/3/sets']);
  const added = app.forms.at(-1);
  assert.equal(added.dataset.setId, '5');
  assert.equal(added.elements.weight.value, '60');
  assert.equal(added.elements.result.value, '8');
  assert.doesNotMatch(app.list.html, /is-complete|checked/);
  assert.equal(added.elements.weight.focused, true);
});

test('tapping Last workout fills the set and saves it without completing it', async () => {
  const entry = (assisted, previous) => ({ workout_exercises: [{ id: 3, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
    assisted, tracking_type: 'repetitions', previous_sets: [previous], sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] }] });
  for (const [assisted, previous, shown, saved] of [
    [0, { weight: 50, result: 10 }, '50', 50],
    [1, { weight: -25, result: 8 }, '25', -25],
    [0, { weight: -10, result: 6 }, '10', -10],
    [0, { weight: null, result: 12 }, '', null],
  ]) {
    const app = await harness(storage(), entry(assisted, previous));
    assert.match(app.nodes['#app'].innerHTML, /<button type="button" class="previous-set fill-previous"[^>]*aria-label="Fill Bench Press, set 1 from last workout: [^"]+">Last workout: /);
    const bodies = [];
    app.env.fetch = async (path, options) => { bodies.push(JSON.parse(options.body)); return response({ id: 2, position: 1, weight: saved, result: previous.result, completed: false }); };
    app.form.querySelector('.fill-previous').events.click();
    await settle();
    assert.equal(app.form.elements.weight.value, shown);
    assert.equal(app.form.elements.result.value, String(previous.result));
    assert.deepEqual(bodies, [{ weight: saved, result: previous.result, completed: false }]);
  }
  const none = await harness();
  assert.match(none.nodes['#app'].innerHTML, /<p class="previous-set">Last workout: No completed set<\/p>/);
});

test('Add set waits when the set above cannot reach the server', async () => {
  const app = await harness();
  const requests = [];
  app.env.fetch = async (path) => { requests.push(path); throw new Error('Offline'); };
  app.form.elements.result.value = '8';
  app.form.events.input();
  await app.addSetButton.events.click();
  assert.deepEqual(requests, ['/api/sets/2']);
  assert.equal(app.forms.length, 1);
  assert.match(app.nodes['#toast'].textContent, /Set 1 must reach the server before adding another set/);
  assert.equal(app.addSetButton.disabled, false);
});

test('removing a set renumbers the remaining sets and pairs them with Last workout again', async () => {
  const blankSet = (id, position) => ({ id, position, weight: null, result: null, completed: false });
  const app = await harness(storage(), { workout_exercises: [{ id: 3, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
    tracking_type: 'repetitions', previous_sets: [{ weight: 80, result: 8 }, { weight: 85, result: 6 }, { weight: 90, result: 4 }],
    sets: [blankSet(2, 1), blankSet(5, 2), blankSet(6, 3)] }] });
  const questions = [];
  app.env.window.confirm = (question) => { questions.push(question); return true; };
  const requests = [];
  app.env.fetch = async (path, options) => {
    requests.push(`${options.method} ${path}`);
    return response({ ok: true, sets: [{ id: 5, position: 1 }, { id: 6, position: 2 }] });
  };
  const list = node();
  const addButton = node();
  const entryNode = { querySelector: (selector) => ({ '.sets-list': list, '.add-set': addButton })[selector] };
  Object.assign(app.form, { closest: () => entryNode, remove() { app.form.isConnected = false; } });
  await app.form.querySelector('.remove-set').events.click();
  assert.deepEqual(questions, ['Remove set 1?']);
  assert.deepEqual(requests, ['DELETE /api/sets/2']);
  const legends = [...list.innerHTML.matchAll(/data-set-id="(\d+)"[\s\S]*?<legend>Set (\d+)<\/legend>/g)].map(([, id, position]) => [id, position]);
  assert.deepEqual(legends, [['5', '1'], ['6', '2']]);
  assert.match(list.innerHTML, /aria-label="Remove Bench Press, set 2"/);
  assert.match(list.innerHTML, /data-set-id="5"[\s\S]*?Last workout: 80 kg × 8 reps[\s\S]*?data-set-id="6"[\s\S]*?Last workout: 85 kg × 6 reps/);
  assert.equal(addButton.focused, true);
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

test('the workout header shows elapsed time and ticks without re-rendering the set forms', async () => {
  const app = await harness();
  assert.match(app.nodes['#app'].innerHTML, /Started 12:00[\s\S]*id="workout-elapsed"[^>]*>25 min</);
  assert.equal(app.nodes['#app'].innerHTML.match(/Finish workout/g).length, 1, 'only the Finish workout button below the exercises');
  app.form.elements.weight.value = '40';
  app.form.elements.weight.focus();
  const html = app.nodes['#app'].innerHTML;
  app.clock.now = Date.parse('2026-09-22T11:07:30Z');
  for (const { callback } of app.intervals.values()) callback();
  assert.equal(app.nodes['#workout-elapsed'].textContent, '1 h 07 min');
  assert.equal(app.nodes['#app'].innerHTML, html);
  assert.equal(app.form.elements.weight.value, '40');
  assert.equal(app.form.elements.weight.focused, true);
});

test('the elapsed time stops ticking once the workout is finished', async () => {
  const app = await harness();
  const tickers = () => [...app.intervals.values()].filter(({ callback }) => {
    app.nodes['#workout-elapsed'].textContent = '';
    callback();
    return app.nodes['#workout-elapsed'].textContent !== '';
  }).length;
  await app.app.load();
  assert.equal(tickers(), 1);
  app.env.fetch = async (path) => response(path === '/api/bootstrap' ? { gyms: [], active_workout: null, workout_exercises: [] } : { ok: true });
  await app.nodes['#finish'].events.click();
  assert.match(app.nodes['#app'].innerHTML, /No active workout/);
  assert.equal(app.intervals.size, 1, 'only the pending-set retry interval remains');
  assert.equal(tickers(), 0);
});

test('a workout started more than 3 hours ago offers Finish it, which uses the normal finish flow', async () => {
  const fresh = await harness(storage(), {}, { now: Date.parse('2026-09-22T12:59:00Z') });
  assert.doesNotMatch(fresh.nodes['#app'].innerHTML, /stale-banner/);
  const app = await harness(storage(), {}, { now: Date.parse('2026-09-22T13:01:00Z') });
  assert.match(app.nodes['#app'].innerHTML,
    /id="stale-banner"[\s\S]*started 3 h 01 min ago[\s\S]*id="stale-finish"[^>]*>Finish it<[\s\S]*id="stale-keep"[^>]*>Keep going</);
  const requests = [];
  app.env.fetch = async (path, options) => {
    requests.push(`${options?.method ?? 'GET'} ${path}`);
    return response(path === '/api/bootstrap' ? { gyms: [], active_workout: null, workout_exercises: [] } : { ok: true });
  };
  await app.nodes['#stale-finish'].events.click();
  assert.ok(requests.includes('POST /api/workouts/1/complete'), requests.join());
  assert.match(app.nodes['#app'].innerHTML, /No active workout/);
  assert.match(app.nodes['#toast'].textContent, /Workout finished/);
});

test('workout and exercise notes stay collapsed, keep drafts on the phone, and autosave after a typing pause', async () => {
  const noted = { active_workout: { id: 1, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00', note: 'Slept <5h' },
    workout_exercises: [{ ...pressEntry, note: '' }] };
  const app = await harness(storage(), noted);
  const html = app.nodes['#app'].innerHTML;
  assert.match(html, /<details class="note"[^>]*>\s*<summary[^>]*>[\s\S]*?Workout note[\s\S]*?<textarea data-note-target="workout"[^>]*maxlength="1000"[^>]*>Slept &lt;5h<\/textarea>/);
  assert.match(html, /Add note[\s\S]*?<textarea data-note-target="exercise:3"[^>]*aria-label="Note for Bench Press"[^>]*><\/textarea>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/, 'notes are collapsed so the recording path stays short');
  const order = ['data-add-set="3"', 'data-note-target="exercise:3"', 'class="exercise-tools"', 'id="open-picker"',
    'data-note-target="workout"', 'data-finish-workout'].map((marker) => html.indexOf(marker));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), `unexpected order ${order}`);

  const requests = [];
  app.env.fetch = async (path, options) => {
    requests.push([`${options.method} ${path}`, JSON.parse(options.body)]);
    return response({ id: 3, note: 'Seat 4' });
  };
  const field = app.noteField('exercise:3');
  field.value = 'Seat 4';
  field.events.input();
  assert.match(app.nodes['#sync-status'].textContent, /1 note waiting to save/);
  const reopened = await harness(app.disk, noted);
  assert.match(reopened.nodes['#app'].innerHTML, /<details class="note" open[^>]*>[\s\S]*?<textarea data-note-target="exercise:3"[^>]*>Seat 4<\/textarea>/);
  assert.deepEqual(requests, []);
  [...app.timers.values()].find((timer) => timer.delay === 800).callback();
  await settle();
  assert.deepEqual(requests, [['PUT /api/workout-exercises/3/note', { note: 'Seat 4' }]]);
  assert.equal(app.nodes['#sync-status'].textContent, 'All changes saved to server.');
  assert.equal(new DraftStore(() => app.disk).cachedWorkout().workout_exercises[0].note, 'Seat 4');
});

test('history detail shows notes as text and saves an added exercise note', async () => {
  const app = await harness();
  const { nodes } = historyDOM(app);
  const workout = { id: 22, gym_id: 1, gym_name: 'Home', started_at: '2026-09-21 10:00:00', completed_at: '2026-09-21 11:00:00',
    note: 'Line one\n<b>bold</b>' };
  const detail = { workout, workout_exercises: [{ id: 33, variation_id: 11, exercise_name: 'Bench Press', variation_name: 'Standard',
    equipment: 'Barbell', manufacturer: '', label: '', tracking_type: 'repetitions', note: '', sets: [] }] };
  const requests = [];
  app.env.fetch = async (url, options) => {
    requests.push([url, options]);
    if (url.startsWith('/api/history?')) return response({ workouts: [{ ...workout, exercise_count: 1, completed_set_count: 0 }], next_offset: null });
    if (url === '/api/history/22') return response(detail);
    if (url === '/api/workout-exercises/33/note') return response({ id: 33, note: 'Paused reps' });
    throw new Error('Unexpected request');
  };
  app.nodes['#open-history'].events.click();
  await settle();
  await nodes['#history-results'].buttons[0].events.click();
  let html = nodes['#history-detail'].innerHTML;
  assert.match(html, /<p class="note-text">Line one\n&lt;b&gt;bold&lt;\/b&gt;<\/p>/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /data-edit-note="workout"[^>]*>Edit workout note</);
  assert.match(html, /data-edit-note="exercise:33"[^>]*aria-label="Add note for Bench Press"[^>]*>Add note</);
  assert.match(html, /<form class="history-note-form" data-history-note="exercise:33" hidden>[\s\S]*?<textarea name="note"[^>]*maxlength="1000"/);
  const status = node();
  const form = Object.assign(node(), {
    dataset: { historyNote: 'exercise:33' }, elements: { note: { value: 'Paused reps' } },
    closest: (selector) => selector === '[data-history-note]' ? form : null,
    querySelector: (selector) => selector === '.set-status' ? status : node(),
  });
  nodes['#history-detail'].querySelector = () => node();
  await nodes['#history-detail'].events.submit({ target: form, preventDefault() {} });
  const saved = requests.find(([url]) => url === '/api/workout-exercises/33/note');
  assert.equal(saved[1].method, 'PUT');
  assert.deepEqual(JSON.parse(saved[1].body), { note: 'Paused reps' });
  html = nodes['#history-detail'].innerHTML;
  assert.match(html, /<p class="note-text">Paused reps<\/p>/);
  assert.match(html, /data-edit-note="exercise:33"[^>]*>Edit note</);
  assert.equal(app.nodes['#toast'].textContent, 'Note saved.');
});

test('Keep going hides the stale workout banner for that workout, also after reopening', async () => {
  const late = { now: Date.parse('2026-09-22T16:00:00Z') };
  const app = await harness(storage(), {}, late);
  app.nodes['#stale-keep'].events.click();
  assert.equal(app.nodes['#stale-banner'].hidden, true);
  const reopened = await harness(app.disk, {}, late);
  assert.doesNotMatch(reopened.nodes['#app'].innerHTML, /stale-banner/);
  const nextWorkout = await harness(app.disk, { active_workout: { id: 2, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00' } }, late);
  assert.match(nextWorkout.nodes['#app'].innerHTML, /id="stale-banner"/);
});

// Opens history detail for a Completed Workout with fetch answered by routes ("METHOD url" keys).
async function openHistoryDetail(app, detail, routes) {
  const { dialog, nodes } = historyDOM(app);
  const requests = [];
  app.env.fetch = async (url, options = {}) => {
    const key = `${options.method ?? 'GET'} ${url}`;
    requests.push(key);
    if (url.startsWith('/api/history?')) return response({ workouts: [{ ...detail.workout, exercise_count: 1, completed_set_count: 1 }], next_offset: null });
    if (key === `GET /api/history/${detail.workout.id}`) return response(structuredClone(detail));
    if (key in routes) return response(routes[key]);
    throw new Error('Unexpected request');
  };
  app.nodes['#open-history'].events.click();
  await settle();
  await nodes['#history-results'].buttons[0].events.click();
  const click = (selector, dataset) => nodes['#history-detail'].events.click({
    target: { closest: (wanted) => wanted === selector ? Object.assign(node(), { dataset }) : null },
  });
  return { dialog, nodes, requests, click };
}

const completedDetail = () => ({
  workout: { id: 22, gym_id: 1, gym_name: 'Home', started_at: '2026-09-21 10:00:00', completed_at: '2026-09-21 11:00:00' },
  workout_exercises: [{ id: 33, variation_id: 11, exercise_name: 'Bench Press', variation_name: 'Standard',
    equipment: 'Barbell', manufacturer: '', label: '', tracking_type: 'repetitions',
    sets: [{ id: 44, position: 1, weight: 80, result: 8, completed: 1 }] }],
});
const refreshedBootstrap = (previousSets) => ({ gyms: [], active_workout: { id: 1, gym_id: 1, gym_name: 'Home', started_at: '2026-09-22 10:00:00' },
  workout_exercises: [{ id: 3, variation_id: 11, exercise_name: 'Bench Press', variation_name: 'Standard', equipment: 'Barbell',
    tracking_type: 'repetitions', previous_sets: previousSets, sets: [{ id: 2, position: 1, weight: null, result: null, completed: false }] }] });

test('adding a set to a completed workout copies the set above and opens it for correction', async () => {
  const app = await harness();
  const { nodes, requests, click } = await openHistoryDetail(app, completedDetail(), {
    'POST /api/history/22/exercises/33/sets': { id: 45, position: 2, weight: 80, result: 8, completed: 0 },
    'GET /api/bootstrap': refreshedBootstrap([{ weight: 70, result: 5 }]),
  });
  assert.match(nodes['#history-detail'].innerHTML, /<button type="button" class="secondary history-add-set" data-add-history-set="33" aria-label="Add set to Bench Press">Add set<\/button>/);
  const added = Object.assign(node(), { hidden: true, elements: { weight: node() } });
  nodes['#history-detail'].querySelector = (selector) => selector === '[data-history-set="45"]' ? added : node();
  await click('[data-add-history-set]', { addHistorySet: '33' });
  assert.ok(requests.includes('POST /api/history/22/exercises/33/sets'));
  assert.match(nodes['#history-detail'].innerHTML, /Set 2: 8 reps · 80 kg<\/span><span class="meta">Not completed/);
  assert.equal(added.hidden, false);
  assert.equal(added.elements.weight.focused, true);
  // Last workout references in the active workout are refreshed from the server.
  assert.match(app.nodes['#app'].innerHTML, /Last workout: 70 kg × 5 reps/);
  assert.equal(app.nodes['#toast'].textContent, 'Set 2 added. Correct it and mark it completed.');
});

test('deleting a set from a completed workout asks first and renumbers the remaining sets', async () => {
  const app = await harness();
  const detail = completedDetail();
  detail.workout_exercises[0].sets.push({ id: 46, position: 2, weight: 85, result: 6, completed: 1 });
  const { nodes, requests, click } = await openHistoryDetail(app, detail, {
    'DELETE /api/history/22/sets/44': { ok: true },
    'GET /api/bootstrap': refreshedBootstrap([{ weight: 85, result: 6 }]),
  });
  assert.match(nodes['#history-detail'].innerHTML, /<button type="button" class="text-button history-delete-set" data-delete-history-set="44">Delete set 1<\/button>/);
  const questions = [];
  app.env.window.confirm = (question) => { questions.push(question); return false; };
  await click('[data-delete-history-set]', { deleteHistorySet: '44' });
  assert.deepEqual(questions, ['Delete set 1 of Bench Press from this completed workout? This cannot be undone.']);
  assert.ok(!requests.some((request) => request.startsWith('DELETE')));
  app.env.window.confirm = () => true;
  await click('[data-delete-history-set]', { deleteHistorySet: '44' });
  assert.ok(requests.includes('DELETE /api/history/22/sets/44'));
  const html = nodes['#history-detail'].innerHTML;
  assert.match(html, /Set 1: 6 reps · 85 kg/);
  assert.doesNotMatch(html, /Set 2:|80 kg/);
  assert.match(app.nodes['#app'].innerHTML, /Last workout: 85 kg × 6 reps/);
  assert.equal(app.nodes['#toast'].textContent, 'Set 1 deleted.');
  await nodes['#history-back'].events.click();
  assert.equal(requests.filter((request) => request.startsWith('GET /api/history?')).length, 2);
});

test('deleting a completed workout needs the typed word DELETE and returns to the refreshed list', async () => {
  const app = await harness();
  app.form.elements.result.value = '9';
  app.form.events.input();
  const { nodes, requests, click } = await openHistoryDetail(app, completedDetail(), {
    'DELETE /api/history/22': { ok: true },
    'GET /api/bootstrap': refreshedBootstrap([]),
  });
  const html = nodes['#history-detail'].innerHTML;
  assert.match(html, /<button type="button" class="text-button history-delete-workout" data-delete-workout-toggle>Delete workout<\/button>/);
  assert.match(html, /<form class="history-delete-form" data-delete-workout hidden>[\s\S]*Type DELETE to confirm <input name="confirmation"/);
  const status = node();
  const form = Object.assign(node(), { hidden: true, elements: { confirmation: Object.assign(node(), { value: '' }) },
    closest: (selector) => selector === '[data-delete-workout]' ? form : null,
    querySelector: (selector) => selector === '.set-status' ? status : node(), reset() { form.elements.confirmation.value = ''; } });
  nodes['#history-detail'].querySelector = (selector) => selector === '[data-delete-workout]' ? form : node();
  await click('[data-delete-workout-toggle]', {});
  assert.equal(form.hidden, false);
  assert.equal(form.elements.confirmation.focused, true);
  const submit = () => nodes['#history-detail'].events.submit({ target: form, preventDefault() {} });
  form.elements.confirmation.value = 'yes';
  await submit();
  assert.equal(status.textContent, 'Type DELETE to delete this workout.');
  assert.ok(!requests.some((request) => request.startsWith('DELETE')));
  form.elements.confirmation.value = ' delete ';
  await submit();
  assert.ok(requests.includes('DELETE /api/history/22'));
  assert.equal(nodes['#history-detail-view'].hidden, true);
  assert.equal(nodes['#history-list-view'].hidden, false);
  assert.equal(requests.filter((request) => request.startsWith('GET /api/history?')).length, 2);
  assert.equal(app.nodes['#toast'].textContent, 'Workout deleted.');
  // The active workout and its unsaved draft survive the refresh.
  assert.match(app.nodes['#app'].innerHTML, /Workout active/);
  assert.equal(app.form.elements.result.value, '9');
});

test('deleting the only workout on an older history page returns to the newer page', async () => {
  const app = await harness();
  const { nodes } = historyDOM(app);
  const detail = completedDetail();
  const listed = (id) => ({ ...detail.workout, id, exercise_count: 1, completed_set_count: 1 });
  const newer = Array.from({ length: 20 }, (_, index) => listed(100 + index));
  let deleted = false;
  const urls = [];
  app.env.fetch = async (url, options = {}) => {
    urls.push(`${options.method ?? 'GET'} ${url}`);
    if (url === '/api/history?offset=0') return response({ workouts: newer, next_offset: deleted ? null : 20 });
    if (url === '/api/history?offset=20') return response({ workouts: deleted ? [] : [listed(22)], next_offset: null });
    if (url === '/api/history/22' && options.method === 'DELETE') { deleted = true; return response({ ok: true }); }
    if (url === '/api/history/22') return response(structuredClone(detail));
    if (url === '/api/bootstrap') return response(refreshedBootstrap([]));
    throw new Error('Unexpected request');
  };
  app.nodes['#open-history'].events.click();
  await settle();
  nodes['#history-next'].events.click();
  await settle();
  await nodes['#history-results'].buttons[0].events.click();
  const form = Object.assign(node(), { elements: { confirmation: Object.assign(node(), { value: 'DELETE' }) },
    closest: (selector) => selector === '[data-delete-workout]' ? form : null, querySelector: () => node() });
  await nodes['#history-detail'].events.submit({ target: form, preventDefault() {} });
  await settle();
  assert.equal(urls.at(-1), 'GET /api/history?offset=0');
  assert.match(nodes['#history-message'].textContent, /Completed workouts, newest first/);
  assert.equal(nodes['#history-results'].buttons.length, 20);
  assert.equal(nodes['#history-previous'].disabled, true);
  assert.equal(app.nodes['#toast'].textContent, 'Workout deleted.');
});

const reply = (status, body) => ({ reply: true, status, body });
const manageOverview = (gyms, extra = {}) => ({ gyms, configurations: [], exercises: [], ...extra });

// Opens Manage from the start screen. Each route is a body, a reply(), or a function returning either.
async function openManage(app, routes) {
  const nodes = {};
  const dialog = node();
  dialog.querySelector = (selector) => nodes[selector] ??= node();
  dialog.showModal = () => { dialog.open = true; };
  dialog.remove = () => { dialog.removed = true; delete app.nodes['#manage']; };
  dialog.close = () => { dialog.open = false; dialog.events.close(); };
  app.env.document.createElement = () => dialog;
  app.env.document.body = { append: () => { app.nodes['#manage'] = dialog; } };
  const requests = [];
  app.env.fetch = async (url, options = {}) => {
    const key = `${options.method ?? 'GET'} ${url}`;
    requests.push([key, options.body && JSON.parse(options.body)]);
    if (!(key in routes)) throw new Error(`Unexpected request ${key}`);
    const route = typeof routes[key] === 'function' ? routes[key]() : routes[key];
    return route?.reply ? response(route.body, route.status) : response(structuredClone(route));
  };
  await app.nodes['#open-manage'].events.click();
  await settle();
  const content = nodes['#manage-content'];
  const click = (selector, dataset) => content.events.click({
    target: { closest: (wanted) => wanted === selector ? Object.assign(node(), { dataset }) : null },
  });
  return { dialog, nodes, content, requests, click };
}

const startData = (gyms, archived = []) => ({ gyms, archived_gyms: archived, active_workout: null, workout_exercises: [] });
const home = { id: 1, name: 'Home' };
const annex = { id: 2, name: 'Annex <b>' };

test('Manage is on the start screen but not during a workout', async () => {
  const active = await harness();
  assert.doesNotMatch(active.nodes['#app'].innerHTML, /open-manage|>Manage</);
  const start = await harness(storage(), startData([home]));
  assert.match(start.nodes['#app'].innerHTML, /<div class="section-title"><h2>Your gyms<\/h2><button type="button" class="text-button manage-open" id="open-manage">Manage<\/button><\/div>/);
});

test('Manage lists gyms with Delete or Archive, and archiving hides the gym from the start screen', async () => {
  const app = await harness(storage(), startData([home, annex]));
  let archived = false;
  const questions = [];
  app.env.window.confirm = (question) => { questions.push(question); return questions.length > 1; };
  const { content, requests, click, nodes } = await openManage(app, {
    'GET /api/manage': () => manageOverview([
      { ...annex, archived, used: true }, { ...home, archived: false, used: false },
    ], { configurations: [{ id: 5, gym_id: 1, gym_name: 'Home', gym_archived: false, variation_id: 11, exercise_name: 'Bench Press',
      variation_name: 'Incline', equipment: 'Machine', manufacturer: 'Technogym', label: 'Press 1', archived: false, used: true }] }),
    'DELETE /api/manage/gyms/2': () => { archived = true; return { outcome: 'archived' }; },
    'GET /api/bootstrap': () => startData([home], [annex]),
  });
  assert.equal(nodes['#manage-message'].textContent, '');
  let html = content.innerHTML;
  assert.match(html, /<details class="manage-section" data-section="gyms" open>/);
  assert.match(html, /Exercise Configurations/);
  assert.match(html, /Incline Bench Press[\s\S]*Machine · Technogym · Press 1/);
  assert.match(html, /Custom exercises[\s\S]*No custom exercises yet/);
  assert.match(html, /Annex &lt;b&gt;[\s\S]*data-manage-remove="gym:2"[^>]*>Archive<\/button>/);
  assert.match(html, /data-manage-remove="gym:1"[^>]*>Delete<\/button>/);
  assert.doesNotMatch(html, /<b>/);
  await click('[data-manage-remove]', { manageRemove: 'gym:2' });
  assert.match(questions[0], /^Archive Annex <b>\? /);
  assert.ok(!requests.some(([key]) => key.startsWith('DELETE')));
  await click('[data-manage-remove]', { manageRemove: 'gym:2' });
  assert.ok(requests.some(([key]) => key === 'DELETE /api/manage/gyms/2'));
  assert.equal(app.nodes['#toast'].textContent, 'Annex <b> archived.');
  assert.doesNotMatch(app.nodes['#app'].innerHTML, /data-gym-id="2"/);
  assert.match(app.nodes['#app'].innerHTML, /data-gym-id="1"/);
  html = content.innerHTML;
  assert.match(html, /Archived \(1\)[\s\S]*Annex &lt;b&gt;[\s\S]*data-manage-restore="gym:2"[^>]*>Restore<\/button>/);
});

test('a rename conflict shows the server error beside the new name', async () => {
  const app = await harness(storage(), startData([home, annex]));
  const { content, requests, click } = await openManage(app, {
    'GET /api/manage': manageOverview([{ ...annex, archived: false, used: false }, { ...home, archived: false, used: true }]),
    'PUT /api/manage/gyms/2': reply(409, { error: 'A gym named Home already exists.' }),
  });
  assert.match(content.innerHTML, /<form class="manage-rename-form" data-manage-rename-form="gym:2" hidden>[\s\S]*<input name="name" maxlength="80" value="Annex &lt;b&gt;"/);
  const status = node();
  const save = node();
  const form = Object.assign(node(), { hidden: true, dataset: { manageRenameForm: 'gym:2' },
    elements: { name: Object.assign(node(), { value: 'Annex <b>' }) },
    closest: (selector) => selector === '[data-manage-rename-form]' ? form : null,
    querySelector: (selector) => ({ '.set-status': status, '[type="submit"]': save })[selector] ?? node() });
  content.querySelector = (selector) => selector === '[data-manage-rename-form="gym:2"]' ? form : node();
  await click('[data-manage-rename]', { manageRename: 'gym:2' });
  assert.equal(form.hidden, false);
  assert.equal(form.elements.name.focused, true);
  form.elements.name.value = 'home';
  await content.events.submit({ target: form, preventDefault() {} });
  assert.deepEqual(requests.at(-1), ['PUT /api/manage/gyms/2', { name: 'home' }]);
  assert.equal(status.textContent, 'A gym named Home already exists.');
  assert.equal(form.hidden, false);
  assert.equal(save.disabled, false);
});

test('renaming and restoring a gym refresh Manage and the start screen', async () => {
  const app = await harness(storage(), startData([home], [annex]));
  let gyms = [{ ...annex, archived: true, used: true }, { ...home, archived: false, used: true }];
  const { content, requests, click } = await openManage(app, {
    'GET /api/manage': () => manageOverview(gyms),
    'PUT /api/manage/gyms/1': () => { gyms = [gyms[0], { ...home, name: 'City Gym', archived: false, used: true }]; return gyms[1]; },
    'POST /api/manage/gyms/2/restore': () => { gyms = [{ ...annex, archived: false, used: true }, gyms[1]]; return gyms[0]; },
    'GET /api/bootstrap': () => startData(gyms.filter((gym) => !gym.archived).map(({ id, name }) => ({ id, name }))),
  });
  assert.match(content.innerHTML, /Archived \(1\)/);
  const form = Object.assign(node(), { dataset: { manageRenameForm: 'gym:1' }, elements: { name: Object.assign(node(), { value: ' City Gym ' }) },
    closest: (selector) => selector === '[data-manage-rename-form]' ? form : null, querySelector: () => node() });
  await content.events.submit({ target: form, preventDefault() {} });
  assert.deepEqual(requests.find(([key]) => key.startsWith('PUT')), ['PUT /api/manage/gyms/1', { name: ' City Gym ' }]);
  assert.equal(app.nodes['#toast'].textContent, 'Renamed to City Gym.');
  assert.match(app.nodes['#app'].innerHTML, /City Gym/);
  await click('[data-manage-restore]', { manageRestore: 'gym:2' });
  assert.ok(requests.some(([key]) => key === 'POST /api/manage/gyms/2/restore'));
  assert.equal(app.nodes['#toast'].textContent, 'Annex <b> restored.');
  assert.match(app.nodes['#app'].innerHTML, /data-gym-id="2"/);
  assert.doesNotMatch(content.innerHTML, /Archived \(/);
});

test('history offers archived gyms as filters and hides Repeat for a workout at one', async () => {
  const app = await harness(storage(), startData([home], [annex]));
  const detail = completedDetail();
  detail.workout = { ...detail.workout, gym_id: 2, gym_name: 'Annex <b>', gym_archived: true };
  const { dialog, nodes } = await openHistoryDetail(app, detail, {});
  assert.match(dialog.innerHTML, /<option value="1">Home<\/option><option value="2">Annex &lt;b&gt; \(archived\)<\/option>/);
  const html = nodes['#history-detail'].innerHTML;
  assert.doesNotMatch(html, /data-repeat-workout/);
  assert.match(html, /Restore Annex &lt;b&gt; in Manage to repeat this workout\./);
});

test('Manage archives, deletes and restores Exercise Configurations', async () => {
  const app = await harness(storage(), startData([home]));
  const questions = [];
  app.env.window.confirm = (question) => { questions.push(question); return true; };
  const configuration = (id, fields) => ({ id, gym_id: 1, gym_name: 'Home', gym_archived: false, variation_id: 11,
    exercise_name: 'Bench Press', variation_name: 'Incline', variation_archived: false, equipment: 'Machine',
    manufacturer: '', label: '', archived: false, used: true, ...fields });
  let configurations = [
    configuration(5, { label: 'Press <1>' }),
    configuration(6, { label: 'Press 2', used: false }),
    configuration(7, { exercise_name: 'Sled Push', variation_name: 'Heavy', variation_archived: true, equipment: 'Sled' }),
    configuration(8, { label: 'Old', archived: true }),
  ];
  const { content, requests, click } = await openManage(app, {
    'GET /api/manage': () => manageOverview([{ ...home, archived: false, used: true }], { configurations }),
    'DELETE /api/manage/configurations/5': () => {
      configurations = configurations.map((item) => item.id === 5 ? { ...item, archived: true } : item);
      return { outcome: 'archived' };
    },
    'DELETE /api/manage/configurations/6': () => {
      configurations = configurations.filter((item) => item.id !== 6);
      return { outcome: 'deleted' };
    },
    'POST /api/manage/configurations/8/restore': () => {
      configurations = configurations.map((item) => item.id === 8 ? { ...item, archived: false } : item);
      return configurations.find((item) => item.id === 8);
    },
    'GET /api/bootstrap': () => startData([home]),
  });
  let html = content.innerHTML;
  assert.match(html, /data-section="configurations">\s*<summary><h3>Exercise Configurations<\/h3><span>3<\/span>/);
  assert.match(html, /Machine · Press &lt;1&gt;[\s\S]*data-manage-remove="configuration:5"[^>]*>Archive<\/button>/);
  assert.match(html, /data-manage-remove="configuration:6"[^>]*>Delete<\/button>/);
  assert.match(html, /Sled · Recent hides it while Heavy Sled Push is archived/);
  assert.match(html, /Archived \(1\)[\s\S]*Home · Machine · Old[\s\S]*data-manage-restore="configuration:8"[^>]*>Restore<\/button>/);
  assert.doesNotMatch(html, /<1>/);

  await click('[data-manage-remove]', { manageRemove: 'configuration:5' });
  assert.match(questions[0], /^Archive Incline Bench Press\? It is used in recorded workouts/);
  assert.equal(app.nodes['#toast'].textContent, 'Incline Bench Press archived.');
  await click('[data-manage-remove]', { manageRemove: 'configuration:6' });
  assert.match(questions[1], /^Delete Incline Bench Press\? It has never been used/);
  assert.equal(app.nodes['#toast'].textContent, 'Incline Bench Press deleted.');
  html = content.innerHTML;
  assert.doesNotMatch(html, /configuration:6/);
  assert.match(html, /Archived \(2\)[\s\S]*data-manage-restore="configuration:5"/);

  await click('[data-manage-restore]', { manageRestore: 'configuration:8' });
  assert.ok(requests.some(([key]) => key === 'POST /api/manage/configurations/8/restore'));
  assert.equal(app.nodes['#toast'].textContent, 'Incline Bench Press restored.');
  assert.match(content.innerHTML, /data-manage-remove="configuration:8"/);
});

const sled = (variations) => ({ id: 3, name: 'Sled <i>', archived: false, renamable: true, variations });
const heavy = { id: 7, name: 'Heavy', tracking_type: 'duration', assisted: 0, archived: false, used: true,
  equipment: [{ name: 'Sled', used: false }, { name: 'Prowler <b>', used: true }] };
const closeGrip = { id: 4, name: 'Bench Press', archived: false, renamable: false, variations: [
  { id: 9, name: 'Close Grip', tracking_type: 'repetitions', assisted: 0, archived: false, used: false, equipment: [{ name: 'Barbell', used: false }] }] };

test('Manage lists custom exercises with rename, equipment and Delete or Archive, and archived variations to restore', async () => {
  const app = await harness(storage(), startData([home]));
  let variations = [heavy, { ...heavy, id: 8, name: 'Old', archived: true, equipment: [{ name: 'Rope', used: true }] }];
  const questions = [];
  app.env.window.confirm = (question) => { questions.push(question); return true; };
  const { content, requests, click } = await openManage(app, {
    'GET /api/manage': () => manageOverview([{ ...home, archived: false, used: true }], { exercises: [sled(variations), closeGrip] }),
    'DELETE /api/manage/variations/7': () => { variations = variations.map((item) => ({ ...item, archived: true })); return { outcome: 'archived' }; },
    'POST /api/manage/variations/8/restore': () => { variations = [variations[0], { ...variations[1], archived: false }]; return variations[1]; },
    'GET /api/bootstrap': () => startData([home]),
  });
  let html = content.innerHTML;
  assert.doesNotMatch(html, /<[ib]>/);
  assert.match(html, /<summary><h3>Custom exercises<\/h3><span>2<\/span><\/summary>/);
  assert.match(html, /data-manage-rename="exercise:3" aria-label="Rename Sled &lt;i&gt;">Rename<\/button>/);
  assert.doesNotMatch(html, /data-manage-rename="exercise:4"/);
  assert.doesNotMatch(html, /data-manage-remove="exercise:/);
  assert.match(html, /data-manage-rename="variation:7"[^>]*>Rename<\/button><button[^>]*data-manage-equipment="variation:7"[^>]*>Equipment<\/button><button[^>]*data-manage-remove="variation:7"[^>]*>Archive<\/button>/);
  assert.match(html, /data-manage-remove="variation:9"[^>]*>Delete<\/button>/);
  // × only on unused equipment, and never on the last value.
  const editor = html.match(/<form class="manage-rename-form manage-equipment-form" data-manage-equipment-form="variation:7" hidden>[\s\S]*?<\/form>/)[0];
  assert.match(editor, /<span>Sled<\/span><button type="button" class="chip-remove" data-remove-equipment="0" aria-label="Remove Sled">/);
  assert.match(editor, /<li class="equipment-chip equipment-chip-fixed"><span>Prowler &lt;b&gt;<\/span><\/li>/);
  assert.match(editor, /used in recorded workouts/);
  assert.doesNotMatch(html.match(/data-manage-equipment-form="variation:9"[\s\S]*?<\/form>/)[0], /chip-remove/);
  assert.match(html, /Archived \(1\)[\s\S]*Old Sled &lt;i&gt;[\s\S]*data-manage-restore="variation:8"[^>]*>Restore<\/button>/);

  await click('[data-manage-remove]', { manageRemove: 'variation:7' });
  assert.match(questions[0], /^Archive Heavy Sled <i>\? /);
  assert.ok(requests.some(([key]) => key === 'DELETE /api/manage/variations/7'));
  assert.equal(app.nodes['#toast'].textContent, 'Heavy Sled <i> archived.');
  html = content.innerHTML;
  assert.match(html, /Archived \(2\)/);
  assert.doesNotMatch(html, /data-manage-rename="exercise:3"/);
  await click('[data-manage-restore]', { manageRestore: 'variation:8' });
  assert.ok(requests.some(([key]) => key === 'POST /api/manage/variations/8/restore'));
  assert.equal(app.nodes['#toast'].textContent, 'Old Sled <i> restored.');
  assert.match(content.innerHTML, /data-manage-rename="exercise:3"/);
});

test('Manage renames a custom exercise', async () => {
  const app = await harness(storage(), startData([home]));
  let name = 'Sled <i>';
  const { content, requests } = await openManage(app, {
    'GET /api/manage': () => manageOverview([], { exercises: [{ ...sled([heavy]), name }] }),
    'PUT /api/manage/exercises/3': () => { name = 'Sled Drive'; return { ...sled([heavy]), name }; },
    'GET /api/bootstrap': () => startData([home]),
  });
  assert.match(content.innerHTML, /data-manage-rename-form="exercise:3" hidden>[\s\S]*value="Sled &lt;i&gt;"/);
  const form = Object.assign(node(), { dataset: { manageRenameForm: 'exercise:3' }, elements: { name: Object.assign(node(), { value: 'Sled Drive' }) },
    closest: (selector) => selector === '[data-manage-rename-form]' ? form : null, querySelector: () => node() });
  await content.events.submit({ target: form, preventDefault() {} });
  assert.deepEqual(requests.find(([key]) => key.startsWith('PUT')), ['PUT /api/manage/exercises/3', { name: 'Sled Drive' }]);
  assert.equal(app.nodes['#toast'].textContent, 'Renamed to Sled Drive.');
  assert.match(content.innerHTML, /Sled Drive/);
});

test('Manage adds and removes equipment of a custom variation and shows refusals', async () => {
  const app = await harness(storage(), startData([home]));
  let equipment = heavy.equipment;
  const { content, requests, click } = await openManage(app, {
    'GET /api/manage': () => manageOverview([], { exercises: [sled([{ ...heavy, equipment }])] }),
    'PUT /api/manage/variations/7': () => {
      const names = requests.at(-1)[1].equipment;
      if (!names.includes('Sled')) return reply(409, { error: 'Sled is used in recorded workouts, so it cannot be removed.' });
      equipment = names.map((value) => ({ name: value, used: value === 'Prowler <b>' }));
      return { ...heavy, equipment };
    },
  });
  const status = node();
  const entry = Object.assign(node(), { value: '' });
  const form = Object.assign(node(), { hidden: true, dataset: { manageEquipmentForm: 'variation:7' }, elements: { equipment: entry },
    closest: (selector) => selector === '[data-manage-equipment-form]' ? form : null,
    querySelector: (selector) => selector === '.set-status' ? status : node() });
  content.querySelector = (selector) => selector === '[data-manage-equipment-form="variation:7"]' ? form : node();
  await click('[data-manage-equipment]', { manageEquipment: 'variation:7' });
  assert.equal(form.hidden, false);
  assert.equal(entry.focused, true);

  entry.value = 'sled';
  await content.events.submit({ target: form, preventDefault() {} });
  assert.equal(status.textContent, 'sled is already added.');
  assert.ok(!requests.some(([key]) => key.startsWith('PUT')));
  entry.value = '  Rope   Sled ';
  entry.focused = false;
  await content.events.submit({ target: form, preventDefault() {} });
  assert.deepEqual(requests.at(-2), ['PUT /api/manage/variations/7', { equipment: ['Sled', 'Prowler <b>', 'Rope Sled'] }]);
  assert.equal(app.nodes['#toast'].textContent, 'Added Rope Sled.');
  // The editor stays open after the refresh, ready for the next value.
  assert.match(content.innerHTML, /data-manage-equipment-form="variation:7">/);
  assert.match(content.innerHTML, /<span>Rope Sled<\/span><button type="button" class="chip-remove" data-remove-equipment="2"/);
  assert.equal(entry.focused, true);

  const chip = (index) => ({ target: { closest: (selector) => selector === '[data-remove-equipment]'
    ? Object.assign(node(), { dataset: { removeEquipment: String(index) }, closest: () => form }) : null } });
  await content.events.click(chip(2));
  assert.deepEqual(requests.at(-2), ['PUT /api/manage/variations/7', { equipment: ['Sled', 'Prowler <b>'] }]);
  assert.equal(app.nodes['#toast'].textContent, 'Removed Rope Sled.');
  await content.events.click(chip(0));
  assert.deepEqual(requests.at(-1), ['PUT /api/manage/variations/7', { equipment: ['Prowler <b>'] }]);
  assert.equal(status.textContent, 'Sled is used in recorded workouts, so it cannot be removed.');
});

test('progress keeps archived custom exercises selectable', async () => {
  const app = await harness(storage(), { gyms: [{ id: 1, name: 'Home' }] });
  const nodes = {};
  const dialog = node();
  dialog.querySelector = (selector) => nodes[selector] ??= node();
  dialog.showModal = () => { dialog.open = true; };
  nodes['#progress-exercise'] = Object.assign(node(), { value: '17' });
  nodes['#progress-filters'] = Object.assign(node(), { elements: { gym_id: { value: '' } } });
  app.env.document.createElement = () => dialog;
  app.env.document.body = { append: () => { app.nodes['#progress'] = dialog; } };
  const urls = [];
  app.env.fetch = async (url) => {
    urls.push(url);
    if (url.startsWith('/api/catalog')) return response({ catalog: [
      { id: 17, exercise_name: 'Sled <i>', variation_name: 'Heavy', equipment: ['Sled'], archived: true },
      { id: 18, exercise_name: 'Leg Press', variation_name: 'Standard', equipment: ['Machine'], archived: false }] });
    return response({ variation_id: 17, exercise_name: 'Sled', variation_name: 'Heavy', tracking_type: 'duration', points: [] });
  };
  await app.nodes['#open-progress'].events.click();
  assert.equal(urls[0], '/api/catalog?gym_id=1&include_archived=1');
  assert.match(nodes['#progress-exercise'].innerHTML, /<option value="17" >Heavy Sled &lt;i&gt; \(archived\)<\/option><option value="18" >Leg Press<\/option>/);
});
