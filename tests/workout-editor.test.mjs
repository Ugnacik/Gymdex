import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DraftStore } from '../static/drafts.mjs';
import { WorkoutEditor } from '../static/workout-editor.mjs';

const values = { weight: '12.5', result: '8', assistance: true, completed: true };
const data = () => ({ active_workout: { id: 1, gym_id: 1 }, gyms: [],
  workout_exercises: [{ id: 3, sets: [{ id: 2, weight: null, result: null, completed: false }] }] });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(drafts = new DraftStore(() => disk)) {
  const timers = new Map();
  let clock = 0;
  const requests = [];
  const env = { online: true, request: async (path, options) => {
    if (options.method === 'PUT') return { id: 2, ...JSON.parse(options.body) };
    return { ok: true };
  } };
  const editor = new WorkoutEditor({ data: data(), drafts,
    request: (path, options) => { requests.push({ path, ...options }); return env.request(path, options); },
    schedule: (callback) => { timers.set(++clock, callback); return clock; },
    clear: (id) => timers.delete(id), online: () => env.online,
  });
  return { editor, drafts, timers, requests, env };
}
// Each default fixture uses unavailable storage, exercising the in-memory fallback.
const disk = { getItem: () => null, setItem: () => { throw new Error('Storage unavailable'); }, removeItem() {} };

test('editing stores a draft immediately and restores it in another editor', () => {
  const { editor, drafts } = fixture();
  editor.edit(2, values);
  assert.equal(drafts.get(1, 2).result, '8');
  const restored = fixture(drafts).editor;
  assert.equal(restored.status(2).values.assistance, true);
  assert.equal(restored.status(2).dirty, true);
});

test('autosave sends assistance and clears the draft only after acknowledgement', async () => {
  const { editor, drafts, timers, env, requests } = fixture();
  const saving = deferred();
  env.request = () => saving.promise;
  editor.edit(2, values);
  const pending = [...timers.values()][0]();
  assert.equal(editor.status(2).saving, true);
  assert.equal(drafts.get(1, 2).result, '8');
  assert.equal(JSON.parse(requests[0].body).weight, -12.5);
  saving.resolve({ id: 2, weight: -12.5, result: 8, completed: true });
  await pending;
  assert.equal(drafts.get(1, 2), null);
  assert.equal(editor.status(2).dirty, false);
  assert.equal(drafts.cachedWorkout().workout_exercises[0].sets[0].weight, -12.5);
});

test('lost connection preserves editable drafts and retries on reconnect', async () => {
  const { editor, env, drafts } = fixture();
  env.request = async () => { throw new Error('Cannot reach the server.'); };
  editor.edit(2, values);
  assert.equal(await editor.save(2), false);
  assert.equal(editor.status(2).dirty, true);
  assert.match(editor.status(2).message, /Will retry automatically/);
  env.online = false;
  editor.edit(2, { ...values, result: '12' });
  await editor.retry();
  assert.equal(drafts.get(1, 2).result, '12');
  env.online = true;
  env.request = async (_, options) => ({ id: 2, ...JSON.parse(options.body) });
  await editor.retry();
  assert.equal(editor.status(2).dirty, false);
  assert.equal(editor.data.workout_exercises[0].sets[0].result, 12);
});

test('edits during saving survive the older acknowledgement and are queued again', async () => {
  const { editor, env, drafts, timers } = fixture();
  const saving = deferred();
  env.request = () => saving.promise;
  editor.edit(2, values);
  const pending = editor.save(2);
  editor.edit(2, { ...values, result: '12' });
  saving.resolve({ id: 2, result: 8, completed: true });
  assert.equal(await pending, false);
  assert.equal(editor.status(2).values.result, '12');
  assert.equal(drafts.get(1, 2).result, '12');
  assert.equal(timers.size, 1);
  env.request = async (_, options) => ({ id: 2, ...JSON.parse(options.body) });
  await editor.retry();
  assert.equal(editor.status(2).dirty, false);
});

test('server rejection stops automatic retries until edit or manual save', async () => {
  const { editor, env, requests } = fixture();
  env.request = async () => { throw Object.assign(new Error('Set no longer active'), { status: 404 }); };
  editor.edit(2, values);
  assert.equal(await editor.save(2), false);
  await editor.retry();
  assert.equal(requests.length, 1);
  assert.equal(editor.status(2).blocked, true);
  await editor.save(2);
  assert.equal(requests.length, 2);
  editor.edit(2, { ...values, result: '12' });
  assert.equal(editor.status(2).blocked, false);
});

test('a rejection of an older revision does not block a newer edit', async () => {
  const { editor, env } = fixture();
  const response = deferred();
  env.request = async () => { await response.promise; throw Object.assign(new Error('Invalid'), { status: 400 }); };
  editor.edit(2, values);
  const saving = editor.save(2);
  editor.edit(2, { ...values, result: '12' });
  response.resolve();
  await saving;
  assert.equal(editor.status(2).blocked, false);
});

test('invalid input prevents flush and finish without discarding drafts', async () => {
  for (const invalid of [{ result: '' }, { result: '1.5' }, { result: '-1' },
    { result: '1000001' }, { weight: '-1' }, { weight: 'Infinity' }, { weight: '100001' }]) {
    const { editor, requests } = fixture();
    editor.edit(2, { ...values, ...invalid });
    assert.equal(await editor.flush(), false);
    assert.equal(await editor.finish(), false);
    assert.equal(editor.busy, false);
    assert.equal(editor.data.active_workout.id, 1);
    assert.equal(editor.status(2).dirty, true);
    assert.equal(requests.length, 0);
  }
  const { editor } = fixture();
  editor.edit(2, { ...values, result: '', completed: false }, { valid: false });
  assert.equal(await editor.flush(), false, 'Native badInput must not turn into an empty saved value');
});

test('finish waits for the latest revision and freezes edits, retries and duplicate actions', async () => {
  const { editor, env, requests, timers } = fixture();
  const saving = deferred();
  const completing = deferred();
  const completeStarted = deferred();
  env.request = async (path, options) => {
    if (requests.length === 1) return saving.promise;
    if (path.endsWith('/complete')) { completeStarted.resolve(); return completing.promise; }
    return { id: 2, ...JSON.parse(options.body) };
  };
  editor.edit(2, values);
  const save = editor.save(2);
  editor.edit(2, { ...values, result: '12' });
  const queued = [...timers.values()][0];
  const finish = editor.finish();
  assert.equal(editor.busy, true);
  assert.equal(timers.size, 0);
  assert.equal(editor.edit(2, { ...values, result: '99' }), false);
  await queued();
  await editor.retry();
  assert.equal(await editor.cancel(), false);
  assert.equal(await editor.finish(), false);
  saving.resolve({ id: 2, result: 8, completed: true });
  await save;
  await completeStarted.promise;
  assert.deepEqual(requests.map(({ path }) => path), ['/api/sets/2', '/api/sets/2', '/api/workouts/1/complete']);
  assert.equal(JSON.parse(requests[1].body).result, 12);
  completing.resolve({ ok: true });
  assert.equal(await finish, true);
  assert.equal(editor.data.active_workout, null);
  assert.equal(editor.busy, false);
});

test('declined or failed terminal requests leave the workout editable', async () => {
  for (const operation of ['finish', 'cancel']) {
    const { editor, env } = fixture();
    assert.equal(await editor[operation](() => false), false);
    env.request = async () => { throw new Error('Offline'); };
    await assert.rejects(editor[operation](), /Offline/);
    assert.equal(editor.busy, false);
    assert.equal(editor.data.active_workout.id, 1);
    assert.equal(editor.edit(2, values), true);
  }
});

test('finish and cancel clear local active state and only their own drafts', async () => {
  for (const operation of ['finish', 'cancel']) {
    const { editor, drafts, requests } = fixture();
    drafts.put(1, 99, values);
    drafts.put(10, 2, values);
    editor.edit(2, { ...values, result: operation === 'cancel' ? '' : '8' });
    assert.equal(await editor[operation](), true);
    assert.equal(editor.data.active_workout, null);
    assert.equal(drafts.cachedWorkout().active_workout, null);
    assert.deepEqual(drafts.cachedWorkout().workout_exercises, []);
    assert.equal(drafts.get(1, 2), null);
    assert.equal(drafts.get(1, 99), null);
    assert.equal(drafts.get(10, 2).result, '8');
    if (operation === 'cancel') assert.deepEqual(requests.map((r) => r.method), ['DELETE']);
    assert.equal(editor.edit(2, values), false);
    assert.equal(await editor.save(2), false);
  }
});

test('cancel waits for saving and preserves a newer draft if deletion fails', async () => {
  const { editor, env, requests, drafts, timers } = fixture();
  const saving = deferred();
  env.request = async (_, options) => {
    if (options.method === 'PUT') return saving.promise;
    throw new Error('Delete failed');
  };
  editor.edit(2, values);
  const save = editor.save(2);
  editor.edit(2, { ...values, result: '12' });
  const cancel = editor.cancel();
  assert.deepEqual(requests.map((r) => r.method), ['PUT']);
  saving.resolve({ id: 2, result: 8, completed: true });
  await save;
  await assert.rejects(cancel, /Delete failed/);
  assert.deepEqual(requests.map((r) => r.method), ['PUT', 'DELETE']);
  assert.equal(timers.size, 0);
  assert.equal(drafts.get(1, 2).result, '12');
  env.request = async (_, options) => ({ id: 2, ...JSON.parse(options.body) });
  await editor.retry();
  assert.equal(editor.status(2).dirty, false);
});

test('set removal waits for saving and prevents any later queued save', async () => {
  const { editor, env, timers, requests } = fixture();
  const saving = deferred();
  env.request = async (_, options) => options.method === 'PUT' ? saving.promise : { ok: true };
  editor.edit(2, values);
  const queued = [...timers.values()][0];
  const save = editor.save(2);
  const removal = editor.remove(2);
  assert.equal(editor.status(2).removing, true);
  assert.equal(editor.edit(2, values), false);
  await queued();
  assert.deepEqual(requests.map((r) => r.method), ['PUT']);
  saving.resolve({ id: 2, result: 8, completed: true });
  await save;
  assert.equal(await removal, true);
  await queued();
  assert.equal(editor.status(2), null);
  assert.equal(await editor.save(2), false);
  assert.deepEqual(requests.map((r) => r.method), ['PUT', 'DELETE']);
});

test('failed removal preserves drafts, and finish waits for an in-flight removal', async () => {
  const { editor, env } = fixture();
  editor.edit(2, values);
  env.request = async () => { throw new Error('Offline'); };
  assert.equal(await editor.remove(2), false);
  assert.equal(editor.status(2).values.result, '8');
  assert.equal(editor.status(2).removing, false);
  const deletion = deferred();
  const calls = [];
  env.request = async (path) => { calls.push(path); return path === '/api/sets/2' ? deletion.promise : { ok: true }; };
  const removal = editor.remove(2);
  const finish = editor.finish();
  await Promise.resolve();
  assert.deepEqual(calls, ['/api/sets/2']);
  deletion.resolve({ ok: true });
  await removal;
  assert.equal(await finish, true);
  assert.deepEqual(calls, ['/api/sets/2', '/api/workouts/1/complete']);
});
