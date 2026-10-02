import { DraftStore, setPayload, WEIGHT_PATTERN } from "./drafts.mjs";
import { NOTE_MAX_LENGTH, WorkoutEditor } from "./workout-editor.mjs";
import { RestTimer } from "./rest-timer.mjs";
import { askTextInPage, confirmInPage } from "./confirm-sheet.mjs";
import { ChoiceField } from "./choice-field.mjs";
import { openRoutines, renderRoutineStarts } from "./routines.mjs";

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
export function createApp({ window, document, navigator, fetch, setTimeout, clearTimeout, setInterval, clearInterval, now = () => Date.now(),
  ask = (question, options) => confirmInPage(document, question, options),
  askText = (question, options) => askTextInPage(document, question, options) }) {

const drafts = new DraftStore(() => window.localStorage);
const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const savedRest = readRestSettings();

const state = {
  data: null,
  selectedGymId: null,
  picker: null,
  pickerContext: null,
  summary: null,
  collapsedExercises: new Set(),
  exerciseOptions: new Set(),
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
const STALE_WORKOUT_MINUTES = 3 * 60;
const STALE_DISMISSED_KEY = "gymdex:stale-dismissed:v1";

state.restTimer = new RestTimer({ durationSeconds: savedRest.duration, schedule: setTimeout, clear: clearTimeout, onChange: renderRestTimerState, onFinish: playRestEndCue });

function readRestSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem("gymdex:rest:v1"));
    return {
      enabled: saved?.enabled === true,
      duration: Number.isInteger(saved?.duration) && saved.duration >= 1 && saved.duration <= 3600 ? saved.duration : 90,
    };
  } catch { return { enabled: false, duration: 90 }; }
}

function saveRestSettings() {
  try {
    window.localStorage.setItem("gymdex:rest:v1", JSON.stringify({
      enabled: state.restEnabled, duration: state.restTimer.snapshot().durationSeconds,
    }));
  } catch { showToast("Rest timer settings could not be saved on this phone."); }
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
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

function updateSyncStatus() {
  const status = document.querySelector("#sync-status");
  if (!status) return;
  const count = document.querySelectorAll('.set-form[data-dirty="true"]').length;
  const notes = noteTargets().filter((target) => state.editor?.noteStatus(target)?.dirty).length;
  const waiting = [count && `${count} set${count === 1 ? "" : "s"}`, notes && `${notes} note${notes === 1 ? "" : "s"}`].filter(Boolean);
  const unavailable = state.unavailable || !navigator.onLine;
  status.textContent = drafts.error
    ? "Phone storage is unavailable. Keep this page open until your changes are saved to the server."
    : unavailable
      ? "Server unavailable. Set and note edits are kept on this phone and will retry automatically. Adding items and finishing require a connection."
      : waiting.length
        ? `${waiting.join(" and ")} waiting to save. Drafts are kept on this phone.`
        : "All changes saved to server.";
  if (!state.offlineReady && unavailable) status.textContent += " Offline reopening is not available yet; keep this page open.";
  status.classList.toggle("error", drafts.error);
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

function renderFinishSummary() {
  const summary = state.summary;
  return `<section class="finish-summary" aria-labelledby="finish-summary-title">
    <h1 id="finish-summary-title" tabindex="-1">Workout complete</h1>
    <p>${escapeHtml(summary.workout.gym_name)} · ${summary.duration}</p>
    <p class="finish-totals">${summary.exercises} exercise${summary.exercises === 1 ? "" : "s"} with completed sets · ${summary.sets} completed set${summary.sets === 1 ? "" : "s"}</p>
    <div class="summary-actions"><button class="secondary" id="summary-routine">Save as routine</button><button class="secondary" id="summary-history">View workout</button></div>
    <button class="text-button" id="dismiss-summary">Done</button>
  </section>`;
}

async function saveWorkoutRoutine(workout) {
  const saved = await askText(`Save this workout as a routine at ${workout.gym_name}`, {
    label: "Routine name", confirmLabel: "Save routine",
    value: `${workout.gym_name} ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(parseServerTime(workout.started_at))}`,
    submit: (name) => api(`/api/history/${workout.id}/routine`, { method: "POST", body: JSON.stringify({ name }) }),
  });
  if (!saved) return;
  state.data.routines = [...(state.data.routines ?? []).filter(item => item.id !== saved.id),
    { id: saved.id, gym_id: saved.gym_id, name: saved.name, exercise_count: saved.exercises.length }]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  if (!state.data.active_workout) renderStart();
  const skippedNote = saved.skipped ? ` ${saved.skipped} archived exercise${saved.skipped === 1 ? "" : "s"} skipped.` : "";
  showToast(`Routine ${saved.name} saved with ${saved.exercises.length} exercise${saved.exercises.length === 1 ? "" : "s"}.${skippedNote}`);
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
    state.data = await api("/api/bootstrap");
    drafts.snapshot(state.data);
    // A gym archived or deleted in Manage can no longer be selected.
    if (!state.data.gyms.some((gym) => gym.id === state.selectedGymId)) state.selectedGymId = null;
    if (!state.selectedGymId && state.data.gyms.length === 1) {
      state.selectedGymId = state.data.gyms[0].id;
    }
    resetEditor();
    render();
    retryPendingSets();
  } catch (error) {
    state.data = state.data || drafts.cachedWorkout();
    if (state.data) {
      resetEditor();
      render();
      return;
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
  return `<header class="app-header"><div class="brand-block"><div class="brand">Gymdex</div><div class="status${state.data.active_workout ? " status-active" : ""}">${escapeHtml(status)}</div></div><nav aria-label="App views"><button class="text-button" id="open-progress" ${recordedGyms().length ? "" : "disabled"}>Progress</button><button class="text-button" id="open-history">History</button></nav></header><p id="sync-status" class="sync-status" role="status"></p>`;
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
    await saveWorkoutRoutine(state.summary.workout);
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

async function startWorkout() {
  try {
    await api("/api/workouts", { method: "POST", body: JSON.stringify({ gym_id: state.selectedGymId }) });
    await load();
  } catch (error) { showToast(error.message); }
}

// Repeat and Start routine answer with the new Active Workout and how many exercises they
// left out because their Variation or Exercise Configuration is archived.
async function showStartedWorkout({ skipped = 0, ...started }, notice) {
  state.summary = null;
  state.collapsedExercises.clear();
  state.exerciseOptions.clear();
  state.data.active_workout = started;
  state.data.workout_exercises = [];
  state.selectedGymId = started.gym_id;
  drafts.snapshot(state.data);
  await load();
  const skippedNote = skipped ? ` ${skipped} archived exercise${skipped === 1 ? "" : "s"} skipped.` : "";
  showToast(`${notice}${skippedNote}`);
}

async function startRoutine(button) {
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
        ${entries.length ? entries.map((entry, index) => `
          <details class="exercise-entry workout-exercise" data-entry-id="${entry.id}" ${state.collapsedExercises.has(entry.id) ? "" : "open"}>
            <summary class="exercise-summary"><h3>${escapeHtml(exerciseDisplayName(entry))}</h3><span data-exercise-count="${entry.id}">${entry.sets.filter(set => set.completed).length}/${entry.sets.length} done</span></summary>
            <div class="exercise-body">
              <p class="meta">${escapeHtml(configurationLabel(entry))}</p>
              <div class="sets-list">${entry.sets.map((set, index) => renderSet(entry, set, index)).join("")}</div>
              <button class="secondary add-set" data-add-set="${entry.id}">Add set</button>
              <details class="exercise-options" data-options-id="${entry.id}" ${state.exerciseOptions.has(entry.id) || state.editor?.noteStatus(`exercise:${entry.id}`)?.dirty ? "open" : ""}><summary>Exercise options</summary>
                <p class="set-hint">${entry.tracking_type === "duration" ? "Duration in seconds" : "Repetitions"}. ${entry.assisted ? "Assist kg is the counterweight and is optional." : "Weight is optional."}</p>
                ${renderNote(`exercise:${entry.id}`, "Note", `Note for ${exerciseDisplayName(entry)}`)}
                <div class="exercise-tools">
                  <button type="button" class="text-button" data-active-progress="${entry.variation_id}" data-progress-equipment="${escapeHtml(entry.equipment)}" data-progress-manufacturer="${escapeHtml(entry.manufacturer || "")}" data-progress-label="${escapeHtml(entry.label || "")}">View progress</button>
                  <button type="button" class="text-button" data-change-machine="${entry.id}" aria-label="Change machine for ${escapeHtml(exerciseDisplayName(entry))}">Change machine</button>
                  <button type="button" class="text-button manage-remove" data-remove-exercise="${entry.id}" aria-label="Remove ${escapeHtml(exerciseDisplayName(entry))}">Remove exercise</button>
                </div>
                ${renderExerciseTools(entry, index, entries.length)}
              </details>
            </div>
          </details>`).join("") : `<div class="empty"><h3>No exercises yet</h3><p>Add a recent choice in one tap, or search the catalog.</p></div>`}
      </section>
      <button class="primary accent add-exercise" id="open-picker">Add exercise</button>
      <div class="workout-actions">
        <button class="secondary" data-finish-workout>Finish workout</button>
        <button class="text-button cancel-workout" id="cancel-workout">Cancel workout</button>
      </div>
    </main>`;
  document.querySelector("#open-picker").addEventListener("click", openPicker);
  document.querySelector("#open-history").addEventListener("click", () => openHistory());
  document.querySelector("#open-progress").addEventListener("click", () => openProgress());
  document.querySelectorAll("[data-finish-workout]").forEach((button) => button.addEventListener("click", finishWorkout));
  document.querySelector("#cancel-workout").addEventListener("click", cancelWorkout);
  document.querySelectorAll(".workout-exercise").forEach((card) => card.addEventListener("toggle", () => {
    const id = Number(card.dataset.entryId);
    if (card.open) state.collapsedExercises.delete(id);
    else state.collapsedExercises.add(id);
  }));
  document.querySelectorAll("[data-options-id]").forEach((options) => options.addEventListener("toggle", () => {
    const id = Number(options.dataset.optionsId);
    if (options.open) state.exerciseOptions.add(id);
    else state.exerciseOptions.delete(id);
  }));
  document.querySelectorAll(".set-form").forEach(bindSet);
  document.querySelectorAll("[data-note-target]").forEach(bindNote);
  document.querySelectorAll("[data-add-set]").forEach((button) => button.addEventListener("click", () => addSet(button)));
  document.querySelectorAll("[data-active-progress]").forEach((button) => button.addEventListener("click", () => openProgress(
    Number(button.dataset.activeProgress), workout.gym_id, {
      equipment: button.dataset.progressEquipment,
      manufacturer: button.dataset.progressManufacturer,
      label: button.dataset.progressLabel,
    },
  )));
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
// waiting to reach the server opens so its draft is visible.
function renderNote(target, label, accessibleName = label) {
  const status = state.editor?.noteStatus(target);
  const note = status?.note ?? "";
  return `<details class="note" ${status?.dirty ? "open" : ""}>
    <summary><span class="note-label" data-note-summary="${target}" data-label="${label}">${noteLabel(label, note)}</span><span class="note-preview" data-note-preview="${target}">${escapeHtml(note)}</span></summary>
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

function renderExerciseTools(entry, index, count) {
  const name = escapeHtml(exerciseDisplayName(entry));
  // data-move-to is the 1-based target position; the ends keep their disabled button for a stable layout.
  return `<div class="exercise-tools">
    <button type="button" class="text-button" data-move-exercise="${entry.id}" data-move-to="${index}" aria-label="Move ${name} up" ${index === 0 ? "disabled" : ""}>Move up</button>
    <button type="button" class="text-button" data-move-exercise="${entry.id}" data-move-to="${index + 2}" aria-label="Move ${name} down" ${index === count - 1 ? "disabled" : ""}>Move down</button>
  </div>`;
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
        ${[30, 60, 90, 120, 180].map((seconds) => `<option value="${seconds}" ${duration === seconds ? "selected" : ""}>${seconds < 60 ? `${seconds} seconds` : `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`}</option>`).join("")}
        ${[30, 60, 90, 120, 180].includes(duration) ? "" : `<option value="${duration}" selected>${duration} seconds</option>`}
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
  enabled.addEventListener("change", () => {
    state.restEnabled = enabled.checked;
    document.querySelector("#rest-controls").hidden = !state.restEnabled;
    if (!state.restEnabled) state.restTimer.stop();
    saveRestSettings();
    renderRestTimerState();
  });
  document.querySelector("#rest-duration").addEventListener("change", (event) => {
    state.restTimer.setDuration(Number(event.target.value));
    saveRestSettings();
  });
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
  return `<h3>${escapeHtml(workout.gym_name)}</h3>
    <p>Started ${escapeHtml(formatLocalDateTime(workout.started_at))}<br>Finished ${escapeHtml(formatLocalDateTime(workout.completed_at))}</p>
    ${renderHistoryNote("workout", workout.note, "workout note")}
    ${workout.gym_archived ? `<p class="history-notice">Restore ${escapeHtml(workout.gym_name)} in Manage to repeat this workout.</p>`
      : `${canRepeat ? `<button class="secondary history-repeat" type="button" data-repeat-workout="${workout.id}">Repeat this workout</button>` : `<p class="history-notice">Finish the active workout before repeating this one.</p>`}
        <button class="secondary history-save-routine" type="button" data-save-routine="${workout.id}">Save as routine</button>`}
    <div class="exercise-list">${entries.length ? entries.map((entry) => `
      <article class="exercise-entry">
        <div class="history-exercise-heading"><h3>${escapeHtml(exerciseDisplayName(entry))}</h3>${entry.variation_id ? `<button type="button" class="text-button" data-progress-variation="${entry.variation_id}" data-progress-equipment="${escapeHtml(entry.equipment)}" data-progress-manufacturer="${escapeHtml(entry.manufacturer || "")}" data-progress-label="${escapeHtml(entry.label || "")}">View progress</button>` : ""}</div>
        <p class="meta">${escapeHtml(configurationLabel(entry))}</p>
        ${renderHistoryNote(`exercise:${entry.id}`, entry.note, "note", ` for ${exerciseDisplayName(entry)}`)}
        ${entry.sets.length ? `<ol class="history-sets">${entry.sets.map((set, index) => {
          const weight = set.weight === null ? "No weight recorded" : `${Math.abs(set.weight)} kg${set.weight < 0 ? " assistance" : ""}`;
          const result = set.result === null ? "No result recorded" : `${set.result} ${entry.tracking_type === "duration" ? "seconds" : "reps"}`;
          const assisted = Boolean(entry.assisted) || set.weight < 0;
          return `<li><span>Set ${index + 1}: ${escapeHtml(result)} · ${escapeHtml(weight)}</span><span class="meta">${set.completed ? "Completed" : "Not completed"}</span>
            ${set.id ? `<div class="history-set-actions"><button type="button" class="text-button history-edit-toggle" data-edit-set="${set.id}">Edit set ${index + 1}</button><button type="button" class="text-button history-delete-set" data-delete-history-set="${set.id}">Delete set ${index + 1}</button></div>
              <form class="history-set-form" data-history-set="${set.id}" data-assisted="${assisted}" hidden>
                <div class="set-inputs">
                  <label>${assisted ? "Assist kg" : "kg"} <input name="weight" type="text" inputmode="decimal" pattern="${WEIGHT_PATTERN}" autocomplete="off" title="A number such as 62.5 or 62,5" value="${set.weight === null ? "" : Math.abs(set.weight)}" /></label>
                  <label>${entry.tracking_type === "duration" ? "Seconds" : "Reps"} <input name="result" type="number" inputmode="numeric" min="1" max="1000000" step="1" value="${set.result ?? ""}" ${set.completed ? "required" : ""} /></label>
                </div>
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
        <strong>${escapeHtml(workout.gym_name)}</strong><span>${escapeHtml(formatLocalDateTime(workout.started_at))}</span>
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
      <label class="field">Exercise<select name="variation_id" id="progress-exercise" required></select></label>
      <label class="field">Gym<select name="gym_id"><option value="">All gyms</option>${gymOptions(initialGymId)}</select></label>
      <button type="submit" class="secondary">Show progress</button>
    </form>
    <div id="progress-config" class="progress-config" ${initialConfig ? "" : "hidden"}><span>Showing this machine configuration</span><button type="button" class="text-button" id="progress-all-configs">Show all equipment</button></div>
    <p id="progress-message" role="status">Loading exercises…</p>
    <div id="progress-results"></div>`;
  document.body.append(dialog);
  const find = (selector) => dialog.querySelector(selector);
  const form = find("#progress-filters");
  const exercise = find("#progress-exercise");
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
        ${entries.map(entry => `<p>${escapeHtml(configurationLabel(entry))}</p><ul>${entry.sets.filter(set => set.completed).map(set =>
          `<li>${set.result} ${entry.tracking_type === "duration" ? "seconds" : "reps"} · ${set.weight === null ? "No weight recorded" : `${Math.abs(set.weight)} kg${set.weight < 0 ? " assistance" : ""}`}</li>`).join("")}</ul>`).join("") || "<p>No matching completed sets remain.</p>"}`;
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
  form.addEventListener("change", () => {
    config = null;
    find("#progress-config").hidden = true;
    loadProgress();
  });
  dialog.showModal();
  try {
    // Archived custom variations stay selectable: their recorded workouts still have progress.
    const catalog = await api(`/api/catalog?gym_id=${gyms[0].id}&include_archived=1`);
    if (!dialog.open) return;
    exercise.innerHTML = catalog.catalog.map((item) => `<option value="${item.id}" ${item.id === initialVariationId ? "selected" : ""}>${escapeHtml(exerciseDisplayName(item))}${item.archived ? " (archived)" : ""}</option>`).join("");
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
  const removeLabel = item.used ? "Archive" : "Delete";
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
        detail: [variation.tracking_type === "duration" ? "Duration" : "Repetitions", ...variation.equipment.map((equipment) => equipment.name)].join(" · "),
        actions: `<button type="button" class="text-button" data-manage-equipment="variation:${variation.id}" aria-label="Edit equipment of ${escapeHtml(exerciseDisplayName(variation))}">Equipment</button>`,
        editor: renderEquipmentEditor(variation, open) })).join("")}</ul>`;
  }).join("");
  return renderManageSection("exercises", "Custom Exercise Variations", active.length, variations.length ? `
      <p class="manage-help">Delete removes a variation with no workouts. Archive keeps a variation with workouts in history and progress but stops offering it in the exercise picker.</p>
      ${groups || "<p>All custom variations are archived.</p>"}
      ${renderManageArchived("exercises", archived.map((variation) => renderManageRow("variation", variation)), open)}`
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
      <p class="manage-help">Saved for a gym when you add an exercise there, and offered under Recent. Delete removes one never used in a workout. Archive keeps a used one in history but stops offering it under Recent and in Repeat; choosing the same equipment, manufacturer and label again restores it.</p>
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
    const { item, name, path } = selected;
    const button = remove || restore;
    if (remove && !await ask(item.used
      ? `Archive ${name}? It is used in recorded workouts, so it stays in history and progress but is no longer offered for new workouts. You can restore it here.`
      : `Delete ${name}? It has never been used in a workout, so it is removed permanently.`,
    { confirmLabel: item.used ? "Archive" : "Delete", danger: true })) return;
    button.disabled = true;
    try {
      if (remove) {
        const { outcome } = await api(path, { method: "DELETE" });
        await changed(`${name} ${outcome}.`);
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
    data: state.data, drafts, request: api, onChange: syncEditorView,
    schedule: setTimeout, clear: clearTimeout, online: () => navigator.onLine,
  }) : null;
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
    if (status.message) setStatus(form, status.message, status.error);
    form.querySelector(".set-retry").hidden = !status.blocked || status.saving;
    const saved = state.data.workout_exercises.flatMap((entry) => entry.sets)
      .find((set) => set.id === Number(form.dataset.setId));
    if (saved && !status.dirty) form.classList.toggle("is-complete", Boolean(saved.completed));
  });
  document.querySelectorAll("[data-note-target]").forEach((field) => {
    const target = field.dataset.noteTarget;
    const status = state.editor?.noteStatus(target);
    if (!status) return;
    if (status.dirty) field.dataset.dirty = "true";
    else delete field.dataset.dirty;
    const message = document.querySelector(`[data-note-status="${target}"]`);
    if (message) {
      message.textContent = status.message;
      message.classList.toggle("error", status.error);
    }
    const summary = document.querySelector(`[data-note-summary="${target}"]`);
    if (summary) summary.textContent = noteLabel(summary.dataset.label, status.note);
    const preview = document.querySelector(`[data-note-preview="${target}"]`);
    if (preview) preview.textContent = status.note;
  });
  document.querySelectorAll("[data-exercise-count]").forEach((label) => {
    const entry = state.data.workout_exercises.find(item => item.id === Number(label.dataset.exerciseCount));
    if (entry) label.textContent = `${entry.sets.filter(set => set.completed).length}/${entry.sets.length} done`;
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
      sets: state.data.workout_exercises.reduce((count, entry) => count + entry.sets.filter(set => set.completed).length, 0),
      exercises: state.data.workout_exercises.filter(entry => entry.sets.some(set => set.completed)).length,
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
    state.summary = summary;
    state.selectedGymId = gymId;
    await load();
    if (summary) {
      document.querySelector("#finish-summary-title")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    showToast(cancel ? "Workout canceled." : "Workout finished.");
  } catch (error) { showToast(error.message); }
}

async function openPicker() {
  if (!await saveAllSets()) return;
  try {
    state.picker = await api(`/api/catalog?gym_id=${state.data.active_workout.gym_id}`);
    state.selectedExercise = null;
    state.selectedEquipment = null;
    renderPicker();
  } catch (error) { showToast(error.message); }
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
  state.selectedExercise = null;
  state.selectedEquipment = null;
  renderPicker();
}

function renderPicker(query = "") {
  openSheet(`
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-header"><h2 id="picker-title">Add exercise</h2><button class="text-button" id="close-picker">Close</button></div>
      <input class="search" id="exercise-search" type="search" inputmode="search" autocomplete="off" placeholder="Search exercises" aria-label="Search exercises" value="${escapeHtml(query)}" />
      <div id="picker-results"></div>`);
  const search = document.querySelector("#exercise-search");
  search.focus();
  search.setSelectionRange(search.value.length, search.value.length);
  search.addEventListener("input", (event) => renderPickerResults(event.target.value));
  renderPickerResults(query);
  document.querySelector("#close-picker").addEventListener("click", () => closePicker());
}

// Without a query: Recent, then the whole catalog. A query searches the Gym's saved
// configurations and the catalog together, so nothing needs a second search elsewhere.
function renderPickerResults(query) {
  const wanted = query.trim().toLowerCase();
  const filtered = state.picker.catalog.filter((item) =>
    `${exerciseDisplayName(item)} ${item.exercise_name} ${item.variation_name}`.toLowerCase().includes(wanted)
  );
  const gymName = escapeHtml(state.pickerContext?.gym.name ?? state.data.active_workout.gym_name);
  const configurations = wanted
    ? (state.picker.saved ?? state.picker.recent).filter((item) =>
      `${exerciseDisplayName(item)} ${item.exercise_name} ${item.variation_name} ${configurationLabel(item)}`.toLowerCase().includes(wanted))
    : state.picker.recent;
  document.querySelector("#picker-results").innerHTML = `
      ${configurations.length ? `<div class="section-title"><h3>${wanted ? "Saved" : "Recent"} at ${gymName}</h3>${wanted ? `<span>${configurations.length}</span>` : ""}</div><div class="recent-list">${configurations.map((item) => `<button class="recent-card" data-profile-id="${item.profile_id}"><strong>${escapeHtml(exerciseDisplayName(item))}</strong><span>${escapeHtml(configurationLabel(item))}</span></button>`).join("")}</div>` : ""}
      <div class="section-title"><h3>Exercise catalog</h3><span>${filtered.length}</span></div>
      <div class="exercise-list">${filtered.map((item) => `<button class="exercise-card" data-variation-id="${item.id}"><strong>${escapeHtml(exerciseDisplayName(item))}</strong><span>${escapeHtml(item.equipment.join(" · "))}</span></button>`).join("") || (wanted && configurations.length
        ? `<p class="picker-note">No catalog exercises match. Create a custom exercise if none of the saved ones fit.</p>`
        : `<div class="empty"><h3>No matches</h3><p>Create the exercise to add it here.</p></div>`)}</div>
      <button class="secondary create-exercise-button" type="button" id="create-exercise">Create custom exercise</button>`;
  document.querySelectorAll("[data-profile-id]").forEach((button) => button.addEventListener("click", () => addRecent(Number(button.dataset.profileId))));
  document.querySelectorAll("[data-variation-id]").forEach((button) => button.addEventListener("click", () => chooseExercise(Number(button.dataset.variationId))));
  document.querySelector("#create-exercise").addEventListener("click", () => renderCustomExerciseForm(query));
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

// Values offered for an Exercise by name, from the picker catalog: its Variations' names and
// Equipment plus the starter Equipment, and the machine details of its Exercise Configurations
// at every gym. A new Exercise gets only the starter Equipment.
function exerciseSuggestions(name) {
  const suggestions = state.picker.suggestions ?? { equipment: [], exercises: [] };
  const key = cleanEquipmentName(name).toLowerCase();
  return suggestions.exercises.find((item) => item.name.toLowerCase() === key)
    ?? { variations: [], equipment: suggestions.equipment, manufacturers: [], labels: [] };
}

// Variation names must be unique within an Exercise, so only Standard is offered, while the
// existing Exercise lacks it; any other new name is typed. A new Exercise gets Standard when left blank.
function variationChoices(variations) {
  return variations.length && !variations.some((value) => value.toLowerCase() === "standard") ? ["Standard"] : [];
}

// A blank Variation name becomes Standard, so Standard is suggested only while it is free.
function variationPlaceholder(known) {
  return known.variations.some((value) => value.toLowerCase() === "standard") ? "e.g. Wide grip" : "Standard";
}

// Names the typed Exercise's existing Variations under the Variation field, so a taken name is not retyped.
function variationHelp(known, choices) {
  if (!known.variations.length) return "";
  const next = choices.length ? "Choose Standard or Other… for a new variation name." : "Enter a new variation name.";
  return `${known.name} already has: ${known.variations.join(", ")}. ${next}`;
}

function renderCustomExerciseForm(query = "") {
  const sheet = document.querySelector("#picker .sheet");
  sheet.innerHTML = `
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-header"><button class="text-button" id="back-to-picker">Back</button><button class="text-button" id="close-picker">Close</button></div>
    <h2 id="picker-title">Create custom exercise</h2>
    <p>Use an existing exercise name to add a new variation, or enter a new name.</p>
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
      <p class="field-help" id="equipment-help">Choose or type one option, then tap Add. You can choose one for each gym machine when logging.</p>
      <label class="assistance-option"><input name="assisted" type="checkbox" /> Assisted (weight is counterweight)</label>
      <button class="primary accent" type="submit">Create exercise</button>
    </form>`;
  sheet.querySelector("#back-to-picker").addEventListener("click", () => renderPicker(query));
  sheet.querySelector("#close-picker").addEventListener("click", () => closePicker());
  const equipment = [];
  const nameInput = sheet.querySelector('[name="name"]');
  // The typed Exercise name decides which suggestions are offered; see exerciseSuggestions().
  let known = exerciseSuggestions(nameInput.value ?? query);
  const variation = new ChoiceField(sheet.querySelector("#variation-field"), { id: "variation-name", name: "variation_name",
    title: "Variation", placeholder: variationPlaceholder(known), describedBy: "variation-help", options: variationChoices(known.variations) });
  const help = sheet.querySelector("#variation-help");
  const showVariationHelp = () => {
    help.textContent = variationHelp(known, variation.options);
    help.hidden = !help.textContent;
  };
  showVariationHelp();
  const unadded = () => known.equipment.filter((value) => !equipment.some((added) => added.toLowerCase() === value.toLowerCase()));
  const entry = new ChoiceField(sheet.querySelector("#equipment-choice"), { id: "equipment-entry", title: "Equipment options",
    empty: "Choose equipment", placeholder: "e.g. Machine", newLabel: "New equipment option", describedBy: "equipment-help",
    options: unadded(), onEnter: () => addEquipment() });
  nameInput.addEventListener("input", () => {
    known = exerciseSuggestions(nameInput.value);
    variation.placeholder = variationPlaceholder(known);
    variation.setOptions(variationChoices(known.variations));
    showVariationHelp();
    entry.setOptions(unadded());
  });
  const chips = sheet.querySelector("#equipment-chips");
  const renderChips = () => {
    chips.innerHTML = renderEquipmentChips(equipment);
    entry.setOptions(unadded());
  };
  const addEquipment = () => {
    const name = entry.value;
    if (!name) return true;
    const problem = equipmentProblem(equipment, name);
    if (problem) { showToast(problem); entry.focus(); return false; }
    equipment.push(name);
    renderChips();
    entry.clear();
    if (entry.typing) entry.focus();
    return true;
  };
  sheet.querySelector("#add-equipment").addEventListener("click", addEquipment);
  chips.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-remove-equipment]");
    if (!button) return;
    equipment.splice(Number(button.dataset.removeEquipment), 1);
    renderChips();
    if (entry.typing) entry.focus();
  });
  sheet.querySelector("#custom-exercise-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    if (!addEquipment()) return;
    if (!equipment.length) {
      showToast("Add at least one equipment option.");
      entry.focus();
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const created = await api("/api/exercises", { method: "POST", body: JSON.stringify({
        name: values.get("name"), variation_name: variation.value,
        tracking_type: values.get("tracking_type"), equipment, assisted: values.get("assisted") === "on",
      }) });
      state.picker.catalog.push(created);
      chooseExercise(created.id);
      showToast("Exercise created. Choose equipment to add it.");
    } catch (error) { submit.disabled = false; showToast(error.message); }
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

async function addRecent(profileId) {
  if (state.pickerContext) {
    const profile = (state.picker.saved ?? state.picker.recent).find(item => item.profile_id === profileId);
    return saveRoutineChoice({ variation_id: profile.variation_id, equipment: profile.equipment,
      manufacturer: profile.manufacturer, label: profile.label });
  }
  try {
    await api(`/api/workouts/${state.data.active_workout.id}/exercises`, { method: "POST", body: JSON.stringify({ profile_id: profileId }) });
    closePicker();
    await load();
    showToast("Exercise added.");
  } catch (error) { showToast(error.message); }
}

function chooseExercise(variationId) {
  state.selectedExercise = state.picker.catalog.find((item) => item.id === variationId);
  state.selectedEquipment = state.selectedExercise.equipment[0];
  renderConfiguration();
}

// The Exercise Configuration form: equipment of state.selectedExercise plus manufacturer and
// machine label. Adding a Variation starts empty; Change machine (change) starts from a
// Workout Exercise's current values and saves them to it instead.
function renderConfiguration(change = null) {
  const sheet = document.querySelector("#picker .sheet");
  const item = state.selectedExercise;
  sheet.innerHTML = `
    <div class="sheet-handle" aria-hidden="true"></div>
    ${change ? `<div class="sheet-header"><h2 id="picker-title">Change machine</h2><button class="text-button" id="close-picker">Cancel</button></div>
    <p>${escapeHtml(exerciseDisplayName(item))} keeps its sets and note.</p>` : `<div class="sheet-header"><button class="text-button" id="back-to-picker">Back</button><button class="text-button" id="close-picker">Close</button></div>
    <h2 id="picker-title">${escapeHtml(exerciseDisplayName(item))}</h2>
    <p>Choose the equipment used at this gym.</p>`}
    <div class="equipment-grid">${item.equipment.map((equipment) => `<button class="equipment-option" data-equipment="${escapeHtml(equipment)}" aria-pressed="${state.selectedEquipment === equipment}">${escapeHtml(equipment)}</button>`).join("")}</div>
    <form id="configuration-form">
      <div class="field choice-field" id="manufacturer-field"></div>
      <div class="field choice-field" id="machine-label-field"></div>
      <button class="primary accent" type="submit">${change ? "Save" : state.pickerContext ? "Add to routine" : "Add exercise"}</button>
    </form>`;
  document.querySelector("#back-to-picker")?.addEventListener("click", () => renderPicker());
  document.querySelector("#close-picker").addEventListener("click", () => closePicker(change?.focus));
  document.querySelectorAll("[data-equipment]").forEach((button) => button.addEventListener("click", () => {
    state.selectedEquipment = button.dataset.equipment;
    document.querySelectorAll("[data-equipment]").forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
  }));
  // Machine details entered before for this Exercise, at any gym, are offered first.
  const known = exerciseSuggestions(item.exercise_name);
  const details = {
    manufacturer: new ChoiceField(document.querySelector("#manufacturer-field"), { id: "manufacturer", name: "manufacturer",
      title: "Manufacturer", optional: true, empty: "None", placeholder: "e.g. Technogym", options: known.manufacturers,
      value: change?.entry.manufacturer ?? null }),
    label: new ChoiceField(document.querySelector("#machine-label-field"), { id: "machine-label", name: "label",
      title: "Machine label", optional: true, empty: "None", placeholder: "e.g. Upstairs plate-loaded", options: known.labels,
      value: change?.entry.label ?? null }),
  };
  document.querySelector("#configuration-form").addEventListener("submit", (event) =>
    change ? saveMachine(event, change, details) : addConfiguredExercise(event, details));
}

// Change machine on a Workout Exercise card: saves set and note drafts first, like the other
// card actions, then opens the Exercise Configuration form with the card's current values.
async function changeMachine(entryId) {
  const entry = state.data.workout_exercises.find((item) => item.id === entryId);
  if (!entry || !state.editor || state.editor.busy) return;
  if (!await saveAllSets("Cannot change the machine yet")) return;
  try {
    state.picker = await api(`/api/catalog?gym_id=${state.data.active_workout.gym_id}`);
  } catch (error) { showToast(error.message); return; }
  const variation = state.picker.catalog.find((item) => item.id === entry.variation_id);
  if (!variation) {
    showToast(`${exerciseDisplayName(entry)} is archived. Restore it in Manage to change its machine.`);
    return;
  }
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
    const saved = await api(`/api/workouts/${state.data.active_workout.id}/exercises/${change.entry.id}/configuration`, {
      method: "PUT",
      body: JSON.stringify({ equipment: state.selectedEquipment, manufacturer: manufacturer.value, label: label.value }),
    });
    closePicker(change.focus);
    await load();
    document.querySelector(change.focus)?.focus();
    showToast(`Changed to ${configurationLabel(saved)}.`);
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
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api(`/api/workouts/${state.data.active_workout.id}/exercises`, {
      method: "POST",
      body: JSON.stringify({
        variation_id: state.selectedExercise.id,
        equipment: state.selectedEquipment,
        manufacturer: manufacturer.value,
        label: label.value,
      }),
    });
    closePicker();
    await load();
    showToast("Exercise added. It will appear under recent choices next time.");
  } catch (error) { submit.disabled = false; showToast(error.message); }
}

function renderSet(entry, set, index) {
  const previous = entry.previous_sets[index];
  const unit = entry.tracking_type === "duration" ? "sec" : "reps";
  const name = `${exerciseDisplayName(entry)}, set ${set.position}`;
  // Negative weights recorded before assistance moved to the variation stay assisted.
  const assisted = Boolean(entry.assisted) || set.weight < 0 || state.editor?.status(set.id)?.values?.assistance === true;
  const previousText = previous
    ? `${previous.weight === null ? "" : `${Math.abs(previous.weight)} kg${previous.weight < 0 ? " assistance" : ""} × `}${previous.result} ${unit}`
    : "No completed set";
  return `<form class="set-form${set.completed ? " is-complete" : ""}" data-set-id="${set.id}" data-entry-id="${entry.id}" data-assisted="${assisted}">
    <fieldset>
      <legend>Set ${set.position}</legend>
      <button type="button" class="remove-set" aria-label="Remove ${escapeHtml(name)}"><span aria-hidden="true">×</span></button>
      ${previous
        ? `<button type="button" class="previous-set fill-previous" data-previous-weight="${previous.weight ?? ""}" data-previous-result="${previous.result}" aria-label="Fill ${escapeHtml(name)} from last workout: ${escapeHtml(previousText)}">Last workout: ${escapeHtml(previousText)}</button>`
        : `<p class="previous-set">Last workout: ${escapeHtml(previousText)}</p>`}
      <div class="set-inputs">
        <label>${assisted ? "Assist kg" : "kg"} <input name="weight" type="text" inputmode="decimal" pattern="${WEIGHT_PATTERN}" autocomplete="off" title="A number such as 62.5 or 62,5" aria-label="${escapeHtml(name)} ${assisted ? "assistance" : "weight"} in kilograms" value="${set.weight === null ? "" : Math.abs(set.weight)}" /></label>
        <label>${unit === "sec" ? "Seconds" : "Reps"} <input name="result" type="number" inputmode="numeric" min="1" max="1000000" step="1" aria-label="${escapeHtml(name)} ${unit}" value="${set.result ?? ""}" ${set.completed ? "required" : ""} /></label>
        <label class="set-complete">Done <input name="completed" type="checkbox" aria-label="Mark ${escapeHtml(name)} completed and save" ${set.completed ? "checked" : ""} /></label>
      </div>
      <div class="set-actions">
        <span class="set-status" role="status">${set.completed ? "Completed" : "Saved"}</span>
        <button type="button" class="text-button set-retry" hidden>Retry</button>
      </div>
    </fieldset>
  </form>`;
}

function setValues(form) {
  return {
    weight: form.elements.weight.value,
    result: form.elements.result.value,
    completed: form.elements.completed.checked,
    assistance: form.dataset.assisted === "true",
  };
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

function fillFromPrevious(form, previous) {
  if (state.editor.busy) return;
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
  form.elements.result.value = previous.previousResult;
  form.requestSubmit();
}

async function retryPendingSets() {
  if (!navigator.onLine || document.visibilityState === "hidden") return;
  await state.editor?.retry();
  updateSyncStatus();
}

function setStatus(form, message, error = false) {
  const status = form.querySelector(".set-status");
  status.textContent = message;
  status.classList.toggle("error", error);
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

async function saveAllSets(blocked = "Cannot add an exercise yet") {
  const saved = await state.editor?.flush();
  if (!saved) showInvalidSet(blocked);
  return Boolean(saved);
}

async function addSet(button) {
  if (state.editor.busy) return;
  button.disabled = true;
  try {
    const entry = state.data.workout_exercises.find((item) => item.id === Number(button.dataset.addSet));
    const above = entry.sets.at(-1);
    // The server copies the set above, so its latest edit must be saved first.
    if (above && !await state.editor.save(above.id)) {
      [...document.querySelectorAll(".set-form")].find((form) => form.dataset.setId === String(above.id))?.reportValidity();
      showToast(`Set ${above.position} must reach the server before adding another set.`);
      return;
    }
    const set = await api(`/api/workout-exercises/${entry.id}/sets`, { method: "POST", body: "{}" });
    entry.sets.push(set);
    drafts.snapshot(state.data);
    const list = button.closest(".exercise-entry").querySelector(".sets-list");
    list.insertAdjacentHTML("beforeend", renderSet(entry, set, entry.sets.length - 1));
    bindSet(list.lastElementChild);
    list.lastElementChild.elements.weight.focus();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}

async function moveExercise(entryId, position) {
  if (!state.editor || state.editor.busy) return;
  const from = state.data.workout_exercises.findIndex((item) => item.id === entryId) + 1;
  try {
    if (!await state.editor.moveExercise(entryId, position)) { showInvalidSet("Not moved yet"); return; }
    render();
    // Keep focus on the moved exercise, preferring the button for the same direction.
    const [preferred, other] = position < from ? [position - 1, position + 1] : [position + 1, position - 1];
    const button = (to) => document.querySelector(`[data-move-exercise="${entryId}"][data-move-to="${to}"]:not(:disabled)`);
    (button(preferred) || button(other))?.focus();
  } catch (error) { showToast(error.message); }
}

async function removeExercise(entryId) {
  const entry = state.data.workout_exercises.find((item) => item.id === entryId);
  if (!entry || !state.editor || state.editor.busy) return;
  const name = exerciseDisplayName(entry);
  const count = entry.sets.length;
  const question = `Remove ${name}${count ? ` and its ${count} set${count === 1 ? "" : "s"}` : ""} from this workout? This cannot be undone.`;
  let confirmed = false;
  try {
    const confirm = async () => (confirmed = await ask(question, { confirmLabel: "Remove", danger: true }));
    if (!await state.editor.removeExercise(entryId, confirm)) {
      if (confirmed) showInvalidSet("Not removed yet");
      return;
    }
    state.collapsedExercises.delete(entryId);
    state.exerciseOptions.delete(entryId);
    render();
    document.querySelector("#open-picker")?.focus();
    showToast(`${name} removed.`);
  } catch (error) { showToast(error.message); }
}

async function removeSet(form) {
  if (state.editor.busy) return;
  if (!await ask(`Remove set ${form.querySelector("legend").textContent.replace("Set ", "")}?`, { confirmLabel: "Remove", danger: true })) return;
  const entryNode = form.closest(".exercise-entry");
  const addButton = entryNode.querySelector(".add-set");
  if (await state.editor.remove(form.dataset.setId)) {
    form.remove();
    // The server renumbered the remaining sets: re-render them so their numbers and
    // Last workout values line up. Their drafts are keyed by set id and restored by bindSet.
    const entry = state.data.workout_exercises.find((item) => item.id === Number(form.dataset.entryId));
    const list = entryNode.querySelector(".sets-list");
    if (entry && list) {
      list.innerHTML = entry.sets.map((set, index) => renderSet(entry, set, index)).join("");
      list.querySelectorAll(".set-form").forEach(bindSet);
    }
    addButton.focus();
    updateSyncStatus();
  }
}

app.addEventListener("click", (event) => {
  const routine = event.target.closest?.("[data-start-routine]");
  if (routine) return startRoutine(routine);
  if (event.target.closest?.("#open-routines")) return openRoutinesScreen();
  const move = event.target.closest?.("[data-move-exercise]");
  if (move) return moveExercise(Number(move.dataset.moveExercise), Number(move.dataset.moveTo));
  const remove = event.target.closest?.("[data-remove-exercise]");
  if (remove) return removeExercise(Number(remove.dataset.removeExercise));
  const machine = event.target.closest?.("[data-change-machine]");
  if (machine) return changeMachine(Number(machine.dataset.changeMachine));
});

window.addEventListener("beforeunload", (event) => {
  if (drafts.error && state.editor?.pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("online", () => { retryPendingSets(); updateSyncStatus(); });
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
