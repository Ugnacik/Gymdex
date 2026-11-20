import test from 'node:test';
import assert from 'node:assert/strict';
import { e1rm, findRecords, recordName, recordText, recordValues } from '../static/records.mjs';

// The same cases as tests/test_records.py, since static/records.mjs mirrors gymdex/records.py.
const done = { completed: true, set_type: null, side: null };

test('record values by kind of set, leaving out warm-ups, incomplete sets and empty results', () => {
  assert.deepEqual(recordValues({ ...done, weight: 100, result: 5 }, 'repetitions'), { weight: 100, volume: 500, e1rm: 100 * 36 / 32 });
  assert.equal('e1rm' in recordValues({ ...done, weight: 40, result: 13 }, 'repetitions'), false);
  assert.deepEqual(recordValues({ ...done, weight: -20, result: 8 }, 'repetitions'), { weight: -20 });
  assert.deepEqual(recordValues({ ...done, weight: null, result: 15 }, 'repetitions'), { reps: 15 });
  assert.deepEqual(recordValues({ ...done, weight: 0, result: 15 }, 'repetitions'), { reps: 15 });
  assert.deepEqual(recordValues({ ...done, weight: 10, result: 60 }, 'duration'), { duration: 60 });
  assert.deepEqual(recordValues({ ...done, set_type: 'warmup', weight: 200, result: 5 }, 'repetitions'), {});
  assert.deepEqual(recordValues({ ...done, completed: false, weight: 200, result: 5 }, 'repetitions'), {});
  assert.deepEqual(recordValues({ ...done, weight: 200, result: null }, 'repetitions'), {});
});

test('only the workout\'s best set per type that beats earlier bests is a record; ties are not', () => {
  const previous = { '': { weight: 100, volume: 500, e1rm: e1rm(100, 5) } };
  const sets = [
    { id: 1, completed: true, weight: 100, result: 5 }, { id: 2, completed: true, weight: 102.5, result: 3 },
    { id: 3, completed: true, weight: 102.5, result: 3 }, { id: 4, completed: true, weight: 90, result: 10 },
  ];
  assert.deepEqual(findRecords(previous, sets, 'repetitions').map(({ set_id, type }) => [set_id, type]),
    [[2, 'weight'], [4, 'e1rm'], [4, 'volume']]);
});

test('no earlier bests means no records, and each side compares with its own side', () => {
  assert.deepEqual(findRecords({}, [{ id: 1, completed: true, weight: 100, result: 5 }], 'repetitions'), []);
  assert.deepEqual(findRecords(undefined, [{ id: 1, completed: true, weight: 100, result: 5 }], 'repetitions'), []);
  const previous = { left: { weight: 20, volume: 200, e1rm: e1rm(20, 10) }, right: { weight: 24, volume: 240, e1rm: e1rm(24, 10) } };
  const found = findRecords(previous, [{ id: 1, completed: true, weight: 22, result: 10, side: 'left' },
    { id: 2, completed: true, weight: 22, result: 10, side: 'right' }], 'repetitions');
  assert.deepEqual([...new Set(found.map((item) => `${item.set_id}:${item.side}`))], ['1:left']);
});

test('record text names assisted and duration records the way they read', () => {
  assert.equal(recordText({ type: 'weight', value: 105, previous: 100 }), 'Weight 105 kg (was 100 kg)');
  assert.equal(recordText({ type: 'weight', value: -25, previous: -30 }), 'Least assistance 25 kg assist (was 30 kg assist)');
  assert.equal(recordText({ type: 'e1rm', value: 118.125, previous: 112.5 }), 'Est. 1RM 118.1 kg (was 112.5 kg)');
  assert.equal(recordText({ type: 'duration', value: 75, previous: 60 }), 'Longest time 75 sec (was 60 sec)');
  assert.equal(recordName({ type: 'reps', value: 16 }), 'Most reps');
});
