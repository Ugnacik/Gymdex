import { parseWeight, setPayload } from "./drafts.mjs";

export const NOTE_MAX_LENGTH = 1000;

const noteKey = (target) => `note:${target}`;

function validValues(values) {
  const weight = parseWeight(values.weight);
  const result = Number(values.result);
  return (weight === null || (Number.isFinite(weight) && weight >= 0 && weight <= 100000))
    && (values.result === "" ? !values.completed : Number.isInteger(result) && result >= 1 && result <= 1000000);
}

// One editor owns an active workout's drafts and requests. data is the bootstrap
// model rendered by the caller; acknowledged mutations update it and its snapshot.
// Sets and Notes are drafted, autosaved and retried alike: set ids and note targets
// ("workout" or "exercise:<id>") name them. Save failures return false and are exposed
// by status() and noteStatus(). Terminal request failures throw, leaving the workout
// editable. onChange is a synchronous rendering callback.
export class WorkoutEditor {
  // Keyed by set id (a number) or noteKey(target) (a string).
  #items = new Map();
  #busy = false;
  #request;
  #drafts;
  #onChange;
  #schedule;
  #clear;
  #online;

  constructor({ data, drafts, request, onChange = () => {},
    schedule = setTimeout, clear = clearTimeout, online = () => true }) {
    this.data = data;
    this.#drafts = drafts;
    this.#request = request;
    this.#onChange = onChange;
    this.#schedule = schedule;
    this.#clear = clear;
    this.#online = online;
    for (const entry of data.workout_exercises) {
      for (const set of entry.sets) this.#register(set.id);
    }
    // Register notes up front so retry and flush also find note drafts restored from this phone.
    this.#register(noteKey("workout"));
    for (const entry of data.workout_exercises) this.#register(noteKey(`exercise:${entry.id}`));
  }

  get busy() { return this.#busy; }
  get pending() { return [...this.#items.values()].some((item) => item.draft || item.pending); }

  // How a key's draft is restored, validated, sent and applied, or null when the
  // key does not belong to the active workout.
  #describe(key) {
    const { active_workout: workout, workout_exercises: entries } = this.data;
    if (!workout) return null;
    if (typeof key === "number") {
      const entry = entries.find((item) => item.sets.some((set) => set.id === key));
      return entry ? {
        restore: () => this.#drafts.get(workout.id, key),
        valid: validValues,
        path: `/api/sets/${key}`,
        body: setPayload,
        apply: (saved) => { entry.sets = entry.sets.map((item) => item.id === key ? saved : item); },
        savedMessage: (saved) => saved.completed ? "Completed · synced" : "Saved to server",
        blockedHint: "Review the set, then tap Retry.",
      } : null;
    }
    const target = key.slice("note:".length);
    const owner = target === "workout" ? workout : entries.find((item) => `exercise:${item.id}` === target);
    return owner ? {
      restore: () => this.#drafts.getNote(workout.id, key),
      valid: (draft) => draft.note.length <= NOTE_MAX_LENGTH,
      path: owner === workout ? `/api/workouts/${workout.id}/note` : `/api/workout-exercises/${owner.id}/note`,
      body: (draft) => ({ note: draft.note }),
      apply: (saved) => { owner.note = saved.note; },
      current: () => owner.note ?? "",
      savedMessage: () => "Note saved to server",
      blockedHint: "Review the note; editing it saves again.",
    } : null;
  }

  #register(key) {
    const spec = this.#describe(key);
    if (!spec) return null;
    if (!this.#items.has(key)) {
      const draft = spec.restore();
      this.#items.set(key, { draft, valid: true, blocked: false, removing: false,
        message: draft ? "Restored from this phone; waiting to sync." : "", error: false });
    }
    return this.#items.get(key);
  }

  status(id) {
    const set = this.#register(Number(id));
    if (!set) return null;
    return { values: set.draft ? { ...set.draft } : null, dirty: Boolean(set.draft),
      saving: Boolean(set.pending), removing: set.removing, blocked: set.blocked,
      message: set.message, error: set.error };
  }

  // target is "workout" or "exercise:<Workout Exercise id>". note is the waiting
  // draft when there is one, otherwise the saved Note.
  noteStatus(target) {
    const key = noteKey(target);
    const item = this.#register(key);
    if (!item) return null;
    return { note: item.draft ? item.draft.note : this.#describe(key).current(),
      dirty: Boolean(item.draft), saving: Boolean(item.pending), blocked: item.blocked,
      message: item.message, error: item.error };
  }

  edit(id, values, { valid = true } = {}) {
    return this.#edit(Number(id), values, valid);
  }

  editNote(target, note) {
    return this.#edit(noteKey(target), { note: String(note) }, true);
  }

  #edit(key, values, valid) {
    if (this.#busy || !this.data.active_workout) return false;
    const item = this.#register(key);
    if (!item || item.removing) return false;
    item.draft = this.#drafts.put(this.data.active_workout.id, key, values);
    item.valid = valid;
    item.blocked = false;
    item.error = this.#drafts.error;
    item.message = item.error ? "Not saved on phone. Keep this page open." : "Saved on phone; waiting to sync.";
    this.#queue(key, item);
    this.#onChange();
    return true;
  }

  #queue(key, item) {
    this.#clear(item.timer);
    item.timer = this.#schedule(() => this.#autoSave(key), 800);
  }

  async #autoSave(key) {
    if (this.#busy || !this.data.active_workout) return false;
    return this.#save(key, true);
  }

  async save(id, { automatic = false } = {}) {
    if (this.#busy || !this.data.active_workout) return false;
    return this.#save(Number(id), automatic);
  }

  async saveNote(target) {
    if (this.#busy || !this.data.active_workout) return false;
    return this.#save(noteKey(target));
  }

  async #save(key, automatic = false) {
    const item = this.#register(key);
    if (!item) return false;
    const spec = this.#describe(key);
    this.#clear(item.timer);
    if (item.removing || (automatic && item.blocked)) return false;
    if (item.pending) return item.pending;
    if (!item.draft) return true;
    if (!item.valid || !spec.valid(item.draft)) {
      item.message = "Check the values before saving to the server.";
      item.error = true;
      this.#onChange();
      return false;
    }
    if (!this.#online()) return false;
    const draft = item.draft;
    const workoutId = this.data.active_workout.id;
    item.message = "Saving to server…";
    item.error = false;
    const pending = (async () => {
      try {
        const saved = await this.#request(spec.path, { method: "PUT", body: JSON.stringify(spec.body(draft)) });
        spec.apply(saved);
        this.#drafts.snapshot(this.data);
        this.#drafts.remove(workoutId, key, draft.revision);
        if (item.draft.revision === draft.revision) {
          item.draft = null;
          item.blocked = false;
          item.message = spec.savedMessage(saved);
        } else {
          item.message = "Newer edits kept on this phone; waiting to sync.";
        }
        return !item.draft;
      } catch (error) {
        // A rejection belongs to the submitted revision, not a later edit.
        item.blocked = item.draft.revision === draft.revision && Boolean(error.status && error.status < 500);
        item.error = true;
        item.message = `${this.#drafts.error ? "Not saved on phone." : "Kept on this phone."} ${error.message} ${item.blocked ? spec.blockedHint : "Will retry automatically."}`;
        return false;
      }
    })();
    item.pending = pending;
    this.#onChange();
    try { return await pending; }
    finally {
      item.pending = null;
      if (item.draft && item.draft.revision !== draft.revision && !this.#busy && !item.removing) this.#queue(key, item);
      this.#onChange();
    }
  }

  async retry() {
    if (this.#busy || !this.data.active_workout || !this.#online()) return;
    for (const [key, item] of this.#items) {
      if (this.#busy) return;
      if (item.draft && !item.blocked && !item.removing) await this.#autoSave(key);
    }
  }

  async #settle() {
    await Promise.all([...this.#items.values()].flatMap((item) => [item.pending, item.removal]).filter(Boolean));
  }

  async flush() {
    if (this.#busy || !this.data.active_workout) return false;
    return this.#flush();
  }

  async #flush(skip = new Set()) {
    await this.#settle();
    for (const [key, item] of this.#items) {
      if (item.draft && !skip.has(key) && !await this.#save(key)) return false;
    }
    return true;
  }

  // Structural changes run exclusively, like finish: automatic saves pause and
  // drafts are saved first. Request failures throw and leave the workout editable.
  async #exclusive(action) {
    if (this.#busy || !this.data.active_workout) return false;
    this.#busy = true;
    for (const item of this.#items.values()) this.#clear(item.timer);
    this.#onChange();
    try { return await action(); }
    finally {
      this.#busy = false;
      this.#onChange();
    }
  }

  async removeExercise(entryId, confirm = () => true) {
    entryId = Number(entryId);
    const entry = this.data.workout_exercises.find((item) => item.id === entryId);
    // Ask before pausing autosave so declining leaves every pending save queued.
    if (this.#busy || !this.data.active_workout || !entry || !await confirm()) return false;
    return this.#exclusive(async () => {
      // The removed exercise's set and note drafts are discarded, so they are neither saved nor retried.
      const removed = new Set([...entry.sets.map((set) => set.id), noteKey(`exercise:${entryId}`)]);
      if (!await this.#flush(removed)) return false;
      const workoutId = this.data.active_workout.id;
      await this.#request(`/api/workout-exercises/${entryId}`, { method: "DELETE" });
      this.data.workout_exercises = this.data.workout_exercises.filter((item) => item.id !== entryId);
      this.data.workout_exercises.forEach((item, index) => { item.position = index + 1; });
      for (const key of removed) {
        this.#drafts.remove(workoutId, key);
        this.#items.delete(key);
      }
      this.#drafts.snapshot(this.data);
      return true;
    });
  }

  async moveExercise(entryId, position) {
    entryId = Number(entryId);
    if (!this.data.workout_exercises.some((item) => item.id === entryId)) return false;
    return this.#exclusive(async () => {
      if (!await this.#flush()) return false;
      const moved = await this.#request(`/api/workout-exercises/${entryId}`, {
        method: "PUT", body: JSON.stringify({ position }),
      });
      const positions = new Map(moved.workout_exercises.map((item) => [item.id, item.position]));
      for (const item of this.data.workout_exercises) item.position = positions.get(item.id) ?? item.position;
      this.data.workout_exercises.sort((a, b) => a.position - b.position);
      this.#drafts.snapshot(this.data);
      return true;
    });
  }

  async finish(confirm = () => true) { return this.#end(false, confirm); }
  async cancel(confirm = () => true) { return this.#end(true, confirm); }

  async #end(cancel, confirm) {
    if (this.#busy || !this.data.active_workout) return false;
    this.#busy = true;
    for (const item of this.#items.values()) this.#clear(item.timer);
    this.#onChange();
    try {
      if (cancel) {
        if (!await confirm()) return false;
        await this.#settle();
      } else {
        if (!await this.#flush() || !await confirm()) return false;
      }
      const workoutId = this.data.active_workout.id;
      await this.#request(`/api/workouts/${workoutId}${cancel ? "" : "/complete"}`,
        cancel ? { method: "DELETE" } : { method: "POST", body: "{}" });
      // The acknowledged terminal state must survive any subsequent refresh failure.
      this.data.active_workout = null;
      this.data.workout_exercises = [];
      this.#drafts.snapshot(this.data);
      this.#drafts.removeWorkout(workoutId);
      this.#items.clear();
      return true;
    } finally {
      this.#busy = false;
      this.#onChange();
    }
  }

  async remove(id) {
    id = Number(id);
    if (this.#busy || !this.data.active_workout) return false;
    const set = this.#register(id);
    if (!set || set.removing) return false;
    set.removing = true;
    this.#clear(set.timer);
    const removal = (async () => {
      await set.pending;
      try {
        const removed = await this.#request(`/api/sets/${id}`, { method: "DELETE" });
        const entry = this.data.workout_exercises.find((entry) => entry.sets.some((item) => item.id === id));
        // The server renumbers the remaining sets 1..n; drafts stay keyed by set id.
        const positions = new Map((removed?.sets ?? []).map((item) => [item.id, item.position]));
        entry.sets = entry.sets.filter((item) => item.id !== id)
          .map((item) => ({ ...item, position: positions.get(item.id) ?? item.position }));
        this.#drafts.remove(this.data.active_workout.id, id);
        this.#drafts.snapshot(this.data);
        this.#items.delete(id);
        return true;
      } catch (error) {
        set.message = error.message;
        set.error = true;
        return false;
      } finally {
        set.removing = false;
        set.removal = null;
        this.#onChange();
      }
    })();
    set.removal = removal;
    this.#onChange();
    return removal;
  }
}
