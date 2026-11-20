import { parseWeight, setPayload } from "./drafts.mjs";
import { Outbox, tempId } from "./outbox.mjs";
import { copiedSetValues, renameId, workoutOps } from "./workout-ops.mjs";

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
// by status() and noteStatus(). onChange is a synchronous rendering callback.
//
// Offline first: structural changes (add or remove an exercise or set, reorder, replace,
// change machine, finish) change data at once and go to the outbox (outbox.mjs), which sends
// them in order in the background. Set and note drafts wait while the outbox still has
// changes to send, so the server always sees a set created before its values, and a set
// added offline is saved once it has its server id (see remap). Cancel still needs the server.
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
  #outbox;

  constructor({ data, drafts, request, onChange = () => {},
    schedule = setTimeout, clear = clearTimeout, online = () => true, outbox = null }) {
    this.data = data;
    this.#drafts = drafts;
    this.#request = request;
    this.#onChange = onChange;
    this.#schedule = schedule;
    this.#clear = clear;
    this.#online = online;
    // Without a shared outbox (tests), one that lives as long as this editor.
    this.#outbox = outbox ?? new Outbox({ request, kinds: workoutOps, schedule, clear, online, onIdle: () => this.retry() });
    if (!outbox) this.#outbox.context = { data: () => this.data, remap: (type, from, to) => this.remap(type, from, to) };
    for (const entry of data.workout_exercises) {
      for (const set of entry.sets) this.#register(set.id);
    }
    // Register notes up front so retry and flush also find note drafts restored from this phone.
    this.#register(noteKey("workout"));
    for (const entry of data.workout_exercises) this.#register(noteKey(`exercise:${entry.id}`));
  }

  get busy() { return this.#busy; }
  get pending() { return [...this.#items.values()].some((item) => item.draft || item.pending); }
  get outbox() { return this.#outbox; }

  // A draft can go to the server once what it belongs to exists there and no earlier
  // structural change is still queued in front of it.
  #ready(key) {
    if (this.#outbox.runnable) return false;
    if (typeof key === "number") return this.#outbox.known(key);
    const target = key.slice("note:".length);
    return target === "workout" || this.#outbox.known(Number(target.slice("exercise:".length)));
  }

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
        path: `/api/sets/${this.#outbox.resolve(key)}`,
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
      path: owner === workout ? `/api/workouts/${workout.id}/note` : `/api/workout-exercises/${this.#outbox.resolve(owner.id)}/note`,
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

  // Ids a stale screen still shows (a temporary id the server has since replaced) are followed.
  #id(id) { return this.#outbox.resolve(Number(id)); }
  #target(target) {
    const [kind, id] = String(target).split(":");
    return id === undefined ? kind : `${kind}:${this.#id(id)}`;
  }

  status(id) {
    const set = this.#register(this.#id(id));
    if (!set) return null;
    return { values: set.draft ? { ...set.draft } : null, dirty: Boolean(set.draft),
      saving: Boolean(set.pending), removing: set.removing, blocked: set.blocked,
      message: set.message, error: set.error };
  }

  // target is "workout" or "exercise:<Workout Exercise id>". note is the waiting
  // draft when there is one, otherwise the saved Note.
  noteStatus(target) {
    const key = noteKey(this.#target(target));
    const item = this.#register(key);
    if (!item) return null;
    return { note: item.draft ? item.draft.note : this.#describe(key).current(),
      dirty: Boolean(item.draft), saving: Boolean(item.pending), blocked: item.blocked,
      message: item.message, error: item.error };
  }

  edit(id, values, { valid = true } = {}) {
    return this.#edit(this.#id(id), values, valid);
  }

  editNote(target, note) {
    return this.#edit(noteKey(this.#target(target)), { note: String(note) }, true);
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
    return this.#save(this.#id(id), automatic);
  }

  async saveNote(target) {
    if (this.#busy || !this.data.active_workout) return false;
    return this.#save(noteKey(this.#target(target)));
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
    if (!this.#online() || !this.#ready(key)) return false;
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

  // A set as the phone shows it: its draft's values once they are valid, else the saved ones.
  localSet(set) {
    const item = this.#items.get(set.id);
    if (!item?.draft || !item.valid || !validValues(item.draft)) return set;
    return { ...set, ...setPayload(item.draft) };
  }

  // Applies a structural change here at once and queues it for the server.
  #change(op) {
    if (this.#busy || !this.data.active_workout) return null;
    const queued = { ...op, workoutId: this.data.active_workout.id };
    workoutOps[queued.kind].apply(this.data, queued, this.#outbox);
    this.#drafts.snapshot(this.data);
    this.#outbox.enqueue(queued);
    this.#onChange();
    return queued;
  }

  // entry: what the phone shows until the server answers (exercise_name, variation_name,
  // variation_id, equipment, manufacturer, label, tracking_type, assisted); body: the request.
  addExercise(entry, body, { requestId } = {}) {
    const entryId = tempId();
    const setIds = [tempId()];
    const op = this.#change({ kind: "addExercise", entry, body, entryId, setIds, creates: [entryId, ...setIds], uses: [],
      ...(requestId ? { request_id: requestId } : {}) });
    if (!op) return null;
    for (const id of setIds) this.#register(id);
    this.#register(noteKey(`exercise:${entryId}`));
    return this.data.workout_exercises.find((item) => item.id === entryId);
  }

  // Adds a set that copies the set above as the phone shows it, like the server's Add set.
  addSet(entryId) {
    entryId = this.#id(entryId);
    const entry = this.data.workout_exercises.find((item) => item.id === entryId);
    if (!entry) return null;
    const above = entry.sets.at(-1);
    const setId = tempId();
    const values = copiedSetValues(above && this.localSet(above));
    if (!this.#change({ kind: "addSet", entryId, setId, values, creates: [setId], uses: [entryId] })) return null;
    this.#register(setId);
    return entry.sets.find((item) => item.id === setId);
  }

  async remove(id) {
    id = this.#id(id);
    if (this.#busy || !this.data.active_workout) return false;
    const set = this.#register(id);
    if (!set || set.removing) return false;
    this.#clear(set.timer);
    this.#drafts.remove(this.data.active_workout.id, id);
    this.#items.delete(id);
    return Boolean(this.#change({ kind: "removeSet", setId: id, uses: [id] }));
  }

  async removeExercise(entryId, confirm = () => true) {
    entryId = this.#id(entryId);
    const entry = this.data.workout_exercises.find((item) => item.id === entryId);
    if (this.#busy || !this.data.active_workout || !entry || !await confirm()) return false;
    if (!this.data.active_workout) return false;
    // The removed exercise's set and note drafts are discarded, so they are neither saved nor retried.
    for (const key of [...entry.sets.map((set) => set.id), noteKey(`exercise:${entryId}`)]) {
      this.#clear(this.#items.get(key)?.timer);
      this.#drafts.remove(this.data.active_workout.id, key);
      this.#items.delete(key);
    }
    return Boolean(this.#change({ kind: "removeExercise", entryId, uses: [entryId] }));
  }

  async moveExercise(entryId, position) {
    entryId = this.#id(entryId);
    if (!this.data.workout_exercises.some((item) => item.id === entryId)) return false;
    return Boolean(this.#change({ kind: "moveExercise", entryId, position, uses: [entryId] }));
  }

  // entry as for addExercise. A different Tracking Type or Assisted clears the sets' values,
  // so their drafts go too, like on the server.
  replaceExercise(entryId, entry, body) {
    entryId = this.#id(entryId);
    const current = this.data.workout_exercises.find((item) => item.id === entryId);
    if (!current) return false;
    if (current.tracking_type !== entry.tracking_type || Boolean(current.assisted) !== Boolean(entry.assisted)) {
      for (const set of current.sets) {
        this.#clear(this.#items.get(set.id)?.timer);
        this.#drafts.remove(this.data.active_workout.id, set.id);
        this.#items.delete(set.id);
      }
    }
    return Boolean(this.#change({ kind: "replaceExercise", entryId, entry, body, uses: [entryId] }));
  }

  changeMachine(entryId, body) {
    entryId = this.#id(entryId);
    return Boolean(this.#change({ kind: "changeMachine", entryId, body, uses: [entryId] }));
  }

  // A temporary id became the server's: data, waiting drafts and their statuses follow it.
  remap(type, from, to) {
    renameId(this.data, type, from, to);
    const workoutId = this.data.active_workout?.id;
    const keys = type === "set" ? [[from, to]] : [[noteKey(`exercise:${from}`), noteKey(`exercise:${to}`)]];
    for (const [old, key] of keys) {
      const item = this.#items.get(old);
      if (item) {
        this.#items.delete(old);
        this.#items.set(key, item);
      }
      if (workoutId === undefined) continue;
      const draft = typeof old === "number" ? this.#drafts.get(workoutId, old) : this.#drafts.getNote(workoutId, old);
      if (draft) {
        const { revision, ...values } = draft;
        const moved = this.#drafts.put(workoutId, key, values);
        if (item?.draft) item.draft = moved;
        this.#drafts.remove(workoutId, old);
      }
    }
    if (workoutId !== undefined) this.#drafts.snapshot(this.data);
    this.#onChange();
  }

  // Whether a set has an unsaved draft (Last workout's Sides then do not overwrite it).
  edited(id) { return Boolean(this.#items.get(id)?.draft); }

  async finish(confirm = () => true) { return this.#end(false, confirm); }
  async cancel(confirm = () => true) { return this.#end(true, confirm); }

  async #end(cancel, confirm) {
    if (this.#busy || !this.data.active_workout) return false;
    this.#busy = true;
    for (const item of this.#items.values()) this.#clear(item.timer);
    this.#onChange();
    try {
      if (!cancel) {
        // Drafts go to the server after the workout is finished here, so they must be valid now.
        for (const [key, item] of this.#items) {
          if (!item.draft || (item.valid && this.#describe(key)?.valid(item.draft))) continue;
          item.message = "Check the values before saving to the server.";
          item.error = true;
          return false;
        }
      }
      if (!await confirm()) return false;
      await this.#settle();
      const workoutId = this.data.active_workout.id;
      if (cancel) {
        await this.#request(`/api/workouts/${workoutId}`, { method: "DELETE" });
        this.#outbox.dropWorkout(workoutId);
      } else {
        // Waiting drafts become queued saves in front of Finish, so they reach the server first.
        for (const [key, item] of this.#items) {
          if (!item.draft) continue;
          const spec = this.#describe(key);
          if (!spec) continue;
          if (typeof key === "number") this.#outbox.enqueue({ kind: "saveSet", workoutId, setId: key, body: spec.body(item.draft), uses: [key] });
          else {
            const target = key.slice("note:".length);
            this.#outbox.enqueue({ kind: "saveNote", workoutId, target, note: item.draft.note,
              uses: target === "workout" ? [] : [Number(target.slice("exercise:".length))] });
          }
        }
        this.#outbox.enqueue({ kind: "finish", workoutId });
      }
      // The terminal state is kept on this phone even when a refresh fails.
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
}
