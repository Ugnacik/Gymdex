// Routines: saved plans of Exercise Configurations with a set count for one Gym (see
// CONTEXT.md and docs/adr/0002-routines.md). The start screen offers the selected Gym's
// Routines beside plain Start; the Routines screen creates, edits and deletes them.

export const ROUTINE_MAX_SETS = 20;
// Sets offered for an exercise added in the Routines screen; the Sets menu changes it.
export const ROUTINE_DEFAULT_SETS = 3;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The start screen's Routines section for the selected Gym; plain Start stays the bottom action.
export function renderRoutineStarts(routines, gym, escapeHtml) {
  const mine = (routines ?? []).filter((routine) => routine.gym_id === gym.id);
  return `<section class="routine-starts" aria-labelledby="routines-title">
    <div class="section-title"><h2 id="routines-title">Routines</h2><button type="button" class="text-button manage-open" id="open-routines" aria-label="Edit routines at ${escapeHtml(gym.name)}">Edit</button></div>
    ${mine.length ? `<div class="recent-list">${mine.map((routine) => `<button type="button" class="recent-card" data-start-routine="${routine.id}" data-routine-name="${escapeHtml(routine.name)}"><strong>Start ${escapeHtml(routine.name)}</strong><span>${plural(routine.exercise_count, "exercise")}</span></button>`).join("")}</div>`
      : `<p class="routine-empty">No routines at ${escapeHtml(gym.name)} yet. Save a finished workout as a routine in History, or create one with Edit.</p>`}
  </section>`;
}

// Opens the Routines screen for one Gym. context supplies the app's api, ask, askText,
// showToast and text helpers; onClose runs after the screen closes when something changed.
export function openRoutines(context, gym) {
  const { document, api, ask, askText, showToast, escapeHtml, exerciseDisplayName, configurationLabel, onClose, openCatalog } = context;
  if (document.querySelector("#routines")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "routines";
  dialog.className = "history-dialog routines-dialog";
  dialog.setAttribute("aria-labelledby", "routines-title-sheet");
  dialog.innerHTML = `<div class="sheet-header"><h2 id="routines-title-sheet">Routines at ${escapeHtml(gym.name)}</h2><button class="text-button" id="close-routines" autofocus>Close</button></div>
    <p id="routines-message" role="status">Loading…</p>
    <div id="routines-content" tabindex="-1"></div>`;
  document.body.append(dialog);
  const find = (selector) => dialog.querySelector(selector);
  const message = find("#routines-message");
  const content = find("#routines-content");
  let data = null;
  let openId = null;
  let view = "list";
  let busy = false;
  let changed = false;
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (changed) onClose();
    document.querySelector("#open-routines")?.focus();
  });
  find("#close-routines").addEventListener("click", () => dialog.close());

  const current = () => data?.routines.find((routine) => routine.id === openId);
  const render = () => {
    const routine = current();
    if (view === "list" || !routine) { view = "list"; content.innerHTML = renderList(); }
    else if (view === "add") { content.innerHTML = renderAdd(routine); renderChoices(""); }
    else content.innerHTML = renderDetail(routine);
  };

  function renderList() {
    return `<button type="button" class="secondary routine-new" data-new-routine>New routine</button>
      ${data.routines.length ? `<div class="recent-list">${data.routines.map((routine) => `<button type="button" class="recent-card" data-open-routine="${routine.id}"><strong>${escapeHtml(routine.name)}</strong><span>${plural(routine.exercises.length, "exercise")}</span></button>`).join("")}</div>`
        : `<p>No routines yet. A routine is a saved list of exercises and set counts to start a workout from.</p>`}`;
  }

  function renderDetail(routine) {
    const name = escapeHtml(routine.name);
    const count = routine.exercises.length;
    return `<button type="button" class="text-button" data-routine-back>Back to routines</button>
      <div class="routine-heading"><h3>${name}</h3><div class="manage-actions">
        <button type="button" class="text-button" data-rename-routine aria-label="Rename ${name}">Rename</button>
        <button type="button" class="text-button manage-remove" data-delete-routine aria-label="Delete ${name}">Delete</button>
      </div></div>
      <p>Starting it adds each exercise with this many empty sets. Last workout values show as usual.</p>
      ${count ? `<ol class="routine-exercises">${routine.exercises.map((item, index) => {
        const label = escapeHtml(exerciseDisplayName(item));
        return `<li class="exercise-entry routine-exercise">
          <div class="history-exercise-heading"><h3>${label}</h3><button type="button" class="remove-exercise" data-remove-routine-exercise="${index}" aria-label="Remove ${label}"><span aria-hidden="true">×</span></button></div>
          <p class="meta">${escapeHtml(configurationLabel(item))}</p>
          ${item.archived ? `<p class="history-notice">Archived: skipped when this routine starts. Restore it in Manage.</p>` : ""}
          <label class="field routine-sets">Sets<select data-set-count="${index}" aria-label="Sets of ${label}">${Array.from({ length: ROUTINE_MAX_SETS }, (_, step) => step + 1)
            .map((sets) => `<option value="${sets}"${sets === item.set_count ? " selected" : ""}>${sets}</option>`).join("")}</select></label>
          <div class="exercise-tools">
            <button type="button" class="text-button" data-move-routine-exercise="${index}" data-move-to="${index - 1}" aria-label="Move ${label} up" ${index === 0 ? "disabled" : ""}>Move up</button>
            <button type="button" class="text-button" data-move-routine-exercise="${index}" data-move-to="${index + 1}" aria-label="Move ${label} down" ${index === count - 1 ? "disabled" : ""}>Move down</button>
          </div>
        </li>`;
      }).join("")}</ol>` : `<p>No exercises yet.</p>`}
      <button type="button" class="primary accent routine-add" data-add-routine-exercise>Add exercise</button>`;
  }

  function renderAdd(routine) {
    return `<button type="button" class="text-button" data-routine-detail>Back to ${escapeHtml(routine.name)}</button>
      <h3>Add exercise</h3>
      <p>Choose a saved configuration at ${escapeHtml(gym.name)}, or browse the catalog to add a new exercise.</p>
      <button type="button" class="secondary routine-add" data-browse-catalog>Browse exercise catalog</button>
      <input class="search" id="routine-search" type="search" inputmode="search" autocomplete="off" placeholder="Search exercises" aria-label="Search exercises" />
      <div id="routine-choices" class="recent-list"></div>`;
  }

  function renderChoices(query) {
    const wanted = query.trim().toLowerCase();
    const choices = data.configurations.filter((item) =>
      `${exerciseDisplayName(item)} ${item.exercise_name} ${item.variation_name} ${configurationLabel(item)}`.toLowerCase().includes(wanted));
    find("#routine-choices").innerHTML = choices.map((item) => `<button type="button" class="recent-card" data-add-profile="${item.profile_id}"><strong>${escapeHtml(exerciseDisplayName(item))}</strong><span>${escapeHtml(configurationLabel(item))}</span></button>`).join("")
      || `<p>${data.configurations.length ? "No saved configurations match. Try the exercise catalog." : `No saved configurations at ${escapeHtml(gym.name)} yet. Browse the catalog to choose your first exercise.`}</p>`;
  }

  function replaceRoutine(saved) {
    const { skipped, ...routine } = saved;
    data.routines = [...data.routines.filter((item) => item.id !== routine.id), routine]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    changed = true;
    return routine;
  }

  // Saves the open Routine's whole ordered exercise list and shows the result.
  async function saveExercises(exercises, notice) {
    const routine = current();
    busy = true;
    try {
      replaceRoutine(await api(`/api/routines/${routine.id}`, { method: "PUT", body: JSON.stringify({
        exercises: exercises.map(({ profile_id, set_count }) => ({ profile_id, set_count })),
      }) }));
      render();
      if (notice) showToast(notice);
      return true;
    } catch (error) { showToast(error.message); render(); return false; }
    finally { busy = false; }
  }

  content.addEventListener("click", async (event) => {
    const target = event.target;
    const hit = (selector) => target.closest?.(selector);
    if (busy) return;
    if (hit("[data-new-routine]")) {
      const created = await askText(`New routine at ${gym.name}`, { label: "Routine name", confirmLabel: "Create routine",
        submit: (name) => api("/api/routines", { method: "POST", body: JSON.stringify({ gym_id: gym.id, name }) }) });
      if (!created) return;
      openId = replaceRoutine(created).id;
      view = "detail";
      render();
      content.focus();
      showToast(`Routine ${created.name} created. Add its exercises.`);
      return;
    }
    const open = hit("[data-open-routine]");
    if (open) { openId = Number(open.dataset.openRoutine); view = "detail"; render(); content.focus(); return; }
    if (hit("[data-routine-back]")) { view = "list"; render(); content.focus(); return; }
    if (hit("[data-routine-detail]")) { view = "detail"; render(); content.focus(); return; }
    const routine = current();
    if (!routine) return;
    if (hit("[data-browse-catalog]")) {
      busy = true;
      try {
        await openCatalog(gym, routine, (saved) => {
          replaceRoutine(saved);
          for (const item of saved.exercises) {
            if (!item.archived && !data.configurations.some(existing => existing.profile_id === item.profile_id)) {
              data.configurations.push(item);
            }
          }
          view = "detail";
          render();
          find("[data-add-routine-exercise]")?.focus();
        });
      } catch (error) { showToast(error.message); }
      finally { busy = false; }
      return;
    }
    if (hit("[data-add-routine-exercise]")) { view = "add"; render(); find("#routine-search")?.focus(); return; }
    const add = hit("[data-add-profile]");
    if (add) {
      const item = data.configurations.find((choice) => choice.profile_id === Number(add.dataset.addProfile));
      if (!item) return;
      view = "detail";
      await saveExercises([...routine.exercises, { ...item, set_count: ROUTINE_DEFAULT_SETS }], `${exerciseDisplayName(item)} added.`);
      return;
    }
    const move = hit("[data-move-routine-exercise]");
    if (move) {
      const from = Number(move.dataset.moveRoutineExercise);
      const to = Number(move.dataset.moveTo);
      if (to < 0 || to >= routine.exercises.length) return;
      const exercises = [...routine.exercises];
      exercises.splice(to, 0, ...exercises.splice(from, 1));
      if (await saveExercises(exercises)) {
        // Keep focus on the moved exercise, preferring the button for the same direction.
        const button = (index, goal) => find(`[data-move-routine-exercise="${index}"][data-move-to="${goal}"]`);
        const preferred = button(to, to < from ? to - 1 : to + 1);
        (preferred && !preferred.disabled ? preferred : button(to, to < from ? to + 1 : to - 1))?.focus();
      }
      return;
    }
    const remove = hit("[data-remove-routine-exercise]");
    if (remove) {
      const index = Number(remove.dataset.removeRoutineExercise);
      const name = exerciseDisplayName(routine.exercises[index]);
      if (!await ask(`Remove ${name} from ${routine.name}?`, { confirmLabel: "Remove", danger: true })) return;
      await saveExercises(routine.exercises.filter((_, position) => position !== index), `${name} removed.`);
      return;
    }
    if (hit("[data-rename-routine]")) {
      const saved = await askText(`Rename ${routine.name}`, { label: "Routine name", value: routine.name, confirmLabel: "Save name",
        submit: (name) => api(`/api/routines/${routine.id}`, { method: "PUT", body: JSON.stringify({ name }) }) });
      if (!saved) return;
      replaceRoutine(saved);
      render();
      showToast(`Renamed to ${saved.name}.`);
      return;
    }
    if (hit("[data-delete-routine]")) {
      if (!await ask(`Delete the routine ${routine.name}? Workouts started from it stay in history.`, { confirmLabel: "Delete", danger: true })) return;
      busy = true;
      try {
        await api(`/api/routines/${routine.id}`, { method: "DELETE" });
        data.routines = data.routines.filter((item) => item.id !== routine.id);
        changed = true;
        view = "list";
        render();
        content.focus();
        showToast(`${routine.name} deleted.`);
      } catch (error) { showToast(error.message); }
      finally { busy = false; }
    }
  });
  content.addEventListener("change", async (event) => {
    const select = event.target.closest?.("[data-set-count]");
    const routine = current();
    if (!select || !routine || busy) return;
    const index = Number(select.dataset.setCount);
    const exercises = routine.exercises.map((item, position) => position === index ? { ...item, set_count: Number(select.value) } : item);
    if (await saveExercises(exercises)) find(`[data-set-count="${index}"]`)?.focus();
  });
  content.addEventListener("input", (event) => {
    if (event.target.id === "routine-search") renderChoices(event.target.value);
  });

  dialog.showModal();
  return (async () => {
    try {
      data = await api(`/api/routines?gym_id=${gym.id}`);
      if (!dialog.open) return;
      message.textContent = "";
      render();
    } catch (error) {
      if (dialog.open) message.textContent = `${error.message} Routines require a connection. Close and open them again to retry.`;
    }
  })();
}
