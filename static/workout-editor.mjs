import { setPayload } from "./drafts.mjs";

function validValues(values) {
  const weight = Number(values.weight);
  const result = Number(values.result);
  return (values.weight === "" || (Number.isFinite(weight) && weight >= 0 && weight <= 100000))
    && (values.result === "" ? !values.completed : Number.isInteger(result) && result >= 1 && result <= 1000000);
}

// One editor owns an active workout's drafts and requests. data is the bootstrap
// model rendered by the caller; acknowledged mutations update it and its snapshot.
// Set failures return false and are exposed by status(). Terminal request failures
// throw, leaving the workout editable. onChange is a synchronous rendering callback.
export class WorkoutEditor {
  #sets = new Map();
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
  }

  get busy() { return this.#busy; }
  get pending() { return [...this.#sets.values()].some((set) => set.draft || set.pending); }

  #register(id) {
    id = Number(id);
    if (!this.data.active_workout || !this.data.workout_exercises.some((entry) => entry.sets.some((set) => set.id === id))) return null;
    if (!this.#sets.has(id)) {
      const draft = this.data.active_workout && this.#drafts.get(this.data.active_workout.id, id);
      this.#sets.set(id, { draft, valid: true, blocked: false, removing: false,
        message: draft ? "Restored from this phone; waiting to sync." : "", error: false });
    }
    return this.#sets.get(id);
  }

  status(id) {
    const set = this.#register(id);
    if (!set) return null;
    return { values: set.draft ? { ...set.draft } : null, dirty: Boolean(set.draft),
      saving: Boolean(set.pending), removing: set.removing, blocked: set.blocked,
      message: set.message, error: set.error };
  }

  edit(id, values, { valid = true } = {}) {
    if (this.#busy || !this.data.active_workout) return false;
    const set = this.#register(id);
    if (!set || set.removing) return false;
    set.draft = this.#drafts.put(this.data.active_workout.id, id, values);
    set.valid = valid;
    set.blocked = false;
    set.error = this.#drafts.error;
    set.message = set.error ? "Not saved on phone. Keep this page open." : "Saved on phone; waiting to sync.";
    this.#queue(id, set);
    this.#onChange();
    return true;
  }

  #queue(id, set) {
    this.#clear(set.timer);
    set.timer = this.#schedule(() => this.save(id, { automatic: true }), 800);
  }

  async save(id, { automatic = false } = {}) {
    if (this.#busy || !this.data.active_workout) return false;
    return this.#save(Number(id), automatic);
  }

  async #save(id, automatic = false) {
    const set = this.#register(id);
    if (!set) return false;
    this.#clear(set.timer);
    if (set.removing || (automatic && set.blocked)) return false;
    if (set.pending) return set.pending;
    if (!set.draft) return true;
    if (!set.valid || !validValues(set.draft)) {
      set.message = "Check the values before saving to the server.";
      set.error = true;
      this.#onChange();
      return false;
    }
    if (!this.#online()) return false;
    const draft = set.draft;
    const workoutId = this.data.active_workout.id;
    set.message = "Saving to server…";
    set.error = false;
    const pending = (async () => {
      try {
        const saved = await this.#request(`/api/sets/${id}`, { method: "PUT", body: JSON.stringify(setPayload(draft)) });
        const entry = this.data.workout_exercises.find((entry) => entry.sets.some((item) => item.id === id));
        entry.sets = entry.sets.map((item) => item.id === id ? saved : item);
        this.#drafts.snapshot(this.data);
        this.#drafts.remove(workoutId, id, draft.revision);
        if (set.draft.revision === draft.revision) {
          set.draft = null;
          set.blocked = false;
          set.message = saved.completed ? "Completed · synced" : "Saved to server";
        } else {
          set.message = "Newer edits kept on this phone; waiting to sync.";
        }
        return !set.draft;
      } catch (error) {
        // A rejection belongs to the submitted revision, not a later edit.
        set.blocked = set.draft.revision === draft.revision && Boolean(error.status && error.status < 500);
        set.error = true;
        set.message = `${this.#drafts.error ? "Not saved on phone." : "Kept on this phone."} ${error.message} ${set.blocked ? "Review the set, then tap Retry." : "Will retry automatically."}`;
        return false;
      }
    })();
    set.pending = pending;
    this.#onChange();
    try { return await pending; }
    finally {
      set.pending = null;
      if (set.draft && set.draft.revision !== draft.revision && !this.#busy && !set.removing) this.#queue(id, set);
      this.#onChange();
    }
  }

  async retry() {
    if (this.#busy || !this.data.active_workout || !this.#online()) return;
    for (const [id, set] of this.#sets) {
      if (this.#busy) return;
      if (set.draft && !set.blocked && !set.removing) await this.save(id, { automatic: true });
    }
  }

  async #settle() {
    await Promise.all([...this.#sets.values()].flatMap((set) => [set.pending, set.removal]).filter(Boolean));
  }

  async flush() {
    if (this.#busy || !this.data.active_workout) return false;
    return this.#flush();
  }

  async #flush() {
    await this.#settle();
    for (const [id, set] of this.#sets) {
      if (set.draft && !await this.#save(id)) return false;
    }
    return true;
  }

  async finish(confirm = () => true) { return this.#end(false, confirm); }
  async cancel(confirm = () => true) { return this.#end(true, confirm); }

  async #end(cancel, confirm) {
    if (this.#busy || !this.data.active_workout) return false;
    this.#busy = true;
    for (const set of this.#sets.values()) this.#clear(set.timer);
    this.#onChange();
    try {
      if (cancel) {
        if (!confirm()) return false;
        await this.#settle();
      } else {
        if (!await this.#flush() || !confirm()) return false;
      }
      const workoutId = this.data.active_workout.id;
      await this.#request(`/api/workouts/${workoutId}${cancel ? "" : "/complete"}`,
        cancel ? { method: "DELETE" } : { method: "POST", body: "{}" });
      // The acknowledged terminal state must survive any subsequent refresh failure.
      this.data.active_workout = null;
      this.data.workout_exercises = [];
      this.#drafts.snapshot(this.data);
      this.#drafts.removeWorkout(workoutId);
      this.#sets.clear();
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
        await this.#request(`/api/sets/${id}`, { method: "DELETE" });
        const entry = this.data.workout_exercises.find((entry) => entry.sets.some((item) => item.id === id));
        entry.sets = entry.sets.filter((item) => item.id !== id);
        this.#drafts.remove(this.data.active_workout.id, id);
        this.#drafts.snapshot(this.data);
        this.#sets.delete(id);
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
