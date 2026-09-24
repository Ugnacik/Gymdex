import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_REST_DURATION_SECONDS, RestTimer } from "../static/rest-timer.mjs";

function fixture(durationSeconds = 3) {
  let now = 100_000;
  let nextId = 0;
  const scheduled = new Map();
  const changes = [];
  const timer = new RestTimer({
    durationSeconds,
    now: () => now,
    schedule: (callback, delay) => {
      const id = ++nextId;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clear: (id) => scheduled.delete(id),
    onChange: (snapshot) => changes.push(snapshot),
  });
  return {
    timer, scheduled, changes,
    advance(ms) { now += ms; },
    tick() {
      const [id, task] = scheduled.entries().next().value;
      scheduled.delete(id);
      task.callback();
    },
  };
}

test("defaults to a 90 second rest interval", () => {
  const timer = new RestTimer();
  assert.equal(DEFAULT_REST_DURATION_SECONDS, 90);
  assert.deepEqual(timer.snapshot(), {
    status: "idle", durationSeconds: 90, remainingSeconds: 0,
  });
});

test("start and ticks use a wall-clock deadline", () => {
  const clock = fixture();
  clock.timer.start();
  assert.deepEqual(clock.changes.at(-1), {
    status: "running", durationSeconds: 3, remainingSeconds: 3,
  });
  assert.equal(clock.scheduled.values().next().value.delay, 1000);
  clock.advance(1000);
  clock.tick();
  assert.equal(clock.changes.at(-1).remainingSeconds, 2);
  // A browser may suspend the next callback while its tab is hidden.
  clock.advance(5000);
  assert.equal(clock.timer.snapshot().status, "finished");
  clock.timer.refresh();
  assert.deepEqual(clock.changes.at(-1), {
    status: "finished", durationSeconds: 3, remainingSeconds: 0,
  });
  assert.equal(clock.scheduled.size, 0);
});

test("pause and resume preserve the remaining interval", () => {
  const clock = fixture(5);
  clock.timer.start();
  clock.advance(1250);
  clock.timer.pause();
  assert.equal(clock.changes.at(-1).status, "paused");
  assert.equal(clock.changes.at(-1).remainingSeconds, 4);
  assert.equal(clock.scheduled.size, 0);
  clock.advance(60_000);
  assert.equal(clock.timer.snapshot().remainingSeconds, 4);
  clock.timer.resume();
  assert.equal(clock.changes.at(-1).status, "running");
  clock.advance(3750);
  clock.timer.refresh();
  assert.equal(clock.changes.at(-1).status, "finished");
});

test("new completed sets restart the timer and stop clears it", () => {
  const clock = fixture(4);
  clock.timer.start();
  clock.advance(2500);
  clock.timer.start();
  assert.equal(clock.timer.snapshot().remainingSeconds, 4);
  assert.equal(clock.scheduled.size, 1);
  clock.timer.stop();
  assert.deepEqual(clock.changes.at(-1), {
    status: "idle", durationSeconds: 4, remainingSeconds: 0,
  });
  assert.equal(clock.scheduled.size, 0);
});

test("duration changes apply to the next interval and reject invalid settings", () => {
  const clock = fixture(5);
  clock.timer.start();
  clock.advance(1000);
  clock.timer.setDuration(120);
  assert.equal(clock.timer.snapshot().remainingSeconds, 4);
  clock.timer.start();
  assert.equal(clock.timer.snapshot().remainingSeconds, 120);
  for (const value of [0, 1.5, 3601, NaN, "90"]) {
    assert.throws(() => clock.timer.setDuration(value), RangeError);
  }
  assert.equal(clock.timer.snapshot().durationSeconds, 120);
});
