// Separate keys keep saving one set from clearing another set's draft.
export class DraftStore {
  constructor(storage) {
    this.storage = storage;
    this.memory = new Map();
    this.error = false;
  }

  read(key) {
    try {
      const raw = this.storage().getItem(key);
      return raw === null ? this.memory.get(key) ?? null : JSON.parse(raw);
    } catch {
      this.error = true;
      return this.memory.get(key) ?? null;
    }
  }

  write(key, value) {
    this.memory.set(key, value);
    try {
      this.storage().setItem(key, JSON.stringify(value));
      this.error = false;
      return true;
    } catch {
      this.error = true;
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

  put(workoutId, setId, values) {
    const draft = { ...values, revision: `${Date.now()}-${Math.random()}` };
    this.write(this.key(workoutId, setId), draft);
    return draft;
  }

  remove(workoutId, setId, revision) {
    const key = this.key(workoutId, setId);
    // A response from an older request must not discard newer edits.
    if (revision && this.read(key)?.revision !== revision) return;
    try {
      this.storage().removeItem(key);
      this.memory.delete(key);
    } catch {
      this.error = true;
    }
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
