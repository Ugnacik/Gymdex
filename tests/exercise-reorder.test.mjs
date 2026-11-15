import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindReorderNameHold, openExerciseReorder } from '../static/exercise-reorder.mjs';

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
  const dispose = bindReorderNameHold(host, document, origin => opened.push(origin), {
    schedule(callback) { timers.set(++timerId, callback); return timerId; }, clear(id) { timers.delete(id); },
  });
  const fire = () => { const [id, callback] = [...timers][0]; timers.delete(id); callback(); };
  return { host, document, name, target, timers, opened, fire, dispose };
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

function reorderHarness(onMove = async () => true, { onRemove } = {}) {
  const list = element();
  list.children = [];
  list.scrollTop = 0;
  list.getBoundingClientRect = () => ({ top: -100, bottom: 1000 });
  let capture = null;
  list.setPointerCapture = id => { capture = id; };
  list.hasPointerCapture = id => capture === id;
  list.releasePointerCapture = () => { capture = null; list.events.lostpointercapture?.(); };
  const createRow = (id, index, count) => {
    const row = Object.assign(element(), { dataset: { reorderId: String(id) } });
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
      if (selector.includes('"-1"')) return !up.disabled ? up : null;
      if (selector.includes('"1"')) return !down.disabled ? down : null;
      if (selector === '[data-reorder-step]:not(:disabled)') return !up.disabled ? up : !down.disabled ? down : null;
      return null;
    };
    row.getBoundingClientRect = () => ({ y: list.children.indexOf(row) * 60, height: 60 });
    return Object.assign(row, { up, down, handle, surface, remove, name });
  };
  Object.defineProperty(list, 'innerHTML', { set(html) {
    const ids = [...html.matchAll(/data-reorder-id="(\d+)"/g)].map(match => Number(match[1]));
    list.children = ids.map((id, index) => createRow(id, index, ids.length));
  } });
  list.append = (...rows) => { list.children = rows; };
  list.querySelector = selector => list.children.find(row => row.dataset.reorderId === selector.match(/"(\d+)"/)?.[1]);
  const status = element(), close = element(), dialog = element();
  dialog.querySelector = selector => ({ '#reorder-list': list, '#reorder-status': status, '#close-reorder': close })[selector];
  dialog.showModal = () => { dialog.open = true; };
  dialog.remove = () => { dialog.removed = true; };
  dialog.close = () => { dialog.open = false; dialog.events.close(); };
  const document = { querySelector: () => null, createElement: () => dialog, body: { append() {} } };
  let closed = false;
  openExerciseReorder(document, { items: [{ id: 1, name: 'Bench' }, { id: 2, name: 'Plank' }, { id: 3, name: 'Dip' }],
    onMove, onRemove, onClose: () => { closed = true; }, escapeHtml: text => text });
  const ids = () => list.children.map(row => Number(row.dataset.reorderId));
  const start = () => list.events.pointerdown(pointer(list.children[0].handle));
  const moveToEnd = () => list.events.pointermove(pointer(list, { clientY: 180 }));
  return { list, status, close, dialog, ids, start, moveToEnd, get closed() { return closed; } };
}

test('a handle drag previews its position and cancellation restores the acknowledged order', () => {
  const calls = [];
  const h = reorderHarness((...args) => calls.push(args));
  h.start();
  h.moveToEnd();
  assert.deepEqual(h.ids(), [2, 3, 1]);
  h.list.events.pointercancel();
  assert.deepEqual(h.ids(), [1, 2, 3]);
  h.start(); h.moveToEnd(); h.list.events.lostpointercapture();
  assert.deepEqual(h.ids(), [1, 2, 3]);
  assert.deepEqual(calls, []);
  h.start(); h.moveToEnd(); h.close.events.click();
  assert.equal(h.closed, true);
  assert.deepEqual(h.ids(), [1, 2, 3]);
});

test('dropping saves one move, gates interaction until acknowledgement, and arrows can reverse it', async () => {
  let resolve;
  const calls = [];
  let save = new Promise(done => { resolve = done; });
  const h = reorderHarness((...args) => { calls.push(args); return save; });
  h.start(); h.moveToEnd();
  const pending = h.list.events.pointerup(pointer(h.list));
  assert.deepEqual(calls, [[1, 2]]);
  assert.equal(h.list.inert, true);
  assert.equal(h.close.disabled, true);
  const escape = pointer(h.dialog);
  h.dialog.events.cancel(escape);
  assert.equal(escape.prevented, true);
  resolve(true); await pending;
  assert.deepEqual(h.ids(), [2, 3, 1]);
  assert.equal(h.list.inert, false);
  assert.match(h.status.textContent, /Bench moved to position 3/);
  save = Promise.resolve(true);
  await h.list.events.click(pointer(h.list.children[2].up));
  assert.deepEqual(calls, [[1, 2], [1, 1]]);
  assert.deepEqual(h.ids(), [2, 1, 3]);
  assert.equal(h.list.children[1].up.focused, true);
});

test('a failed move restores the visible order and explains the failure without closing', async () => {
  const h = reorderHarness(async () => { throw new Error('Cannot reach the server.'); });
  h.start(); h.moveToEnd();
  await h.list.events.pointerup(pointer(h.list));
  assert.deepEqual(h.ids(), [1, 2, 3]);
  assert.equal(h.dialog.open, true);
  assert.match(h.status.textContent, /Order unchanged.*Cannot reach the server/);
  assert.equal(h.status.classList.contains('error'), true);
  assert.equal(h.list.inert, false);
});

test('dragging only starts on a handle, so the name and list retain ordinary scrolling', () => {
  const h = reorderHarness();
  h.list.events.pointerdown(pointer({ closest: () => null }));
  h.moveToEnd();
  assert.deepEqual(h.ids(), [1, 2, 3]);
});


test('moving a held handle near a list edge scrolls to further destinations and stops on cancellation', () => {
  const h = reorderHarness();
  h.list.getBoundingClientRect = () => ({ top: 0, bottom: 120 });
  h.start();
  h.list.events.pointermove(pointer(h.list, { clientY: 110 }));
  assert.equal(h.list.scrollTop, 24);
  h.list.events.pointermove(pointer(h.list, { clientY: 110 }));
  assert.equal(h.list.scrollTop, 48);
  h.list.events.pointercancel();
  h.list.events.pointermove(pointer(h.list, { clientY: 110 }));
  assert.equal(h.list.scrollTop, 48);
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
