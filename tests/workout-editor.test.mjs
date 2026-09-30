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
function fixture(drafts = new DraftStore(() => disk), initial = data()) {
  const timers = new Map();
  let clock = 0;
  const requests = [];
  const env = { online: true, request: async (path, options) => {
    if (options.method === 'PUT') return { id: 2, ...JSON.parse(options.body) };
    return { ok: true };
  } };
  const editor = new WorkoutEditor({ data: initial, drafts,
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

test('a weight typed with a decimal comma saves as a decimal', async () => {
  const { editor, requests } = fixture();
  editor.edit(2, { ...values, assistance: false, weight: '62,5' });
  assert.equal(await editor.flush(), true);
  assert.equal(JSON.parse(requests[0].body).weight, 62.5);
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
    { result: '1000001' }, { weight: '-1' }, { weight: 'Infinity' }, { weight: '100001' },
    { weight: '62,5,1' }, { weight: '1e3' }, { weight: 'abc' }]) {
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
    assert.equal(await editor[operation](async () => false), false);
    env.request = async () => { throw new Error('Offline'); };
    await assert.rejects(editor[operation](), /Offline/);
    assert.equal(editor.busy, false);
    assert.equal(editor.data.active_workout.id, 1);
    assert.equal(editor.edit(2, values), true);
  }
});

test('finish and cancel hold the workout busy while the confirmation sheet waits for an answer', async () => {
  for (const operation of ['finish', 'cancel']) {
    for (const accepted of [false, true]) {
      const { editor, requests, timers } = fixture();
      editor.edit(2, values);
      const answer = deferred();
      let savedBeforeAsking;
      const ending = editor[operation](() => { savedBeforeAsking = requests.length; return answer.promise; });
      await new Promise((resolve) => setImmediate(resolve));
      // Finish saves drafts before asking; cancel asks first and discards them.
      assert.equal(savedBeforeAsking, operation === 'finish' ? 1 : 0);
      assert.equal(editor.busy, true);
      assert.equal(timers.size, 0);
      assert.equal(editor.edit(2, { ...values, result: '9' }), false);
      assert.equal(await editor.finish(), false);
      answer.resolve(accepted);
      assert.equal(await ending, accepted);
      assert.equal(editor.busy, false);
      assert.equal(requests.some(({ method }) => method === 'DELETE' || method === 'POST'), accepted);
    }
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

test('removing a set applies the renumbered positions and keeps the other sets\' drafts', async () => {
  const threeSets = { active_workout: { id: 1, gym_id: 1 }, gyms: [], workout_exercises: [{ id: 3, sets: [
    { id: 2, position: 1 }, { id: 5, position: 2 }, { id: 6, position: 3 }] }] };
  const { editor, env, drafts, requests } = fixture(undefined, threeSets);
  editor.edit(6, values);
  env.request = async (path, options) => options.method === 'DELETE'
    ? { ok: true, sets: [{ id: 2, position: 1 }, { id: 6, position: 2 }] }
    : { id: 6, position: 2, ...JSON.parse(options.body) };
  assert.equal(await editor.remove(5), true);
  const positions = (entry) => entry.sets.map((set) => [set.id, set.position]);
  assert.deepEqual(positions(editor.data.workout_exercises[0]), [[2, 1], [6, 2]]);
  assert.deepEqual(positions(drafts.cachedWorkout().workout_exercises[0]), [[2, 1], [6, 2]]);
  // Drafts are keyed by set id, so the renumbered set keeps its draft and saves to its own id.
  assert.equal(editor.status(6).values.result, '8');
  assert.equal(await editor.save(6), true);
  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), ['DELETE /api/sets/5', 'PUT /api/sets/6']);
  assert.deepEqual(positions(editor.data.workout_exercises[0]), [[2, 1], [6, 2]]);
});

const blank = (id) => ({ id, weight: null, result: null, completed: false });
const twoExercises = () => ({ active_workout: { id: 1, gym_id: 1 }, gyms: [], workout_exercises: [
  { id: 3, position: 1, sets: [blank(2)] }, { id: 4, position: 2, sets: [blank(5), blank(6)] }] });
const echoSets = async (path, options) => options.method === 'PUT' && path.startsWith('/api/sets/')
  ? { id: Number(path.split('/').pop()), ...JSON.parse(options.body) } : { ok: true };

test('removing an exercise saves other drafts first and discards its own for good', async () => {
  const { editor, env, drafts, requests, timers } = fixture(undefined, twoExercises());
  env.request = echoSets;
  editor.edit(2, values);
  editor.edit(5, { ...values, result: '' });
  editor.edit(6, values);
  assert.equal(await editor.removeExercise(4, async () => false), false);
  assert.deepEqual(requests, []);
  assert.equal(timers.size, 3, 'declining keeps autosave queued');
  assert.equal(await editor.removeExercise(4), true);
  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`),
    ['PUT /api/sets/2', 'DELETE /api/workout-exercises/4']);
  assert.deepEqual(editor.data.workout_exercises.map((entry) => [entry.id, entry.position]), [[3, 1]]);
  assert.deepEqual(drafts.cachedWorkout().workout_exercises.map((entry) => entry.id), [3]);
  assert.equal(drafts.get(1, 5), null);
  assert.equal(drafts.get(1, 6), null);
  assert.equal(editor.status(5), null);
  assert.equal(editor.pending, false);
  await editor.retry();
  assert.equal(requests.length, 2);
  assert.equal(editor.busy, false);
});

test('moving an exercise saves drafts first and applies the server order', async () => {
  const { editor, env, drafts, requests } = fixture(undefined, twoExercises());
  editor.edit(2, { ...values, result: '' });
  assert.equal(await editor.moveExercise(4, 1), false, 'an invalid draft must be corrected first');
  assert.deepEqual(requests, []);
  editor.edit(2, values);
  env.request = async (path, options) => path === '/api/workout-exercises/4'
    ? { workout_exercises: [{ id: 4, position: 1 }, { id: 3, position: 2 }] } : echoSets(path, options);
  assert.equal(await editor.moveExercise(4, 1), true);
  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`),
    ['PUT /api/sets/2', 'PUT /api/workout-exercises/4']);
  assert.deepEqual(JSON.parse(requests[1].body), { position: 1 });
  assert.deepEqual(editor.data.workout_exercises.map((entry) => [entry.id, entry.position]), [[4, 1], [3, 2]]);
  assert.deepEqual(drafts.cachedWorkout().workout_exercises.map((entry) => entry.id), [4, 3]);
  env.request = async () => { throw new Error('Offline'); };
  await assert.rejects(editor.moveExercise(3, 1), /Offline/);
  await assert.rejects(editor.removeExercise(3), /Offline/);
  assert.deepEqual(editor.data.workout_exercises.map((entry) => entry.id), [4, 3]);
  assert.equal(editor.busy, false);
  assert.equal(editor.edit(2, values), true);
});

const noted = () => ({ active_workout: { id: 1, gym_id: 1, note: '' }, gyms: [], workout_exercises: [
  { id: 3, position: 1, note: 'Old', sets: [blank(2)] }, { id: 4, position: 2, note: '', sets: [blank(5)] }] });
const echoNotes = async (path, options) => path.endsWith('/note')
  ? { id: Number(path.split('/')[3]), note: JSON.parse(options.body).note.trim() } : echoSets(path, options);

test('a note is kept on the phone, restores in another editor, and autosaves after a typing pause', async () => {
  const { editor, drafts, timers, requests, env } = fixture(undefined, noted());
  env.request = echoNotes;
  assert.deepEqual(editor.noteStatus('exercise:3'), { note: 'Old', dirty: false, saving: false, blocked: false, message: '', error: false });
  assert.equal(editor.editNote('workout', 'Felt strong '), true);
  assert.equal(editor.pending, true);
  const restored = fixture(drafts, noted()).editor;
  assert.equal(restored.noteStatus('workout').note, 'Felt strong ');
  assert.equal(restored.noteStatus('workout').dirty, true);
  assert.equal(timers.size, 1);
  await [...timers.values()][0]();
  assert.deepEqual(requests.map(({ method, path, body }) => [method, path, JSON.parse(body)]),
    [['PUT', '/api/workouts/1/note', { note: 'Felt strong ' }]]);
  assert.equal(editor.noteStatus('workout').dirty, false);
  assert.equal(editor.noteStatus('workout').note, 'Felt strong');
  assert.equal(editor.pending, false);
  assert.equal(drafts.cachedWorkout().active_workout.note, 'Felt strong');
  assert.equal(fixture(drafts, noted()).editor.noteStatus('workout').dirty, false);
  editor.editNote('exercise:4', 'Seat 4');
  await editor.saveNote('exercise:4');
  assert.deepEqual(requests.at(-1).path, '/api/workout-exercises/4/note');
  assert.equal(editor.data.workout_exercises[1].note, 'Seat 4');
  assert.equal(editor.noteStatus('exercise:99'), null);
});

test('a note typed without signal retries on reconnect and is saved before finishing', async () => {
  const { editor, env, requests } = fixture(undefined, noted());
  env.request = async () => { throw new Error('Cannot reach the server.'); };
  editor.editNote('exercise:3', 'Grip slipped');
  assert.equal(await editor.saveNote('exercise:3'), false);
  assert.match(editor.noteStatus('exercise:3').message, /Will retry automatically/);
  assert.equal(editor.noteStatus('exercise:3').dirty, true);
  env.request = echoNotes;
  await editor.retry();
  assert.equal(editor.noteStatus('exercise:3').dirty, false);
  assert.equal(editor.data.workout_exercises[0].note, 'Grip slipped');
  editor.editNote('workout', 'Good session');
  assert.equal(await editor.finish(), true);
  assert.deepEqual(requests.slice(-2).map(({ method, path }) => `${method} ${path}`),
    ['PUT /api/workouts/1/note', 'POST /api/workouts/1/complete']);
});

test('a rejected note waits for an edit, and removing an exercise discards its note draft', async () => {
  const { editor, env, drafts, requests } = fixture(undefined, noted());
  env.request = async () => { throw Object.assign(new Error('Notes must be 1000 characters or fewer.'), { status: 400 }); };
  editor.editNote('exercise:4', 'Too long');
  assert.equal(await editor.saveNote('exercise:4'), false);
  assert.equal(editor.noteStatus('exercise:4').blocked, true);
  await editor.retry();
  assert.equal(requests.length, 1);
  env.request = echoNotes;
  assert.equal(await editor.removeExercise(4), true);
  assert.deepEqual(requests.slice(1).map(({ method, path }) => `${method} ${path}`), ['DELETE /api/workout-exercises/4']);
  assert.equal(editor.noteStatus('exercise:4'), null);
  assert.equal(fixture(drafts, noted()).editor.noteStatus('exercise:4').dirty, false);
  assert.equal(editor.pending, false);
});
