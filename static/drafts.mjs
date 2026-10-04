// Separate keys keep saving one set from clearing another set's draft.
export class DraftStore {
  constructor(storage) {
    this.storage = storage;
    this.memory = new Map();
    this.failedKeys = new Set();
  }

  get error() { return this.failedKeys.size > 0; }

  read(key) {
    // This page's latest value wins even when storage still contains an older one.
    if (this.memory.has(key)) return this.memory.get(key);
    try {
      const raw = this.storage().getItem(key);
      const value = raw === null ? null : JSON.parse(raw);
      this.memory.set(key, value);
      this.failedKeys.delete(key);
      return value;
    } catch {
      this.failedKeys.add(key);
      return null;
    }
  }

  write(key, value) {
    this.memory.set(key, value);
    try {
      this.storage().setItem(key, JSON.stringify(value));
      this.failedKeys.delete(key);
      return true;
    } catch {
      this.failedKeys.add(key);
      return false;
    }
  }

  key(workoutId, setId) {
    return `gymdex:draft:v1:${workoutId}:${setId}`;
  }

  get(workoutId, setId) {
    const draft = this.read(this.key(workoutId, setId));
    // Drafts written before Effort existed have no effort key and are still valid.
    if (!draft || typeof draft.weight !== "string" || typeof draft.result !== "string"
      || typeof draft.assistance !== "boolean" || typeof draft.completed !== "boolean"
      || ("effort" in draft && draft.effort !== null && !EFFORTS.includes(draft.effort))) return null;
    return draft;
  }

  // Note drafts share the workout's key space as "note:<target>", so removeWorkout clears them too.
  getNote(workoutId, key) {
    const draft = this.read(this.key(workoutId, key));
    return draft && typeof draft.note === "string" ? draft : null;
  }

  put(workoutId, setId, values) {
    const draft = { ...values, revision: `${Date.now()}-${Math.random()}` };
    this.write(this.key(workoutId, setId), draft);
    return draft;
  }

  remove(workoutId, setId, revision) {
    const key = this.key(workoutId, setId);
    // A response from an older request must not discard newer edits.
    if (revision && this.read(key)?.revision !== revision) return;
    this.erase(key);
  }

  erase(key) {
    // Keep a tombstone so a failed deletion cannot restore a stale draft here.
    this.memory.set(key, null);
    try {
      this.storage().removeItem(key);
      this.failedKeys.delete(key);
    } catch {
      this.failedKeys.add(key);
    }
  }

  removeWorkout(workoutId) {
    const prefix = `gymdex:draft:v1:${workoutId}:`;
    const keys = new Set([...this.memory.keys()].filter((key) => key.startsWith(prefix)));
    try {
      const storage = this.storage();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.add(key);
      }
      this.failedKeys.delete(prefix);
    } catch {
      this.failedKeys.add(prefix);
    }
    for (const key of keys) this.erase(key);
  }

  snapshot(data) {
    this.write("gymdex:workout:v1", data);
  }

  cachedWorkout() {
    const data = this.read("gymdex:workout:v1");
    return data && Array.isArray(data.gyms) && Array.isArray(data.workout_exercises)
      && (data.active_workout === null || Number.isInteger(data.active_workout?.id)) ? data : null;
  }
}

// Weight fields are text so a decimal comma survives (Chrome's number inputs drop it
// in English locales). Blank is null; anything but digits with one "." or "," is NaN.
export const WEIGHT_PATTERN = "\\s*(\\d+([.,]\\d*)?|[.,]\\d+)\\s*";

export function parseWeight(text) {
  const value = text.trim();
  if (value === "") return null;
  return new RegExp(`^(?:${WEIGHT_PATTERN})$`).test(value) ? Number(value.replace(",", ".")) : NaN;
}

// Values without an effort key (drafts from before Effort existed) leave the stored effort unchanged.
export function setPayload(values) {
  const weight = parseWeight(values.weight);
  return {
    weight: weight === null ? null : Math.abs(weight) * (values.assistance ? -1 : 1),
    result: values.result === "" ? null : Number(values.result),
    completed: values.completed,
    ...("effort" in values ? { effort: values.effort } : {}),
  };
}

// A Set's optional Effort: Failure, or the repetitions left in reserve. Duration Sets record only Failure.
export const EFFORTS = ["failure", "0", "1", "2", "3", "4+"];

export function effortsFor(trackingType) {
  return trackingType === "duration" ? ["failure"] : EFFORTS;
}

// "Failure", "0 reps left", "1 rep left", ... "4+ reps left"; short gives "2 left" for the Set button.
export function effortText(effort, { short = false } = {}) {
  if (effort === "failure") return "Failure";
  return short ? `${effort} left` : `${effort} rep${effort === "1" ? "" : "s"} left`;
}
