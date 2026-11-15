// Holding a name opens the compact order list; ordinary taps and scrolling keep
// their usual behavior. Pointer movement, cancellation and scrolling abandon a hold.
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
      hold = { name, id: event.pointerId, x: event.clientX, y: event.clientY };
      timer = schedule(() => {
        const origin = hold?.name;
        cancel();
        if (!origin?.isConnected) return;
        suppress = origin;
        clear(suppressionTimer);
        suppressionTimer = schedule(() => { suppress = null; }, 1000);
        open(origin);
      }, 450);
    },
    pointermove(event) {
      if (hold?.id === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) cancel();
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
  document.addEventListener('scroll', cancel, true);
  return () => {
    cancel();
    clear(suppressionTimer);
    for (const [type, handler] of Object.entries(handlers)) host.removeEventListener?.(type, handler, true);
    document.removeEventListener?.('scroll', cancel, true);
  };
}

const SWIPE_REMOVE_DISTANCE = 72;

// Each drop or arrow tap saves one move immediately. Failed saves and cancelled
// pointers restore the last acknowledged list. onMove(id, zeroBasedPosition)
// owns persistence, so both Workouts and Routines use their existing save paths.
// Optional onRemove(id, removing) confirms and removes, and calls removing() once the removal
// is confirmed; a left swipe past the threshold asks before deleting so a stray swipe does
// not lose logged sets. Each row's Remove button is also a real button for Tab and screen readers.
export function openExerciseReorder(document, { items, onMove, onRemove, onClose, escapeHtml }) {
  if (document.querySelector('#exercise-reorder')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'exercise-reorder';
  dialog.className = 'history-dialog reorder-dialog';
  dialog.setAttribute('aria-labelledby', 'reorder-title');
  const canRemove = typeof onRemove === 'function';
  dialog.innerHTML = `<div class="sheet-header"><h2 id="reorder-title">Reorder exercises</h2><button type="button" class="text-button" id="close-reorder" autofocus>Close</button></div>
    <p class="muted">Drag a handle or use the arrows. Move near an edge to scroll. Each move saves right away.${canRemove ? ' Swipe left to remove; you will be asked to confirm.<span class="visually-hidden"> With a screen reader, use the Remove button after each exercise.</span>' : ""}</p>
    <ol class="reorder-list" id="reorder-list"></ol><p id="reorder-status" role="status"></p>`;
  document.body.append(dialog);
  const list = dialog.querySelector('#reorder-list');
  const status = dialog.querySelector('#reorder-status');
  const close = dialog.querySelector('#close-reorder');
  let order = [...items];
  let drag = null;
  let swipe = null;
  let busy = false;
  const rowId = (row) => Number(row.dataset.reorderId);
  const rows = () => [...list.children];
  // focusId puts focus on that row's arrow (direction preferred); focusIndex on the row now at
  // that position, or the last row, so focus stays inside the sheet after a removal.
  function render(focusId = null, direction = null, focusIndex = null) {
    list.innerHTML = order.map((item, index) => `<li class="reorder-row" data-reorder-id="${item.id}">
      <div class="reorder-swipe">
        <div class="reorder-name"><strong>${escapeHtml(item.name)}</strong>${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}</div>
        <button type="button" class="text-button" data-reorder-step="-1" aria-label="Move ${escapeHtml(item.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="text-button" data-reorder-step="1" aria-label="Move ${escapeHtml(item.name)} down" ${index === order.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="reorder-handle text-button" aria-label="Drag ${escapeHtml(item.name)} to reorder"><span aria-hidden="true">≡</span></button>
      </div>
      ${canRemove ? `<button type="button" class="reorder-remove" data-reorder-remove aria-label="Remove ${escapeHtml(item.name)}">Remove</button>` : ''}
    </li>`).join('');
    if (focusIndex !== null && order.length) focusId = order[Math.min(focusIndex, order.length - 1)].id;
    if (focusId !== null) {
      const row = list.querySelector(`[data-reorder-id="${focusId}"]`);
      const preferred = row?.querySelector(`[data-reorder-step="${direction}"]:not(:disabled)`);
      (preferred || row?.querySelector('[data-reorder-step]:not(:disabled)') || close).focus();
    }
  }
  function cancelDrag() {
    if (!drag) return;
    const active = drag;
    drag = null;
    active.row.classList.remove('is-dragging');
    list.append(...active.before);
    if (list.hasPointerCapture?.(active.pointerId)) list.releasePointerCapture(active.pointerId);
  }
  function resetSwipe(row) {
    const surface = row?.querySelector?.('.reorder-swipe');
    if (surface) surface.style.transform = '';
    row?.classList.remove('is-swiping', 'is-revealed');
  }
  function cancelSwipe() {
    if (!swipe) return;
    const active = swipe;
    swipe = null;
    resetSwipe(active.row);
    if (list.hasPointerCapture?.(active.pointerId)) list.releasePointerCapture(active.pointerId);
  }
  async function move(id, to, direction = null) {
    const from = order.findIndex((item) => item.id === id);
    if (busy || to === from || to < 0 || to >= order.length) return;
    busy = true;
    close.disabled = true;
    list.inert = true;
    status.classList.remove('error');
    status.textContent = 'Saving order…';
    try {
      if (await onMove(id, to) === false) throw new Error('Could not save this move. Close and try again.');
      order.splice(to, 0, ...order.splice(from, 1));
      status.textContent = `${order[to].name} moved to position ${to + 1}.`;
    } catch (error) {
      status.classList.add('error');
      status.textContent = `Order unchanged. ${error.message}`;
    } finally {
      busy = false;
      close.disabled = false;
      list.inert = false;
      render(id, direction);
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
    let focusIndex = index;
    try {
      // Says Removing only once the question is answered yes.
      if (await onRemove(id, () => { status.textContent = `Removing ${item.name}…`; }) === false) {
        status.textContent = `${item.name} kept.`;
        return;
      }
      order.splice(index, 1);
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
      if (dialog.open) render(null, null, focusIndex);
    }
  }
  list.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-reorder-step]');
    if (button) {
      if (button.disabled || busy || drag || swipe) return;
      const id = rowId(button.closest('[data-reorder-id]'));
      const direction = Number(button.dataset.reorderStep);
      return move(id, order.findIndex((item) => item.id === id) + direction, direction);
    }
    const removeButton = event.target.closest?.('[data-reorder-remove]');
    if (removeButton && !busy && !drag && !swipe) {
      return remove(rowId(removeButton.closest('[data-reorder-id]')));
    }
  });
  list.addEventListener('pointerdown', (event) => {
    if (busy || drag || swipe || event.button !== 0 || event.isPrimary === false) return;
    const handle = event.target.closest?.('.reorder-handle');
    if (handle) {
      event.preventDefault();
      const row = handle.closest('[data-reorder-id]');
      drag = { row, pointerId: event.pointerId, before: rows() };
      row.classList.add('is-dragging');
      list.setPointerCapture(event.pointerId);
      return;
    }
    if (!canRemove || event.target.closest?.('button')) return;
    const row = event.target.closest?.('[data-reorder-id]');
    if (!row) return;
    swipe = {
      row, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      dx: 0, axis: null,
    };
    row.classList.add('is-swiping');
    list.setPointerCapture(event.pointerId);
  });
  list.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      // Edge scrolling follows pointer movement, with no repaint loop while held still.
      const bounds = list.getBoundingClientRect();
      if (event.clientY < bounds.top + 36) list.scrollTop -= 24;
      else if (event.clientY > bounds.bottom - 36) list.scrollTop += 24;
      const others = rows().filter((row) => row !== drag.row);
      const before = others.findIndex((row) => { const box = row.getBoundingClientRect(); return event.clientY < box.y + box.height / 2; });
      others.splice(before < 0 ? others.length : before, 0, drag.row);
      list.append(...others);
      return;
    }
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (!swipe.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      // Vertical intent keeps the list scrollable; only commit to a left swipe.
      if (Math.abs(dy) >= Math.abs(dx)) {
        cancelSwipe();
        return;
      }
      swipe.axis = 'x';
    }
    event.preventDefault();
    swipe.dx = Math.min(0, dx);
    const surface = swipe.row.querySelector('.reorder-swipe');
    if (surface) surface.style.transform = `translateX(${Math.max(swipe.dx, -96)}px)`;
    swipe.row.classList.toggle('is-revealed', swipe.dx <= -SWIPE_REMOVE_DISTANCE);
  });
  list.addEventListener('pointerup', (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      const id = rowId(drag.row);
      const to = rows().indexOf(drag.row);
      cancelDrag();
      return move(id, to);
    }
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    const id = rowId(swipe.row);
    const shouldRemove = swipe.axis === 'x' && swipe.dx <= -SWIPE_REMOVE_DISTANCE;
    cancelSwipe();
    if (shouldRemove) return remove(id);
  });
  list.addEventListener('pointercancel', () => { cancelDrag(); cancelSwipe(); });
  list.addEventListener('lostpointercapture', () => { cancelDrag(); cancelSwipe(); });
  close.addEventListener('click', () => { cancelDrag(); cancelSwipe(); dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); else { cancelDrag(); cancelSwipe(); } });
  dialog.addEventListener('close', () => { cancelDrag(); cancelSwipe(); dialog.remove(); onClose?.(); });
  render();
  dialog.showModal();
  return dialog;
}
