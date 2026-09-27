import { DraftStore, setPayload } from "./drafts.mjs";
import { NOTE_MAX_LENGTH, WorkoutEditor } from "./workout-editor.mjs";
import { RestTimer } from "./rest-timer.mjs";

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

export function createApp({ window, document, navigator, fetch, setTimeout, clearTimeout, setInterval, clearInterval, now = () => Date.now() }) {

const drafts = new DraftStore(() => window.localStorage);
const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const savedRest = readRestSettings();

const state = {
  data: null,
  selectedGymId: null,
  picker: null,
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
  return `<header class="app-header"><div class="brand">Gymdex</div><nav aria-label="App views"><button class="text-button" id="open-progress" ${recordedGyms().length ? "" : "disabled"}>Progress</button><button class="text-button" id="open-history">History</button></nav><div class="status${state.data.active_workout ? " status-active" : ""}">${escapeHtml(status)}</div></header><p id="sync-status" class="sync-status" role="status"></p>`;
}

function renderStart() {
  stopWorkoutElapsed();
  const gyms = state.data.gyms;
  app.innerHTML = `
    <main class="shell">
      ${renderHeader("No active workout")}
      <section class="intro">
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
      <div class="bottom-action"><button class="primary accent" id="start-workout" ${state.selectedGymId ? "" : "disabled"}>Start workout</button></div>
    </main>`;

  document.querySelectorAll("[data-gym-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedGymId = Number(button.dataset.gymId);
      renderStart();
      updateSyncStatus();
    });
  });
  document.querySelector("#add-gym-form").addEventListener("submit", createGym);
  document.querySelector("#start-workout").addEventListener("click", startWorkout);
  document.querySelector("#open-history").addEventListener("click", openHistory);
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
        <div class="stale-actions"><button type="button" class="primary" id="stale-finish">Finish it</button><button type="button" class="secondary" id="stale-keep">Keep going</button></div>
      </section>` : ""}
      ${renderRestTimer()}
      <div class="section-title"><h2>Exercises</h2><span>${entries.length}</span></div>
      <section class="exercise-list">
        ${entries.length ? entries.map((entry, index) => `
          <article class="exercise-entry" data-entry-id="${entry.id}">
            <div class="history-exercise-heading"><h3>${escapeHtml(exerciseDisplayName(entry))}</h3><button type="button" class="text-button" data-active-progress="${entry.variation_id}" data-progress-equipment="${escapeHtml(entry.equipment)}" data-progress-manufacturer="${escapeHtml(entry.manufacturer || "")}" data-progress-label="${escapeHtml(entry.label || "")}">View progress</button></div>
            <p class="meta">${escapeHtml(configurationLabel(entry))}</p>
            <p class="set-hint">${entry.tracking_type === "duration" ? "Duration in seconds" : "Repetitions"}. ${entry.assisted ? "Assist kg is the counterweight and is optional." : "Weight is optional."}</p>
            <div class="sets-list">${entry.sets.map((set, index) => renderSet(entry, set, index)).join("")}</div>
            <button class="secondary add-set" data-add-set="${entry.id}">Add set</button>
            ${renderNote(`exercise:${entry.id}`, "Note", `Note for ${exerciseDisplayName(entry)}`)}
            ${renderExerciseTools(entry, index, entries.length)}
          </article>`).join("") : `<div class="empty"><h3>No exercises yet</h3><p>Add a recent choice in one tap, or search the catalog.</p></div>`}
      </section>
      <button class="primary accent add-exercise" id="open-picker">Add exercise</button>
      ${renderNote("workout", "Workout note")}
      <div class="workout-actions">
        <button class="secondary" data-finish-workout>Finish workout</button>
        <button class="text-button cancel-workout" id="cancel-workout">Cancel workout</button>
      </div>
    </main>`;
  document.querySelector("#open-picker").addEventListener("click", openPicker);
  document.querySelector("#open-history").addEventListener("click", openHistory);
  document.querySelector("#open-progress").addEventListener("click", () => openProgress());
  document.querySelectorAll("[data-finish-workout]").forEach((button) => button.addEventListener("click", finishWorkout));
  document.querySelector("#cancel-workout").addEventListener("click", cancelWorkout);
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
    document.querySelector("#stale-finish").addEventListener("click", finishWorkout);
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
    <button type="button" class="text-button remove-exercise" data-remove-exercise="${entry.id}" aria-label="Remove ${name}">Remove</button>
  </div>`;
}

function renderRestTimer() {
  const duration = state.restTimer.snapshot().durationSeconds;
  return `<section class="rest-timer" aria-labelledby="rest-title">
    <div class="rest-heading"><h2 id="rest-title">Rest timer</h2><label class="rest-switch"><input id="rest-enabled" type="checkbox" ${state.restEnabled ? "checked" : ""} /> On</label></div>
    <div id="rest-controls" ${state.restEnabled ? "" : "hidden"}>
      <label class="field rest-duration">Rest after a set<select id="rest-duration">
        ${[30, 60, 90, 120, 180].map((seconds) => `<option value="${seconds}" ${duration === seconds ? "selected" : ""}>${seconds < 60 ? `${seconds} seconds` : `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`}</option>`).join("")}
        ${[30, 60, 90, 120, 180].includes(duration) ? "" : `<option value="${duration}" selected>${duration} seconds</option>`}
      </select></label>
      <div class="rest-readout"><strong id="rest-clock" role="timer" aria-live="off"></strong><span id="rest-status" role="status"></span></div>
      <div class="rest-actions"><button type="button" class="secondary" id="rest-start">Start</button><button type="button" class="secondary" id="rest-pause">Pause</button><button type="button" class="text-button" id="rest-stop">Reset</button></div>
    </div>
  </section>`;
}

function renderRestTimerState() {
  const clock = document.querySelector("#rest-clock");
  if (!clock) return;
  const snapshot = state.restTimer.snapshot();
  const minutes = Math.floor(snapshot.remainingSeconds / 60);
  const seconds = String(snapshot.remainingSeconds % 60).padStart(2, "0");
  clock.textContent = `${minutes}:${seconds}`;
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
      : canRepeat ? `<button class="secondary history-repeat" type="button" data-repeat-workout="${workout.id}">Repeat this workout</button>` : `<p class="history-notice">Finish the active workout before repeating this one.</p>`}
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
                  <label>${assisted ? "Assist kg" : "kg"} <input name="weight" type="number" inputmode="decimal" step="any" min="0" max="100000" value="${set.weight === null ? "" : Math.abs(set.weight)}" /></label>
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

function openHistory() {
  if (state.editor?.busy || document.querySelector("#history")) return;
  // Keep the active workout DOM and its local drafts intact beneath the dialog.
  const dialog = document.createElement("dialog");
  dialog.id = "history";
  dialog.className = "history-dialog";
  dialog.setAttribute("aria-labelledby", "history-title");
  dialog.innerHTML = `
    <div class="sheet-header"><h2 id="history-title">Workout history</h2><button class="text-button" id="close-history" autofocus>Close</button></div>
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
    <div id="history-detail-view" hidden><button class="text-button" id="history-back">Back to history</button><div id="history-detail" tabindex="-1"></div></div>`;
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
  let historyChanged = false;
  dialog.addEventListener("close", () => { request++; dialog.remove(); });
  find("#close-history").addEventListener("click", () => dialog.close());
  find("#history-back").addEventListener("click", async () => {
    request++;
    detailView.hidden = true;
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
    detail.textContent = "Loading workout…";
    find("#history-back").focus();
    try {
      const data = await api(`/api/history/${button.dataset.historyId}`);
      if (version !== request) return;
      selectedDetail = data;
      detail.innerHTML = renderHistoryDetail(data, !state.data.active_workout);
      detail.focus();
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
        state.data.active_workout = repeated;
        state.data.workout_exercises = [];
        state.selectedGymId = repeated.gym_id;
        drafts.snapshot(state.data);
        dialog.close();
        await load();
        showToast("Workout repeated. Sets are ready to log.");
      } catch (error) { repeat.disabled = false; showToast(error.message); }
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
      if (!window.confirm(`Delete set ${number} of ${exerciseDisplayName(entry)} from this completed workout? This cannot be undone.`)) return;
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
  loadPage(0);
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
    x: points.length === 1 ? 160 : 28 + index * 264 / (points.length - 1),
    y: high === low ? 76 : 126 - (value - low) * 100 / span,
  }));
  const path = xy.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const label = metric === "best_weight" ? "Best weight" : `Best ${unit}`;
  return `<svg class="progress-chart" viewBox="0 0 320 160" role="img" aria-labelledby="progress-chart-title progress-chart-desc">
    <title id="progress-chart-title">${escapeHtml(label)} across ${points.length} workouts</title>
    <desc id="progress-chart-desc">Values range from ${escapeHtml(low)} to ${escapeHtml(high)} ${metric === "best_weight" ? "kilograms" : escapeHtml(unit)}. The table below lists each workout.</desc>
    <line x1="28" y1="26" x2="292" y2="26" /><line x1="28" y1="126" x2="292" y2="126" />
    ${xy.length > 1 ? `<polyline points="${path}" />` : ""}
    ${xy.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.5" />`).join("")}
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
      <div class="progress-table-wrap"><table class="progress-table"><caption class="visually-hidden">Completed workout progress</caption><thead><tr><th scope="col">Workout</th><th scope="col">Best ${unit}</th><th scope="col">Best weight</th><th scope="col">Sets</th></tr></thead><tbody>
      ${points.map((point) => `<tr><th scope="row">${escapeHtml(formatLocalDateTime(point.completed_at))}</th><td>${point.best_result ?? "—"}</td><td>${point.best_weight === null ? "—" : `${escapeHtml(Math.abs(point.best_weight))} kg${point.best_weight < 0 ? " assistance" : ""}`}</td><td>${point.completed_sets}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty"><h3>No completed sets yet</h3><p>Complete a set in a workout to see progress here.</p></div>`}`;
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
  dialog.addEventListener("close", () => { request++; dialog.remove(); });
  find("#close-progress").addEventListener("click", () => dialog.close());
  find("#progress-all-configs").addEventListener("click", () => {
    config = null;
    find("#progress-config").hidden = true;
    loadProgress();
  });
  results.addEventListener("change", (event) => {
    if (event.target.id !== "progress-metric" || !currentData) return;
    metric = event.target.value;
    results.innerHTML = renderProgressData(currentData, metric);
  });
  async function loadProgress() {
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
    const catalog = await api(`/api/catalog?gym_id=${gyms[0].id}`);
    if (!dialog.open) return;
    exercise.innerHTML = catalog.catalog.map((item) => `<option value="${item.id}" ${item.id === initialVariationId ? "selected" : ""}>${escapeHtml(exerciseDisplayName(item))}</option>`).join("");
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
    exercise.variations.map((variation) => ({ ...variation, exercise_name: exercise.name, variation_name: variation.name })));
  return [];
}

function manageItemName(kind, item) {
  return kind === "configuration" || kind === "variation" ? exerciseDisplayName(item) : item.name;
}

function renderManageRow(kind, item, { name = manageItemName(kind, item), detail = "", rename = false, remove = true } = {}) {
  const key = `${kind}:${item.id}`;
  const label = escapeHtml(name);
  const removeLabel = item.used ? "Archive" : "Delete";
  const actions = item.archived
    ? `<button type="button" class="text-button" data-manage-restore="${key}" aria-label="Restore ${label}">Restore</button>`
    : `${rename ? `<button type="button" class="text-button" data-manage-rename="${key}" aria-label="Rename ${label}">Rename</button>` : ""}${remove ? `<button type="button" class="text-button manage-remove" data-manage-remove="${key}" aria-label="${removeLabel} ${label}">${removeLabel}</button>` : ""}`;
  return `<li class="manage-row">
    <div class="manage-row-text"><span class="manage-name">${label}</span>${detail ? `<span class="meta">${escapeHtml(detail)}</span>` : ""}</div>
    ${actions ? `<div class="manage-actions">${actions}</div>` : ""}
    ${rename && !item.archived ? `<form class="manage-rename-form" data-manage-rename-form="${key}" hidden>
      <label class="field">New name<input name="name" maxlength="80" value="${label}" required autocomplete="off" /></label>
      <div class="history-edit-actions"><button type="submit" class="secondary">Save name</button><button type="button" class="text-button" data-manage-cancel>Cancel</button></div>
      <p class="set-status" role="status"></p>
    </form>` : ""}
  </li>`;
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
  const variations = manageItems(overview, "variation");
  return [
    renderManageSection("gyms", "Gyms", gyms.length, `
      <p class="manage-help">Delete removes a gym with no workouts. Archive hides a gym with workouts from the start screen; its workouts stay in history and progress.</p>
      ${gyms.length ? `<ul class="manage-list">${gyms.map((gym) => renderManageRow("gym", gym, { rename: true })).join("")}</ul>` : `<p>No gyms to manage.</p>`}
      ${renderManageArchived("gyms", archivedGyms.map((gym) => renderManageRow("gym", gym)), open)}`, open),
    renderManageSection("configurations", "Exercise Configurations", configurations.length, `
      <p class="manage-help">Saved for a gym when you add an exercise there, and offered under Recent.</p>
      ${configurations.length ? renderManageGroups(configurations, (item) => `${item.gym_name}${item.gym_archived ? " (archived)" : ""}`,
        (item) => renderManageRow("configuration", item, { detail: configurationLabel(item), remove: false }))
        : `<p>No exercise configurations yet. Add an exercise to a workout to save one.</p>`}`, open),
    renderManageSection("exercises", "Custom exercises", variations.length, variations.length
      ? renderManageGroups(variations, (item) => item.exercise_name,
        (item) => renderManageRow("variation", item, { name: item.name, remove: false,
          detail: [item.tracking_type === "duration" ? "Duration" : "Repetitions", ...item.equipment.map((equipment) => equipment.name)].join(" · ") }))
      : `<p>No custom exercises yet. Create one with Create custom exercise when adding an exercise to a workout.</p>`, open),
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
    if (remove && !window.confirm(item.used
      ? `Archive ${name}? It is used in recorded workouts, so it stays in history and progress but is no longer offered for new workouts. You can restore it here.`
      : `Delete ${name}? It has never been used in a workout, so it is removed permanently.`)) return;
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
  content.addEventListener("submit", async (event) => {
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
  const confirm = () => window.confirm(cancel
    ? "Cancel this workout and discard all its exercises and sets? This cannot be undone."
    : "Finish this workout?");
  try {
    const ended = await (cancel ? editor.cancel(confirm) : editor.finish(confirm));
    if (!ended) { showInvalidSet(); return; }
    state.restTimer.stop();
    state.selectedGymId = gymId;
    await load();
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

function renderPicker(query = "") {
  document.querySelector("#picker")?.remove();
  const wrapper = document.createElement("div");
  wrapper.id = "picker";
  wrapper.className = "sheet-backdrop";
  wrapper.innerHTML = `
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-header"><h2 id="picker-title">Add exercise</h2><button class="text-button" id="close-picker">Close</button></div>
      <input class="search" id="exercise-search" type="search" inputmode="search" autocomplete="off" placeholder="Search exercises" aria-label="Search exercises" value="${escapeHtml(query)}" />
      <div id="picker-results"></div>
    </section>`;
  document.querySelector("main")?.setAttribute("inert", "");
  document.body.append(wrapper);
  const search = document.querySelector("#exercise-search");
  search.focus();
  search.setSelectionRange(search.value.length, search.value.length);
  search.addEventListener("input", (event) => renderPickerResults(event.target.value));
  renderPickerResults(query);
  document.querySelector("#close-picker").addEventListener("click", closePicker);
  wrapper.addEventListener("click", (event) => { if (event.target === wrapper) closePicker(); });
}

function renderPickerResults(query) {
  const filtered = state.picker.catalog.filter((item) =>
    `${exerciseDisplayName(item)} ${item.exercise_name} ${item.variation_name}`.toLowerCase().includes(query.toLowerCase())
  );
  document.querySelector("#picker-results").innerHTML = `
      ${!query && state.picker.recent.length ? `<div class="section-title"><h3>Recent at ${escapeHtml(state.data.active_workout.gym_name)}</h3></div><div class="recent-list">${state.picker.recent.map((item) => `<button class="recent-card" data-profile-id="${item.profile_id}"><strong>${escapeHtml(exerciseDisplayName(item))}</strong><span>${escapeHtml(configurationLabel(item))}</span></button>`).join("")}</div>` : ""}
      <div class="section-title"><h3>${query ? "Results" : "Exercise catalog"}</h3><span>${filtered.length}</span></div>
      <div class="exercise-list">${filtered.map((item) => `<button class="exercise-card" data-variation-id="${item.id}"><strong>${escapeHtml(exerciseDisplayName(item))}</strong><span>${escapeHtml(item.equipment.join(" · "))}</span></button>`).join("") || `<div class="empty"><h3>No matches</h3><p>Create the exercise to add it here.</p></div>`}</div>
      <button class="secondary create-exercise-button" type="button" id="create-exercise">Create custom exercise</button>`;
  document.querySelectorAll("[data-profile-id]").forEach((button) => button.addEventListener("click", () => addRecent(Number(button.dataset.profileId))));
  document.querySelectorAll("[data-variation-id]").forEach((button) => button.addEventListener("click", () => chooseExercise(Number(button.dataset.variationId))));
  document.querySelector("#create-exercise").addEventListener("click", () => renderCustomExerciseForm(query));
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
      <label class="field">Variation<input name="variation_name" maxlength="80" placeholder="Standard" /></label>
      <label class="field">Track by<select name="tracking_type"><option value="repetitions">Repetitions</option><option value="duration">Duration in seconds</option></select></label>
      <div class="field equipment-field">
        <label for="equipment-entry">Equipment options</label>
        <div class="equipment-entry"><input id="equipment-entry" maxlength="80" placeholder="e.g. Machine" autocomplete="off" enterkeyhint="done" aria-describedby="equipment-help" /><button type="button" class="secondary" id="add-equipment">Add</button></div>
        <ul class="equipment-chips" id="equipment-chips" aria-label="Added equipment options"></ul>
      </div>
      <p class="field-help" id="equipment-help">Type one option, then tap Add or press Enter. You can choose one for each gym machine when logging.</p>
      <label class="assistance-option"><input name="assisted" type="checkbox" /> Assisted (weight is counterweight)</label>
      <button class="primary accent" type="submit">Create exercise</button>
    </form>`;
  sheet.querySelector("#back-to-picker").addEventListener("click", () => renderPicker(query));
  sheet.querySelector("#close-picker").addEventListener("click", closePicker);
  const equipment = [];
  const entry = sheet.querySelector("#equipment-entry");
  const chips = sheet.querySelector("#equipment-chips");
  const renderChips = () => {
    chips.innerHTML = equipment.map((name, index) => `<li class="equipment-chip"><span>${escapeHtml(name)}</span><button type="button" class="chip-remove" data-remove-equipment="${index}" aria-label="Remove ${escapeHtml(name)}"><span aria-hidden="true">×</span></button></li>`).join("");
  };
  const addEquipment = () => {
    const name = entry.value.split(/\s+/).filter(Boolean).join(" ");
    if (!name) return true;
    let problem = "";
    if (name.includes("|")) problem = "Equipment names cannot contain |.";
    else if (equipment.some((item) => item.toLowerCase() === name.toLowerCase())) problem = `${name} is already added.`;
    else if (equipment.length >= 20) problem = "You can add up to 20 equipment options.";
    if (problem) { showToast(problem); entry.focus(); return false; }
    equipment.push(name);
    entry.value = "";
    renderChips();
    entry.focus();
    return true;
  };
  entry.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addEquipment();
  });
  sheet.querySelector("#add-equipment").addEventListener("click", addEquipment);
  chips.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-remove-equipment]");
    if (!button) return;
    equipment.splice(Number(button.dataset.removeEquipment), 1);
    renderChips();
    entry.focus();
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
        name: values.get("name"), variation_name: values.get("variation_name"),
        tracking_type: values.get("tracking_type"), equipment, assisted: values.get("assisted") === "on",
      }) });
      state.picker.catalog.push(created);
      chooseExercise(created.id);
      showToast("Exercise created. Choose equipment to add it.");
    } catch (error) { submit.disabled = false; showToast(error.message); }
  });
  sheet.querySelector('[name="name"]').focus();
}

function closePicker() {
  document.querySelector("#picker")?.remove();
  document.querySelector("main")?.removeAttribute("inert");
  document.querySelector("#open-picker")?.focus();
}

async function addRecent(profileId) {
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

function renderConfiguration() {
  const sheet = document.querySelector("#picker .sheet");
  const item = state.selectedExercise;
  sheet.innerHTML = `
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-header"><button class="text-button" id="back-to-picker">Back</button><button class="text-button" id="close-picker">Close</button></div>
    <h2 id="picker-title">${escapeHtml(exerciseDisplayName(item))}</h2>
    <p>Choose the equipment used at this gym.</p>
    <div class="equipment-grid">${item.equipment.map((equipment) => `<button class="equipment-option" data-equipment="${escapeHtml(equipment)}" aria-pressed="${state.selectedEquipment === equipment}">${escapeHtml(equipment)}</button>`).join("")}</div>
    <form id="configuration-form">
      <div class="field"><label for="manufacturer">Manufacturer <small>(optional)</small></label><input id="manufacturer" name="manufacturer" maxlength="80" autocomplete="off" placeholder="e.g. Technogym" /></div>
      <div class="field"><label for="machine-label">Machine label <small>(optional)</small></label><input id="machine-label" name="label" maxlength="80" autocomplete="off" placeholder="e.g. Upstairs plate-loaded" /></div>
      <button class="primary accent" type="submit">Add exercise</button>
    </form>`;
  document.querySelector("#back-to-picker").addEventListener("click", () => renderPicker());
  document.querySelector("#close-picker").addEventListener("click", closePicker);
  document.querySelectorAll("[data-equipment]").forEach((button) => button.addEventListener("click", () => {
    state.selectedEquipment = button.dataset.equipment;
    document.querySelectorAll("[data-equipment]").forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
  }));
  document.querySelector("#configuration-form").addEventListener("submit", addConfiguredExercise);
}

async function addConfiguredExercise(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/workouts/${state.data.active_workout.id}/exercises`, {
      method: "POST",
      body: JSON.stringify({
        variation_id: state.selectedExercise.id,
        equipment: state.selectedEquipment,
        manufacturer: form.get("manufacturer"),
        label: form.get("label"),
      }),
    });
    closePicker();
    await load();
    showToast("Exercise added. It will appear under recent choices next time.");
  } catch (error) { showToast(error.message); }
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
        <label>${assisted ? "Assist kg" : "kg"} <input name="weight" type="number" inputmode="decimal" step="any" min="0" max="100000" aria-label="${escapeHtml(name)} ${assisted ? "assistance" : "weight"} in kilograms" value="${set.weight === null ? "" : Math.abs(set.weight)}" /></label>
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

function showInvalidSet() {
  const form = document.querySelector('.set-form[data-dirty="true"]');
  if (form) {
    form.scrollIntoView({ block: "center" });
    form.reportValidity();
    return;
  }
  const note = document.querySelector('[data-note-target][data-dirty="true"]');
  if (!note) return;
  note.closest("details").open = true;
  note.scrollIntoView({ block: "center" });
  note.focus();
}

async function saveAllSets() {
  const saved = await state.editor?.flush();
  if (!saved) showInvalidSet();
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
    if (!await state.editor.moveExercise(entryId, position)) { showInvalidSet(); return; }
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
    if (!await state.editor.removeExercise(entryId, () => (confirmed = window.confirm(question)))) {
      if (confirmed) showInvalidSet();
      return;
    }
    render();
    document.querySelector("#open-picker")?.focus();
    showToast(`${name} removed.`);
  } catch (error) { showToast(error.message); }
}

async function removeSet(form) {
  if (state.editor.busy) return;
  if (!window.confirm(`Remove set ${form.querySelector("legend").textContent.replace("Set ", "")}?`)) return;
  const addButton = form.closest(".exercise-entry").querySelector(".add-set");
  if (await state.editor.remove(form.dataset.setId)) {
    form.remove();
    addButton.focus();
    updateSyncStatus();
  }
}

app.addEventListener("click", (event) => {
  const move = event.target.closest?.("[data-move-exercise]");
  if (move) return moveExercise(Number(move.dataset.moveExercise), Number(move.dataset.moveTo));
  const remove = event.target.closest?.("[data-remove-exercise]");
  if (remove) return removeExercise(Number(remove.dataset.removeExercise));
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
