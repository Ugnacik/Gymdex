import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindReorderNameHold, edgeSpeed, gapShift, openExerciseReorder, settleOffset, targetIndex } from '../static/exercise-reorder.mjs';

function element() {
  const events = {};
  const classes = new Set();
  return { events, isConnected: true, disabled: false, inert: false,
    addEventListener(type, callback) { events[type] = callback; },
    removeEventListener(type) { delete events[type]; },
    setAttribute() {}, focus() { this.focused = true; },
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, force) {
        const on = force === undefined ? !classes.has(value) : Boolean(force);
        if (on) classes.add(value); else classes.delete(value);
        return on;
      },
    },
  };
}
const pointer = (target, overrides = {}) => ({ target, button: 0, pointerId: 1, isPrimary: true, clientX: 10, clientY: 10,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides });
function holdHarness() {
  const host = element();
  const document = element();
  const name = { isConnected: true };
  const target = { closest: () => name };
  const timers = new Map();
  const opened = [];
  let timerId = 0;
  const pointers = [];
  const dispose = bindReorderNameHold(host, document, (origin, held) => { opened.push(origin); pointers.push(held); }, {
    schedule(callback) { timers.set(++timerId, callback); return timerId; }, clear(id) { timers.delete(id); },
  });
  const fire = () => { const [id, callback] = [...timers][0]; timers.delete(id); callback(); };
  return { host, document, name, target, timers, opened, pointers, fire, dispose };
}

test('a normal name tap remains available; a held name opens the order list without a collapse click', () => {
  const h = holdHarness();
  h.host.events.pointerdown(pointer(h.target));
  h.host.events.pointerup(pointer(h.target));
  const tap = pointer(h.target);
  h.host.events.click(tap);
  assert.equal(tap.prevented, undefined);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.opened, []);
  h.host.events.pointerdown(pointer(h.target));
  h.fire();
  assert.deepEqual(h.opened, [h.name]);
  const click = pointer(h.target);
  h.host.events.click(click);
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  h.dispose();
  assert.equal(h.timers.size, 0);
});

test('moving, scrolling and cancelling a held name never open the reorder list', () => {
  for (const cancel of [h => h.host.events.pointermove(pointer(h.target, { clientY: 30 })),
    h => h.document.events.scroll(), h => h.host.events.pointercancel(), h => h.host.events.lostpointercapture()]) {
    const h = holdHarness();
    h.host.events.pointerdown(pointer(h.target));
    cancel(h);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.opened, []);
    h.dispose();
  }
  const h = holdHarness();
  h.name.isConnected = false;
  h.host.events.pointerdown(pointer(h.target));
  h.fire();
  assert.deepEqual(h.opened, []);
});

test('a held name hands its still-pressed pointer to the list, and touch scrolling is only blocked while lifted', () => {
  const h = holdHarness();
  h.host.events.pointerdown(pointer(h.target, { pointerId: 4, clientX: 10, clientY: 10 }));
  h.host.events.pointermove(pointer(h.target, { pointerId: 4, clientX: 13, clientY: 14 }));
  h.fire();
  assert.deepEqual(h.pointers, [{ pointerId: 4, clientX: 13, clientY: 14 }]);
  const touch = { cancelable: true, preventDefault() { this.prevented = true; } };
  h.host.events.touchmove(touch);
  assert.equal(touch.prevented, undefined, 'ordinary scrolling is untouched');
  const r = reorderHarness();
  r.start(0, 30);
  h.host.events.touchmove(touch);
  assert.equal(touch.prevented, true, 'no page scroll under a lifted row (iOS Safari)');
  r.list.events.pointercancel();
  h.dispose();
});

function reorderHarness(onMove = async () => true, { onRemove, lift = null, reducedMotion = false, items } = {}) {
  const list = element();
  list.children = [];
  list.scrollTop = 0;
  list.box = { top: 0, bottom: 1000 };
  list.getBoundingClientRect = () => list.box;
  let capture = null;
  list.setPointerCapture = id => { capture = id; };
  list.hasPointerCapture = id => capture === id;
  list.releasePointerCapture = () => { capture = null; };
  const createRow = (id, index, count) => {
    const row = Object.assign(element(), { dataset: { reorderId: String(id) }, style: {} });
    const up = Object.assign(element(), { dataset: { reorderStep: '-1' }, disabled: index === 0 });
    const down = Object.assign(element(), { dataset: { reorderStep: '1' }, disabled: index === count - 1 });
    const handle = element();
    const surface = Object.assign(element(), { style: {} });
    const remove = Object.assign(element(), { dataset: { reorderRemove: '' } });
    const name = element();
    handle.closest = selector => selector === '.reorder-handle' ? handle
      : selector === 'button' ? handle
        : selector === '[data-reorder-id]' ? row : null;
    for (const button of [up, down]) button.closest = selector => selector === '[data-reorder-step]' ? button
      : selector === 'button' ? button
        : selector === '[data-reorder-id]' ? row : null;
    remove.closest = selector => selector === '[data-reorder-remove]' ? remove
      : selector === 'button' ? remove
        : selector === '[data-reorder-id]' ? row : null;
    name.closest = selector => selector === '.reorder-handle' || selector === 'button' || selector === '[data-reorder-remove]' ? null
      : selector === '[data-reorder-id]' ? row : null;
    row.closest = selector => selector === '[data-reorder-id]' ? row : null;
    row.querySelector = selector => {
      if (selector === '.reorder-swipe') return surface;
      if (selector === '.reorder-handle') return handle;
      if (selector.includes('"-1"')) return !up.disabled ? up : null;
      if (selector.includes('"1"')) return !down.disabled ? down : null;
      if (selector === '[data-reorder-step]:not(:disabled)') return !up.disabled ? up : !down.disabled ? down : null;
      return null;
    };
    // Layout follows the DOM order: 60px rows, moved by the list's scroll.
    row.getBoundingClientRect = () => ({ top: list.box.top + list.children.indexOf(row) * 60 - list.scrollTop, height: 60 });
    return Object.assign(row, { up, down, handle, surface, remove, name });
  };
  Object.defineProperty(list, 'innerHTML', { set(html) {
    const ids = [...html.matchAll(/data-reorder-id="(\d+)"/g)].map(match => Number(match[1]));
    list.children = ids.map((id, index) => createRow(id, index, ids.length));
  } });
  list.querySelector = selector => list.children.find(row => row.dataset.reorderId === selector.match(/"(\d+)"/)?.[1]);
  const status = element(), close = element(), dialog = element();
  dialog.querySelector = selector => ({ '#reorder-list': list, '#reorder-status': status, '#close-reorder': close })[selector];
  dialog.showModal = () => { dialog.open = true; };
  dialog.remove = () => { dialog.removed = true; };
  dialog.close = () => { dialog.open = false; dialog.events.close(); };
  const document = { querySelector: () => null, createElement: () => dialog, body: { append() {} } };
  const timers = new Map();
  const frames = new Map();
  const buzzes = [];
  let next = 0;
  let closed = false;
  openExerciseReorder(document, { items: items ?? [{ id: 1, name: 'Bench' }, { id: 2, name: 'Plank' }, { id: 3, name: 'Dip' }],
    onMove, onRemove, onClose: () => { closed = true; }, escapeHtml: text => text, lift, reducedMotion,
    schedule: (callback, delay) => { timers.set(++next, { callback, delay }); return next; }, clear: id => timers.delete(id),
    frame: callback => { frames.set(++next, callback); return next; }, cancelFrame: id => frames.delete(id),
    vibrate: ms => buzzes.push(ms) });
  const ids = () => list.children.map(row => Number(row.dataset.reorderId));
  const runTimers = () => { for (const [id, { callback }] of [...timers]) { timers.delete(id); callback(); } };
  const runFrame = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  const start = (index = 0, y = 30) => list.events.pointerdown(pointer(list.children[index].handle, { clientY: y }));
  const moveTo = (y) => list.events.pointermove(pointer(list, { clientY: y }));
  const drop = async () => { const settled = list.events.pointerup(pointer(list)); runTimers(); await settled?.finish?.(); await Promise.resolve(); };
  const transforms = () => list.children.map(row => row.style.transform || '');
  return { list, status, close, dialog, ids, start, moveTo, drop, timers, frames, buzzes, runTimers, runFrame, transforms,
    get capture() { return capture; }, get closed() { return closed; } };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

test('the drop position follows the lifted row past each neighbour\'s middle, with a gap and settle offset', () => {
  const slots = [0, 60, 120, 180].map(top => ({ top, height: 56 }));
  assert.equal(targetIndex(slots, 0, 28), 0);
  assert.equal(targetIndex(slots, 0, 87), 0);
  assert.equal(targetIndex(slots, 0, 89), 1);
  assert.equal(targetIndex(slots, 0, 500), 3);
  assert.equal(targetIndex(slots, 3, -40), 0);
  assert.deepEqual([0, 1, 2, 3].map(index => gapShift(index, 0, 2, 60)), [0, -60, -60, 0]);
  assert.deepEqual([0, 1, 2, 3].map(index => gapShift(index, 3, 1, 60)), [0, 60, 60, 0]);
  assert.equal(settleOffset(slots, 0, 2), 120);
  assert.equal(settleOffset(slots, 3, 1), -120);
  assert.equal(edgeSpeed(500, 0, 1000), 0);
  assert.ok(edgeSpeed(990, 0, 1000) > edgeSpeed(960, 0, 1000) && edgeSpeed(960, 0, 1000) > 0);
  assert.equal(edgeSpeed(1000, 0, 1000), 16);
  assert.ok(edgeSpeed(5, 0, 1000) < 0);
});

test('a handle lifts its row: it follows the finger, the others slide apart, and nothing saves until the drop', async () => {
  const calls = [];
  const h = reorderHarness(async (...args) => { calls.push(args); return true; });
  h.start(0, 30);
  const [bench] = h.list.children;
  assert.equal(bench.classList.contains('is-lifted'), true);
  assert.equal(h.list.classList.contains('is-reordering'), true);
  assert.deepEqual(h.buzzes, [8], 'a short buzz where vibration exists (Android)');
  h.moveTo(160);
  assert.deepEqual(h.transforms(), ['translateY(120px)', 'translateY(-60px)', 'translateY(-60px)'], 'past the end it stays in the last place');
  assert.deepEqual(h.ids(), [1, 2, 3], 'the DOM stays put while dragging; only transforms move');
  assert.match(h.status.textContent, /Bench: position 3 of 3/);
  h.moveTo(100);
  assert.deepEqual(h.transforms(), ['translateY(70px)', 'translateY(-60px)', '']);
  h.moveTo(160);
  assert.deepEqual(calls, [], 'no save per step');
  h.list.events.pointerup(pointer(h.list));
  assert.equal(bench.classList.contains('is-settling'), true);
  assert.equal(bench.style.transform, 'translateY(120px)', 'it settles into the gap');
  assert.equal([...h.timers.values()][0].delay, 200);
  h.runTimers();
  await flush();
  assert.deepEqual(calls, [[1, 2]], 'one save per drop');
  assert.deepEqual(h.ids(), [2, 3, 1]);
  assert.deepEqual(h.transforms(), ['', '', '']);
  assert.match(h.status.textContent, /Bench moved to position 3/);
  assert.equal(h.list.children[2].handle.focused, true);
  assert.equal(h.frames.size, 0, 'auto-scroll stops after the drop');
});

test('a drop back where it started saves nothing, and cancel or Escape puts every row back', async () => {
  const calls = [];
  const h = reorderHarness(async (...args) => { calls.push(args); return true; });
  h.start(1, 90); h.moveTo(100);
  h.list.events.pointerup(pointer(h.list)); h.runTimers(); await flush();
  assert.match(h.status.textContent, /Plank stayed at position 2/);
  h.start(0, 30); h.moveTo(160);
  h.list.events.pointercancel();
  assert.deepEqual(h.transforms(), ['', '', '']);
  assert.equal(h.list.children[0].classList.contains('is-lifted'), false);
  h.start(0, 30); h.moveTo(160);
  const escape = pointer(h.dialog);
  h.dialog.events.cancel(escape);
  assert.equal(escape.prevented, true, 'Escape during a drag does not close the sheet');
  assert.equal(h.dialog.open, true);
  assert.deepEqual(h.transforms(), ['', '', '']);
  assert.match(h.status.textContent, /Order unchanged/);
  h.start(0, 30); h.moveTo(160); h.close.events.click();
  assert.equal(h.closed, true);
  assert.deepEqual(calls, []);
});

test('held near an edge the list keeps scrolling each frame, without the finger moving, and the gap follows', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: `E${index + 1}` }));
  const h = reorderHarness(async () => true, { items });
  h.list.box = { top: 0, bottom: 240 };
  h.start(0, 30);
  h.moveTo(235);
  const before = h.list.scrollTop;
  h.runFrame(); h.runFrame(); h.runFrame();
  assert.ok(h.list.scrollTop > before + 20, 'it scrolled while held still');
  const lifted = Number(h.list.children[0].style.transform.match(/-?\d+/)[0]);
  assert.equal(lifted, 235 - 30 + h.list.scrollTop, 'the lifted row stays under the finger as the list scrolls');
  h.list.events.pointercancel();
  const stopped = h.list.scrollTop;
  h.runFrame();
  assert.equal(h.list.scrollTop, stopped);
  assert.equal(h.frames.size, 0);
});

test('the list shows a move at once; a failed save puts the order back and explains, without closing', async () => {
  let fail;
  const h = reorderHarness(() => new Promise((_, reject) => { fail = reject; }));
  h.start(0, 30); h.moveTo(160);
  h.list.events.pointerup(pointer(h.list)); h.runTimers();
  assert.deepEqual(h.ids(), [2, 3, 1], 'shown in its new place while saving');
  assert.equal(h.list.inert, true);
  assert.equal(h.close.disabled, true);
  const escape = pointer(h.dialog);
  h.dialog.events.cancel(escape);
  assert.equal(escape.prevented, true);
  fail(new Error('Cannot reach the server.'));
  await flush();
  assert.deepEqual(h.ids(), [1, 2, 3]);
  assert.equal(h.dialog.open, true);
  assert.match(h.status.textContent, /Order unchanged.*Cannot reach the server/);
  assert.equal(h.status.classList.contains('error'), true);
  assert.equal(h.list.inert, false);
});

test('keyboards and screen readers move with Move up / Move down or arrow keys on the handle, one save each', async () => {
  const calls = [];
  const h = reorderHarness(async (...args) => { calls.push(args); return true; });
  await h.list.events.click(pointer(h.list.children[2].up));
  assert.deepEqual(h.ids(), [1, 3, 2]);
  assert.equal(h.list.children[1].up.focused, true, 'focus stays on the same direction');
  const key = { key: 'ArrowUp', target: h.list.children[1].handle, preventDefault() { this.prevented = true; } };
  await h.list.events.keydown(key);
  assert.equal(key.prevented, true);
  assert.deepEqual(h.ids(), [3, 1, 2]);
  assert.equal(h.list.children[0].handle.focused, true);
  await h.list.events.keydown({ key: 'ArrowUp', target: h.list.children[0].handle, preventDefault() {} });
  assert.deepEqual(calls, [[3, 1], [3, 0]], 'nothing above the top');
});

test('holding a row lifts it like the handle; moving first scrolls instead', async () => {
  const calls = [];
  const h = reorderHarness(async (...args) => { calls.push(args); return true; });
  const row = h.list.children[2];
  h.list.events.pointerdown(pointer(row.name, { clientX: 100, clientY: 150 }));
  h.list.events.pointermove(pointer(row.name, { clientX: 101, clientY: 152 }));
  assert.equal([...h.timers.values()][0].delay, 320);
  h.runTimers();
  assert.equal(row.classList.contains('is-lifted'), true);
  h.moveTo(20);
  await h.drop();
  await flush();
  assert.deepEqual(calls, [[3, 0]]);
  assert.deepEqual(h.ids(), [3, 1, 2]);
  const second = h.list.children[1];
  h.list.events.pointerdown(pointer(second.name, { clientX: 100, clientY: 90 }));
  h.list.events.pointermove(pointer(second.name, { clientX: 100, clientY: 130 }));
  h.runTimers();
  assert.equal(second.classList.contains('is-lifted'), false, 'a vertical move is a scroll');
});

test('a held exercise name opens the list with that exercise already lifted under the same finger', async () => {
  const calls = [];
  const h = reorderHarness(async (...args) => { calls.push(args); return true; }, { lift: { id: 2, pointerId: 7, clientX: 50, clientY: 400 } });
  assert.equal(h.list.children[1].classList.contains('is-lifted'), true);
  assert.equal(h.capture, 7);
  h.list.events.pointermove(pointer(h.list, { pointerId: 7, clientY: 330 }));
  h.list.events.pointerup(pointer(h.list, { pointerId: 7 }));
  h.runTimers();
  await flush();
  assert.deepEqual(calls, [[2, 0]]);
  // Reduced motion: no settle animation.
  const calm = reorderHarness(async () => true, { reducedMotion: true });
  calm.start(0, 30); calm.moveTo(160);
  calm.list.events.pointerup(pointer(calm.list));
  assert.equal(calm.timers.size, 0);
  await flush();
  assert.deepEqual(calm.ids(), [2, 3, 1]);
});

test('a left swipe past the threshold asks to remove and keeps the row when declined', async () => {
  const removals = [];
  const h = reorderHarness(async () => true, {
    onRemove: async (id) => { removals.push(id); return false; },
  });
  const row = h.list.children[0];
  h.list.events.pointerdown(pointer(row.name, { clientX: 200, clientY: 20 }));
  h.list.events.pointermove(pointer(row.name, { clientX: 120, clientY: 22 }));
  assert.equal(row.classList.contains('is-revealed'), true);
  assert.match(row.surface.style.transform, /translateX\(-80px\)/);
  await h.list.events.pointerup(pointer(row.name, { clientX: 120, clientY: 22 }));
  assert.deepEqual(removals, [1]);
  assert.deepEqual(h.ids(), [1, 2, 3]);
  assert.match(h.status.textContent, /Bench kept/);
  assert.equal(row.classList.contains('is-swiping'), false);
});

test('a confirmed swipe remove drops the exercise and closes once fewer than two remain', async () => {
  const removals = [];
  const h = reorderHarness(async () => true, {
    onRemove: async (id) => { removals.push(id); return true; },
  });
  const first = h.list.children[0];
  h.list.events.pointerdown(pointer(first.name, { clientX: 180, clientY: 10 }));
  h.list.events.pointermove(pointer(first.name, { clientX: 90, clientY: 12 }));
  await h.list.events.pointerup(pointer(first.name, { clientX: 90, clientY: 12 }));
  assert.deepEqual(removals, [1]);
  assert.deepEqual(h.ids(), [2, 3]);
  assert.match(h.status.textContent, /Bench removed/);
  const second = h.list.children[0];
  h.list.events.pointerdown(pointer(second.name, { clientX: 180, clientY: 10 }));
  h.list.events.pointermove(pointer(second.name, { clientX: 90, clientY: 10 }));
  await h.list.events.pointerup(pointer(second.name, { clientX: 90, clientY: 10 }));
  assert.deepEqual(removals, [1, 2]);
  assert.equal(h.closed, true);
});

test('a short or vertical swipe never removes an exercise', async () => {
  const removals = [];
  const h = reorderHarness(async () => true, {
    onRemove: async (id) => { removals.push(id); return true; },
  });
  const row = h.list.children[1];
  h.list.events.pointerdown(pointer(row.name, { clientX: 160, clientY: 40 }));
  h.list.events.pointermove(pointer(row.name, { clientX: 140, clientY: 42 }));
  await h.list.events.pointerup(pointer(row.name, { clientX: 140, clientY: 42 }));
  assert.deepEqual(removals, []);
  assert.deepEqual(h.ids(), [1, 2, 3]);
  h.list.events.pointerdown(pointer(row.name, { clientX: 160, clientY: 40 }));
  h.list.events.pointermove(pointer(row.name, { clientX: 158, clientY: 90 }));
  await h.list.events.pointerup(pointer(row.name, { clientX: 158, clientY: 90 }));
  assert.deepEqual(removals, []);
  assert.deepEqual(h.ids(), [1, 2, 3]);
});

test('Removing shows only once the removal is confirmed, and focus stays in the sheet on the next row', async () => {
  let answer;
  const seen = [];
  const h = reorderHarness(async () => true, {
    onRemove: async (id, removing) => {
      seen.push(h.status.textContent);
      if (!await new Promise((done) => { answer = done; })) return false;
      removing();
      seen.push(h.status.textContent);
      return true;
    },
  });
  const swipeRemove = async (row) => {
    h.list.events.pointerdown(pointer(row.name, { clientX: 180, clientY: 10 }));
    h.list.events.pointermove(pointer(row.name, { clientX: 90, clientY: 12 }));
    return h.list.events.pointerup(pointer(row.name, { clientX: 90, clientY: 12 }));
  };
  // Declined: no Removing message, and focus returns to the kept row.
  let pending = swipeRemove(h.list.children[1]);
  answer(false); await pending;
  assert.deepEqual(seen, ['']);
  assert.match(h.status.textContent, /Plank kept/);
  assert.equal(h.list.children[1].up.focused, true);
  // Confirmed: Removing appears after the yes, and focus moves to the row that took its place.
  seen.length = 0;
  pending = swipeRemove(h.list.children[1]);
  answer(true); await pending;
  assert.deepEqual(seen, ['', 'Removing Plank…']);
  assert.deepEqual(h.ids(), [1, 3]);
  assert.equal(h.list.children[1].up.focused, true, 'Dip, now in that place, has focus');
  assert.equal(h.dialog.open, true);
});
