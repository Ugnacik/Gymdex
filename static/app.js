const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const state = {
  data: null,
  selectedGymId: null,
  picker: null,
  selectedExercise: null,
  selectedEquipment: null,
  setSaves: new Set(),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Something went wrong.");
  return body;
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

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

async function load() {
  try {
    state.data = await api("/api/bootstrap");
    if (!state.selectedGymId && state.data.gyms.length === 1) {
      state.selectedGymId = state.data.gyms[0].id;
    }
    render();
  } catch (error) {
    app.innerHTML = `<main class="shell"><h1>Gymdex is unavailable.</h1><p class="error">${escapeHtml(error.message)}</p><button class="primary" id="retry">Try again</button></main>`;
    document.querySelector("#retry").addEventListener("click", load);
  }
}

function render() {
  if (state.data.active_workout) renderWorkout();
  else renderStart();
}

function renderHeader(status = "Ready") {
  return `<header class="app-header"><div class="brand">Gymdex</div><div class="status${state.data.active_workout ? " status-active" : ""}">${escapeHtml(status)}</div></header>`;
}

function renderStart() {
  const gyms = state.data.gyms;
  app.innerHTML = `
    <main class="shell">
      ${renderHeader("No active workout")}
      <section class="intro">
        <h1>Start where you train.</h1>
        <p>Choose your gym to find your machines and recent exercises.</p>
      </section>
      <div class="section-title"><h2>Your gyms</h2><span>${gyms.length}</span></div>
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
    });
  });
  document.querySelector("#add-gym-form").addEventListener("submit", createGym);
  document.querySelector("#start-workout").addEventListener("click", startWorkout);
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
  app.innerHTML = `
    <main class="shell">
      ${renderHeader("Workout active")}
      <section class="workout-heading">
        <div><h1>${escapeHtml(workout.gym_name)}</h1><p>Started ${escapeHtml(formatTime(workout.started_at))}</p></div>
        <button class="text-button" id="finish-workout">Finish</button>
      </section>
      <div class="section-title"><h2>Exercises</h2><span>${entries.length}</span></div>
      <section class="exercise-list">
        ${entries.length ? entries.map((entry) => `
          <article class="exercise-entry" data-entry-id="${entry.id}">
            <h3>${escapeHtml(entry.exercise_name)}${entry.variation_name === "Standard" ? "" : ` · ${escapeHtml(entry.variation_name)}`}</h3>
            <p class="meta">${escapeHtml(configurationLabel(entry))}</p>
            <p class="set-hint">${entry.tracking_type === "duration" ? "Duration in seconds" : "Repetitions"}. Weight is optional; use a negative value for assistance.</p>
            <div class="sets-list">${entry.sets.map((set, index) => renderSet(entry, set, index)).join("")}</div>
            <button class="secondary add-set" data-add-set="${entry.id}">Add set</button>
          </article>`).join("") : `<div class="empty"><h3>No exercises yet</h3><p>Add a recent choice in one tap, or search the catalog.</p></div>`}
      </section>
      <div class="bottom-action"><button class="primary accent" id="open-picker">Add exercise</button></div>
    </main>`;
  document.querySelector("#open-picker").addEventListener("click", openPicker);
  document.querySelector("#finish-workout").addEventListener("click", finishWorkout);
  document.querySelectorAll(".set-form").forEach(bindSet);
  document.querySelectorAll("[data-add-set]").forEach((button) => button.addEventListener("click", () => addSet(button)));
}

function formatTime(value) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(normalized));
}

async function finishWorkout() {
  if (!await saveAllSets()) return;
  if (!window.confirm("Finish this workout?")) return;
  try {
    await api(`/api/workouts/${state.data.active_workout.id}/complete`, { method: "POST", body: "{}" });
    state.selectedGymId = state.data.active_workout.gym_id;
    await load();
    showToast("Workout finished.");
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
  const filtered = state.picker.catalog.filter((item) =>
    `${item.exercise_name} ${item.variation_name}`.toLowerCase().includes(query.toLowerCase())
  );
  const wrapper = document.createElement("div");
  wrapper.id = "picker";
  wrapper.className = "sheet-backdrop";
  wrapper.innerHTML = `
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-header"><h2 id="picker-title">Add exercise</h2><button class="text-button" id="close-picker">Close</button></div>
      <input class="search" id="exercise-search" type="search" inputmode="search" autocomplete="off" placeholder="Search exercises" aria-label="Search exercises" value="${escapeHtml(query)}" />
      ${!query && state.picker.recent.length ? `<div class="section-title"><h3>Recent at ${escapeHtml(state.data.active_workout.gym_name)}</h3></div><div class="recent-list">${state.picker.recent.map((item) => `<button class="recent-card" data-profile-id="${item.profile_id}"><strong>${escapeHtml(item.exercise_name)}</strong><span>${escapeHtml(configurationLabel(item))}</span></button>`).join("")}</div>` : ""}
      <div class="section-title"><h3>${query ? "Results" : "Exercise catalog"}</h3><span>${filtered.length}</span></div>
      <div class="exercise-list">${filtered.map((item) => `<button class="exercise-card" data-variation-id="${item.id}"><strong>${escapeHtml(item.exercise_name)}</strong><span>${item.variation_name === "Standard" ? escapeHtml(item.equipment.join(" · ")) : `${escapeHtml(item.variation_name)} · ${escapeHtml(item.equipment.join(" · "))}`}</span></button>`).join("") || `<div class="empty"><h3>No matches</h3><p>Try a shorter exercise name.</p></div>`}</div>
    </section>`;
  document.querySelector("main")?.setAttribute("inert", "");
  document.body.append(wrapper);
  const search = document.querySelector("#exercise-search");
  search.focus();
  search.setSelectionRange(search.value.length, search.value.length);
  search.addEventListener("input", (event) => renderPicker(event.target.value));
  document.querySelector("#close-picker").addEventListener("click", closePicker);
  wrapper.addEventListener("click", (event) => { if (event.target === wrapper) closePicker(); });
  document.querySelectorAll("[data-profile-id]").forEach((button) => button.addEventListener("click", () => addRecent(Number(button.dataset.profileId))));
  document.querySelectorAll("[data-variation-id]").forEach((button) => button.addEventListener("click", () => chooseExercise(Number(button.dataset.variationId))));
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
    <h2>${escapeHtml(item.exercise_name)}</h2>
    <p>${item.variation_name === "Standard" ? "Choose the equipment used at this gym." : `${escapeHtml(item.variation_name)}. Choose the equipment used at this gym.`}</p>
    <div class="equipment-grid">${item.equipment.map((equipment) => `<button class="equipment-option" data-equipment="${escapeHtml(equipment)}" aria-pressed="${state.selectedEquipment === equipment}">${escapeHtml(equipment)}</button>`).join("")}</div>
    <form id="configuration-form">
      <div class="field"><label for="manufacturer">Manufacturer <small>(optional)</small></label><input id="manufacturer" name="manufacturer" maxlength="80" autocomplete="off" placeholder="e.g. Technogym" /></div>
      <div class="field"><label for="machine-label">Machine label <small>(optional)</small></label><input id="machine-label" name="label" maxlength="80" autocomplete="off" placeholder="e.g. Upstairs plate-loaded" /></div>
      <button class="primary accent" type="submit">Add exercise</button>
    </form>`;
  document.querySelector("#back-to-picker").addEventListener("click", () => renderPicker());
  document.querySelector("#close-picker").addEventListener("click", closePicker);
  document.querySelectorAll("[data-equipment]").forEach((button) => button.addEventListener("click", () => { state.selectedEquipment = button.dataset.equipment; renderConfiguration(); }));
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
  const name = `${entry.exercise_name}, set ${set.position}`;
  const previousText = previous
    ? `${previous.weight === null ? "" : `${previous.weight} kg × `}${previous.result} ${unit}`
    : "No completed set";
  return `<form class="set-form${set.completed ? " is-complete" : ""}" data-set-id="${set.id}" data-entry-id="${entry.id}">
    <fieldset>
      <legend>Set ${set.position}</legend>
      <p class="previous-set">Last workout: ${escapeHtml(previousText)}</p>
      <div class="set-inputs">
        <label>kg <input name="weight" type="number" inputmode="decimal" step="any" min="-100000" max="100000" aria-label="${escapeHtml(name)} weight in kilograms" value="${set.weight ?? ""}" /></label>
        <label>${unit === "sec" ? "Seconds" : "Reps"} <input name="result" type="number" inputmode="numeric" min="1" max="1000000" step="1" aria-label="${escapeHtml(name)} ${unit}" value="${set.result ?? ""}" ${set.completed ? "required" : ""} /></label>
        <label class="set-complete">Done <span><input name="completed" type="checkbox" aria-label="Complete ${escapeHtml(name)}" ${set.completed ? "checked" : ""} /></span></label>
      </div>
      <div class="set-actions">
        <button type="submit" class="text-button">Save set</button>
        <button type="button" class="text-button remove-set" aria-label="Remove ${escapeHtml(name)}">Remove</button>
        <span class="set-status" role="status">${set.completed ? "Completed" : "Saved"}</span>
      </div>
    </fieldset>
  </form>`;
}

function bindSet(form) {
  form.addEventListener("input", () => {
    form.dataset.dirty = "true";
    form.elements.result.required = form.elements.completed.checked;
    setStatus(form, "Unsaved");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSet(form);
  });
  form.elements.completed.addEventListener("change", () => form.requestSubmit());
  form.querySelector(".remove-set").addEventListener("click", () => removeSet(form));
}

function setStatus(form, message, error = false) {
  const status = form.querySelector(".set-status");
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function saveSet(form) {
  if (form.savePromise) return form.savePromise;
  if (!form.reportValidity()) return false;
  const payload = {
    weight: form.elements.weight.value === "" ? null : Number(form.elements.weight.value),
    result: form.elements.result.value === "" ? null : Number(form.elements.result.value),
    completed: form.elements.completed.checked,
  };
  form.querySelector("fieldset").disabled = true;
  setStatus(form, "Saving…");
  const pending = (async () => {
    try {
      const saved = await api(`/api/sets/${form.dataset.setId}`, { method: "PUT", body: JSON.stringify(payload) });
      const entry = state.data.workout_exercises.find((item) => item.id === Number(form.dataset.entryId));
      entry.sets = entry.sets.map((item) => item.id === saved.id ? saved : item);
      delete form.dataset.dirty;
      form.classList.toggle("is-complete", Boolean(saved.completed));
      setStatus(form, saved.completed ? "Completed" : "Saved");
      return true;
    } catch (error) {
      form.dataset.dirty = "true";
      setStatus(form, `Not saved. ${error.message} Try Save set again.`, true);
      return false;
    } finally {
      form.querySelector("fieldset").disabled = false;
    }
  })();
  form.savePromise = pending;
  state.setSaves.add(pending);
  try { return await pending; }
  finally { state.setSaves.delete(pending); form.savePromise = null; }
}

async function saveAllSets() {
  await Promise.all([...state.setSaves]);
  for (const form of document.querySelectorAll('.set-form[data-dirty="true"]')) {
    if (!await saveSet(form)) {
      form.scrollIntoView({ block: "center" });
      return false;
    }
  }
  return true;
}

async function addSet(button) {
  button.disabled = true;
  try {
    const entry = state.data.workout_exercises.find((item) => item.id === Number(button.dataset.addSet));
    const set = await api(`/api/workout-exercises/${entry.id}/sets`, { method: "POST", body: "{}" });
    entry.sets.push(set);
    const list = button.closest(".exercise-entry").querySelector(".sets-list");
    list.insertAdjacentHTML("beforeend", renderSet(entry, set, entry.sets.length - 1));
    bindSet(list.lastElementChild);
    list.lastElementChild.elements.weight.focus();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}

async function removeSet(form) {
  if (!window.confirm(`Remove set ${form.querySelector("legend").textContent.replace("Set ", "")}?`)) return;
  form.querySelector("fieldset").disabled = true;
  try {
    await api(`/api/sets/${form.dataset.setId}`, { method: "DELETE" });
    const entry = state.data.workout_exercises.find((item) => item.id === Number(form.dataset.entryId));
    entry.sets = entry.sets.filter((item) => item.id !== Number(form.dataset.setId));
    const addButton = form.closest(".exercise-entry").querySelector(".add-set");
    form.remove();
    addButton.focus();
  } catch (error) {
    setStatus(form, error.message, true);
    form.querySelector("fieldset").disabled = false;
  }
}

window.addEventListener("beforeunload", (event) => {
  if (state.setSaves.size || document.querySelector('.set-form[data-dirty="true"]')) {
    event.preventDefault();
    event.returnValue = "";
  }
});

load();
