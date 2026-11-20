// Reordering exercises, modelled on Strong: hold an exercise name and the workout (or routine)
// collapses to a compact list of names, with the held exercise already lifted under your finger;
// drag it and the others slide apart to open a gap where it will land; let go and it settles
// into the gap. The order is saved once per drop. Handles start a drag at once, and the list
// scrolls by itself while the lifted row is held near its top or bottom edge.
//
// Keyboard and screen readers: every row has Move up / Move down buttons (shown when focused),
// and Arrow Up / Arrow Down on a focused handle move the exercise. Each such move saves once.

// The finger currently owns a drag; touchmove is cancelled so the page and list never scroll under it.
let dragging = false;
const blockTouch = (event) => { if (dragging && event.cancelable) event.preventDefault(); };

const HOLD_MS = 450;
const ROW_HOLD_MS = 320;
const SLOP = 8;

// Holding a name opens the compact order list; ordinary taps and scrolling keep their usual
// behavior. Pointer movement, cancellation and scrolling abandon a hold. open(name, pointer)
// receives the still-pressed pointer so the list can lift that exercise under the same finger.
export function bindReorderNameHold(host, document, open, { schedule = setTimeout, clear = clearTimeout } = {}) {
  let hold = null;
  let timer = null;
  let suppress = null;
  let suppressionTimer = null;
  const cancel = () => { clear(timer); timer = null; hold = null; };
  const handlers = {
    pointerdown(event) {
      cancel();
      const name = event.target.closest?.('[data-reorder-name]');
      if (!name || event.button !== 0 || event.isPrimary === false) return;
      hold = { name, id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY };
      timer = schedule(() => {
        const pressed = hold;
        cancel();
        if (!pressed?.name?.isConnected) return;
        suppress = pressed.name;
        clear(suppressionTimer);
        suppressionTimer = schedule(() => { suppress = null; }, 1000);
        open(pressed.name, { pointerId: pressed.id, clientX: pressed.lastX, clientY: pressed.lastY });
      }, HOLD_MS);
    },
    pointermove(event) {
      if (hold?.id !== event.pointerId) return;
      hold.lastX = event.clientX;
      hold.lastY = event.clientY;
      if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > SLOP) cancel();
    },
    pointerup: cancel,
    pointercancel: cancel,
    lostpointercapture: cancel,
    click(event) {
      if (suppress && event.target.closest?.('[data-reorder-name]') === suppress) {
        event.preventDefault();
        event.stopPropagation();
        suppress = null;
      }
    },
    contextmenu(event) {
      if (event.target.closest?.('[data-reorder-name]')) event.preventDefault();
    },
  };
  for (const [type, handler] of Object.entries(handlers)) host.addEventListener(type, handler, true);
  // Registered up front and not passive, so iOS Safari lets a lifted drag cancel scrolling.
  host.addEventListener('touchmove', blockTouch, { passive: false });
  document.addEventListener('scroll', cancel, true);
  return () => {
    cancel();
    clear(suppressionTimer);
    for (const [type, handler] of Object.entries(handlers)) host.removeEventListener?.(type, handler, true);
    host.removeEventListener?.('touchmove', blockTouch, { passive: false });
    document.removeEventListener?.('scroll', cancel, true);
  };
}

// Auto-scroll speed (px per frame) for a pointer at y in a list spanning top..bottom: zero in
// the middle, growing to MAX_SPEED at the very edge.
export const EDGE = 56;
export const MAX_SPEED = 16;
export function edgeSpeed(y, top, bottom) {
  const zone = Math.min(EDGE, (bottom - top) / 3);
  if (y < top + zone) return -Math.ceil(MAX_SPEED * Math.min(1, (top + zone - y) / zone));
  if (y > bottom - zone) return Math.ceil(MAX_SPEED * Math.min(1, (y - (bottom - zone)) / zone));
  return 0;
}

// Where the lifted row (originally at index from) lands when its centre is at `center`: it
// passes another row once it crosses that row's middle. slots are the rows' {top, height} in
// list content coordinates, measured once at lift.
export function targetIndex(slots, from, center) {
  let to = from;
  for (let index = from - 1; index >= 0 && center < slots[index].top + slots[index].height / 2; index -= 1) to = index;
  for (let index = from + 1; index < slots.length && center > slots[index].top + slots[index].height / 2; index += 1) to = index;
  return to;
}

// How far the other rows slide to open the gap, and where the lifted row settles.
export function gapShift(index, from, to, span) {
  if (from < to && index > from && index <= to) return -span;
  if (to < from && index >= to && index < from) return span;
  return 0;
}
export function settleOffset(slots, from, to) {
  if (to > from) return slots[to].top + slots[to].height - (slots[from].top + slots[from].height);
  return slots[to].top - slots[from].top;
}

const SWIPE_REMOVE_DISTANCE = 72;

// onMove(id, zeroBasedPosition) owns persistence and is called once per drop or arrow move;
// the list shows the new order at once and goes back if onMove fails, so Workouts (saved on
// the phone first) and Routines (saved to the server) share it. Optional onRemove(id, removing)
// confirms and removes; a left swipe past the threshold asks first. lift: {id, pointerId,
// clientX, clientY} lifts that row under a pointer that is still down (a held name).
export function openExerciseReorder(document, { items, onMove, onRemove, onClose, escapeHtml, lift = null,
  schedule = setTimeout, clear = clearTimeout, frame = null, cancelFrame = null, vibrate = null, reducedMotion = null }) {
  if (document.querySelector('#exercise-reorder')) return;
  const view = document.defaultView;
  const nextFrame = frame ?? (view?.requestAnimationFrame ? (callback) => view.requestAnimationFrame(callback) : (callback) => schedule(callback, 16));
  const stopFrame = cancelFrame ?? (view?.cancelAnimationFrame ? (id) => view.cancelAnimationFrame(id) : clear);
  const buzz = vibrate ?? ((ms) => { try { view?.navigator?.vibrate?.(ms); } catch { /* Not supported (iOS Safari). */ } });
  const calm = () => reducedMotion ?? Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const dialog = document.createElement('dialog');
  dialog.id = 'exercise-reorder';
  dialog.className = 'history-dialog reorder-dialog';
  dialog.setAttribute('aria-labelledby', 'reorder-title');
  const canRemove = typeof onRemove === 'function';
  dialog.innerHTML = `<div class="sheet-header"><h2 id="reorder-title">Reorder exercises</h2><button type="button" class="text-button" id="close-reorder" autofocus>Done</button></div>
    <p class="muted reorder-hint">Hold a name or drag ≡ to move it. Each drop saves.${canRemove ? ' Swipe left to remove.' : ''}<span class="visually-hidden"> With a keyboard or screen reader, use Move up and Move down${canRemove ? ', and the Remove button,' : ''} on each exercise.</span></p>
    <ol class="reorder-list" id="reorder-list"></ol><p id="reorder-status" role="status"></p>`;
  document.body.append(dialog);
  const list = dialog.querySelector('#reorder-list');
  const status = dialog.querySelector('#reorder-status');
  const close = dialog.querySelector('#close-reorder');
  let order = [...items];
  let drag = null;
  let press = null;
  let settling = null;
  let busy = false;
  const rowId = (row) => Number(row.dataset.reorderId);
  const rows = () => [...(list.children ?? [])];
  const nameOf = (id) => order.find((item) => item.id === id)?.name ?? '';
  // focus: {id, target: 'up' | 'down' | 'handle'} or {index} (the row now at that position).
  function render(focus = null) {
    list.innerHTML = order.map((item, index) => `<li class="reorder-row" data-reorder-id="${item.id}">
      <div class="reorder-swipe">
        <div class="reorder-name"><strong>${escapeHtml(item.name)}</strong>${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}</div>
        <button type="button" class="text-button reorder-step" data-reorder-step="-1" aria-label="Move ${escapeHtml(item.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="text-button reorder-step" data-reorder-step="1" aria-label="Move ${escapeHtml(item.name)} down" ${index === order.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="reorder-handle text-button" aria-label="Reorder ${escapeHtml(item.name)}, position ${index + 1} of ${order.length}. Drag, or use the arrow keys" aria-keyshortcuts="ArrowUp ArrowDown"><span aria-hidden="true">≡</span></button>
      </div>
      ${canRemove ? `<button type="button" class="reorder-remove" data-reorder-remove aria-label="Remove ${escapeHtml(item.name)}">Remove</button>` : ''}
    </li>`).join('');
    if (!focus) return;
    let id = focus.id;
    if (focus.index !== undefined) id = order.length ? order[Math.min(focus.index, order.length - 1)].id : null;
    const row = id === null || id === undefined ? null : list.querySelector(`[data-reorder-id="${id}"]`);
    const wanted = focus.target === 'handle' ? row?.querySelector('.reorder-handle')
      : row?.querySelector(`[data-reorder-step="${focus.target === 'down' ? 1 : -1}"]:not(:disabled)`);
    (wanted || row?.querySelector('[data-reorder-step]:not(:disabled)') || close).focus();
  }

  // ---- Drag: the lifted row follows the pointer; the others slide to open a gap. ----
  function startDrag(row, pointer) {
    if (busy || drag || settling || !row) return false;
    const all = rows();
    const from = all.indexOf(row);
    if (from < 0) return false;
    try { list.setPointerCapture?.(pointer.pointerId); } catch { return false; }
    const box = list.getBoundingClientRect();
    const slots = all.map((item) => {
      const rect = item.getBoundingClientRect();
      return { top: rect.top - box.top + list.scrollTop, height: rect.height };
    });
    const gap = from + 1 < slots.length ? slots[from + 1].top - slots[from].top - slots[from].height
      : from > 0 ? slots[from].top - slots[from - 1].top - slots[from - 1].height : 0;
    drag = { row, all, from, to: from, slots, span: slots[from].height + Math.max(0, gap), pointerId: pointer.pointerId,
      startY: pointer.clientY, y: pointer.clientY, startScroll: list.scrollTop, loop: null };
    dragging = true;
    list.classList.add('is-reordering');
    row.classList.add('is-lifted');
    buzz(8);
    status.classList.remove('error');
    status.textContent = `${nameOf(rowId(row))} lifted. Position ${from + 1} of ${all.length}.`;
    follow();
    drag.loop = nextFrame(autoScroll);
    return true;
  }
  function follow() {
    // Kept within the list, so the lifted row never slides out of view past the first or last place.
    const first = drag.slots[0];
    const last = drag.slots.at(-1);
    const own = drag.slots[drag.from];
    const offset = drag.y - drag.startY + (list.scrollTop - drag.startScroll);
    const shown = Math.min(last.top + last.height - own.top - own.height, Math.max(first.top - own.top, offset));
    drag.row.style.transform = `translateY(${shown}px)`;
    const center = own.top + own.height / 2 + offset;
    const to = targetIndex(drag.slots, drag.from, center);
    if (to === drag.to) return;
    drag.to = to;
    drag.all.forEach((item, index) => {
      if (item === drag.row) return;
      const shift = gapShift(index, drag.from, to, drag.span);
      item.style.transform = shift ? `translateY(${shift}px)` : '';
    });
    buzz(4);
    status.textContent = `${nameOf(rowId(drag.row))}: position ${to + 1} of ${drag.all.length}.`;
  }
  // Keeps scrolling while the finger rests near an edge, not only while it moves.
  function autoScroll() {
    if (!drag) return;
    const box = list.getBoundingClientRect();
    const speed = edgeSpeed(drag.y, box.top, box.bottom);
    if (speed) {
      const before = list.scrollTop;
      // The browser clamps at the end of the list.
      list.scrollTop = Math.max(0, before + speed);
      if (list.scrollTop !== before) follow();
    }
    drag.loop = nextFrame(autoScroll);
  }
  function endDrag() {
    const active = drag;
    drag = null;
    dragging = false;
    if (active.loop !== null) stopFrame(active.loop);
    try { if (list.hasPointerCapture?.(active.pointerId)) list.releasePointerCapture(active.pointerId); } catch { /* Already released. */ }
    return active;
  }
  function clearStyles(active) {
    for (const item of active.all) item.style.transform = '';
    active.row.classList.remove('is-lifted', 'is-settling');
    list.classList.remove('is-reordering');
  }
  // Animates the lifted row into the gap, then saves the move once.
  function dropDrag() {
    if (!drag) return;
    const active = endDrag();
    const { from, to } = active;
    active.row.classList.add('is-settling');
    active.row.style.transform = `translateY(${settleOffset(active.slots, from, to)}px)`;
    const finish = () => {
      settling = null;
      clearStyles(active);
      const id = rowId(active.row);
      if (to === from) {
        status.textContent = `${nameOf(id)} stayed at position ${from + 1}.`;
        return render({ id, target: 'handle' });
      }
      return move(id, to, 'handle');
    };
    if (calm()) return finish();
    settling = { timer: schedule(() => settling?.finish(), 200), finish };
    return settling;
  }
  // Puts every row back where it was (cancel, Escape, a lost pointer).
  function cancelDrag() {
    if (!drag) return;
    const active = endDrag();
    clearStyles(active);
    status.textContent = 'Order unchanged.';
  }

  // ---- Rows: hold to lift, swipe left to remove, vertical movement scrolls. ----
  function resetSwipe(row) {
    const surface = row?.querySelector?.('.reorder-swipe');
    if (surface) surface.style.transform = '';
    row?.classList.remove('is-swiping', 'is-revealed');
  }
  function cancelPress() {
    if (!press) return;
    const active = press;
    press = null;
    clear(active.timer);
    resetSwipe(active.row);
    try { if (list.hasPointerCapture?.(active.pointerId)) list.releasePointerCapture(active.pointerId); } catch { /* Already released. */ }
  }

  async function move(id, to, focusTarget = null) {
    const from = order.findIndex((item) => item.id === id);
    if (busy || to === from || to < 0 || to >= order.length) return;
    const before = order;
    order = [...order];
    order.splice(to, 0, ...order.splice(from, 1));
    busy = true;
    close.disabled = true;
    list.inert = true;
    status.classList.remove('error');
    // Shown in its new place at once; the save follows.
    render();
    status.textContent = 'Saving order…';
    try {
      if (await onMove(id, to) === false) throw new Error('Could not save this move. Close and try again.');
      status.textContent = `${nameOf(id)} moved to position ${to + 1}.`;
    } catch (error) {
      order = before;
      status.classList.add('error');
      status.textContent = `Order unchanged. ${error.message}`;
    } finally {
      busy = false;
      close.disabled = false;
      list.inert = false;
      render(focusTarget ? { id, target: focusTarget } : null);
    }
  }
  async function remove(id) {
    const index = order.findIndex((item) => item.id === id);
    if (!canRemove || busy || index < 0) return;
    const item = order[index];
    busy = true;
    close.disabled = true;
    list.inert = true;
    status.classList.remove('error');
    status.textContent = '';
    try {
      // Says Removing only once the question is answered yes.
      if (await onRemove(id, () => { status.textContent = `Removing ${item.name}…`; }) === false) {
        status.textContent = `${item.name} kept.`;
        return;
      }
      order = order.filter((entry) => entry.id !== id);
      status.textContent = `${item.name} removed.`;
      if (order.length < 2) {
        dialog.close();
        return;
      }
    } catch (error) {
      status.classList.add('error');
      status.textContent = `Still in the list. ${error.message}`;
    } finally {
      busy = false;
      close.disabled = false;
      list.inert = false;
      if (dialog.open) render({ index });
    }
  }
  list.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-reorder-step]');
    if (button) {
      if (button.disabled || busy || drag || press || settling) return;
      const id = rowId(button.closest('[data-reorder-id]'));
      const direction = Number(button.dataset.reorderStep);
      return move(id, order.findIndex((item) => item.id === id) + direction, direction < 0 ? 'up' : 'down');
    }
    const removeButton = event.target.closest?.('[data-reorder-remove]');
    if (removeButton && !busy && !drag && !press && !settling) {
      return remove(rowId(removeButton.closest('[data-reorder-id]')));
    }
  });
  list.addEventListener('keydown', (event) => {
    const handle = event.target.closest?.('.reorder-handle');
    if (!handle || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || busy || drag) return;
    event.preventDefault();
    const id = rowId(handle.closest('[data-reorder-id]'));
    return move(id, order.findIndex((item) => item.id === id) + (event.key === 'ArrowUp' ? -1 : 1), 'handle');
  });
  list.addEventListener('pointerdown', (event) => {
    if (busy || drag || press || settling || event.button !== 0 || event.isPrimary === false) return;
    const handle = event.target.closest?.('.reorder-handle');
    if (handle) {
      event.preventDefault();
      startDrag(handle.closest('[data-reorder-id]'), event);
      return;
    }
    if (event.target.closest?.('button')) return;
    const row = event.target.closest?.('[data-reorder-id]');
    if (!row) return;
    press = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, dx: 0, axis: null, timer: null };
    // Held still: lift it, like holding a name on the workout.
    press.timer = schedule(() => {
      const held = press;
      if (!held || held.axis) return;
      press = null;
      resetSwipe(held.row);
      startDrag(held.row, { pointerId: held.pointerId, clientY: held.lastY });
    }, ROW_HOLD_MS);
    if (canRemove) {
      row.classList.add('is-swiping');
      try { list.setPointerCapture?.(event.pointerId); } catch { /* The press still works without capture. */ }
    }
  });
  list.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      drag.y = event.clientY;
      follow();
      return;
    }
    if (!press || event.pointerId !== press.pointerId) return;
    press.lastY = event.clientY;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.axis) {
      if (Math.hypot(dx, dy) < SLOP) return;
      // Vertical intent keeps the list scrollable; only a left swipe is taken over.
      if (!canRemove || Math.abs(dy) >= Math.abs(dx)) {
        cancelPress();
        return;
      }
      press.axis = 'x';
      clear(press.timer);
    }
    event.preventDefault();
    press.dx = Math.min(0, dx);
    const surface = press.row.querySelector('.reorder-swipe');
    if (surface) surface.style.transform = `translateX(${Math.max(press.dx, -96)}px)`;
    press.row.classList.toggle('is-revealed', press.dx <= -SWIPE_REMOVE_DISTANCE);
  });
  list.addEventListener('pointerup', (event) => {
    if (drag && event.pointerId === drag.pointerId) return dropDrag();
    if (!press || event.pointerId !== press.pointerId) return;
    const id = rowId(press.row);
    const shouldRemove = press.axis === 'x' && press.dx <= -SWIPE_REMOVE_DISTANCE;
    cancelPress();
    if (shouldRemove) return remove(id);
  });
  const lost = () => { cancelDrag(); cancelPress(); };
  list.addEventListener('pointercancel', lost);
  list.addEventListener('lostpointercapture', (event) => { if (!drag || event?.pointerId === undefined || event.pointerId === drag.pointerId) lost(); });
  list.addEventListener('touchmove', blockTouch, { passive: false });
  const finishSettling = () => { if (settling) { clear(settling.timer); settling.finish(); } };
  close.addEventListener('click', () => { cancelDrag(); cancelPress(); finishSettling(); dialog.close(); });
  dialog.addEventListener('cancel', (event) => {
    // Escape during a drag puts the row back instead of closing.
    if (drag) { event.preventDefault(); cancelDrag(); return; }
    if (busy) event.preventDefault(); else { cancelPress(); finishSettling(); }
  });
  dialog.addEventListener('close', () => { cancelDrag(); cancelPress(); dialog.remove(); onClose?.(); });
  render();
  dialog.showModal();
  if (lift) {
    const row = list.querySelector(`[data-reorder-id="${lift.id}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
    startDrag(row, lift);
  }
  return dialog;
}
