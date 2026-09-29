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
    if (!draft || typeof draft.weight !== "string" || typeof draft.result !== "string"
      || typeof draft.assistance !== "boolean" || typeof draft.completed !== "boolean") return null;
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

export function setPayload(values) {
  return {
    weight: values.weight === "" ? null : Math.abs(Number(values.weight)) * (values.assistance ? -1 : 1),
    result: values.result === "" ? null : Number(values.result),
    completed: values.completed,
  };
}
