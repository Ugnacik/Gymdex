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

// Each drop or arrow tap saves one move immediately. Failed saves and cancelled
// pointers restore the last acknowledged list. onMove(id, zeroBasedPosition)
// owns persistence, so both Workouts and Routines use their existing save paths.
export function openExerciseReorder(document, { items, onMove, onClose, escapeHtml }) {
  if (document.querySelector('#exercise-reorder')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'exercise-reorder';
  dialog.className = 'history-dialog reorder-dialog';
  dialog.setAttribute('aria-labelledby', 'reorder-title');
  dialog.innerHTML = `<div class="sheet-header"><h2 id="reorder-title">Reorder exercises</h2><button type="button" class="text-button" id="close-reorder" autofocus>Close</button></div>
    <p class="muted">Drag a handle or use the arrows. Move near an edge to scroll. Each move saves right away.</p>
    <ol class="reorder-list" id="reorder-list"></ol><p id="reorder-status" role="status"></p>`;
  document.body.append(dialog);
  const list = dialog.querySelector('#reorder-list');
  const status = dialog.querySelector('#reorder-status');
  const close = dialog.querySelector('#close-reorder');
  let order = [...items];
  let drag = null;
  let busy = false;
  const rowId = (row) => Number(row.dataset.reorderId);
  const rows = () => [...list.children];
  function render(focusId = null, direction = null) {
    list.innerHTML = order.map((item, index) => `<li class="reorder-row" data-reorder-id="${item.id}">
      <div class="reorder-name"><strong>${escapeHtml(item.name)}</strong>${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}</div>
      <button type="button" class="text-button" data-reorder-step="-1" aria-label="Move ${escapeHtml(item.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="text-button" data-reorder-step="1" aria-label="Move ${escapeHtml(item.name)} down" ${index === order.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="reorder-handle text-button" aria-label="Drag ${escapeHtml(item.name)} to reorder"><span aria-hidden="true">≡</span></button>
    </li>`).join('');
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
  list.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-reorder-step]');
    if (!button || button.disabled || busy || drag) return;
    const id = rowId(button.closest('[data-reorder-id]'));
    const direction = Number(button.dataset.reorderStep);
    return move(id, order.findIndex((item) => item.id === id) + direction, direction);
  });
  list.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest?.('.reorder-handle');
    if (!handle || busy || drag || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    const row = handle.closest('[data-reorder-id]');
    drag = { row, pointerId: event.pointerId, before: rows() };
    row.classList.add('is-dragging');
    list.setPointerCapture(event.pointerId);
  });
  list.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    // Edge scrolling follows pointer movement, with no repaint loop while held still.
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + 36) list.scrollTop -= 24;
    else if (event.clientY > bounds.bottom - 36) list.scrollTop += 24;
    const others = rows().filter((row) => row !== drag.row);
    const before = others.findIndex((row) => { const box = row.getBoundingClientRect(); return event.clientY < box.y + box.height / 2; });
    others.splice(before < 0 ? others.length : before, 0, drag.row);
    list.append(...others);
  });
  list.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const id = rowId(drag.row);
    const to = rows().indexOf(drag.row);
    cancelDrag();
    return move(id, to);
  });
  list.addEventListener('pointercancel', cancelDrag);
  list.addEventListener('lostpointercapture', cancelDrag);
  close.addEventListener('click', () => { cancelDrag(); dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); else cancelDrag(); });
  dialog.addEventListener('close', () => { cancelDrag(); dialog.remove(); onClose?.(); });
  render();
  dialog.showModal();
  return dialog;
}
