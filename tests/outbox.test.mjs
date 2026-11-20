import assert from 'node:assert/strict';
import test from 'node:test';
import { Outbox, OUTBOX_KEY, tempId, isTemp } from '../static/outbox.mjs';
import { workoutOps, renameId, copiedSetValues } from '../static/workout-ops.mjs';

function storage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), items };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function failure(status, message = 'Refused.') { return Object.assign(new Error(message), { status }); }

// A recording outbox; the server answers through `answer(path, options)`.
function harness({ disk = storage(), answer = async () => ({}), online = () => true, kinds } = {}) {
  const sent = [];
  const timers = [];
  const outbox = new Outbox({
    storage: () => disk,
    request: async (path, options) => { sent.push(`${options.method} ${path}`); return answer(path, options); },
    kinds: kinds ?? { note: { request: (op) => ({ method: 'PUT', path: `/note/${op.n}`, body: { n: op.n } }) },
      gone: { request: (op) => ({ method: 'DELETE', path: `/gone/${op.n}` }), ok: (error) => error.status === 404 } },
    schedule: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clear: () => {},
    online,
    random: () => 0,
  });
  return { outbox, sent, timers, disk };
}

test('temporary ids are negative and unique, and resolve follows the server map', () => {
  const a = tempId(1000), b = tempId(1000), c = tempId(5);
  assert.ok(isTemp(a) && isTemp(b) && isTemp(c));
  assert.equal(new Set([a, b, c]).size, 3);
  assert.equal(isTemp(12), false);
  const { outbox } = harness();
  assert.equal(outbox.resolve(a), a);
  assert.equal(outbox.known(a), false);
  outbox.map(a, 40);
  assert.equal(outbox.resolve(a), 40);
  assert.equal(outbox.known(a), true);
  assert.equal(outbox.tempFor(40), a);
});

test('changes are sent one at a time, in order, and the queue survives a reload', async () => {
  const gates = [];
  const app = harness({ answer: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
  app.outbox.enqueue({ kind: 'note', n: 1 });
  app.outbox.enqueue({ kind: 'note', n: 2 });
  app.outbox.enqueue({ kind: 'note', n: 3 });
  await settle();
  assert.deepEqual(app.sent, ['PUT /note/1'], 'one request at a time');
  const saved = JSON.parse(app.disk.getItem(OUTBOX_KEY));
  assert.deepEqual(saved.ops.map((op) => op.n), [1, 2, 3]);
  assert.ok(saved.ops.every((op) => op.request_id), 'every change carries a request id');
  gates[0].resolve({});
  await settle();
  assert.deepEqual(app.sent, ['PUT /note/1', 'PUT /note/2']);

  // The app closes here, with note 2 in flight and note 3 queued: a new outbox picks both up.
  const reopened = harness({ disk: app.disk, answer: async () => ({}) });
  assert.deepEqual(reopened.outbox.ops.map((op) => op.n), [2, 3]);
  reopened.outbox.kick();
  await settle();
  assert.deepEqual(reopened.sent, ['PUT /note/2', 'PUT /note/3']);
  assert.deepEqual(JSON.parse(app.disk.getItem(OUTBOX_KEY)).ops, []);
});

test('network failures and server errors retry with growing backoff and keep the same request id', async () => {
  let failing = true;
  const bodies = [];
  const app = harness({ answer: async (path, options) => {
    bodies.push(JSON.parse(options.body));
    if (failing === true) throw new TypeError('Failed to fetch');
    if (failing) throw failure(failing, 'Busy');
    return {};
  } });
  const op = app.outbox.enqueue({ kind: 'note', n: 1 });
  await settle();
  assert.equal(app.timers.length, 1);
  assert.equal(app.timers[0].delay, 1000);
  assert.equal(app.outbox.failed, null, 'a dropped connection is not shown as a refusal');
  assert.ok(app.outbox.waitingForRetry);
  for (const [status, delay] of [[503, 2000], [429, 5000], [408, 10000]]) {
    failing = status;
    app.timers.at(-1).callback();
    await settle();
    assert.equal(app.timers.at(-1).delay, delay);
  }
  assert.equal(JSON.parse(app.disk.getItem(OUTBOX_KEY)).ops[0].attempts, 4);
  failing = false;
  app.timers.at(-1).callback();
  await settle();
  assert.equal(app.outbox.size, 0);
  assert.equal(app.sent.length, 5);
  assert.ok(app.sent.every((line) => line === 'PUT /note/1'));
  assert.equal(op.request_id, op.id);
});

test('a refusal stops the queue and is kept until Retry or Discard; nothing is dropped silently', async () => {
  let refuse = true;
  const app = harness({ answer: async (path) => { if (refuse && path === '/note/1') throw failure(409, 'Workout is not active.'); return {}; } });
  app.outbox.enqueue({ kind: 'note', n: 1 });
  app.outbox.enqueue({ kind: 'note', n: 2 });
  await settle();
  assert.deepEqual(app.sent, ['PUT /note/1']);
  assert.equal(app.outbox.failed.error, 'Workout is not active.');
  assert.equal(app.outbox.failed.status, 409);
  assert.equal(app.outbox.runnable, false);
  assert.equal(app.timers.length, 0, 'a refusal is not retried on its own');
  // A reload keeps the refusal visible.
  assert.equal(harness({ disk: app.disk }).outbox.failed.error, 'Workout is not active.');
  refuse = false;
  app.outbox.retry();
  await settle();
  assert.deepEqual(app.sent, ['PUT /note/1', 'PUT /note/1', 'PUT /note/2']);
  assert.equal(app.outbox.size, 0);
});

test('Discard drops the refused change and the later changes that depend on what it created', async () => {
  const app = harness({ answer: async (path) => { if (path === '/note/1') throw failure(400, 'Bad.'); return {}; } });
  const first = app.outbox.enqueue({ kind: 'note', n: 1, creates: [-5, -6] });
  app.outbox.enqueue({ kind: 'note', n: 2, uses: [-6], creates: [-7] });
  app.outbox.enqueue({ kind: 'note', n: 3, uses: [-7] });
  app.outbox.enqueue({ kind: 'note', n: 4, uses: [12] });
  await settle();
  const dropped = app.outbox.discard(first.id);
  await settle();
  assert.deepEqual(dropped.map((op) => op.n), [1, 2, 3]);
  assert.deepEqual(app.sent, ['PUT /note/1', 'PUT /note/4']);
  assert.equal(app.outbox.size, 0);
});

test('a refusal that means already done counts as done, and nothing is sent while offline', async () => {
  let online = false;
  const app = harness({ online: () => online, answer: async () => { throw failure(404, 'Set not found.'); } });
  app.outbox.enqueue({ kind: 'gone', n: 9 });
  await settle();
  assert.deepEqual(app.sent, []);
  assert.equal(app.outbox.size, 1);
  assert.deepEqual(app.timers.map((timer) => timer.delay), [5000], 'it looks again in 5 s, in case "online" never fires');
  online = true;
  app.timers[0].callback();
  await settle();
  assert.deepEqual(app.sent, ['DELETE /gone/9']);
  assert.equal(app.outbox.size, 0);
  assert.equal(app.outbox.completed, 1);
});

test('changes queued while answering one go right after it, and a canceled workout forgets its changes', async () => {
  const kinds = {
    note: { request: (op) => ({ method: 'PUT', path: `/note/${op.n}` }),
      done: (op, answer, outbox) => { if (op.n === 1) outbox.enqueue({ kind: 'note', n: 1.5 }, { next: true }); } },
  };
  const app = harness({ kinds });
  app.outbox.enqueue({ kind: 'note', n: 1 });
  app.outbox.enqueue({ kind: 'note', n: 2 });
  await settle();
  assert.deepEqual(app.sent, ['PUT /note/1', 'PUT /note/1.5', 'PUT /note/2']);

  const offline = harness({ online: () => false });
  offline.outbox.enqueue({ kind: 'note', n: 1, workoutId: 1 });
  offline.outbox.enqueue({ kind: 'note', n: 2, workoutId: 2 });
  offline.outbox.dropWorkout(1);
  assert.deepEqual(offline.outbox.ops.map((op) => op.n), [2]);
});

test('a full or unavailable phone storage is reported instead of ignored', () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const app = harness({ disk: broken, online: () => false });
  app.outbox.enqueue({ kind: 'note', n: 1 });
  assert.equal(app.outbox.storageFailed, true);
});

// The workout changes themselves.
const workout = () => ({
  active_workout: { id: 1, gym_id: 1, note: '' },
  workout_exercises: [{ id: 3, position: 1, exercise_name: 'Bench Press', tracking_type: 'repetitions', note: '', previous_sets: [],
    record_bests: {}, sets: [{ id: 2, position: 1, weight: 60, result: 8, completed: true, effort: 2, side: 'left', set_type: null }] }],
});

function opsHarness(answer = async () => ({})) {
  let data = workout();
  const disk = storage();
  const outbox = new Outbox({ storage: () => disk, request: async (path, options) => answer(path, options), kinds: workoutOps,
    schedule: () => 0, clear: () => {}, online: () => false, random: () => 0 });
  outbox.context = { data: () => data, remap: (type, from, to) => renameId(data, type, from, to), edited: () => false, changed: () => {} };
  return { outbox, data: () => data, setData: (value) => { data = value; }, disk };
}

test('Add set copies the set above, and replaying the queue on fresh server data shows it exactly once', () => {
  assert.deepEqual(copiedSetValues(workout().workout_exercises[0].sets[0]), { weight: 60, result: 8, side: 'right', set_type: null });
  const { outbox, data } = opsHarness();
  const setId = tempId();
  const op = { kind: 'addSet', workoutId: 1, entryId: 3, setId, values: copiedSetValues(data().workout_exercises[0].sets[0]), creates: [setId], uses: [3] };
  workoutOps.addSet.apply(data(), op, outbox);
  outbox.enqueue(op);
  const fresh = outbox.replay(workout());
  outbox.replay(fresh);
  assert.deepEqual(fresh.workout_exercises[0].sets.map((set) => [set.id, set.weight, set.side, set.completed]),
    [[2, 60, 'left', true], [setId, 60, 'right', false]]);
  assert.deepEqual(workoutOps.addSet.request(op, outbox), { method: 'POST', path: '/api/workout-exercises/3/sets',
    body: { weight: 60, result: 8, side: 'right', set_type: null, request_id: op.request_id } });
});

test('an exercise added offline gets the server ids, Last workout and extra slots when it syncs', async () => {
  const sets = [{ id: 21, position: 1, side: 'left', set_type: null }, { id: 22, position: 2, side: 'right', set_type: null },
    { id: 23, position: 3, side: null, set_type: 'warmup' }];
  const { outbox, data } = opsHarness();
  const entryId = tempId(), setId = tempId();
  const op = outbox.enqueue({ kind: 'addExercise', workoutId: 1, entryId, setIds: [setId], body: { profile_id: 7 },
    entry: { variation_id: 30, exercise_name: 'Hammer Curl', tracking_type: 'repetitions' }, creates: [entryId, setId] });
  workoutOps.addExercise.apply(data(), op, outbox);
  const later = outbox.enqueue({ kind: 'saveSet', setId, body: { weight: 16, result: 10, completed: true } });
  assert.deepEqual(workoutOps.addExercise.request(op, outbox).body, { profile_id: 7, request_id: op.request_id });
  workoutOps.addExercise.done(op, { id: 9, entry: { id: 9, exercise_name: 'Hammer Curl', previous_sets: [{ weight: 16, result: 10 }], sets } }, outbox);
  const entry = data().workout_exercises.at(-1);
  assert.deepEqual(entry.sets.map((set) => [set.id, set.side, set.set_type]), [[21, 'left', null], [22, 'right', null], [23, null, 'warmup']]);
  assert.deepEqual([entry.id, entry.previous_sets], [9, [{ weight: 16, result: 10 }]]);
  assert.equal(workoutOps.saveSet.request(later, outbox).path, '/api/sets/21', 'later changes use the server id');
});

test('removing, moving, replacing and finishing apply idempotently, and a 404 on delete means already done', () => {
  const { outbox, data } = opsHarness();
  data().workout_exercises.push({ id: 4, position: 2, exercise_name: 'Front Plank', tracking_type: 'duration', sets: [] });
  const move = { kind: 'moveExercise', entryId: 4, position: 1 };
  workoutOps.moveExercise.apply(data(), move, outbox);
  workoutOps.moveExercise.apply(data(), move, outbox);
  assert.deepEqual(data().workout_exercises.map((entry) => [entry.id, entry.position]), [[4, 1], [3, 2]]);
  const replace = { kind: 'replaceExercise', workoutId: 1, entryId: 3, entry: { variation_id: 31, exercise_name: 'Dead Hang', tracking_type: 'duration', assisted: 0, equipment: '', manufacturer: '', label: '' } };
  workoutOps.replaceExercise.apply(data(), replace, outbox);
  assert.deepEqual(data().workout_exercises[1].sets[0], { id: 2, position: 1, weight: null, result: null, completed: false, effort: null, side: 'left', set_type: null });
  const removal = { kind: 'removeSet', setId: 2 };
  workoutOps.removeSet.apply(data(), removal, outbox);
  workoutOps.removeSet.apply(data(), removal, outbox);
  assert.deepEqual(data().workout_exercises[1].sets, []);
  assert.equal(workoutOps.removeSet.ok({ status: 404 }), true);
  assert.equal(workoutOps.removeSet.ok({ status: 409 }), false);
  workoutOps.finish.apply(data(), { kind: 'finish', workoutId: 1 }, outbox);
  assert.equal(data().active_workout, null);
  assert.deepEqual(workoutOps.finish.request({ workoutId: 1 }), { method: 'POST', path: '/api/workouts/1/complete', body: {} });
});
