import { DraftStore, effortsFor, effortText, setLabels, setPayload, SET_TYPES, setTypeText, SIDES, sideText, WEIGHT_PATTERN } from "./drafts.mjs";
import { NOTE_MAX_LENGTH, WorkoutEditor } from "./workout-editor.mjs";
import { DEFAULT_REST_DURATION_SECONDS, RestTimer } from "./rest-timer.mjs";
import { askTextInPage, chooseInPage, confirmInPage } from "./confirm-sheet.mjs";
import { ChoiceField } from "./choice-field.mjs";
import { ExerciseSearch } from "./exercise-search.mjs";
import { openRoutines, renderRoutineStarts } from "./routines.mjs";
import { bindReorderNameHold, openExerciseReorder } from "./exercise-reorder.mjs";
import { findRecords, recordName, recordText } from "./records.mjs";
import { Outbox } from "./outbox.mjs";
import { renameId, workoutOps } from "./workout-ops.mjs";

// The server stores times as SQLite CURRENT_TIMESTAMP values in UTC ("YYYY-MM-DD HH:MM:SS").
// Gymdex shows them in the device's time zone.
export function parseServerTime(value) {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

export function formatLocalTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(parseServerTime(value));
}

export function formatLocalDateTime(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parseServerTime(value));
}

// Returns the UTC instant of local midnight at the start of a YYYY-MM-DD date,
// shifted by whole days, or the value unchanged when it is not such a date.
// Names a Workout in history by what it trained, such as "Chest & Triceps", or by its Gym.
export function workoutTitle(workout) {
  const groups = workout.muscle_groups || [];
  if (!groups.length) return workout.gym_name;
  return groups.length === 1 ? groups[0] : `${groups.slice(0, -1).join(", ")} & ${groups.at(-1)}`;
}

export function localMidnightUtc(value, addDays = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const midnight = new Date(0);
  // setFullYear keeps years below 100 literal, unlike the Date constructor.
  midnight.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

// ask(question, { confirmLabel, cancelLabel, danger }) resolves to the user's answer from the confirmation sheet.
// askText(question, { label, value, confirmLabel, submit }) asks for a name in a sheet (see confirm-sheet.mjs).
// choose(question, { choices, selected, hint }) offers a few choices, such as a Set's Effort, in a sheet.
export function createApp({ window, document, navigator, fetch, setTimeout, clearTimeout, setInterval, clearInterval, now = () => Date.now(),
  ask = (question, options) => confirmInPage(document, question, options),
  askText = (question, options) => askTextInPage(document, question, options),
  choose = (question, options) => chooseInPage(document, question, options) }) {

const drafts = new DraftStore(() => window.localStorage);
// Structural Active Workout changes, saved on the phone and sent in order (see outbox.mjs).
const outbox = new Outbox({
  storage: () => window.localStorage, request: (path, options) => api(path, options), kinds: workoutOps,
  schedule: setTimeout, clear: clearTimeout, online: () => navigator.onLine,
  onChange: () => updateSyncStatus(), onIdle: () => retryPendingSets(),
});
outbox.context = {
  data: () => state.data,
  remap: (type, from, to) => remapId(type, from, to),
  edited: (id) => Boolean(state.editor?.edited(id)),
  changed: () => { if (state.data) drafts.snapshot(state.data); scheduleWorkoutRender(); },
};
const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const savedRest = readRestSettings();

const state = {
  data: null,
  selectedGymId: null,
  picker: null,
  pickerContext: null,
  pickerReplace: null,
  pickerQuery: "",
  pickerMuscleGroup: "",
  summary: null,
  collapsedExercises: new Set(),
  // A Workout Exercise whose empty note was just opened from its ⋯ sheet; the next render shows it once.
  addingNote: null,
  selectedExercise: null,
  selectedEquipment: null,
  unavailable: !navigator.onLine,
  offlineReady: false,
  editor: null,
  restTimer: null,
  restEnabled: savedRest.enabled,
  elapsedTimer: null,
  staleDismissed: null,
};
bindReorderNameHold(app, document, (name) => openWorkoutReorder(Number(name.dataset.reorderName)), { schedule: setTimeout, clear: clearTimeout });
const STALE_WORKOUT_MINUTES = 3 * 60;
const STALE_DISMISSED_KEY = "gymdex:stale-dismissed:v1";

state.restTimer = new RestTimer({ durationSeconds: savedRest.duration, schedule: setTimeout, clear: clearTimeout, onChange: renderRestTimerState, onFinish: playRestEndCue });

function readRestSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem("gymdex:rest:v1"));
    return {
      enabled: saved?.enabled === true,
      duration: Number.isInteger(saved?.duration) && saved.duration >= 1 && saved.duration <= 3600 ? saved.duration : DEFAULT_REST_DURATION_SECONDS,
    };
  } catch { return { enabled: false, duration: DEFAULT_REST_DURATION_SECONDS }; }
}

function saveRestSettings() {
  try {
    window.localStorage.setItem("gymdex:rest:v1", JSON.stringify({
      enabled: state.restEnabled, duration: state.restTimer.snapshot().durationSeconds,
    }));
  } catch { showToast("Rest timer settings could not be saved on this phone."); }
}

async function api(path, { timeout: limit = 8000, ...options } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limit);
  try {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
      signal: controller.signal,
    });
    const body = await response.json();
    state.unavailable = false;
    if (!response.ok) {
      const error = new Error(body.error || "Something went wrong.");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } catch (error) {
    if (!error.status) {
      state.unavailable = true;
      throw new Error("Cannot reach the server.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    updateSyncStatus();
  }
}

// One quiet line under the header: "Synced", "Saved on phone, syncing…", offline, or a refused
// change with Retry and Discard. Nothing logged on the phone is dropped without asking.
function updateSyncStatus() {
  const status = document.querySelector("#sync-status");
  if (!status) return;
  const sets = document.querySelectorAll('.set-form[data-dirty="true"]').length;
  const notes = noteTargets().filter((target) => state.editor?.noteStatus(target)?.dirty).length;
  const waiting = outbox.size > 0 || sets > 0 || notes > 0;
  const unavailable = state.unavailable || !navigator.onLine;
  const failed = outbox.failed;
  let text;
  let kind = "synced";
  if (drafts.error || outbox.storageFailed) {
    text = "Phone storage is unavailable. Keep this page open until your changes are saved to the server.";
    kind = "error";
  } else if (failed) {
    text = `Not synced: ${workoutOps[failed.kind]?.describe?.(failed) ?? "a change"} was refused. ${failed.error}`;
    kind = "error";
  } else if (waiting) {
    text = unavailable ? "Offline. Saved on phone; syncs when you are back online." : "Saved on phone, syncing…";
    kind = unavailable ? "offline" : "pending";
  } else {
    text = unavailable ? "Offline. Everything so far is synced." : "Synced";
    kind = unavailable ? "offline" : "synced";
  }
  if (!state.offlineReady && unavailable) text += " Offline reopening is not available yet; keep this page open.";
  status.setAttribute("data-sync", kind);
  status.classList.toggle("error", kind === "error");
  if (failed && kind === "error") {
    status.innerHTML = `<span>${escapeHtml(text)}</span><span class="sync-actions"><button type="button" class="text-button" data-sync-retry>Retry</button><button type="button" class="text-button" data-sync-discard="${escapeHtml(failed.id)}">Discard change</button></span>`;
  } else status.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function configurationLabel(item) {
  return [item.equipment, item.manufacturer, item.label].filter(Boolean).join(" · ");
}

function exerciseDisplayName(item) {
  const { exercise_name: exercise, variation_name: variation } = item;
  if (!variation || variation === "Standard") return exercise;
  if (variation.toLowerCase().includes(exercise.toLowerCase())) return variation;
  return `${variation} ${exercise}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

// An Active Workout exercise's sets as the phone shows them, with valid drafts applied.
function localSets(entry) {
  return state.editor ? entry.sets.map((set) => state.editor.localSet(set)) : entry.sets;
}

// New bests of an Active Workout exercise from its sets as logged on the phone.
function liveRecords(entry) {
  return findRecords(entry.record_bests, localSets(entry), entry.tracking_type);
}

// "New best · Weight, Est. 1RM", the set's record types in a pill like Strong's PR marker.
function recordBadgeText(records) {
  return `New best · ${records.map(recordName).join(", ")}`;
}

// Marks each Active Workout set that is a new best as logged on the phone, and unmarks it once
// an edit makes it no longer the best or it is no longer completed.
function syncRecordBadges() {
  const found = new Map();
  for (const entry of state.data?.workout_exercises ?? []) {
    for (const record of liveRecords(entry)) found.set(record.set_id, [...(found.get(record.set_id) ?? []), record]);
  }
  document.querySelectorAll(".set-form").forEach((form) => {
    const badge = form.querySelector("[data-set-record]");
    if (!badge) return;
    const records = found.get(formSetId(form));
    badge.hidden = !records;
    badge.textContent = records ? recordBadgeText(records) : "";
    if (records) badge.setAttribute("aria-label", `New best: ${records.map(recordText).join(", ")}`);
    else badge.removeAttribute("aria-label");
    form.classList.toggle("is-record", Boolean(records));
  });
}

// Records grouped under their exercise (and Side), in order: [["Bench Press", [record, …]], …].
function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const title = `${record.exercise}${record.side ? ` · ${sideText(record.side)}` : ""}`;
    groups.set(title, [...(groups.get(title) ?? []), record]);
  }
  return [...groups];
}

// The finish summary's and history detail's list of new bests, one line per record under its exercise.
function renderRecordList(records) {
  if (!records.length) return "";
  return `<section class="record-list" aria-label="New bests">
    <h2>${records.length} new best${records.length === 1 ? "" : "s"}</h2>
    <ul>${groupRecords(records).map(([title, items]) => `<li><span class="record-exercise">${escapeHtml(title)}</span>${items.map((record) => `<span>${escapeHtml(recordText(record))}</span>`).join("")}</li>`).join("")}</ul>
  </section>`;
}

function renderFinishSummary() {
  const summary = state.summary;
  return `<section class="finish-summary" aria-labelledby="finish-summary-title">
    <h1 id="finish-summary-title" tabindex="-1">Workout complete</h1>
    <p>${escapeHtml(summary.workout.gym_name)} · ${summary.duration}</p>
    <p class="finish-totals">${summary.exercises} exercise${summary.exercises === 1 ? "" : "s"} with completed sets · ${summary.sets} completed set${summary.sets === 1 ? "" : "s"}</p>
    ${renderRecordList(summary.records ?? [])}
    <div class="summary-actions"><button class="secondary" id="summary-routine">Save as routine</button><button class="secondary" id="summary-history">View workout</button></div>
    <button class="text-button" id="dismiss-summary">Done</button>
  </section>`;
}

async function saveWorkoutRoutine(workout) {
  // One sheet at a time, however often Save as routine is tapped.
  if (state.savingRoutine) return;
  state.savingRoutine = true;
  let saved = null;
  try {
    saved = await askText(`Save this workout as a routine at ${workout.gym_name}`, {
      label: "Routine name", confirmLabel: "Save routine",
      // Same title history shows for this workout (trained Muscle Groups, or the Gym).
      value: workoutTitle(workout),
      submit: (name) => api(`/api/history/${workout.id}/routine`, { method: "POST", body: JSON.stringify({ name }) }),
      // A name the Gym already uses can replace that Routine in place, after asking.
      errorAction: (error) => {
        const existing = error.body?.existing_routine;
        if (!existing) return null;
        return {
          label: "Replace routine", busyLabel: "Replacing…",
          confirm: () => ask(`Replace ${existing.name}? Its exercises will be replaced by this workout's.`,
            { confirmLabel: "Replace routine", cancelLabel: "Keep", danger: true }),
          run: (name) => api(`/api/history/${workout.id}/routine`, {
            method: "POST", body: JSON.stringify({ name, replace: true }) }),
        };
      },
    });
  } finally { state.savingRoutine = false; }
  if (!saved) return;
  state.data.routines = [...(state.data.routines ?? []).filter(item => item.id !== saved.id),
    { id: saved.id, gym_id: saved.gym_id, name: saved.name, exercise_count: saved.exercises.length }]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  if (!state.data.active_workout) renderStart();
  const skippedNote = saved.skipped ? ` ${saved.skipped} archived exercise${saved.skipped === 1 ? "" : "s"} skipped.` : "";
  showToast(`Routine ${saved.name} ${saved.replaced ? "replaced" : "saved"} with ${saved.exercises.length} exercise${saved.exercises.length === 1 ? "" : "s"}.${skippedNote}`);
}

async function saveRoutineChoice(configuration) {
  const context = state.pickerContext;
  if (!context || context.saving) return;
  context.saving = true;
  const buttons = document.querySelectorAll('#picker button');
  buttons.forEach(button => { button.disabled = true; });
  try {
    const saved = await api(`/api/routines/${context.routine.id}/exercises`, {
      method: "POST", body: JSON.stringify(configuration),
    });
    closePicker();
    await context.onSave(saved);
    showToast("Exercise added to routine.");
  } catch (error) { showToast(error.message); }
  finally { context.saving = false; buttons.forEach(button => { button.disabled = false; }); }
}

async function load() {
  try {
    // Changes still queued on this phone are applied on top of the server's copy. A change
    // acknowledged while bootstrap was loading may or may not be in it, so load again.
    let data;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const completed = outbox.completed;
      data = await api("/api/bootstrap");
      if (outbox.completed === completed) break;
    }
    state.data = outbox.replay(data);
    drafts.snapshot(state.data);
    // A gym archived or deleted in Manage can no longer be selected.
    if (!state.data.gyms.some((gym) => gym.id === state.selectedGymId)) state.selectedGymId = null;
    if (!state.selectedGymId && state.data.gyms.length === 1) {
      state.selectedGymId = state.data.gyms[0].id;
    }
    resetEditor();
    render();
    outbox.kick();
    retryPendingSets();
    return true;
  } catch (error) {
    state.data = state.data || drafts.cachedWorkout();
    if (state.data) {
      resetEditor();
      render();
      return false;
    }
    app.innerHTML = `<main class="shell"><h1>Gymdex is unavailable.</h1><p class="error">${escapeHtml(error.message)}</p><button class="primary" id="retry">Try again</button></main>`;
    document.querySelector("#retry").addEventListener("click", load);
  }
}

function render() {
  if (state.data.active_workout) renderWorkout();
  else renderStart();
  updateSyncStatus();
}

// Archived gyms stay selectable where recorded workouts are browsed: history and progress.
function recordedGyms() {
  return [...state.data.gyms, ...(state.data.archived_gyms ?? []).map((gym) => ({ ...gym, archived: true }))];
}

function gymOptions(selectedId = null) {
  return recordedGyms().map((gym) => `<option value="${gym.id}"${Number(selectedId) === gym.id ? " selected" : ""}>${escapeHtml(gym.name)}${gym.archived ? " (archived)" : ""}</option>`).join("");
}

function renderHeader(status = "Ready") {
  return `<header class="app-header"><div class="brand-block"><div class="brand">Gymdex</div><div class="status${state.data.active_workout ? " status-active" : ""}">${escapeHtml(status)}</div></div><nav aria-label="App views"><button class="text-button" id="open-progress" ${recordedGyms().length ? "" : "disabled"}>Progress</button><button class="text-button" id="open-history">History</button><button class="text-button" id="open-settings">Settings</button></nav></header><p id="sync-status" class="sync-status" role="status"></p>`;
}

function renderStart() {
  stopWorkoutElapsed();
  const gyms = state.data.gyms;
  const selectedGym = gyms.find((gym) => gym.id === state.selectedGymId);
  app.innerHTML = `
    <main class="shell">
      ${renderHeader("No active workout")}
      ${state.summary ? renderFinishSummary() : ""}
      <section class="intro" ${state.summary ? "hidden" : ""}>
        <h1>Start where you train.</h1>
        <p>Choose your gym to find your machines and recent exercises.</p>
      </section>
      <div class="section-title"><h2>Your gyms</h2><button type="button" class="text-button manage-open" id="open-manage">Manage</button></div>
      <div class="gym-list" id="gym-list">
        ${gyms.map((gym) => `<button class="gym-card" data-gym-id="${gym.id}" aria-pressed="${state.selectedGymId === gym.id}"><span>${escapeHtml(gym.name)}</span><span aria-hidden="true">${state.selectedGymId === gym.id ? "Selected" : "Select"}</span></button>`).join("")}
      </div>
      ${gyms.length === 0 ? `<div class="empty"><h3>Add your first gym</h3><p>Machine choices and recent exercises will be saved to this location.</p></div>` : ""}
      <form class="add-gym-form" id="add-gym-form">
        <input id="gym-name" name="name" maxlength="80" autocomplete="organization" aria-label="Gym name" placeholder="Gym name" required />
        <button class="secondary" type="submit">Add</button>
      </form>
      ${selectedGym ? renderRoutineStarts(state.data.routines, selectedGym, escapeHtml) : ""}
      <div class="bottom-action"><button class="primary accent" id="start-workout" ${state.selectedGymId ? "" : "disabled"}>Start workout</button></div>
    </main>`;

  document.querySelector("#dismiss-summary")?.addEventListener("click", () => { state.summary = null; renderStart(); });
  document.querySelector("#summary-history")?.addEventListener("click", () => openHistory(state.summary.workout.id));
  document.querySelector("#summary-routine")?.addEventListener("click", async () => {
    // The finished workout's trained Muscle Groups come from its history record; the copy kept
    // from the Active Workout has none, so without a connection the name falls back to the Gym.
    let workout = state.summary.workout;
    try { workout = (await api(`/api/history/${workout.id}`)).workout ?? workout; } catch { /* Gym name it is. */ }
    await saveWorkoutRoutine(workout);
  });
  document.querySelectorAll("[data-gym-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedGymId = Number(button.dataset.gymId);
      renderStart();
      updateSyncStatus();
    });
  });
  document.querySelector("#add-gym-form").addEventListener("submit", createGym);
  document.querySelector("#start-workout").addEventListener("click", startWorkout);
  document.querySelector("#open-history").addEventListener("click", () => openHistory());
  document.querySelector("#open-settings").addEventListener("click", openSettings);
  document.querySelector("#open-progress").addEventListener("click", () => openProgress());
  document.querySelector("#open-manage").addEventListener("click", openManage);
}

async function createGym(event) {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("name");
  try {
    const gym = await api("/api/gyms", { method: "POST", body: JSON.stringify({ name }) });
    state.selectedGymId = gym.id;
    await load();
  } catch (error) { showToast(error.message); }
}

async function startWorkout(event) {
  const button = event?.currentTarget ?? document.querySelector("#start-workout");
  if (state.startingWorkout || startBlocked()) return;
  state.startingWorkout = true;
  if (button) { button.disabled = true; button.textContent = "Starting…"; }
  try {
    await api("/api/workouts", { method: "POST", body: JSON.stringify({ gym_id: state.selectedGymId }) });
    await load();
  } catch (error) {
    if (button?.isConnected !== false) { button.disabled = false; button.textContent = "Start workout"; }
    showToast(error.message);
  } finally { state.startingWorkout = false; }
}

// Repeat and Start routine answer with the new Active Workout and how many exercises they
// left out because their Variation or Exercise Configuration is archived.
async function showStartedWorkout({ skipped = 0, ...started }, notice) {
  state.summary = null;
  state.collapsedExercises.clear();
  forgetWorkoutMarks();
  state.data.active_workout = started;
  state.data.workout_exercises = [];
  state.selectedGymId = started.gym_id;
  drafts.snapshot(state.data);
  await load();
  const skippedNote = skipped ? ` ${skipped} archived exercise${skipped === 1 ? "" : "s"} skipped.` : "";
  showToast(`${notice}${skippedNote}`);
}

async function startRoutine(button) {
  if (startBlocked()) return;
  button.disabled = true;
  try {
    const started = await api(`/api/routines/${Number(button.dataset.startRoutine)}/start`, { method: "POST", body: "{}" });
    await showStartedWorkout(started, `${button.dataset.routineName} started. Sets are ready to log.`);
  } catch (error) { button.disabled = false; showToast(error.message); }
}

function openRoutinesScreen() {
  const gym = state.data.gyms.find((item) => item.id === state.selectedGymId);
  if (!gym) return;
  return openRoutines({ document, api, ask, askText, showToast, escapeHtml, exerciseDisplayName, configurationLabel,
    openCatalog: openRoutineCatalog,
    // The start screen lists the routines, so it refreshes once the screen closes.
    onClose: () => load() }, gym);
}

function renderWorkout() {
  const workout = state.data.active_workout;
  const entries = state.data.workout_exercises;
  const stale = elapsedMinutes(workout) > STALE_WORKOUT_MINUTES && !staleWorkoutDismissed(workout.id);
  app.innerHTML = `
    <main class="shell workout-shell">
      ${renderHeader("Workout active")}
      <section class="workout-heading">
        <div><h1>${escapeHtml(workout.gym_name)}</h1><p>Started ${escapeHtml(formatLocalTime(workout.started_at))} · <span id="workout-elapsed" aria-label="Elapsed">${formatElapsed(elapsedMinutes(workout))}</span></p></div>
      </section>
      ${stale ? `<section class="stale-banner" id="stale-banner" aria-labelledby="stale-title">
        <h2 id="stale-title">Still training?</h2>
        <p>This workout started ${formatElapsed(elapsedMinutes(workout))} ago.</p>
        <div class="stale-actions"><button type="button" class="primary" id="stale-finish" data-finish-workout>Finish it</button><button type="button" class="secondary" id="stale-keep">Keep going</button></div>
      </section>` : ""}
      ${renderNote("workout", "Workout note")}
      ${renderRestTimer()}
      <div class="section-title"><h2>Exercises</h2><span>${entries.length}</span></div>
      <section class="exercise-list">
        ${entries.length ? entries.map((entry) => `
          <article class="exercise-entry workout-exercise-card">
            ${renderExerciseNote(entry)}
            <div class="exercise-frame">
            <details class="workout-exercise" data-entry-id="${entry.id}" ${state.collapsedExercises.has(entry.id) ? "" : "open"}>
              <summary class="exercise-summary"><h3 data-reorder-name="${entry.id}">${escapeHtml(exerciseDisplayName(entry))}</h3><span data-exercise-count="${entry.id}">${entry.sets.filter(set => set.completed).length}/${entry.sets.length} done</span></summary>
              <div class="exercise-body">
                ${renderMachineLine(entry)}
                <div class="sets-list">${entry.sets.map((set, index) => renderSet(entry, set, index)).join("")}</div>
                <button class="secondary add-set" data-add-set="${entry.id}">Add set</button>
              </div>
            </details>
            <button type="button" class="exercise-more" data-exercise-more="${entry.id}" aria-label="More for ${escapeHtml(exerciseDisplayName(entry))}" aria-haspopup="dialog"><span aria-hidden="true">⋯</span></button>
            </div>
          </article>`).join("") : `<div class="empty"><h3>No exercises yet</h3><p>Add a recent choice in one tap, or search the catalog.</p></div>`}
      </section>
      <button class="primary accent add-exercise" id="open-picker">Add exercise</button>
      <div class="workout-actions">
        <button class="secondary" data-finish-workout>Finish workout</button>
        <button class="text-button cancel-workout" id="cancel-workout">Cancel workout</button>
      </div>
    </main>`;
  document.querySelector("#open-picker").addEventListener("click", openPicker);
  document.querySelector("#open-history").addEventListener("click", () => openHistory());
  document.querySelector("#open-settings").addEventListener("click", openSettings);
  document.querySelector("#open-progress").addEventListener("click", () => openProgress());
  document.querySelectorAll("[data-finish-workout]").forEach((button) => button.addEventListener("click", finishWorkout));
  document.querySelector("#cancel-workout").addEventListener("click", cancelWorkout);
  document.querySelectorAll(".workout-exercise").forEach((card) => card.addEventListener("toggle", () => {
    const id = Number(card.dataset.entryId);
    if (card.open) state.collapsedExercises.delete(id);
    else state.collapsedExercises.add(id);
  }));
  document.querySelectorAll(".set-form").forEach(bindSet);
  document.querySelectorAll("details.note").forEach(bindNoteToggle);
  document.querySelectorAll("[data-note-target]").forEach(bindNote);
  document.querySelectorAll("[data-add-set]").forEach((button) => button.addEventListener("click", () => addSet(button)));
  if (stale) {
    document.querySelector("#stale-keep").addEventListener("click", () => {
      dismissStaleWorkout(workout.id);
      document.querySelector("#stale-banner").hidden = true;
    });
  }
  bindRestTimer();
  // Only the elapsed text changes each tick, so typing and focus in the set forms are kept.
  state.elapsedTimer ??= setInterval(updateWorkoutElapsed, 30000);
}

function elapsedMinutes(workout) {
  return Math.max(0, Math.floor((now() - parseServerTime(workout.started_at)) / 60000));
}

function formatElapsed(minutes) {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

// "Keep going" is remembered for the active workout so reopening the app does not ask again.
function staleWorkoutDismissed(workoutId) {
  try { return state.staleDismissed === workoutId || window.localStorage.getItem(STALE_DISMISSED_KEY) === String(workoutId); }
  catch { return false; }
}

function dismissStaleWorkout(workoutId) {
  state.staleDismissed = workoutId;
  try { window.localStorage.setItem(STALE_DISMISSED_KEY, String(workoutId)); } catch { /* Dismissed for this page only. */ }
}

function updateWorkoutElapsed() {
  const workout = state.data?.active_workout;
  const elapsed = document.querySelector("#workout-elapsed");
  if (workout && elapsed) elapsed.textContent = formatElapsed(elapsedMinutes(workout));
  else stopWorkoutElapsed();
}

function stopWorkoutElapsed() {
  if (state.elapsedTimer !== null) clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

// Notes are collapsed so they never lengthen the set recording path. A note still
// waiting to reach the server opens so its draft is visible. An open note shows a minus
// icon and its name ends in ", collapse", so it does not read as deleting the note. The name
// starts with the visible label, so Voice Control's "Tap Note" still finds it.
function renderNote(target, label, accessibleName = label, { forceOpen = false } = {}) {
  const status = state.editor?.noteStatus(target);
  const note = status?.note ?? "";
  const open = Boolean(status?.dirty) || forceOpen;
  const context = accessibleName.startsWith(label) ? accessibleName.slice(label.length) : "";
  return `<details class="note" ${open ? "open" : ""}>
    <summary><span class="note-label" data-note-summary="${target}" data-label="${label}">${noteLabel(label, note)}</span>${context ? `<span class="visually-hidden">${escapeHtml(context)}</span>` : ""}<span class="note-preview" data-note-preview="${target}">${escapeHtml(note)}</span><span class="visually-hidden" data-note-collapse>${open ? ", collapse" : ""}</span></summary>
    <textarea data-note-target="${target}" maxlength="${NOTE_MAX_LENGTH}" rows="3" aria-label="${escapeHtml(accessibleName)}" placeholder="Optional">${escapeHtml(note)}</textarea>
    <p class="note-status" data-note-status="${target}" role="status"></p>
  </details>`;
}

function noteLabel(label, note) {
  return note ? label : `Add ${label.toLowerCase()}`;
}

function noteTargets() {
  if (!state.data?.active_workout) return [];
  return ["workout", ...state.data.workout_exercises.map((entry) => `exercise:${entry.id}`)];
}

function bindNoteToggle(details) {
  const hint = details.querySelector("[data-note-collapse]");
  if (!hint) return;
  const sync = () => { hint.textContent = details.open ? ", collapse" : ""; };
  sync();
  details.addEventListener("toggle", sync);
}

function bindNote(field) {
  const target = field.dataset.noteTarget;
  field.addEventListener("input", () => {
    if (!state.editor.busy) state.editor.editNote(target, field.value);
  });
  // Leaving the field saves at once instead of after the typing pause.
  field.addEventListener("change", () => {
    if (!state.editor.busy) state.editor.saveNote(target);
  });
}

// An exercise note shows on its card once it has text or a draft. An empty one stays out of the
// way: Add note in the card's ⋯ sheet opens it.
function renderExerciseNote(entry) {
  const target = `exercise:${entry.id}`;
  const status = state.editor?.noteStatus(target);
  const adding = state.addingNote === target;
  if (!adding && !status?.note && !status?.dirty) return "";
  return renderNote(target, "Note", `Note for ${exerciseDisplayName(entry)}`, { forceOpen: adding });
}

// The Exercise Configuration as one quiet line that opens Edit manufacturer / machine.
function renderMachineLine(entry) {
  const name = exerciseDisplayName(entry);
  const label = configurationLabel(entry);
  return `<button type="button" class="machine-line" data-change-machine="${entry.id}" aria-label="Edit machine for ${escapeHtml(name)}: ${escapeHtml(label)}"><span class="meta">${escapeHtml(label)}</span></button>`;
}

function trackingHint(entry) {
  return `${entry.tracking_type === "duration" ? "Duration in seconds" : "Repetitions"}. ${entry.assisted ? "Assist kg is the counterweight and is optional." : "Weight is optional."}`;
}

// The ⋯ sheet holds what a Workout Exercise needs now and then, so the card keeps to the sets.
function openExerciseMenu(entryId) {
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(entryId));
  if (!entry || !state.editor || state.editor.busy || document.querySelector("#picker")) return;
  const name = escapeHtml(exerciseDisplayName(entry));
  const count = state.data.workout_exercises.length;
  const noteStatus = state.editor.noteStatus(`exercise:${entry.id}`);
  const hasNote = Boolean(noteStatus?.note || noteStatus?.dirty);
  openSheet(`
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-header"><h2 id="picker-title">${name}</h2><button class="text-button" id="close-picker">Close</button></div>
    <p class="set-hint exercise-menu-hint">${escapeHtml(trackingHint(entry))}</p>
    <label class="sides-option"><span>Record sides<small>Tag each set R or L</small></span>
      <span class="rest-switch"><input type="checkbox" role="switch" data-record-sides="${entry.id}" aria-label="Record sides for ${name}" ${recordsSides(entry) ? "checked" : ""} ${entry.sets.length ? "" : "disabled"} /></span></label>
    <div class="exercise-menu">
      ${entry.variation_id ? `<button type="button" class="exercise-menu-item" data-active-progress="${entry.variation_id}" data-progress-equipment="${escapeHtml(entry.equipment)}" data-progress-manufacturer="${escapeHtml(entry.manufacturer || "")}" data-progress-label="${escapeHtml(entry.label || "")}">View progress</button>` : ""}
      <button type="button" class="exercise-menu-item" data-replace-exercise="${entry.id}" aria-label="Replace ${name}">Replace exercise</button>
      <button type="button" class="exercise-menu-item" data-reorder-exercises="${entry.id}" ${count < 2 ? "disabled" : ""}>Reorder exercises</button>
      ${hasNote ? "" : `<button type="button" class="exercise-menu-item" data-add-note="${entry.id}" aria-label="Add note for ${name}">Add note</button>`}
      <button type="button" class="exercise-menu-item danger" data-remove-exercise="${entry.id}" aria-label="Remove ${name}">Remove exercise</button>
    </div>`);
  const sheet = document.querySelector("#picker .sheet");
  const back = `[data-exercise-more="${entry.id}"]`;
  sheet.querySelector("#close-picker").addEventListener("click", () => closePicker(back));
  sheet.querySelector("[data-record-sides]").addEventListener("change", (event) => recordSides(event.currentTarget));
  // Every other choice closes the sheet first; the card's ⋯ button gets focus back.
  sheet.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-active-progress], [data-replace-exercise], [data-reorder-exercises], [data-add-note], [data-remove-exercise]");
    if (!action || action.disabled) return;
    closePicker(back);
    return exerciseAction(action);
  });
}

// Opens an exercise note that has no text yet, from the ⋯ sheet.
function addExerciseNote(entryId) {
  const target = `exercise:${entryId}`;
  state.addingNote = target;
  render();
  state.addingNote = null;
  document.querySelector(`[data-note-target="${target}"]`)?.focus();
}

// The actions offered on a Workout Exercise card and in its ⋯ sheet.
function exerciseAction(button) {
  const data = button.dataset;
  if (data.exerciseMore) return openExerciseMenu(Number(data.exerciseMore));
  if (data.reorderExercises) return openWorkoutReorder(Number(data.reorderExercises));
  if (data.removeExercise) return removeExercise(Number(data.removeExercise));
  if (data.replaceExercise) return replaceExercise(Number(data.replaceExercise));
  if (data.changeMachine) return changeMachine(Number(data.changeMachine));
  if (data.addNote) return addExerciseNote(Number(data.addNote));
  if (data.activeProgress) return openProgress(Number(data.activeProgress), state.data.active_workout.gym_id, {
    equipment: data.progressEquipment, manufacturer: data.progressManufacturer, label: data.progressLabel });
}

function restDurationOptions(duration) {
  const choices = [30, 60, 90, 120, 180];
  if (!choices.includes(duration)) choices.push(duration);
  return choices.map((seconds) => `<option value="${seconds}" ${duration === seconds ? "selected" : ""}>${seconds < 60 || seconds % 60 ? `${seconds} seconds` : `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`}</option>`).join("");
}

function setRestEnabled(enabled) {
  state.restEnabled = enabled;
  const workoutSwitch = document.querySelector("#rest-enabled");
  if (workoutSwitch) workoutSwitch.checked = enabled;
  const controls = document.querySelector("#rest-controls");
  if (controls) controls.hidden = !enabled;
  if (!enabled) state.restTimer.stop();
  saveRestSettings();
  renderRestTimerState();
}

function setRestDuration(duration) {
  state.restTimer.setDuration(duration);
  const workoutDuration = document.querySelector("#rest-duration");
  if (workoutDuration) {
    workoutDuration.innerHTML = restDurationOptions(duration);
    workoutDuration.value = String(duration);
  }
  saveRestSettings();
}

// A full-screen dialog keeps the previous screen and its unsaved inputs intact.
function openSettings() {
  const dialog = document.createElement("dialog");
  dialog.id = "settings";
  dialog.className = "settings-screen";
  dialog.setAttribute("aria-labelledby", "settings-title");
  dialog.innerHTML = `<main class="shell">
    <header class="settings-header"><button type="button" class="secondary" id="close-settings" autofocus>Back to ${state.data.active_workout ? "workout" : "start"}</button><h1 id="settings-title">Settings</h1></header>
    <section class="settings-card" aria-labelledby="settings-rest-title">
      <div class="rest-heading"><div class="rest-title"><h2 id="settings-rest-title">Rest timer</h2><p class="rest-caption">Start after each completed set</p></div>
        <label class="rest-switch"><input id="settings-rest-enabled" type="checkbox" role="switch" aria-label="Enable rest timer" ${state.restEnabled ? "checked" : ""} /></label></div>
      <label class="field">Rest after a set<select id="settings-rest-duration">${restDurationOptions(state.restTimer.snapshot().durationSeconds)}</select></label>
      <p class="muted">Interval changes apply to your next rest. You can also change the interval in Timer settings during a workout.</p>
    </section>
    <p class="muted">Preferences are saved on this phone.</p>
  </main>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("#close-settings").addEventListener("click", () => dialog.close());
  dialog.querySelector("#settings-rest-enabled").addEventListener("change", (event) => setRestEnabled(event.target.checked));
  dialog.querySelector("#settings-rest-duration").addEventListener("change", (event) => setRestDuration(Number(event.target.value)));
  dialog.showModal();
}

function renderRestTimer() {
  const duration = state.restTimer.snapshot().durationSeconds;
  // One column: title and switch, then clock and controls, then settings. The switch is the
  // only on/off cue; its accessible name comes from aria-label.
  return `<section class="rest-timer" aria-labelledby="rest-title" data-rest-state="idle">
    <div class="rest-heading">
      <div class="rest-title"><h2 id="rest-title">Rest timer</h2><p class="rest-caption">Counts down after each completed set</p></div>
      <label class="rest-switch"><input id="rest-enabled" type="checkbox" role="switch" aria-label="Rest timer" ${state.restEnabled ? "checked" : ""} /></label>
    </div>
    <div id="rest-controls" ${state.restEnabled ? "" : "hidden"}>
      <div class="rest-readout"><strong id="rest-clock" role="timer" aria-live="off"></strong><span id="rest-status" role="status"></span></div>
      <div class="rest-actions"><button type="button" class="secondary rest-start" id="rest-start">Start</button><button type="button" class="secondary" id="rest-pause">Pause</button></div>
      <div class="rest-meter" aria-hidden="true"><span></span></div>
    </div>
    <details class="rest-settings"><summary>Timer settings</summary>
      <label class="field rest-duration">Rest after a set<select id="rest-duration">
        ${restDurationOptions(duration)}
      </select></label>
      <button type="button" class="text-button" id="rest-stop">Reset timer</button>
    </details>
  </section>`;
}

function renderRestTimerState() {
  const clock = document.querySelector("#rest-clock");
  if (!clock) return;
  const snapshot = state.restTimer.snapshot();
  const minutes = Math.floor(snapshot.remainingSeconds / 60);
  const seconds = String(snapshot.remainingSeconds % 60).padStart(2, "0");
  clock.textContent = `${minutes}:${seconds}`;
  // Styling hooks only: the card's state and the share of the rest still to go.
  const card = clock.closest?.(".rest-timer");
  if (card) {
    card.dataset.restState = snapshot.status;
    card.style.setProperty("--rest-left", String(snapshot.durationSeconds ? snapshot.remainingSeconds / snapshot.durationSeconds : 1));
  }
  document.querySelector("#rest-status").textContent = {
    idle: "Ready after a completed set", running: "Resting", paused: "Paused", finished: "Rest complete",
  }[snapshot.status];
  const pause = document.querySelector("#rest-pause");
  pause.textContent = snapshot.status === "paused" ? "Resume" : "Pause";
  pause.disabled = snapshot.status !== "running" && snapshot.status !== "paused";
  document.querySelector("#rest-stop").disabled = snapshot.status === "idle";
}

function bindRestTimer() {
  const enabled = document.querySelector("#rest-enabled");
  if (!enabled) return;
  enabled.addEventListener("change", () => setRestEnabled(enabled.checked));
  document.querySelector("#rest-duration").addEventListener("change", (event) => setRestDuration(Number(event.target.value)));
  document.querySelector("#rest-start").addEventListener("click", () => {
    unlockRestAudio();
    state.restTimer.start();
  });
  document.querySelector("#rest-pause").addEventListener("click", () => {
    if (state.restTimer.snapshot().status === "paused") {
      unlockRestAudio();
      state.restTimer.resume();
    } else state.restTimer.pause();
  });
  document.querySelector("#rest-stop").addEventListener("click", () => state.restTimer.stop());
  renderRestTimerState();
}

// Rest end cue. iOS Safari only plays Web Audio from a context resumed during a tap,
// so Done, Start and Resume unlock it. iOS has no navigator.vibrate.
let restAudio = null;

function unlockRestAudio() {
  const AudioContext = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    restAudio ??= new AudioContext();
    if (restAudio.state !== "running") restAudio.resume().catch(() => {});
  } catch { restAudio = null; }
}

function playRestEndCue() {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* Vibration is optional. */ }
  if (!restAudio) return;
  try {
    const start = restAudio.currentTime;
    for (const offset of [0, 0.3]) {
      const oscillator = restAudio.createOscillator();
      const gain = restAudio.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.5, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.2);
      oscillator.connect(gain);
      gain.connect(restAudio.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.22);
    }
  } catch { /* The visible "Rest complete" status remains the cue. */ }
}

function renderHistoryDetail(data, canRepeat) {
  const { workout, workout_exercises: entries } = data;
  return `<h3>${escapeHtml(workoutTitle(workout))}</h3>
    <p>${workout.muscle_groups?.length ? `${escapeHtml(workout.gym_name)}<br>` : ""}Started ${escapeHtml(formatLocalDateTime(workout.started_at))}<br>Finished ${escapeHtml(formatLocalDateTime(workout.completed_at))}</p>
    ${renderHistoryNote("workout", workout.note, "workout note")}
    ${renderRecordList(entries.flatMap((entry) => (entry.records ?? []).map((record) => ({ ...record, exercise: exerciseDisplayName(entry) }))))}
    ${workout.gym_archived ? `<p class="history-notice">Restore ${escapeHtml(workout.gym_name)} in Manage to repeat this workout.</p>`
      : `${canRepeat ? `<button class="secondary history-repeat" type="button" data-repeat-workout="${workout.id}">Repeat this workout</button>` : `<p class="history-notice">Finish the active workout before repeating this one.</p>`}
        <button class="secondary history-save-routine" type="button" data-save-routine="${workout.id}">Save as routine</button>`}
    <div class="exercise-list">${entries.length ? entries.map((entry) => `
      <article class="exercise-entry">
        ${renderHistoryNote(`exercise:${entry.id}`, entry.note, "note", ` for ${exerciseDisplayName(entry)}`)}
        <div class="history-exercise-heading"><h3>${escapeHtml(exerciseDisplayName(entry))}</h3>${entry.variation_id ? `<button type="button" class="text-button" data-progress-variation="${entry.variation_id}" data-progress-equipment="${escapeHtml(entry.equipment)}" data-progress-manufacturer="${escapeHtml(entry.manufacturer || "")}" data-progress-label="${escapeHtml(entry.label || "")}">View progress</button>` : ""}</div>
        <p class="meta">${escapeHtml(configurationLabel(entry))}</p>
        ${entry.sets.length ? `<ol class="history-sets">${entry.sets.map((set, index, sets) => {
          const label = setLabels(sets.map((item) => item.set_type ?? null), { short: false })[index];
          const lower = label[0].toLowerCase() + label.slice(1);
          const weight = set.weight === null ? "No weight recorded" : `${Math.abs(set.weight)} kg${set.weight < 0 ? " assistance" : ""}`;
          const result = set.result === null ? "No result recorded" : `${set.result} ${entry.tracking_type === "duration" ? "seconds" : "reps"}`;
          const assisted = Boolean(entry.assisted) || set.weight < 0;
          const effort = set.effort ? ` · ${effortText(set.effort)}` : "";
          const side = set.side ? ` ${sideText(set.side, { short: true })}` : "";
          const setRecords = (entry.records ?? []).filter((record) => record.set_id === set.id);
          return `<li><span>${label}${side}: ${escapeHtml(result)} · ${escapeHtml(weight)}${escapeHtml(effort)}</span><span class="meta">${set.completed ? "Completed" : "Not completed"}</span>
            ${setRecords.length ? `<span class="set-record history-set-record">${escapeHtml(recordBadgeText(setRecords))}</span>` : ""}
            ${set.id ? `<div class="history-set-actions"><button type="button" class="text-button history-edit-toggle" data-edit-set="${set.id}">Edit ${lower}</button><button type="button" class="text-button history-delete-set" data-delete-history-set="${set.id}">Delete ${lower}</button></div>
              <form class="history-set-form" data-history-set="${set.id}" data-assisted="${assisted}" hidden>
                <div class="set-inputs">
                  <label>${assisted ? "Assist kg" : "kg"} <input name="weight" type="text" inputmode="decimal" pattern="${WEIGHT_PATTERN}" autocomplete="off" title="A number such as 62.5 or 62,5" value="${set.weight === null ? "" : Math.abs(set.weight)}" /></label>
                  <label>${entry.tracking_type === "duration" ? "Seconds" : "Reps"} <input name="result" type="number" inputmode="numeric" min="1" max="1000000" step="1" value="${set.result ?? ""}" ${set.completed ? "required" : ""} /></label>
                </div>
                ${renderEffortOptions(entry, set)}
                ${renderSetTypeOptions(set)}
                ${renderSideOptions(set)}
                <label class="set-complete"><input name="completed" type="checkbox" ${set.completed ? "checked" : ""} /> Set completed</label>
                <div class="history-edit-actions"><button type="submit" class="secondary">Save correction</button><button type="button" class="text-button" data-cancel-edit>Cancel</button></div>
                <p class="set-status" role="status"></p>
              </form>` : ""}</li>`;
        }).join("")}</ol>` : `<p>No sets recorded.</p>`}
        ${entry.id ? `<button type="button" class="secondary history-add-set" data-add-history-set="${entry.id}" aria-label="Add set to ${escapeHtml(exerciseDisplayName(entry))}">Add set</button>` : ""}
      </article>`).join("") : `<p>No exercises recorded.</p>`}</div>
    <section class="history-danger">
      <button type="button" class="text-button history-delete-workout" data-delete-workout-toggle>Delete workout</button>
      <form class="history-delete-form" data-delete-workout hidden>
        <p>This permanently removes the workout and all its sets from history, progress, and Last workout.</p>
        <label class="field">Type DELETE to confirm <input name="confirmation" autocomplete="off" autocapitalize="characters" spellcheck="false" /></label>
        <div class="history-edit-actions"><button type="submit" class="secondary history-delete-confirm">Delete permanently</button><button type="button" class="text-button" data-cancel-delete-workout>Cancel</button></div>
        <p class="set-status" role="status"></p>
      </form>
    </section>`;
}

// The Completed Workout correction form's Effort choice; Cancel's form.reset() restores the saved one.
function renderEffortOptions(entry, set) {
  return `<fieldset class="effort-options"><legend>Effort</legend><div>
    ${[null, ...effortsFor(entry.tracking_type)].map((value) => `<label><input type="radio" name="effort" value="${value ?? ""}"
      aria-label="${value === null ? "No effort" : effortText(value)}" ${(set.effort ?? null) === value ? "checked" : ""} /><span>${value === null ? "None" : value === "failure" ? "Failure" : value}</span></label>`).join("")}
  </div></fieldset>`;
}

// The Completed Workout correction form's Set Type choice, where Working set is a set without one.
function renderSetTypeOptions(set) {
  return `<fieldset class="effort-options set-type-options"><legend>Set type</legend><div>
    ${[null, ...SET_TYPES].map((value) => `<label><input type="radio" name="set_type" value="${value ?? ""}"
      ${(set.set_type ?? null) === value ? "checked" : ""} /><span>${value ? setTypeText(value) : "Working"}</span></label>`).join("")}
  </div></fieldset>`;
}

// The Completed Workout correction form's Side choice, where Both is a set without a Side.
function renderSideOptions(set) {
  return `<fieldset class="effort-options"><legend>Side</legend><div>
    ${[null, ...SIDES].map((value) => `<label><input type="radio" name="side" value="${value ?? ""}"
      ${(set.side ?? null) === value ? "checked" : ""} /><span>${sideText(value)}</span></label>`).join("")}
  </div></fieldset>`;
}

function renderHistoryNote(target, note = "", label, subject = "") {
  const action = `${note ? "Edit" : "Add"} ${label}`;
  return `${note ? `<p class="note-text">${escapeHtml(note)}</p>` : ""}
    <button type="button" class="text-button history-edit-toggle history-note-toggle" data-edit-note="${target}" aria-label="${escapeHtml(action + subject)}">${action}</button>
    <form class="history-note-form" data-history-note="${target}" hidden>
      <textarea name="note" maxlength="${NOTE_MAX_LENGTH}" rows="3" aria-label="${escapeHtml(`${label[0].toUpperCase()}${label.slice(1)}${subject}`)}">${escapeHtml(note)}</textarea>
      <div class="history-edit-actions"><button type="submit" class="secondary">Save note</button><button type="button" class="text-button" data-cancel-edit>Cancel</button></div>
      <p class="set-status" role="status"></p>
    </form>`;
}

function openHistory(initialWorkoutId = null) {
  if (state.editor?.busy || document.querySelector("#history")) return;
  // Keep the active workout DOM and its local drafts intact beneath the dialog.
  const dialog = document.createElement("dialog");
  dialog.id = "history";
  dialog.className = "history-dialog";
  dialog.setAttribute("aria-labelledby", "history-title");
  dialog.innerHTML = `
    <div class="sheet-header"><div><h2 id="history-title">Workout history</h2><button class="text-button" id="history-back" hidden>Back to history</button></div><button class="text-button" id="close-history" autofocus>Close</button></div>
    <div id="history-list-view">
      <form id="history-filters" class="history-filters">
        <label class="field">Gym<select name="gym_id"><option value="">All gyms</option>${gymOptions()}</select></label>
        <div class="history-dates"><label class="field">From<input type="date" name="start"></label><label class="field">To<input type="date" name="end"></label></div>
        <p>Filter by the day each workout started.</p>
        <button class="secondary" type="submit">Apply filters</button>
      </form>
      <p id="history-message" role="status"></p>
      <div id="history-results" class="exercise-list"></div>
      <div class="history-pages"><button class="secondary" id="history-previous">Newer</button><button class="secondary" id="history-next">Older</button></div>
      <a class="secondary export-link" href="/api/export/workouts.csv" download="gymdex-workouts.csv">Export workouts as CSV</a>
    </div>
    <div id="history-detail-view" hidden><div id="history-detail" tabindex="-1"></div></div>`;
  document.body.append(dialog);
  const find = (selector) => dialog.querySelector(selector);
  const listView = find("#history-list-view");
  const detailView = find("#history-detail-view");
  const message = find("#history-message");
  const results = find("#history-results");
  const previous = find("#history-previous");
  const next = find("#history-next");
  const filters = find("#history-filters");
  const detail = find("#history-detail");
  let query = new URLSearchParams();
  let offset = 0;
  let nextOffset = null;
  let request = 0;
  let selectedButton;
  let selectedDetail;
  let historyChanged = Boolean(initialWorkoutId);
  dialog.addEventListener("close", () => { request++; dialog.remove(); });
  find("#close-history").addEventListener("click", () => dialog.close());
  find("#history-back").addEventListener("click", async () => {
    request++;
    detailView.hidden = true;
    find("#history-back").hidden = true;
    listView.hidden = false;
    if (historyChanged) {
      const selectedId = selectedButton?.dataset.historyId;
      historyChanged = false;
      await loadPage(offset);
      results.querySelector?.(`[data-history-id="${selectedId}"]`)?.focus();
    } else selectedButton?.focus();
  });
  async function showDetail(button) {
    const version = ++request;
    selectedButton = button;
    listView.hidden = true;
    detailView.hidden = false;
    find("#history-back").hidden = false;
    dialog.scrollTop = 0;
    detail.textContent = "Loading workout…";
    find("#history-back").focus();
    try {
      const data = await api(`/api/history/${button.dataset.historyId}`);
      if (version !== request) return;
      selectedDetail = data;
      detail.innerHTML = renderHistoryDetail(data, !state.data.active_workout);
      detail.focus({ preventScroll: true });
      dialog.scrollTop = 0;
    } catch (error) {
      if (version === request) detail.textContent = `${error.message} Return to history and select the workout to retry.`;
    }
  }
  // A changed Completed Workout alters the list counts and the active workout's Last workout values.
  async function rerenderChangedDetail() {
    historyChanged = true;
    if (state.data.active_workout) await load();
    detail.innerHTML = renderHistoryDetail(selectedDetail, !state.data.active_workout);
  }
  detail.addEventListener("click", async (event) => {
    const target = event.target;
    const repeat = target.closest("[data-repeat-workout]");
    if (repeat) {
      if (startBlocked()) return;
      repeat.disabled = true;
      try {
        const repeated = await api(`/api/history/${repeat.dataset.repeatWorkout}/repeat`, { method: "POST", body: "{}" });
        dialog.close();
        await showStartedWorkout(repeated, "Workout repeated. Sets are ready to log.");
      } catch (error) { repeat.disabled = false; showToast(error.message); }
      return;
    }
    if (target.closest("[data-save-routine]") && selectedDetail) {
      const { workout } = selectedDetail;
      await saveWorkoutRoutine(workout);
      return;
    }
    const progress = target.closest("[data-progress-variation]");
    if (progress) {
      dialog.close();
      openProgress(Number(progress.dataset.progressVariation), selectedDetail?.workout.gym_id, {
        equipment: progress.dataset.progressEquipment,
        manufacturer: progress.dataset.progressManufacturer,
        label: progress.dataset.progressLabel,
      });
      return;
    }
    const addSet = target.closest("[data-add-history-set]");
    if (addSet) {
      addSet.disabled = true;
      try {
        const entry = selectedDetail.workout_exercises.find((item) => item.id === Number(addSet.dataset.addHistorySet));
        const added = await api(`/api/history/${selectedDetail.workout.id}/exercises/${entry.id}/sets`, { method: "POST", body: "{}" });
        entry.sets = [...entry.sets, added];
        await rerenderChangedDetail();
        const form = detail.querySelector(`[data-history-set="${added.id}"]`);
        if (form) { form.hidden = false; form.elements.weight.focus(); }
        showToast(`Set ${entry.sets.length} added. Correct it and mark it completed.`);
      } catch (error) { addSet.disabled = false; showToast(error.message); }
      return;
    }
    const deleteSet = target.closest("[data-delete-history-set]");
    if (deleteSet) {
      const setId = Number(deleteSet.dataset.deleteHistorySet);
      const entry = selectedDetail.workout_exercises.find((item) => item.sets.some((set) => set.id === setId));
      const number = entry.sets.findIndex((set) => set.id === setId) + 1;
      if (!await ask(`Delete set ${number} of ${exerciseDisplayName(entry)} from this completed workout? This cannot be undone.`,
        { confirmLabel: "Delete", danger: true })) return;
      deleteSet.disabled = true;
      try {
        await api(`/api/history/${selectedDetail.workout.id}/sets/${setId}`, { method: "DELETE" });
        entry.sets = entry.sets.filter((set) => set.id !== setId).map((set, index) => ({ ...set, position: index + 1 }));
        await rerenderChangedDetail();
        detail.focus();
        showToast(`Set ${number} deleted.`);
      } catch (error) { deleteSet.disabled = false; showToast(error.message); }
      return;
    }
    const deleteWorkout = target.closest("[data-delete-workout-toggle]") || target.closest("[data-cancel-delete-workout]");
    if (deleteWorkout) {
      const form = detail.querySelector("[data-delete-workout]");
      form.reset();
      form.querySelector(".set-status").textContent = "";
      form.hidden = !form.hidden;
      if (!form.hidden) form.elements.confirmation.focus();
      return;
    }
    const noteToggle = target.closest("[data-edit-note]");
    if (noteToggle) {
      const form = detail.querySelector(`[data-history-note="${noteToggle.dataset.editNote}"]`);
      form.hidden = !form.hidden;
      if (form.hidden) form.reset();
      else form.elements.note.focus();
      return;
    }
    const toggle = target.closest("[data-edit-set]");
    if (toggle) {
      const form = detail.querySelector(`[data-history-set="${toggle.dataset.editSet}"]`);
      form.hidden = !form.hidden;
      if (form.hidden) form.reset();
      else form.elements.weight.focus();
      return;
    }
    const cancel = target.closest("[data-cancel-edit]");
    if (cancel) {
      const form = cancel.closest("form");
      form.reset();
      form.hidden = true;
    }
  });
  detail.addEventListener("change", (event) => {
    if (event.target.name === "completed") {
      const form = event.target.closest("form");
      form.elements.result.required = event.target.checked;
    }
  });
  detail.addEventListener("submit", async (event) => {
    const deleteForm = event.target.closest("[data-delete-workout]");
    if (deleteForm && selectedDetail) {
      event.preventDefault();
      const status = deleteForm.querySelector(".set-status");
      if (deleteForm.elements.confirmation.value.trim().toUpperCase() !== "DELETE") {
        status.textContent = "Type DELETE to delete this workout.";
        deleteForm.elements.confirmation.focus();
        return;
      }
      const button = deleteForm.querySelector('[type="submit"]');
      button.disabled = true;
      status.textContent = "Deleting workout…";
      try {
        await api(`/api/history/${selectedDetail.workout.id}`, { method: "DELETE" });
        request++;
        selectedDetail = null;
        historyChanged = false;
        detailView.hidden = true;
        listView.hidden = false;
        if (state.data.active_workout) await load();
        await loadPage(offset);
        (results.querySelector?.("[data-history-id]") ?? find("#close-history")).focus();
        showToast("Workout deleted.");
      } catch (error) { status.textContent = error.message; button.disabled = false; }
      return;
    }
    const form = event.target.closest("[data-history-set]");
    if (!form) return saveHistoryNote(event);
    if (!selectedDetail) return;
    event.preventDefault();
    form.elements.result.required = form.elements.completed.checked;
    if (!form.reportValidity()) return;
    const status = form.querySelector(".set-status");
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    status.textContent = "Saving correction…";
    try {
      const saved = await api(`/api/history/${selectedDetail.workout.id}/sets/${form.dataset.historySet}`, {
        method: "PUT", body: JSON.stringify(setPayload(setValues(form))),
      });
      const entry = selectedDetail.workout_exercises.find((item) => item.sets.some((set) => set.id === saved.id));
      entry.sets = entry.sets.map((set) => set.id === saved.id ? saved : set);
      await rerenderChangedDetail();
      detail.querySelector(`[data-edit-set="${saved.id}"]`)?.focus();
      showToast("Set corrected.");
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
  async function saveHistoryNote(event) {
    const form = event.target.closest("[data-history-note]");
    if (!form || !selectedDetail) return;
    event.preventDefault();
    const target = form.dataset.historyNote;
    const exerciseId = target === "workout" ? null : Number(target.split(":")[1]);
    const status = form.querySelector(".set-status");
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    status.textContent = "Saving note…";
    try {
      const saved = await api(exerciseId ? `/api/workout-exercises/${exerciseId}/note` : `/api/workouts/${selectedDetail.workout.id}/note`, {
        method: "PUT", body: JSON.stringify({ note: form.elements.note.value }),
      });
      const owner = exerciseId ? selectedDetail.workout_exercises.find((item) => item.id === exerciseId) : selectedDetail.workout;
      owner.note = saved.note;
      detail.innerHTML = renderHistoryDetail(selectedDetail, !state.data.active_workout);
      detail.querySelector(`[data-edit-note="${target}"]`)?.focus();
      showToast("Note saved.");
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  }
  async function loadPage(pageOffset) {
    const version = ++request;
    previous.disabled = next.disabled = true;
    results.innerHTML = "";
    message.textContent = "Loading history…";
    const params = new URLSearchParams(query);
    params.set("offset", pageOffset);
    try {
      const data = await api(`/api/history?${params}`);
      if (version !== request) return;
      // Deleting the last workout on an older page empties it: show the newer page instead.
      if (!data.workouts.length && pageOffset > 0) return loadPage(Math.max(0, pageOffset - 20));
      offset = pageOffset;
      nextOffset = data.next_offset;
      message.textContent = data.workouts.length ? "Completed workouts, newest first." : "No completed workouts match these filters.";
      results.innerHTML = data.workouts.map((workout) => `<button class="recent-card" data-history-id="${workout.id}">
        <strong>${escapeHtml(workoutTitle(workout))}</strong><span>${workout.muscle_groups?.length ? `${escapeHtml(workout.gym_name)} · ` : ""}${escapeHtml(formatLocalDateTime(workout.started_at))}</span>
        <span>${workout.exercise_count} exercise${workout.exercise_count === 1 ? "" : "s"} · ${workout.completed_set_count} completed set${workout.completed_set_count === 1 ? "" : "s"}</span></button>`).join("");
      results.querySelectorAll("[data-history-id]").forEach((button) => button.addEventListener("click", () => showDetail(button)));
      previous.disabled = offset === 0;
      next.disabled = nextOffset === null;
    } catch (error) {
      if (version === request) message.textContent = `${error.message} History requires a connection. Use Apply filters to retry.`;
    }
  }
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    // From and To are whole local days: send the UTC instants of their bounding midnights.
    const dayOffsets = { start: 0, end: 1 };
    query = new URLSearchParams([...new FormData(filters)].map(([name, value]) =>
      [name, value && name in dayOffsets ? localMidnightUtc(value, dayOffsets[name]) : value]));
    loadPage(0);
  });
  previous.addEventListener("click", () => loadPage(Math.max(0, offset - 20)));
  next.addEventListener("click", () => { if (nextOffset !== null) loadPage(nextOffset); });
  dialog.showModal();
  if (initialWorkoutId) showDetail({ dataset: { historyId: initialWorkoutId } });
  else loadPage(0);
}

function progressChart(points, metric, unit) {
  const values = points.map((point) => Number(point[metric]));
  const plotted = points.map((point, index) => ({ index, value: values[index] }))
    .filter((point) => points[point.index][metric] !== null && Number.isFinite(point.value));
  if (!plotted.length) return `<p>No ${metric === "best_weight" ? "weight" : unit} values have been recorded.</p>`;
  const low = Math.min(...plotted.map((point) => point.value));
  const high = Math.max(...plotted.map((point) => point.value));
  const span = high - low || 1;
  const xy = plotted.map(({ index, value }) => ({
    x: points.length === 1 ? 176 : 60 + index * 232 / (points.length - 1),
    y: high === low ? 76 : 126 - (value - low) * 100 / span,
  }));
  const path = xy.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const label = metric === "best_weight" ? "Best weight" : `Best ${unit}`;
  return `<svg class="progress-chart" viewBox="0 0 320 180" role="group" aria-labelledby="progress-chart-title progress-chart-desc">
    <title id="progress-chart-title">${escapeHtml(label)} across ${points.length} workouts</title>
    <desc id="progress-chart-desc">Values range from ${escapeHtml(low)} to ${escapeHtml(high)} ${metric === "best_weight" ? "kilograms" : escapeHtml(unit)}. The table below lists each workout.</desc>
    <line x1="60" y1="26" x2="292" y2="26" /><line x1="60" y1="126" x2="292" y2="126" />
    ${xy.length > 1 ? `<polyline points="${path}" />` : ""}
    ${xy.map((point, index) => {
      const source = points[plotted[index].index];
      return `<g role="button" tabindex="0" data-progress-point="${plotted[index].index}" aria-label="View sets from ${escapeHtml(formatLocalDateTime(source.completed_at))}: ${escapeHtml(plotted[index].value)} ${metric === "best_weight" ? "kg" : escapeHtml(unit)}">
        <circle class="point-hit" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="16" />
        <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.5" />
      </g>`;
    }).join("")}
    <text x="60" y="160">${escapeHtml(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(parseServerTime(points[0].completed_at)))}</text>
    ${points.length > 1 ? `<text x="292" y="160" text-anchor="end">${escapeHtml(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(parseServerTime(points.at(-1).completed_at)))}</text>` : ""}
    <text x="4" y="29">${escapeHtml(high)}</text><text x="4" y="129">${escapeHtml(low)}</text>
  </svg>`;
}

function renderProgressData(data, metric) {
  const unit = data.tracking_type === "duration" ? "seconds" : "reps";
  const points = data.points || [];
  return `<h3>${escapeHtml(exerciseDisplayName(data))}</h3>
    <p>${points.length} workout${points.length === 1 ? "" : "s"} with completed sets, oldest to newest.</p>
    ${points.length ? `<label class="field progress-metric">Chart<select id="progress-metric"><option value="best_result" ${metric === "best_result" ? "selected" : ""}>Best ${unit}</option><option value="best_weight" ${metric === "best_weight" ? "selected" : ""}>Best weight</option></select></label>
      ${progressChart(points, metric, unit)}
      <p class="field-help">Tap a point to see its completed sets. Best weight and best ${unit} may come from different sets.</p>
      <div id="progress-point-details" class="progress-point-details" role="status"></div>
      <div class="progress-table-wrap"><table class="progress-table"><caption class="visually-hidden">Completed workout progress</caption><thead><tr><th scope="col">Workout</th><th scope="col">Best ${unit}</th><th scope="col">Best weight</th><th scope="col">Sets</th></tr></thead><tbody>
      ${points.map((point) => `<tr><th scope="row">${escapeHtml(formatLocalDateTime(point.completed_at))}</th><td>${point.best_result ?? "—"}</td><td>${point.best_weight === null ? "—" : `${escapeHtml(Math.abs(point.best_weight))} kg${point.best_weight < 0 ? " assistance" : ""}`}</td><td>${point.completed_sets}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty"><h3>No completed sets yet</h3><p>Finish a workout with completed sets to see progress here.</p></div>`}`;
}

async function openProgress(initialVariationId = null, initialGymId = null, initialConfig = null) {
  const gyms = recordedGyms();
  if (document.querySelector("#progress") || gyms.length === 0) return;
  const dialog = document.createElement("dialog");
  dialog.id = "progress";
  dialog.className = "history-dialog progress-dialog";
  dialog.setAttribute("aria-labelledby", "progress-title");
  dialog.innerHTML = `<div class="sheet-header"><h2 id="progress-title">Exercise progress</h2><button class="text-button" id="close-progress" autofocus>Close</button></div>
    <form id="progress-filters" class="history-filters">
      <div class="field exercise-search" id="progress-exercise-field"></div>
      <label class="field">Gym<select name="gym_id"><option value="">All gyms</option>${gymOptions(initialGymId)}</select></label>
      <button type="submit" class="secondary">Show progress</button>
    </form>
    <div id="progress-config" class="progress-config" ${initialConfig ? "" : "hidden"}><span>Showing this machine configuration</span><button type="button" class="text-button" id="progress-all-configs">Show all equipment</button></div>
    <p id="progress-message" role="status">Loading exercises…</p>
    <div id="progress-results"></div>`;
  document.body.append(dialog);
  const find = (selector) => dialog.querySelector(selector);
  const form = find("#progress-filters");
  let exercise = { value: "" };
  const message = find("#progress-message");
  const results = find("#progress-results");
  let config = initialConfig;
  let currentData = null;
  let metric = "best_result";
  let request = 0;
  let pointRequest = 0;
  dialog.addEventListener("close", () => { request++; dialog.remove(); });
  find("#close-progress").addEventListener("click", () => dialog.close());
  find("#progress-all-configs").addEventListener("click", () => {
    config = null;
    find("#progress-config").hidden = true;
    loadProgress();
  });
  results.addEventListener("change", (event) => {
    if (event.target.id !== "progress-metric" || !currentData) return;
    pointRequest++;
    metric = event.target.value;
    results.innerHTML = renderProgressData(currentData, metric);
  });
  async function showProgressPoint(target) {
    const point = currentData?.points[Number(target.dataset.progressPoint)];
    if (!point) return;
    const version = ++pointRequest;
    const selectedConfig = config && { ...config };
    const variationId = currentData.variation_id;
    const panel = find("#progress-point-details");
    panel.textContent = "Loading completed sets…";
    try {
      const detail = await api(`/api/history/${point.workout_id}`);
      if (version !== pointRequest || !dialog.open) return;
      const entries = detail.workout_exercises.filter(entry => entry.variation_id === variationId
        && (!selectedConfig || ["equipment", "manufacturer", "label"].every(field => (entry[field] ?? "") === (selectedConfig[field] ?? ""))));
      panel.innerHTML = `<p><strong>${escapeHtml(formatLocalDateTime(point.completed_at))}</strong> · ${escapeHtml(detail.workout.gym_name)}</p>
        ${entries.map(entry => `<p>${escapeHtml(configurationLabel(entry))}</p><ul>${entry.sets.filter(set => set.completed && set.set_type !== "warmup").map(set =>
          `<li>${set.side ? `${sideText(set.side)} · ` : ""}${set.result} ${entry.tracking_type === "duration" ? "seconds" : "reps"} · ${set.weight === null ? "No weight recorded" : `${Math.abs(set.weight)} kg${set.weight < 0 ? " assistance" : ""}`}${set.effort ? ` · ${effortText(set.effort)}` : ""}</li>`).join("")}</ul>`).join("") || "<p>No matching completed sets remain.</p>"}`;
      panel.scrollIntoView?.({ block: "nearest" });
    } catch (error) { if (version === pointRequest && dialog.open) panel.textContent = error.message; }
  }
  results.addEventListener("click", event => {
    const point = event.target.closest?.("[data-progress-point]");
    if (point) showProgressPoint(point);
  });
  results.addEventListener("keydown", event => {
    const point = event.target.closest?.("[data-progress-point]");
    if (point && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); showProgressPoint(point); }
  });
  async function loadProgress() {
    pointRequest++;
    const version = ++request;
    const variationId = exercise.value;
    if (!variationId) return;
    const params = new URLSearchParams({ variation_id: variationId });
    if (form.elements.gym_id.value) params.set("gym_id", form.elements.gym_id.value);
    if (config) for (const field of ["equipment", "manufacturer", "label"]) params.set(field, config[field] ?? "");
    message.textContent = "Loading progress…";
    results.innerHTML = "";
    try {
      const data = await api(`/api/progress?${params}`);
      if (version !== request) return;
      currentData = data;
      message.textContent = "";
      results.innerHTML = renderProgressData(data, metric);
    } catch (error) { if (version === request) message.textContent = error.message; }
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); loadProgress(); });
  form.addEventListener("change", (event) => {
    // Typing in the Exercise search only narrows its list; choosing a match reloads.
    if (event?.target?.id === "progress-exercise-search") return;
    config = null;
    find("#progress-config").hidden = true;
    loadProgress();
  });
  dialog.showModal();
  try {
    // Archived custom variations stay selectable: their recorded workouts still have progress.
    const catalog = await api(`/api/catalog?gym_id=${gyms[0].id}&include_archived=1`);
    if (!dialog.open) return;
    // Alphabetical, searchable by exercise and variation name; choosing one shows its progress.
    exercise = new ExerciseSearch(find("#progress-exercise-field"), {
      id: "progress-exercise", label: "Exercise", selectedId: initialVariationId,
      items: catalog.catalog.map((item) => ({ id: item.id, name: exerciseDisplayName(item),
        texts: [exerciseDisplayName(item), item.exercise_name, item.variation_name], note: item.archived ? "(archived)" : "" })),
      onChange: () => {
        config = null;
        find("#progress-config").hidden = true;
        loadProgress();
      },
    });
    if (!catalog.catalog.length) {
      message.textContent = "No exercises yet. Create one from a workout.";
      return;
    }
    await loadProgress();
  } catch (error) { if (dialog.open) message.textContent = error.message; }
}

// Manage renames, removes and restores the items new workouts are built from. Removing
// deletes a never-used item and archives a used one; the server decides which.
// A row's data-manage-* attributes hold "kind:id", and MANAGE_PATHS maps each kind to its API path.
const MANAGE_PATHS = { gym: "gyms", configuration: "configurations", exercise: "exercises", variation: "variations" };

function manageItems(overview, kind) {
  if (kind === "gym") return overview.gyms;
  if (kind === "configuration") return overview.configurations;
  if (kind === "exercise") return overview.exercises;
  if (kind === "variation") return overview.exercises.flatMap((exercise) =>
    exercise.variations.map((variation) => ({ ...variation, exercise_id: exercise.id, exercise_name: exercise.name, variation_name: variation.name })));
  return [];
}

// Names an item in confirmations, toasts and aria-labels. A configuration adds its equipment
// details, which tell apart several configurations of one exercise at a gym.
function manageItemName(kind, item) {
  if (kind === "configuration") return `${exerciseDisplayName(item)} (${configurationLabel(item)})`;
  return kind === "variation" ? exerciseDisplayName(item) : item.name;
}

// shown is the visible name when the row's detail line already says the rest of name.
function renderManageRow(kind, item, { name = manageItemName(kind, item), shown = name, detail = "", rename = false, remove = true, actions: more = "", editor = "" } = {}) {
  const key = `${kind}:${item.id}`;
  const label = escapeHtml(name);
  const removeLabel = kind === "configuration" || !item.used ? "Delete" : "Archive";
  const actions = item.archived
    ? `<button type="button" class="text-button" data-manage-restore="${key}" aria-label="Restore ${label}">Restore</button>`
    : `${rename ? `<button type="button" class="text-button" data-manage-rename="${key}" aria-label="Rename ${label}">Rename</button>` : ""}${more}${remove ? `<button type="button" class="text-button manage-remove" data-manage-remove="${key}" aria-label="${removeLabel} ${label}">${removeLabel}</button>` : ""}`;
  return `<li class="manage-row">
    <div class="manage-row-text"><span class="manage-name">${escapeHtml(shown)}</span>${detail ? `<span class="meta">${escapeHtml(detail)}</span>` : ""}</div>
    ${actions ? `<div class="manage-actions">${actions}</div>` : ""}
    ${rename && !item.archived ? `<form class="manage-rename-form" data-manage-rename-form="${key}" hidden>
      <label class="field">New name<input name="name" maxlength="80" value="${label}" required autocomplete="off" /></label>
      <div class="history-edit-actions"><button type="submit" class="secondary">Save name</button><button type="button" class="text-button" data-manage-cancel>Cancel</button></div>
      <p class="set-status" role="status"></p>
    </form>` : ""}
    ${item.archived ? "" : editor}
  </li>`;
}

// Optional Muscle Groups are intentional training targets shared by every Configuration.
function renderMuscleGroupChoices(groups, selected = []) {
  return `<fieldset class="muscle-group-options"><legend>Muscle Groups <small>(optional)</small></legend>
    <p class="field-help">Choose the areas this Variation is intentionally selected to train.</p>
    <div>${groups.map((group) => `<label class="assistance-option"><input type="checkbox" name="muscle_group" value="${escapeHtml(group)}"${selected.includes(group) ? " checked" : ""} />${escapeHtml(group)}</label>`).join("")}</div>
  </fieldset>`;
}

function selectedMuscleGroups(form) {
  return [...form.querySelectorAll('input[name="muscle_group"]:checked')].map((input) => input.value);
}

function renderMuscleGroupEditor(variation, groups, open) {
  const key = `variation:${variation.id}`;
  return `<form class="manage-rename-form" data-manage-muscle-groups-form="${key}"${open.has(`muscle-groups:${key}`) ? "" : " hidden"}>
    ${renderMuscleGroupChoices(groups, variation.muscle_groups ?? [])}
    <div class="history-edit-actions"><button type="submit" class="secondary">Save Muscle Groups</button><button type="submit" class="text-button" value="clear">Clear</button></div>
    <p class="set-status" role="status"></p>
  </form>`;
}

// A custom Variation's Equipment editor. Values recorded in workouts, and the last value, stay.
function renderEquipmentEditor(variation, open) {
  const key = `variation:${variation.id}`;
  const names = variation.equipment.map((equipment) => equipment.name);
  const label = escapeHtml(exerciseDisplayName(variation));
  const removable = (index) => !variation.equipment[index].used && names.length > 1;
  return `<form class="manage-rename-form manage-equipment-form" data-manage-equipment-form="${key}"${open.has(`equipment:${key}`) ? "" : " hidden"}>
      <ul class="equipment-chips" aria-label="Equipment options for ${label}">${renderEquipmentChips(names, removable)}</ul>
      ${variation.equipment.some((equipment) => equipment.used) ? `<p class="field-help">Equipment used in recorded workouts can't be removed.</p>` : ""}
      <label for="manage-equipment-${variation.id}">Add equipment</label>
      <div class="equipment-entry"><input id="manage-equipment-${variation.id}" name="equipment" maxlength="80" autocomplete="off" enterkeyhint="done" /><button type="submit" class="secondary">Add</button></div>
      <p class="set-status" role="status"></p>
    </form>`;
}

// Custom Exercise Variations grouped by Exercise; archived ones are listed under Archived.
function renderCustomExercises(overview, open) {
  const variations = manageItems(overview, "variation");
  const active = variations.filter((variation) => !variation.archived);
  const archived = variations.filter((variation) => variation.archived);
  const groups = overview.exercises.map((exercise) => {
    const members = active.filter((variation) => variation.exercise_id === exercise.id);
    if (!members.length) return "";
    return `<ul class="manage-list manage-exercise">${renderManageRow("exercise", exercise, { rename: exercise.renamable, remove: false,
      detail: exercise.renamable ? "" : "Starter catalog exercise" })}</ul>
      <ul class="manage-list manage-variations">${members.map((variation) => renderManageRow("variation", variation, { name: variation.name, rename: true,
        detail: [variation.tracking_type === "duration" ? "Duration" : "Repetitions", ...variation.equipment.map((equipment) => equipment.name), ...(variation.muscle_groups ?? [])].join(" · "),
        actions: `<button type="button" class="text-button" data-manage-equipment="variation:${variation.id}" aria-label="Edit equipment of ${escapeHtml(exerciseDisplayName(variation))}">Equipment</button><button type="button" class="text-button" data-manage-muscle-groups="variation:${variation.id}" aria-label="Edit Muscle Groups of ${escapeHtml(exerciseDisplayName(variation))}">Muscle Groups</button>`,
        editor: renderEquipmentEditor(variation, open) + renderMuscleGroupEditor(variation, overview.muscle_groups ?? [], open) })).join("")}</ul>`;
  }).join("");
  return renderManageSection("exercises", "Custom Exercise Variations", active.length, variations.length ? `
      <p class="manage-help">Delete removes a variation with no workouts. Archive keeps a variation with workouts in history and progress but stops offering it in the exercise picker.</p>
      ${groups || "<p>All custom variations are archived.</p>"}
      ${renderManageArchived("exercises", archived.map((variation) => renderManageRow("variation", variation, { detail: (variation.muscle_groups ?? []).join(" · ") })), open)}`
    : `<p>No custom variations yet. Create one with Create custom exercise when adding an exercise to a workout.</p>`, open);
}

function renderManageSection(section, title, count, body, open) {
  return `<details class="manage-section" data-section="${section}"${open.has(section) ? " open" : ""}>
    <summary><h3>${title}</h3><span>${count}</span></summary>${body}</details>`;
}

function renderManageArchived(section, rows, open) {
  if (!rows.length) return "";
  return `<details class="manage-archived" data-section="${section}-archived"${open.has(`${section}-archived`) ? " open" : ""}>
    <summary>Archived (${rows.length})</summary><ul class="manage-list">${rows.join("")}</ul></details>`;
}

// Groups items under headings, keeping the server's order.
function renderManageGroups(items, heading, row) {
  const groups = new Map();
  for (const item of items) {
    const title = heading(item);
    groups.set(title, [...(groups.get(title) ?? []), item]);
  }
  return [...groups].map(([title, members]) => `<h4 class="manage-group">${escapeHtml(title)}</h4><ul class="manage-list">${members.map(row).join("")}</ul>`).join("");
}

function renderManage(overview, open) {
  const gyms = overview.gyms.filter((gym) => !gym.archived);
  const archivedGyms = overview.gyms.filter((gym) => gym.archived);
  const configurations = overview.configurations.filter((item) => !item.archived);
  const archivedConfigurations = overview.configurations.filter((item) => item.archived);
  const configurationDetail = (item) => item.variation_archived
    ? `${configurationLabel(item)} · Recent hides it while ${exerciseDisplayName(item)} is archived` : configurationLabel(item);
  return [
    renderManageSection("gyms", "Gyms", gyms.length, `
      <p class="manage-help">Delete removes a gym with no workouts. Archive keeps a gym with workouts in history and progress but stops offering it on the start screen.</p>
      ${gyms.length ? `<ul class="manage-list">${gyms.map((gym) => renderManageRow("gym", gym, { rename: true })).join("")}</ul>` : `<p>No gyms to manage.</p>`}
      ${renderManageArchived("gyms", archivedGyms.map((gym) => renderManageRow("gym", gym)), open)}`, open),
    renderManageSection("configurations", "Exercise Configurations", configurations.length, `
      <p class="manage-help">Saved for a gym when you add an exercise there, and offered under Recent. Delete removes this saved choice without deleting recorded Sets or history. Used choices stay under Archived with Restore and are skipped by Repeat and when starting a Routine. Choosing the same exercise, equipment, manufacturer and label again restores one; unused choices are removed permanently.</p>
      ${configurations.length ? renderManageGroups(configurations, (item) => `${item.gym_name}${item.gym_archived ? " (archived)" : ""}`,
        (item) => renderManageRow("configuration", item, { shown: exerciseDisplayName(item), detail: configurationDetail(item) }))
        : `<p>No exercise configurations yet. Add an exercise to a workout to save one.</p>`}
      ${renderManageArchived("configurations", archivedConfigurations.map((item) =>
        renderManageRow("configuration", item, { shown: exerciseDisplayName(item), detail: `${item.gym_name} · ${configurationLabel(item)}` })), open)}`, open),
    renderCustomExercises(overview, open),
  ].join("");
}

function openManage() {
  if (document.querySelector("#manage")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "manage";
  dialog.className = "history-dialog manage-dialog";
  dialog.setAttribute("aria-labelledby", "manage-title");
  dialog.innerHTML = `<div class="sheet-header"><h2 id="manage-title">Manage</h2><button class="text-button" id="close-manage" autofocus>Close</button></div>
    <p id="manage-message" role="status">Loading…</p>
    <div id="manage-content" tabindex="-1"></div>`;
  document.body.append(dialog);
  const find = (selector) => dialog.querySelector(selector);
  const message = find("#manage-message");
  const content = find("#manage-content");
  // Re-rendering keeps each section open or closed as the user left it.
  const open = new Set(["gyms"]);
  let overview = null;
  let request = 0;
  dialog.addEventListener("close", () => {
    request++;
    dialog.remove();
    document.querySelector("#open-manage")?.focus();
  });
  find("#close-manage").addEventListener("click", () => dialog.close());
  content.addEventListener("toggle", (event) => {
    const section = event.target.dataset?.section;
    if (section && event.target.open) open.add(section);
    else if (section) open.delete(section);
  }, true);
  async function refresh() {
    const version = ++request;
    try {
      const data = await api("/api/manage");
      if (version !== request) return;
      overview = data;
      message.textContent = "";
      content.innerHTML = renderManage(overview, open);
    } catch (error) {
      if (version === request) message.textContent = `${error.message} Manage requires a connection. Close it and open it again to retry.`;
    }
  }
  // A change shows in Manage and on the start screen beneath it.
  async function changed(notice) {
    showToast(notice);
    await refresh();
    await load();
    content.focus();
  }
  const itemFor = (key) => {
    const [kind, id] = key.split(":");
    const item = overview && manageItems(overview, kind).find((entry) => entry.id === Number(id));
    return item && { kind, item, name: manageItemName(kind, item), path: `/api/manage/${MANAGE_PATHS[kind]}/${Number(id)}` };
  };
  content.addEventListener("click", async (event) => {
    const target = event.target;
    const rename = target.closest?.("[data-manage-rename]");
    if (rename) {
      const form = content.querySelector(`[data-manage-rename-form="${rename.dataset.manageRename}"]`);
      form.hidden = !form.hidden;
      if (form.hidden) form.reset();
      else form.elements.name.focus();
      return;
    }
    const muscleGroups = target.closest?.("[data-manage-muscle-groups]");
    if (muscleGroups) {
      const key = muscleGroups.dataset.manageMuscleGroups;
      const form = content.querySelector(`[data-manage-muscle-groups-form="${key}"]`);
      form.hidden = !form.hidden;
      if (form.hidden) open.delete(`muscle-groups:${key}`);
      else { open.add(`muscle-groups:${key}`); form.querySelector("input")?.focus(); }
      return;
    }
    const equipment = target.closest?.("[data-manage-equipment]");
    if (equipment) {
      const key = equipment.dataset.manageEquipment;
      const form = content.querySelector(`[data-manage-equipment-form="${key}"]`);
      form.hidden = !form.hidden;
      if (form.hidden) open.delete(`equipment:${key}`);
      else { open.add(`equipment:${key}`); form.elements.equipment.focus(); }
      return;
    }
    const chip = target.closest?.("[data-remove-equipment]");
    if (chip) {
      const form = chip.closest("[data-manage-equipment-form]");
      const selected = itemFor(form.dataset.manageEquipmentForm);
      if (!selected) return;
      const names = selected.item.equipment.map((item) => item.name);
      const [removed] = names.splice(Number(chip.dataset.removeEquipment), 1);
      return saveEquipment(form, selected, names, `Removed ${removed}.`);
    }
    const cancel = target.closest?.("[data-manage-cancel]");
    if (cancel) {
      const form = cancel.closest("form");
      form.reset();
      form.hidden = true;
      return;
    }
    const remove = target.closest?.("[data-manage-remove]");
    const restore = target.closest?.("[data-manage-restore]");
    const selected = remove ? itemFor(remove.dataset.manageRemove) : restore ? itemFor(restore.dataset.manageRestore) : null;
    if (!selected) return;
    const { kind, item, name, path } = selected;
    const button = remove || restore;
    if (remove && !await ask(kind === "configuration" && item.used
      ? `Delete ${name}? Recorded Sets and history stay. This saved choice is no longer offered in Recent and is skipped by Repeat and when starting a Routine. Restore it under Archived, or choose the same exercise, equipment, manufacturer and label again.`
      : item.used
      ? `Archive ${name}? It is used in recorded workouts, so it stays in history and progress but is no longer offered for new workouts. You can restore it here.`
      : `Delete ${name}? It has never been used in a workout, so it is removed permanently.`,
    { confirmLabel: kind === "configuration" || !item.used ? "Delete" : "Archive", danger: true })) return;
    button.disabled = true;
    try {
      if (remove) {
        const { outcome } = await api(path, { method: "DELETE" });
        await changed(kind === "configuration"
          ? `${name} deleted.${outcome === "archived" ? " Recorded Sets and history stay. Restore it under Archived." : ""}`
          : `${name} ${outcome}.`);
      } else {
        await api(`${path}/restore`, { method: "POST", body: "{}" });
        await changed(`${name} restored.`);
      }
    } catch (error) { button.disabled = false; showToast(error.message); }
  });
  // Saves a Variation's full Equipment list and keeps its editor open for the next change.
  async function saveEquipment(form, selected, names, notice) {
    const status = form.querySelector(".set-status");
    status.textContent = "Saving equipment…";
    try {
      await api(selected.path, { method: "PUT", body: JSON.stringify({ equipment: names }) });
      showToast(notice);
      await refresh();
      content.querySelector(`[data-manage-equipment-form="${form.dataset.manageEquipmentForm}"]`)?.elements.equipment.focus();
    } catch (error) { status.textContent = error.message; }
  }
  content.addEventListener("submit", async (event) => {
    const muscleGroupForm = event.target.closest?.("[data-manage-muscle-groups-form]");
    if (muscleGroupForm) {
      event.preventDefault();
      const selected = itemFor(muscleGroupForm.dataset.manageMuscleGroupsForm);
      if (!selected) return;
      const status = muscleGroupForm.querySelector(".set-status");
      const buttons = muscleGroupForm.querySelectorAll('[type="submit"]');
      buttons.forEach((button) => { button.disabled = true; });
      status.textContent = "Saving Muscle Groups…";
      try {
        const groups = event.submitter?.value === "clear" ? [] : selectedMuscleGroups(muscleGroupForm);
        await api(selected.path, { method: "PUT", body: JSON.stringify({ muscle_groups: groups }) });
        showToast(groups.length ? "Muscle Groups saved." : "Muscle Groups cleared.");
        await refresh();
        content.querySelector(`[data-manage-muscle-groups-form="${muscleGroupForm.dataset.manageMuscleGroupsForm}"]`)?.querySelector("input")?.focus();
      } catch (error) { status.textContent = error.message; buttons.forEach((button) => { button.disabled = false; }); }
      return;
    }
    const equipmentForm = event.target.closest?.("[data-manage-equipment-form]");
    if (equipmentForm) {
      event.preventDefault();
      const selected = itemFor(equipmentForm.dataset.manageEquipmentForm);
      const name = cleanEquipmentName(equipmentForm.elements.equipment.value);
      if (!selected || !name) return;
      const names = selected.item.equipment.map((item) => item.name);
      const problem = equipmentProblem(names, name);
      if (problem) { equipmentForm.querySelector(".set-status").textContent = problem; return; }
      return saveEquipment(equipmentForm, selected, [...names, name], `Added ${name}.`);
    }
    const form = event.target.closest?.("[data-manage-rename-form]");
    if (!form) return;
    event.preventDefault();
    const selected = itemFor(form.dataset.manageRenameForm);
    if (!selected) return;
    const status = form.querySelector(".set-status");
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    status.textContent = "Saving name…";
    try {
      const saved = await api(selected.path, { method: "PUT", body: JSON.stringify({ name: form.elements.name.value }) });
      await changed(`Renamed to ${saved.name}.`);
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
  dialog.showModal();
  return refresh();
}

function resetEditor() {
  state.editor = state.data.active_workout ? new WorkoutEditor({
    data: state.data, drafts, request: api, onChange: syncEditorView, outbox,
    schedule: setTimeout, clear: clearTimeout, online: () => navigator.onLine,
  }) : null;
}

// A temporary id became the server's (see outbox.mjs).
function remapId(type, from, to) {
  if (state.editor && state.data?.active_workout) state.editor.remap(type, from, to);
  else if (state.data) { renameId(state.data, type, from, to); drafts.snapshot(state.data); }
  if (type === "set" && copiedSets.delete(from)) copiedSets.add(to);
  if (type === "entry" && state.collapsedExercises.delete(from)) state.collapsedExercises.add(to);
  scheduleWorkoutRender();
}

// Synced ids and the server's Last workout show without disturbing what is being typed:
// one re-render after the answers settle, keeping focus and the caret in the same field.
function scheduleWorkoutRender() {
  if (state.workoutRenderTimer) return;
  state.workoutRenderTimer = setTimeout(() => {
    state.workoutRenderTimer = null;
    if (!state.data?.active_workout) return;
    const active = document.activeElement;
    const form = active?.closest?.(".set-form");
    const note = active?.dataset?.noteTarget;
    // Exercise buttons (Edit machine, Add set, ⋯) keep focus too, following a temporary id to the server's.
    const button = ["data-change-machine", "data-add-set", "data-exercise-more"].find((name) => active?.hasAttribute?.(name));
    const memo = { setId: form && formSetId(form), name: active?.name, note, button, entry: button && Number(active.getAttribute(button)),
      start: active?.selectionStart, end: active?.selectionEnd };
    render();
    let target = null;
    if (memo.setId) target = document.querySelector(`.set-form[data-set-id="${outbox.resolve(memo.setId)}"]`)?.elements?.[memo.name];
    else if (memo.note) {
      const [kind, id] = memo.note.split(":");
      target = document.querySelector(`[data-note-target="${id ? `${kind}:${outbox.resolve(Number(id))}` : kind}"]`);
    } else if (memo.button) target = document.querySelector(`[${memo.button}="${outbox.resolve(memo.entry)}"]`);
    if (!target) return;
    target.focus?.({ preventScroll: true });
    try { if (typeof memo.start === "number") target.setSelectionRange?.(memo.start, memo.end); } catch { /* Not a text field. */ }
  }, 0);
}

// A new workout waits until the last one's queued changes have reached the server.
function startBlocked() {
  if (!outbox.size) return false;
  outbox.kick();
  showToast("Your last workout is still syncing from this phone. Connect to the internet and wait for Synced, then start a new one.");
  return true;
}

// Each Gym's catalog is kept on the phone, so Add exercise, Replace and machine changes work offline.
const catalogKey = (gymId) => `gymdex:catalog:v1:${gymId}`;
async function loadCatalog(gymId) {
  let cached = null;
  try { cached = JSON.parse(window.localStorage.getItem(catalogKey(gymId))); } catch { cached = null; }
  if (cached && (state.unavailable || !navigator.onLine)) return cached;
  try {
    // With a copy on the phone, a slow gym connection gets three seconds before the copy is used.
    const fresh = await api(`/api/catalog?gym_id=${gymId}`, cached ? { timeout: 3000 } : {});
    try { window.localStorage.setItem(catalogKey(gymId), JSON.stringify(fresh)); } catch { /* Kept for this page only. */ }
    return fresh;
  } catch (error) {
    if (cached && !error.status) return cached;
    if (!error.status) throw new Error("The exercise list needs a connection the first time. Try again when you are online.");
    throw error;
  }
}

// What a picked choice shows in the workout until the server answers: its Variation from the
// catalog, and the saved Exercise Configuration for a Recent or saved choice.
function pickedEntry(choice) {
  const picker = state.picker ?? {};
  const profile = choice.profile_id
    ? [...(picker.saved ?? []), ...(picker.recent ?? [])].find((item) => item.profile_id === choice.profile_id) : null;
  const variationId = profile?.variation_id ?? choice.variation_id;
  const variation = (picker.catalog ?? []).find((item) => item.id === variationId);
  if (!variation && !profile) return null;
  return {
    variation_id: variationId,
    exercise_name: variation?.exercise_name ?? profile.exercise_name,
    variation_name: variation?.variation_name ?? profile.variation_name,
    equipment: profile?.equipment ?? choice.equipment,
    manufacturer: (profile?.manufacturer ?? choice.manufacturer ?? "").trim(),
    label: (profile?.label ?? choice.label ?? "").trim(),
    tracking_type: variation?.tracking_type ?? "repetitions",
    assisted: Boolean(variation?.assisted),
  };
}

function syncEditorView() {
  const busy = Boolean(state.editor?.busy);
  const main = document.querySelector("main");
  if (main) main.inert = busy || Boolean(document.querySelector("#picker"));
  document.querySelectorAll("[data-finish-workout], #cancel-workout").forEach((button) => { button.disabled = busy; });
  document.querySelectorAll(".set-form").forEach((form) => {
    const status = state.editor?.status(form.dataset.setId);
    if (!status) return;
    if (status.dirty) form.dataset.dirty = "true";
    else delete form.dataset.dirty;
    form.querySelector("fieldset").disabled = status.removing;
    if (status.message) setStatus(form, status.message, status.error, isSettled(status));
    form.querySelector(".set-retry").hidden = !status.blocked || status.saving;
    const saved = state.data.workout_exercises.flatMap((entry) => entry.sets)
      .find((set) => set.id === formSetId(form));
    if (saved) form.classList.toggle("is-complete", Boolean(state.editor.localSet(saved).completed));
  });
  syncRecordBadges();
  document.querySelectorAll("[data-note-target]").forEach((field) => {
    const target = field.dataset.noteTarget;
    const status = state.editor?.noteStatus(target);
    if (!status) return;
    if (status.dirty) field.dataset.dirty = "true";
    else delete field.dataset.dirty;
    const message = document.querySelector(`[data-note-status="${target}"]`);
    if (message) showStatus(message, `note:${target}`, status.message, status.error, isSettled(status));
    const summary = document.querySelector(`[data-note-summary="${target}"]`);
    if (summary) summary.textContent = noteLabel(summary.dataset.label, status.note);
    const preview = document.querySelector(`[data-note-preview="${target}"]`);
    if (preview) preview.textContent = status.note;
  });
  document.querySelectorAll("[data-exercise-count]").forEach((label) => {
    const entry = state.data.workout_exercises.find(item => item.id === outbox.resolve(Number(label.dataset.exerciseCount)));
    if (entry) label.textContent = `${localSets(entry).filter(set => set.completed).length}/${entry.sets.length} done`;
  });
  updateSyncStatus();
}

async function finishWorkout() {
  await endWorkout(false);
}

async function cancelWorkout() {
  await endWorkout(true);
}

async function endWorkout(cancel) {
  const editor = state.editor;
  if (!editor || editor.busy) return;
  const gymId = state.data.active_workout.gym_id;
  // Finishing saves drafts before asking, so a false result without the question means a draft blocked it.
  let asked = false;
  // The button is disabled while the sheet asks, so focus returns to it once the workout is editable again.
  const origin = document.activeElement;
  let summary = null;
  const confirm = async () => {
    asked = true;
    const confirmed = await (cancel
    ? ask("Cancel this workout and discard all its exercises and sets? This cannot be undone.", { confirmLabel: "Cancel workout", danger: true })
    : ask("Finish this workout?", { confirmLabel: "Finish", cancelLabel: "Back" }));
    if (confirmed && !cancel) summary = {
      workout: { ...state.data.active_workout },
      duration: formatElapsed(elapsedMinutes(state.data.active_workout)),
      sets: state.data.workout_exercises.reduce((count, entry) => count + localSets(entry).filter(set => set.completed).length, 0),
      exercises: state.data.workout_exercises.filter(entry => localSets(entry).some(set => set.completed)).length,
      records: state.data.workout_exercises.flatMap((entry) => liveRecords(entry).map((record) => ({ ...record, exercise: exerciseDisplayName(entry) }))),
    };
    return confirmed;
  };
  try {
    const ended = await (cancel ? editor.cancel(confirm) : editor.finish(confirm));
    if (!ended) {
      if (!asked) showInvalidSet(cancel ? "Not canceled yet" : "Not finished yet");
      else origin?.focus();
      return;
    }
    state.restTimer.stop();
    forgetWorkoutMarks();
    state.summary = summary;
    state.selectedGymId = gymId;
    await load();
    if (summary) {
      document.querySelector("#finish-summary-title")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    showToast(cancel ? "Workout canceled."
      : outbox.size && (state.unavailable || !navigator.onLine) ? "Workout finished on this phone. It syncs when you are back online." : "Workout finished.");
  } catch (error) { showToast(error.message); }
}

async function openPicker() {
  // A slow catalog load must not open the picker once per tap.
  if (state.openingPicker) return;
  state.openingPicker = true;
  try {
    state.picker = await loadCatalog(state.data.active_workout.gym_id);
    newPickerSession();
    state.pickerReplace = null;
    state.selectedExercise = null;
    state.selectedEquipment = null;
    state.pickerQuery = "";
    state.pickerMuscleGroup = "";
    renderPicker();
  } catch (error) { showToast(error.message); }
  finally { state.openingPicker = false; }
}

// Opens the bottom sheet that Add exercise and Change machine render into (#picker .sheet).
function openSheet(content) {
  let wrapper = document.querySelector("#picker");
  if (!wrapper) {
    const origin = document.activeElement;
    wrapper = document.createElement("dialog");
    wrapper.id = "picker";
    wrapper.className = "sheet-backdrop";
    wrapper.setAttribute("aria-labelledby", "picker-title");
    wrapper.cleanup = () => {
      if (wrapper.cleaned) return;
      wrapper.cleaned = true;
      wrapper.remove();
      state.pickerContext = null;
      state.pickerReplace = null;
      document.querySelector("main")?.removeAttribute("inert");
      if (origin?.isConnected) origin.focus();
      else document.querySelector("#open-picker")?.focus();
    };
    wrapper.addEventListener("close", () => wrapper.cleanup());
    wrapper.addEventListener("click", (event) => { if (event.target === wrapper) closePicker(); });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...wrapper.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]')]
        .filter(item => !item.disabled && item.tabIndex >= 0 && item.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    document.body.append(wrapper);
  }
  wrapper.innerHTML = `<section class="sheet">${content}</section>`;
  if (!wrapper.open) wrapper.showModal();
}

async function openRoutineCatalog(gym, routine, onSave) {
  state.picker = await api(`/api/catalog?gym_id=${gym.id}`);
  state.pickerContext = { gym, routine, onSave };
  state.pickerReplace = null;
  state.selectedExercise = null;
  state.selectedEquipment = null;
  state.pickerQuery = "";
  state.pickerMuscleGroup = "";
  renderPicker();
}

function renderPicker(query = state.pickerQuery) {
  state.pickerQuery = query;
  const replacing = state.pickerReplace;
  openSheet(`
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-header"><h2 id="picker-title">${replacing ? "Replace exercise" : "Add exercise"}</h2><button class="text-button" id="close-picker">${replacing ? "Cancel" : "Close"}</button></div>
      ${replacing ? `<p>${escapeHtml(exerciseDisplayName(replacing.entry))} keeps its note and set slots. Weight, reps or seconds, and effort that no longer match are cleared.</p>` : ""}
      <input class="search" id="exercise-search" type="search" inputmode="search" autocomplete="off" placeholder="Search exercises" aria-label="Search exercises" value="${escapeHtml(query)}" />
      <button type="button" class="filter-chip" id="muscle-group-chip"${state.pickerMuscleGroup ? "" : " hidden"}></button>
      <div class="picker-filters">
        <label class="field">Muscle Group<select id="muscle-group-filter"><option value="">All Muscle Groups</option>${(state.picker.muscle_groups ?? []).map((group) => `<option value="${escapeHtml(group)}"${state.pickerMuscleGroup === group ? " selected" : ""}>${escapeHtml(group)}</option>`).join("")}</select></label>
        <button type="button" class="text-button" id="clear-muscle-group-filter"${state.pickerMuscleGroup ? "" : " hidden"}>Clear filter</button>
      </div>
      <div id="picker-results"></div>`);
  document.querySelector("#picker .sheet").className = "sheet picker-catalog";
  const search = document.querySelector("#exercise-search");
  search.focus();
  search.setSelectionRange(search.value.length, search.value.length);
  search.addEventListener("input", (event) => renderPickerResults(event.target.value));
  const muscleGroup = document.querySelector("#muscle-group-filter");
  muscleGroup.addEventListener("change", () => {
    state.pickerMuscleGroup = muscleGroup.value;
    renderPickerResults(search.value);
  });
  document.querySelector("#clear-muscle-group-filter").addEventListener("click", () => {
    state.pickerMuscleGroup = "";
    muscleGroup.value = "";
    renderPickerResults(search.value);
    muscleGroup.focus();
  });
  // While typing the filter is hidden; its chip clears it without closing the keyboard.
  const chip = document.querySelector("#muscle-group-chip");
  chip.addEventListener("pointerdown", (event) => event.preventDefault());
  chip.addEventListener("click", () => {
    state.pickerMuscleGroup = "";
    muscleGroup.value = "";
    renderPickerResults(search.value);
    search.focus();
  });
  renderPickerResults(query);
  document.querySelector("#close-picker").addEventListener("click", () => closePicker());
}

// Search and Muscle Group intersect across the Catalog and the Gym's saved Configurations.
// With neither filter, Recent stays the quick path for adding a familiar exercise.
function renderPickerResults(query) {
  state.pickerQuery = query;
  const wanted = query.trim().toLowerCase();
  const group = state.pickerMuscleGroup;
  const filtering = Boolean(wanted || group);
  const groupsByVariation = new Map(state.picker.catalog.map((item) => [item.id, item.muscle_groups ?? []]));
  const matches = (item, groups, details = "") => (!group || groups.includes(group))
    && `${exerciseDisplayName(item)} ${item.exercise_name} ${item.variation_name} ${details} ${groups.join(" ")}`.toLowerCase().includes(wanted);
  const filtered = state.picker.catalog.filter((item) => matches(item, item.muscle_groups ?? []));
  const gymName = escapeHtml(state.pickerContext?.gym.name ?? state.data.active_workout.gym_name);
  const configurations = (filtering ? state.picker.saved ?? state.picker.recent : state.picker.recent)
    .filter((item) => matches(item, groupsByVariation.get(item.variation_id) ?? [], configurationLabel(item)));
  document.querySelector("#clear-muscle-group-filter").hidden = !group;
  const chip = document.querySelector("#muscle-group-chip");
  chip.hidden = !group;
  chip.innerHTML = group ? `${escapeHtml(group)} <span aria-hidden="true">×</span>` : "";
  chip.setAttribute("aria-label", group ? `Clear Muscle Group ${group}` : "");
  document.querySelector("#picker-results").innerHTML = `
      ${configurations.length ? `<div class="section-title"><h3>${filtering ? "Saved" : "Recent"} at ${gymName}</h3>${filtering ? `<span>${configurations.length}</span>` : ""}</div><div class="recent-list">${configurations.map((item) => `<button class="recent-card" data-profile-id="${item.profile_id}"><strong>${escapeHtml(exerciseDisplayName(item))}</strong><span>${escapeHtml(configurationLabel(item))}</span></button>`).join("")}</div>` : ""}
      <div class="section-title"><h3>Exercise catalog</h3><span>${filtered.length}</span></div>
      <div class="exercise-list">${filtered.map((item) => `<button class="exercise-card" data-variation-id="${item.id}"><strong>${escapeHtml(exerciseDisplayName(item))}</strong><span>${escapeHtml(item.equipment.join(" · "))}</span></button>`).join("") || (configurations.length
        ? `<p class="picker-note">No catalog exercises match. Create a custom exercise if none of the saved ones fit.</p>`
        : `<div class="empty"><h3>No matches</h3><p>Try another search or Muscle Group, or create a custom exercise.</p></div>`)}</div>
      <div class="picker-create"><button class="secondary create-exercise-button" type="button" id="create-exercise">Create custom exercise</button></div>`;
  document.querySelector("#create-exercise").addEventListener("click", () => renderCustomExerciseForm(state.pickerQuery));
  document.querySelectorAll("[data-profile-id]").forEach((button) => button.addEventListener("click", () => addRecent(Number(button.dataset.profileId), button)));
  document.querySelectorAll("[data-variation-id]").forEach((button) => button.addEventListener("click", () => chooseExercise(Number(button.dataset.variationId))));
}

// Equipment chips of the custom exercise form and Manage. × appears only on removable values.
function renderEquipmentChips(names, removable = () => true) {
  return names.map((name, index) => removable(index)
    ? `<li class="equipment-chip"><span>${escapeHtml(name)}</span><button type="button" class="chip-remove" data-remove-equipment="${index}" aria-label="Remove ${escapeHtml(name)}"><span aria-hidden="true">×</span></button></li>`
    : `<li class="equipment-chip equipment-chip-fixed"><span>${escapeHtml(name)}</span></li>`).join("");
}

function cleanEquipmentName(value) {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

// Why a cleaned equipment name cannot join the list, or "".
function equipmentProblem(names, name) {
  if (name.includes("|")) return "Equipment names cannot contain |.";
  if (names.some((item) => item.toLowerCase() === name.toLowerCase())) return `${name} is already added.`;
  if (names.length >= 20) return "You can add up to 20 equipment options.";
  return "";
}

// Variations, Equipment and machine labels stay relevant to the typed Exercise; manufacturers
// can be reused globally.
function exerciseSuggestions(name) {
  const suggestions = state.picker.suggestions ?? { equipment: [], exercises: [] };
  const key = cleanEquipmentName(name).toLowerCase();
  const known = suggestions.exercises.find((item) => item.name.toLowerCase() === key)
    ?? { variations: [], equipment: suggestions.equipment, manufacturers: [], labels: [] };
  return { ...known, manufacturers: suggestions.manufacturers ?? known.manufacturers };
}

// Standard, the default for a new Variation, then the typed Exercise's own Variations.
function variationChoices(known) {
  return ["Standard", ...known.variations.filter((value) => value.toLowerCase() !== "standard")];
}

function variationHelp(known) {
  return known.variations.length
    ? `${known.name} already has: ${known.variations.join(", ")}. Choose an existing variation to keep its tracking, equipment, Muscle Groups and Assisted settings, or type a new name.`
    : "";
}

function renderCustomExerciseForm(query = "") {
  const sheet = document.querySelector("#picker .sheet");
  sheet.className = "sheet";
  sheet.innerHTML = `
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-header"><button class="text-button" id="back-to-picker">Back</button><button class="text-button" id="close-picker">Close</button></div>
    <h2 id="picker-title">Create custom exercise</h2>
    <p>Use an existing exercise name to choose or add a variation, or enter a new name.</p>
    <form id="custom-exercise-form">
      <label class="field">Exercise name<input name="name" maxlength="80" value="${escapeHtml(query)}" placeholder="e.g. Leg Press" required /></label>
      <div class="field choice-field" id="variation-field"></div>
      <p class="field-help" id="variation-help" hidden></p>
      <fieldset class="track-by"><legend>Track by</legend>
        <label class="radio-option"><input type="radio" name="tracking_type" value="repetitions" checked /> Repetitions</label>
        <label class="radio-option"><input type="radio" name="tracking_type" value="duration" /> Duration in seconds</label>
      </fieldset>
      <div class="field equipment-field">
        <div class="equipment-entry"><div class="choice-field" id="equipment-choice"></div><button type="button" class="secondary" id="add-equipment">Add</button></div>
        <ul class="equipment-chips" id="equipment-chips" aria-label="Added equipment options"></ul>
      </div>
      <p class="field-help" id="equipment-help">Type one option and tap Add, or pick one from the list. You can choose one for each gym machine when logging.</p>
      <label class="assistance-option"><input name="assisted" type="checkbox" /> Assisted (weight is counterweight)</label>
      <details class="custom-muscle-groups"><summary>Muscle Groups (optional)</summary>${renderMuscleGroupChoices(state.picker.muscle_groups ?? [])}</details>
      <button class="primary accent" type="submit">Continue</button>
    </form>`;
  sheet.querySelector("#back-to-picker").addEventListener("click", () => renderPicker(query));
  sheet.querySelector("#close-picker").addEventListener("click", () => closePicker());
  const equipment = [];
  const nameInput = sheet.querySelector('[name="name"]');
  // The typed Exercise name decides which suggestions are offered; see exerciseSuggestions().
  let known = exerciseSuggestions(nameInput.value ?? query);
  const variation = new ChoiceField(sheet.querySelector("#variation-field"), { id: "variation-name", name: "variation_name",
    title: "Variation", placeholder: "Standard", describedBy: "variation-help", options: variationChoices(known) });
  const help = sheet.querySelector("#variation-help");
  const showVariationHelp = () => {
    help.textContent = variationHelp(known);
    help.hidden = !help.textContent;
  };
  showVariationHelp();
  const unadded = () => known.equipment.filter((value) => !equipment.some((added) => added.toLowerCase() === value.toLowerCase()));
  const entry = new ChoiceField(sheet.querySelector("#equipment-choice"), { id: "equipment-entry", title: "Equipment options",
    placeholder: "e.g. Machine", describedBy: "equipment-help",
    options: unadded(), onEnter: (picked) => addEquipment({ focus: !picked }) });
  nameInput.addEventListener("input", () => {
    known = exerciseSuggestions(nameInput.value);
    variation.setOptions(variationChoices(known));
    showVariationHelp();
    entry.setOptions(unadded());
  });
  const chips = sheet.querySelector("#equipment-chips");
  const renderChips = () => {
    chips.innerHTML = renderEquipmentChips(equipment);
    entry.setOptions(unadded());
  };
  // Keeps the keyboard up after a typed option, so the next one can be typed straight away.
  const addEquipment = ({ focus = true } = {}) => {
    const name = entry.value;
    if (!name) return true;
    const problem = equipmentProblem(equipment, name);
    if (problem) { showToast(problem); entry.focus(); return false; }
    equipment.push(name);
    renderChips();
    entry.clear();
    if (focus) entry.focus();
    return true;
  };
  sheet.querySelector("#add-equipment").addEventListener("click", () => addEquipment());
  chips.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-remove-equipment]");
    if (!button) return;
    equipment.splice(Number(button.dataset.removeEquipment), 1);
    renderChips();
  });
  sheet.querySelector("#custom-exercise-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    // Enter or a second tap while the exercise is being created does nothing.
    if (form.querySelector('[type="submit"]').disabled) return;
    const values = new FormData(form);
    const existing = state.picker.catalog.find((item) =>
      item.exercise_name.toLowerCase() === cleanEquipmentName(values.get("name")).toLowerCase()
      && item.variation_name.toLowerCase() === (variation.value || "Standard").toLowerCase());
    if (existing) {
      chooseExercise(existing.id);
      return;
    }
    if (!addEquipment()) return;
    if (!equipment.length) {
      showToast("Add at least one equipment option.");
      entry.focus();
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    const submitText = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const created = await api("/api/exercises", { method: "POST", body: JSON.stringify({
        name: values.get("name"), variation_name: variation.value,
        tracking_type: values.get("tracking_type"), equipment, assisted: values.get("assisted") === "on",
        muscle_groups: selectedMuscleGroups(form),
      }) });
      state.picker.catalog.push(created);
      chooseExercise(created.id);
      showToast(state.pickerReplace ? "Exercise created. Choose equipment to replace with it." : "Exercise created. Choose equipment to add it.");
    } catch (error) { submit.disabled = false; submit.textContent = submitText; showToast(error.message); }
  });
  nameInput.focus();
}

function closePicker(focus = "#open-picker") {
  const picker = document.querySelector("#picker");
  picker?.close();
  // Native close events are queued. Remove the picker before a reload checks for it,
  // and return focus once, so a late event cannot steal focus from the refreshed card.
  picker?.cleanup();
  document.querySelector(focus)?.focus();
}

async function addRecent(profileId, button = null) {
  // A tap that lands after the sheet already closed (a replace or add that was instant) does nothing.
  if (state.addingExercise || !document.querySelector("#picker")) return;
  const profile = (state.picker.saved ?? state.picker.recent).find(item => item.profile_id === profileId);
  if (!profile) {
    showToast("That saved exercise is no longer available. Choose it from the catalog instead.");
    return;
  }
  if (state.pickerContext) {
    return saveRoutineChoice({ variation_id: profile.variation_id, equipment: profile.equipment,
      manufacturer: profile.manufacturer, label: profile.label });
  }
  if (state.pickerReplace) {
    return saveReplacedExercise({
      variation_id: profile.variation_id, equipment: profile.equipment,
      manufacturer: profile.manufacturer, label: profile.label,
    }, button);
  }
  await addWorkoutExercise({ profile_id: profileId }, button, "Exercise added.");
}

// A per-picker key the server uses to answer a repeated Add exercise request with the exercise
// the first one added, so a retried or doubled request never adds it twice.
function newPickerSession() {
  state.pickerSession = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Adding an exercise is instant and offline first: it shows in the workout at once and the
// server hears about it from the outbox. One picker opening adds at most one exercise, so taps
// queued on a slow phone cannot add copies (the 7 Hammer Curls).
async function addWorkoutExercise(choice, control, doneMessage) {
  if (state.addingExercise || !state.data.active_workout || !state.editor) return;
  if (!state.pickerSession) newPickerSession();
  if (state.pickerAdded === state.pickerSession) return;
  state.addingExercise = true;
  try {
    const entry = pickedEntry(choice);
    if (!entry) throw new Error("This exercise is not in the list on this phone. Reopen Add exercise when you are online.");
    const added = state.editor.addExercise(entry, choice, { requestId: `${state.pickerSession}:${JSON.stringify(choice)}` });
    if (!added) return;
    state.pickerAdded = state.pickerSession;
    swallowTaps(control);
    closePicker();
    render();
    document.querySelector(`[data-exercise-more="${added.id}"]`)?.closest?.(".workout-exercise-card")?.scrollIntoView?.({ block: "center" });
    showToast(doneMessage);
  } catch (error) {
    showToast(error.message);
  } finally { state.addingExercise = false; }
}

function chooseExercise(variationId) {
  state.selectedExercise = state.picker.catalog.find((item) => item.id === variationId);
  state.selectedEquipment = state.selectedExercise.equipment[0];
  renderConfiguration();
}

// The Exercise Configuration form: equipment of state.selectedExercise plus manufacturer and
// machine label. Adding a Variation starts empty; Editing manufacturer / machine (change) starts from a
// Workout Exercise's current values and saves them to it instead. Replacing an Active Workout
// exercise keeps its note and set slots.
function renderConfiguration(change = null) {
  const sheet = document.querySelector("#picker .sheet");
  sheet.className = "sheet";
  const item = state.selectedExercise;
  const replacing = !change && state.pickerReplace;
  const submitLabel = change ? "Save"
    : replacing ? "Replace exercise"
      : state.pickerContext ? "Add to routine" : "Add exercise";
  sheet.innerHTML = `
    <div class="sheet-handle" aria-hidden="true"></div>
    ${change ? `<div class="sheet-header"><h2 id="picker-title">Edit manufacturer / machine</h2><button class="text-button" id="close-picker">Cancel</button></div>
    <p>${escapeHtml(exerciseDisplayName(item))} keeps its sets and note.</p>` : `<div class="sheet-header"><button class="text-button" id="back-to-picker">Back</button><button class="text-button" id="close-picker">${replacing ? "Cancel" : "Close"}</button></div>
    <h2 id="picker-title">${escapeHtml(exerciseDisplayName(item))}</h2>
    <p>${replacing ? "Choose the equipment used at this gym. Mismatched weight, reps or seconds, and effort are cleared." : "Choose the equipment used at this gym."}</p>`}
    <div class="equipment-grid">${item.equipment.map((equipment) => `<button class="equipment-option" data-equipment="${escapeHtml(equipment)}" aria-pressed="${state.selectedEquipment === equipment}">${escapeHtml(equipment)}</button>`).join("")}</div>
    <form id="configuration-form">
      <div class="field choice-field" id="manufacturer-field"></div>
      <div class="field choice-field" id="machine-label-field"></div>
      <button class="primary accent" type="submit">${submitLabel}</button>
    </form>`;
  document.querySelector("#back-to-picker")?.addEventListener("click", () => renderPicker());
  document.querySelector("#close-picker").addEventListener("click", () => closePicker(change?.focus || replacing?.focus));
  document.querySelectorAll("[data-equipment]").forEach((button) => button.addEventListener("click", () => {
    state.selectedEquipment = button.dataset.equipment;
    document.querySelectorAll("[data-equipment]").forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
  }));
  // Manufacturers entered for any Exercise, and this Exercise's machine labels, can be reused from any Gym.
  const known = exerciseSuggestions(item.exercise_name);
  const details = {
    manufacturer: new ChoiceField(document.querySelector("#manufacturer-field"), { id: "manufacturer", name: "manufacturer",
      title: "Manufacturer", optional: true, placeholder: "e.g. Technogym", options: known.manufacturers,
      value: change?.entry.manufacturer }),
    label: new ChoiceField(document.querySelector("#machine-label-field"), { id: "machine-label", name: "label",
      title: "Machine label", optional: true, placeholder: "e.g. Upstairs plate-loaded", options: known.labels,
      value: change?.entry.label }),
  };
  document.querySelector("#configuration-form").addEventListener("submit", (event) =>
    change ? saveMachine(event, change, details) : addConfiguredExercise(event, details));
}

// Replace an Active Workout's Workout Exercise with another Variation while keeping its note
// and set slots. Finished workouts are refused by the server.
async function replaceExercise(entryId) {
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(entryId));
  if (!entry || !state.editor || state.editor.busy || state.pickerContext) return;
  try {
    state.picker = await loadCatalog(state.data.active_workout.gym_id);
  } catch (error) { showToast(error.message); return; }
  state.pickerReplace = { entry, focus: `[data-exercise-more="${entry.id}"]` };
  state.selectedExercise = null;
  state.selectedEquipment = null;
  state.pickerQuery = "";
  state.pickerMuscleGroup = "";
  renderPicker();
}

// One replace at a time: every choice in the sheet stays disabled until it settles. A choice that
// would clear logged values asks first, because the cleared sets cannot be brought back.
async function saveReplacedExercise(choice, control = null) {
  const replacing = state.pickerReplace;
  if (!replacing || replacing.saving || !state.data.active_workout) return;
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(replacing.entry.id)) ?? replacing.entry;
  replacing.saving = true;
  let buttons = [];
  let replaced = false;
  try {
    const logged = localSets(entry).filter((set) => set.weight !== null || set.result !== null || set.effort).length;
    const variation = state.picker?.catalog?.find((item) => item.id === choice.variation_id);
    // Without the Variation in the catalog it cannot be told apart, so ask as if it clears.
    const clears = !variation || variation.tracking_type !== entry.tracking_type
      || Boolean(variation.assisted) !== Boolean(entry.assisted);
    if (clears && logged) {
      const target = variation ? exerciseDisplayName(variation) : "this exercise";
      if (!await ask(`Replace ${exerciseDisplayName(entry)} with ${target}? It records sets differently, so weight, reps or seconds, and effort on ${logged} set${logged === 1 ? "" : "s"} will be cleared and done sets marked not done. This cannot be undone.`,
        { confirmLabel: "Replace and clear", danger: true })) return;
    }
    // Disabled only now, so declining the question returns focus to the tapped choice.
    buttons = [...document.querySelectorAll("#picker button")];
    buttons.forEach((button) => { button.disabled = true; });
    const replacement = pickedEntry(choice);
    if (!replacement || !state.editor.replaceExercise(entry.id, replacement, choice)) throw new Error("This exercise cannot be replaced right now.");
    replaced = true;
    const focus = replacing.focus;
    swallowTaps(control);
    closePicker(focus);
    render();
    document.querySelector(focus)?.focus();
    const name = exerciseDisplayName(replacement);
    showToast(clears && logged ? `Replaced with ${name}. Cleared set values that no longer match.` : `Replaced with ${name}.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    replacing.saving = false;
    if (!replaced) buttons.forEach((button) => { if (button.isConnected) button.disabled = false; });
  }
}

// Edit manufacturer / machine on a Workout Exercise card: saves set and note drafts first, like the other
// card actions, then opens the Exercise Configuration form with the card's current values.
async function changeMachine(entryId) {
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(entryId));
  if (!entry || !state.editor || state.editor.busy) return;
  try {
    state.picker = await loadCatalog(state.data.active_workout.gym_id);
  } catch (error) { showToast(error.message); return; }
  const variation = state.picker.catalog.find((item) => item.id === entry.variation_id);
  if (!variation) {
    showToast(`${exerciseDisplayName(entry)} is archived. Restore it in Manage to edit its manufacturer or machine.`);
    return;
  }
  state.pickerReplace = null;
  state.selectedExercise = variation;
  state.selectedEquipment = entry.equipment;
  openSheet("");
  renderConfiguration({ entry, focus: `[data-change-machine="${entry.id}"]` });
}

async function saveMachine(event, change, { manufacturer, label }) {
  event.preventDefault();
  const submit = event.currentTarget?.querySelector?.('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const body = { equipment: state.selectedEquipment, manufacturer: manufacturer.value.trim(), label: label.value.trim() };
    if (!state.editor?.changeMachine(change.entry.id, body)) throw new Error("The machine cannot be changed right now.");
    closePicker(change.focus);
    render();
    document.querySelector(change.focus)?.focus();
    showToast(`Changed to ${configurationLabel(body)}.`);
  } catch (error) {
    if (submit) submit.disabled = false;
    showToast(error.message);
  }
}

async function addConfiguredExercise(event, { manufacturer, label }) {
  event.preventDefault();
  if (state.pickerContext) return saveRoutineChoice({
    variation_id: state.selectedExercise.id, equipment: state.selectedEquipment,
    manufacturer: manufacturer.value, label: label.value,
  });
  if (state.pickerReplace) {
    return saveReplacedExercise({
      variation_id: state.selectedExercise.id,
      equipment: state.selectedEquipment,
      manufacturer: manufacturer.value,
      label: label.value,
    });
  }
  await addWorkoutExercise({
    variation_id: state.selectedExercise.id,
    equipment: state.selectedEquipment,
    manufacturer: manufacturer.value,
    label: label.value,
  }, event.currentTarget.querySelector('[type="submit"]'), "Exercise added. It will appear under recent choices next time.");
}

function renderSet(entry, set, index) {
  const previous = entry.previous_sets[index];
  const unit = entry.tracking_type === "duration" ? "sec" : "reps";
  const name = setName(entry, index);
  // Negative weights recorded before assistance moved to the variation stay assisted.
  const draft = state.editor?.status(set.id)?.values;
  const assisted = Boolean(entry.assisted) || set.weight < 0 || draft?.assistance === true;
  // A draft from before Effort existed has no effort key and shows the saved one.
  const effort = draft && "effort" in draft ? draft.effort : set.effort ?? null;
  const side = setSide(set);
  const setType = setTypeOf(set);
  const label = setLabels(entry.sets.map(setTypeOf))[index];
  const previousText = previous
    ? `${previous.weight === null ? "" : `${Math.abs(previous.weight)} kg${previous.weight < 0 ? " assistance" : ""} × `}${previous.result} ${unit}${previous.effort ? ` · ${effortText(previous.effort)}` : ""}`
    : "";
  return `<form class="set-form${set.completed ? " is-complete" : ""}" data-set-id="${set.id}" data-set-label="${escapeHtml(setName(entry, index, { exercise: false }))}" data-entry-id="${entry.id}" data-assisted="${assisted}">
    <fieldset>
      <legend class="visually-hidden">${escapeHtml(name)}</legend>
      <input type="hidden" name="effort" value="${escapeHtml(effort ?? "")}" />
      <input type="hidden" name="side" value="${side ?? ""}" />
      <input type="hidden" name="set_type" value="${setType ?? ""}" />
      <button type="button" class="remove-set" aria-label="Remove ${escapeHtml(name)}"><span aria-hidden="true">×</span></button>
      <div class="set-top">${previous
        ? `<button type="button" class="previous-set fill-previous" data-previous-weight="${previous.weight ?? ""}" data-previous-result="${previous.result}" aria-label="Fill ${escapeHtml(name)} from last workout: ${escapeHtml(previousText)}">Last workout: ${escapeHtml(previousText)}</button>`
        : ""}</div>
      <div class="set-inputs">
        ${renderSetMarker(name, label, setType, recordsSides(entry) ? side : undefined)}
        <label>${assisted ? "Assist kg" : "kg"} <input name="weight" type="text" inputmode="decimal" pattern="${WEIGHT_PATTERN}" autocomplete="off" title="A number such as 62.5 or 62,5" aria-label="${escapeHtml(name)} ${assisted ? "assistance" : "weight"} in kilograms" value="${set.weight === null ? "" : Math.abs(set.weight)}" /></label>
        <label>${unit === "sec" ? "Sec" : "Reps"} <input name="result" type="number" inputmode="numeric" min="1" max="1000000" step="1" aria-label="${escapeHtml(name)} ${unit}" value="${set.result ?? ""}" ${set.completed ? "required" : ""} /></label>
        ${renderEffortButton(entry, name, effort)}
        <label class="set-complete">Done <input name="completed" type="checkbox" aria-label="Mark ${escapeHtml(name)} completed and save" ${set.completed ? "checked" : ""} /></label>
      </div>
      <div class="set-actions">
        <span class="set-record" data-set-record hidden></span>
        <span class="set-status" role="status"></span>
        <button type="button" class="text-button set-retry" hidden>Retry</button>
      </div>
    </fieldset>
  </form>`;
}

// A set's Side: its draft's, or the saved one. Drafts from before Side existed have no side key.
function setSide(set) {
  const draft = state.editor?.status(set.id)?.values;
  return draft && "side" in draft ? draft.side : set.side ?? null;
}

// How a set is named in labels and questions, after its visible marker: "Bench Press, set 1" or
// "Bench Press, warm-up", since only working sets are numbered. Without the exercise: "set 1".
function setName(entry, index, { exercise = true } = {}) {
  const label = setLabels(entry.sets.map(setTypeOf), { short: false })[index];
  const lower = label[0].toLowerCase() + label.slice(1);
  return exercise ? `${exerciseDisplayName(entry)}, ${lower}` : lower;
}

// A set's Set Type: its draft's, or the saved one. Drafts from before Set Type existed have no set_type key.
function setTypeOf(set) {
  const draft = state.editor?.status(set.id)?.values;
  return draft && "set_type" in draft ? draft.set_type : set.set_type ?? null;
}

// The set marker leads the input row: the set number, or a typed Set's letter, with its Side as
// a superscript R or L while Record sides is on (side is undefined while it is off). It opens
// one sheet for both, since the superscript is too small for a tap target of its own.
function renderSetMarker(name, label, type, side) {
  const sideNote = side === undefined ? "" : `, ${sideText(side)}`;
  return `<button type="button" class="set-marker" data-set-type data-recorded="${Boolean(type)}" aria-label="${escapeHtml(`${name}: ${setTypeText(type)}${sideNote}. Tap to change.`)}">${escapeHtml(label)}${side ? `<sup data-side="${side}">${sideText(side, { short: true })}</sup>` : ""}</button>`;
}

// Picking a Set Type or a Side saves at once like Effort. The sets are renumbered, since only working sets have numbers.
async function chooseSetType(form) {
  if (!state.editor || state.editor.busy) return;
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(Number(form.dataset.entryId)));
  const set = entry?.sets.find((item) => item.id === formSetId(form));
  if (!set) return;
  const current = form.elements.set_type.value || null;
  const side = form.elements.side.value || null;
  const sides = recordsSides(entry) ? SIDES.map((value) => ({ value: `side:${value}`, label: `${sideText(value)} side`, wide: true })) : [];
  const picked = await choose(setName(entry, entry.sets.indexOf(set)), {
    choices: [...[null, ...SET_TYPES].map((value) => ({ value, label: setTypeText(value), wide: true })), ...sides],
    selected: [current, `side:${side}`],
    hint: "Warm-ups are left out of Progress. Only working sets are numbered.",
  });
  if (picked === undefined || picked === current || picked === `side:${side}` || state.editor.busy || !form.isConnected) return;
  if (picked?.startsWith("side:")) form.elements.side.value = picked.slice(5);
  else form.elements.set_type.value = picked ?? "";
  saveSetForm(form);
  const list = form.closest(".sets-list");
  renderSets(entry, list);
  [...list.querySelectorAll(".set-form")].find((item) => formSetId(item) === set.id)?.querySelector("[data-set-type]")?.focus();
}

// Record sides is on while any set of the Workout Exercise has a Side.
function recordsSides(entry) {
  return entry.sets.some((set) => setSide(set));
}

function saveSetForm(form) {
  form.elements.result.required = form.elements.completed.checked;
  const valid = form.checkValidity();
  state.editor.edit(form.dataset.setId, setValues(form), { valid });
  if (valid) state.editor.save(form.dataset.setId);
}

// Record sides gives the sets R, L, R, L… from the top; turning it off returns them to both sides.
function recordSides(input) {
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(Number(input.dataset.recordSides)));
  if (!entry || !state.editor || state.editor.busy) { input.checked = !input.checked; return; }
  const list = document.querySelector(`.workout-exercise[data-entry-id="${entry.id}"] .sets-list`);
  if (!list) { input.checked = !input.checked; return; }
  const forms = [...list.querySelectorAll(".set-form")];
  for (const [index, form] of forms.entries()) {
    form.elements.side.value = input.checked ? SIDES[index % 2] : "";
    saveSetForm(form);
  }
  renderSets(entry, list);
}

// Re-render a Workout Exercise's sets from state; drafts are keyed by set id and restored by bindSet.
function renderSets(entry, list) {
  list.innerHTML = entry.sets.map((set, index) => renderSet(entry, set, index)).join("");
  list.querySelectorAll(".set-form").forEach(bindSet);
  syncSidesSwitch(entry);
}

// Keeps Record sides showing whether the sets still have Sides after Add set or a removal.
function syncSidesSwitch(entry) {
  const toggle = document.querySelector(`[data-record-sides="${entry.id}"]`);
  if (!toggle) return;
  toggle.checked = recordsSides(entry);
  toggle.disabled = !entry.sets.length;
}

// The Effort button sits in the label row over the result column. Repetitions Sets open the
// Effort sheet from it ("RIR", "RIR 2", "Failure"); Duration Sets toggle Failure directly.
function effortButtonState(entry, name, effort) {
  const duration = entry.tracking_type === "duration";
  return {
    text: duration ? "Failure" : effort ? effortText(effort, { short: true }) : "RIR",
    label: `Effort for ${name}: ${effort ? effortText(effort) : "none"}`,
    pressed: duration ? String(effort === "failure") : null,
  };
}

function renderEffortButton(entry, name, effort) {
  const { text, label, pressed } = effortButtonState(entry, name, effort);
  return `<button type="button" class="effort-button" data-set-effort data-recorded="${Boolean(effort)}" aria-label="${escapeHtml(label)}"
    ${pressed === null ? 'aria-haspopup="dialog"' : `aria-pressed="${pressed}"`}>${escapeHtml(text)}</button>`;
}

function setValues(form) {
  const values = {
    weight: form.elements.weight.value,
    result: form.elements.result.value,
    completed: form.elements.completed.checked,
    assistance: form.dataset.assisted === "true",
  };
  // Blank is no Effort, no Side and a working set; the Active Workout keeps them in hidden inputs, history in radio buttons.
  if (form.elements.effort) values.effort = form.elements.effort.value || null;
  if (form.elements.side) values.side = form.elements.side.value || null;
  if (form.elements.set_type) values.set_type = form.elements.set_type.value || null;
  return values;
}

// Picking an Effort saves at once like Done, without changing completion; picking the
// selected value again clears it. Duration Sets have only Failure, so a tap toggles it.
async function chooseSetEffort(form) {
  if (!state.editor || state.editor.busy) return;
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(Number(form.dataset.entryId)));
  const set = entry?.sets.find((item) => item.id === formSetId(form));
  if (!set) return;
  const current = form.elements.effort.value || null;
  const duration = entry.tracking_type === "duration";
  // Named before the sheet opens: a save that lands meanwhile replaces the set object in entry.sets.
  const name = setName(entry, entry.sets.indexOf(set));
  const picked = duration ? "failure" : await choose(`Effort for ${name}`, {
    choices: effortsFor(entry.tracking_type).map((value) => value === "failure"
      ? { value, label: "Failure", wide: true }
      : { value, label: value, name: effortText(value) }),
    selected: current,
    hint: `Failure: you tried another rep and missed it. Numbers are reps left in reserve; 0 means none was left.${current ? " Tap the selected value to clear it." : ""}`,
  });
  if (picked === undefined || state.editor.busy || !form.isConnected) return;
  const effort = picked === current ? null : picked;
  form.elements.effort.value = effort ?? "";
  saveSetForm(form);
  const button = form.querySelector("[data-set-effort]");
  const { text, label, pressed } = effortButtonState(entry, name, effort);
  button.textContent = text;
  button.dataset.recorded = String(Boolean(effort));
  button.setAttribute("aria-label", label);
  if (pressed !== null) button.setAttribute("aria-pressed", pressed);
}

function bindSet(form) {
  const draft = state.editor.status(form.dataset.setId).values;
  if (draft) {
    form.elements.weight.value = draft.weight;
    form.elements.result.value = draft.result;
    form.elements.completed.checked = draft.completed;
  }
  form.elements.result.required = form.elements.completed.checked;
  form.addEventListener("input", () => {
    // Typed kg or reps are the lifter's own, so Last workout no longer overwrites them.
    copiedSets.delete(formSetId(form));
    if (state.editor.busy) return;
    form.elements.result.required = form.elements.completed.checked;
    state.editor.edit(form.dataset.setId, setValues(form), { valid: form.checkValidity() });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.editor.busy) return;
    form.elements.result.required = form.elements.completed.checked;
    if (!form.reportValidity()) return;
    state.editor.edit(form.dataset.setId, setValues(form));
    state.editor.save(form.dataset.setId);
  });
  // Without a submit button, browsers skip implicit submission for multi-input forms.
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.type === "checkbox" || event.target.tagName === "BUTTON") return;
    event.preventDefault();
    form.requestSubmit();
  });
  form.elements.completed.addEventListener("change", () => {
    form.elements.result.required = form.elements.completed.checked;
    if (state.restEnabled && form.elements.completed.checked) unlockRestAudio();
    if (state.restEnabled && form.elements.completed.checked && form.checkValidity()) state.restTimer.start();
    form.requestSubmit();
  });
  form.querySelector(".set-retry").addEventListener("click", () => {
    if (state.editor.busy || !form.reportValidity()) return;
    state.editor.save(form.dataset.setId);
  });
  form.querySelector(".remove-set").addEventListener("click", () => removeSet(form));
  const fill = form.querySelector(".fill-previous");
  fill?.addEventListener("click", () => fillFromPrevious(form, fill.dataset));
  syncEditorView();
}

// A set form's set id, following a temporary id the server has replaced since it was rendered.
function formSetId(form) {
  return outbox.resolve(Number(form.dataset.setId));
}

// Sets that Add set copied from the set above and that nobody has typed into or completed
// since. Last workout may overwrite their values; anything typed stays protected.
const copiedSets = new Set();

// Fills only the fields still empty, or every field of an untouched Add set copy, so a stray
// tap never overwrites what was typed.
function fillFromPrevious(form, previous) {
  if (state.editor.busy) return;
  const id = formSetId(form);
  const copy = copiedSets.has(id) && !form.elements.completed.checked;
  const fillWeight = copy || form.elements.weight.value.trim() === "";
  const fillResult = copy || form.elements.result.value === "";
  copiedSets.delete(id);
  if (!fillWeight && !fillResult) {
    showToast("Last workout fills only empty fields. Clear kg or reps first to use it.");
    return;
  }
  if (fillResult) form.elements.result.value = previous.previousResult;
  if (!fillWeight) { form.requestSubmit(); return; }
  const weight = previous.previousWeight === "" ? null : Number(previous.previousWeight);
  // Last time's assistance stays assistance, even on sets recorded before it was a variation property.
  if (weight < 0 && form.dataset.assisted !== "true") {
    form.dataset.assisted = "true";
    const label = form.elements.weight.labels?.[0]?.firstChild;
    if (label) label.textContent = "Assist kg ";
    const name = form.elements.weight.getAttribute("aria-label");
    if (name) form.elements.weight.setAttribute("aria-label", name.replace(/ weight in kilograms$/, " assistance in kilograms"));
  }
  form.elements.weight.value = weight === null ? "" : String(Math.abs(weight));
  form.requestSubmit();
}

async function retryPendingSets() {
  if (!navigator.onLine || document.visibilityState === "hidden") return;
  outbox.kick();
  await state.editor?.retry();
  updateSyncStatus();
}

// A save that reached the server says so for a moment and fades; waiting, failed and blocked
// saves keep their message. A set re-rendered later does not repeat a message already shown.
const STATUS_FADE_MS = 1500;
const shownStatus = new Map();
function setStatus(form, message, error = false, transient = false) {
  showStatus(form.querySelector(".set-status"), String(formSetId(form)), message, error, transient);
}

// Ending or starting a workout drops the per-set marks of the one before.
function forgetWorkoutMarks() {
  for (const { timer } of shownStatus.values()) clearTimeout(timer);
  shownStatus.clear();
  copiedSets.clear();
}

// A set or note whose latest value reached the server.
function isSettled(status) {
  return !status.dirty && !status.saving && !status.blocked && !status.error;
}

function showStatus(status, id, message, error = false, transient = false) {
  const shown = shownStatus.get(id);
  if (transient && shown?.message === message) return;
  clearTimeout(shown?.timer);
  const entry = { message, timer: null };
  shownStatus.set(id, entry);
  status.textContent = message;
  status.classList.toggle("error", error);
  status.classList.remove("is-faded");
  if (!transient || !message) return;
  entry.timer = setTimeout(() => {
    status.classList.add("is-faded");
    // Empty once faded, so an empty note status takes no room.
    entry.timer = setTimeout(() => { status.textContent = ""; status.classList.remove("is-faded"); }, 400);
  }, STATUS_FADE_MS);
}

// Shows the draft that blocked an action and says why in a toast, because iOS Safari
// does not show validation bubbles and the draft may be far from the tapped button.
function showInvalidSet(blocked) {
  const offline = state.unavailable || !navigator.onLine;
  const form = document.querySelector('.set-form[data-dirty="true"]');
  const note = form ? null : document.querySelector('[data-note-target][data-dirty="true"]');
  if (form) {
    for (let parent = form.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
    form.scrollIntoView({ block: "center" });
    form.reportValidity();
  } else if (note) {
    for (let parent = note.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
    note.scrollIntoView({ block: "center" });
    note.focus();
  }
  showToast(offline ? `${blocked}: cannot reach the server. Your sets are kept on this phone.`
    : `${blocked}: fix the highlighted ${note ? "note" : "set"}, then try again.`);
}

// Add set is instant: it copies the set above as shown on the phone and syncs in the background.
function addSet(button) {
  if (!state.editor || state.editor.busy) return;
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(Number(button.dataset.addSet)));
  const set = entry && state.editor.addSet(entry.id);
  if (!set) return;
  if (set.weight !== null || set.result !== null) copiedSets.add(set.id);
  const list = button.closest(".exercise-entry").querySelector(".sets-list");
  list.insertAdjacentHTML("beforeend", renderSet(entry, set, entry.sets.length - 1));
  bindSet(list.lastElementChild);
  syncSidesSwitch(entry);
  list.lastElementChild.elements.weight.focus();
}

function openWorkoutReorder(entryId) {
  if (!state.editor || state.editor.busy || state.data.workout_exercises.length < 2) return;
  openExerciseReorder(document, {
    items: state.data.workout_exercises.map((entry) => ({ id: entry.id, name: exerciseDisplayName(entry), detail: configurationLabel(entry) })),
    escapeHtml,
    onMove: async (id, index) => {
      if (!await saveExerciseMove(id, index + 1)) throw new Error("Close and save or correct your pending Sets and Notes, then try again.");
    },
    onRemove: async (id, removing) => {
      const before = state.data.workout_exercises.length;
      await removeExercise(id, { onConfirmed: removing });
      return state.data.workout_exercises.length < before;
    },
    // The exercise it was opened from may have been removed in the sheet.
    onClose: () => (document.querySelector(`[data-reorder-name="${entryId}"]`)?.closest("summary")
      ?? document.querySelector(".exercise-summary") ?? document.querySelector("#open-picker"))?.focus(),
  });
}

async function saveExerciseMove(entryId, position) {
  if (!state.editor || state.editor.busy || !await state.editor.moveExercise(entryId, position)) return false;
  render();
  return true;
}

// onConfirmed runs once the removal is confirmed. From the Reorder sheet, focus stays in the sheet.
async function removeExercise(entryId, { onConfirmed } = {}) {
  const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(entryId));
  if (!entry || !state.editor || state.editor.busy) return;
  const name = exerciseDisplayName(entry);
  const count = entry.sets.length;
  const question = `Remove ${name}${count ? ` and its ${count} set${count === 1 ? "" : "s"}` : ""} from this workout? This cannot be undone.`;
  let confirmed = false;
  try {
    const confirm = async () => {
      confirmed = await ask(question, { confirmLabel: "Remove", danger: true });
      if (confirmed) onConfirmed?.();
      return confirmed;
    };
    if (!await state.editor.removeExercise(entryId, confirm)) {
      if (confirmed) showInvalidSet("Not removed yet");
      return;
    }
    state.collapsedExercises.delete(entryId);
    render();
    if (!document.querySelector("#exercise-reorder")) document.querySelector("#open-picker")?.focus();
    showToast(`${name} removed.`);
  } catch (error) { showToast(error.message); }
}

async function removeSet(form) {
  if (state.editor.busy) return;
  if (!await ask(`Remove ${form.dataset.setLabel}?`, { confirmLabel: "Remove", danger: true })) return;
  const entryNode = form.closest(".exercise-entry");
  const addButton = entryNode.querySelector(".add-set");
  if (await state.editor.remove(form.dataset.setId)) {
    form.remove();
    // The server renumbered the remaining sets: re-render them so their numbers and
    // Last workout values line up.
    const entry = state.data.workout_exercises.find((item) => item.id === outbox.resolve(Number(form.dataset.entryId)));
    const list = entryNode.querySelector(".sets-list");
    if (entry && list) renderSets(entry, list);
    addButton.focus();
    updateSyncStatus();
  }
}

app.addEventListener("click", (event) => {
  if (event.target.closest?.("[data-sync-retry]")) { outbox.retry(); return; }
  const discard = event.target.closest?.("[data-sync-discard]");
  if (discard) return discardChange(discard.dataset.syncDiscard);
  const effort = event.target.closest?.("[data-set-effort]");
  if (effort) return chooseSetEffort(effort.closest(".set-form"));
  const setType = event.target.closest?.("[data-set-type]");
  if (setType) return chooseSetType(setType.closest(".set-form"));
  const routine = event.target.closest?.("[data-start-routine]");
  if (routine) return startRoutine(routine);
  if (event.target.closest?.("#open-routines")) return openRoutinesScreen();
  for (const selector of ["[data-exercise-more]", "[data-reorder-exercises]", "[data-remove-exercise]", "[data-replace-exercise]", "[data-change-machine]"]) {
    const button = event.target.closest?.(selector);
    if (button) return exerciseAction(button);
  }
});

// A refused change is dropped only after asking. Things it created go with the changes that use
// them, and the workout is rebuilt from the server and the rest of the queue.
async function discardChange(id) {
  const failed = outbox.ops.find((op) => op.id === id);
  if (!failed) return;
  const what = workoutOps[failed.kind]?.describe?.(failed) ?? "this change";
  if (!await ask(`Discard ${what}? The server refused it: ${failed.error} It will be removed from this phone.`,
    { confirmLabel: "Discard change", danger: true })) return;
  outbox.discard(id);
  if (!await load()) render();
  showToast("Change discarded.");
}

// The picker closes the moment a choice is tapped, so the rest of a quick double or triple tap
// would land on the workout underneath (a set's × or Done). Taps on that spot in the next moment
// are ignored; taps elsewhere go through.
let swallowed = null;
function swallowTaps(control, ms = 600) {
  const box = control?.getBoundingClientRect?.();
  swallowed = box ? { until: Date.now() + ms, left: box.left - 24, right: box.right + 24, top: box.top - 24, bottom: box.bottom + 24 } : null;
}
document.addEventListener("click", (event) => {
  if (!swallowed || Date.now() >= swallowed.until || event.target?.closest?.("dialog")) return;
  const { clientX: x, clientY: y } = event;
  if (!(x >= swallowed.left && x <= swallowed.right && y >= swallowed.top && y <= swallowed.bottom)) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

window.addEventListener("beforeunload", (event) => {
  if ((drafts.error && state.editor?.pending) || (outbox.storageFailed && outbox.size)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("online", () => { state.unavailable = false; retryPendingSets(); updateSyncStatus(); });
window.addEventListener("offline", () => { state.unavailable = true; updateSyncStatus(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    state.restTimer.refresh();
    retryPendingSets();
  }
});
setInterval(retryPendingSets, 15000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => {
    state.offlineReady = true;
    updateSyncStatus();
  }).catch(() => { state.offlineReady = false; updateSyncStatus(); });
}

return { load };
}
