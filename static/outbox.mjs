// The durable, ordered outbox behind offline-first logging. Every change to the Active
// Workout's structure (add or remove an exercise or set, reorder, replace, change machine,
// finish) is applied to the phone's copy at once and queued here; the queue sends one change
// at a time, in order, and survives closing or reloading the app (it lives in localStorage
// next to the set drafts). Things created offline get temporary negative ids, mapped to the
// server's ids when their change is acknowledged.
//
// Each change carries its own request_id, so a retry after a lost answer is answered with the
// first result instead of a second copy (see once() in server.py). Network failures and server
// errors (5xx) retry with backoff; any other refusal stops the queue and is shown with Retry
// and Discard, so nothing is dropped silently.
//
// What a change does is described by its kind in `kinds` (see workout-ops.mjs):
//   request(op, outbox) -> { path, method, body }
//   apply(data, op, outbox)        the change on the phone's copy (idempotent; replayed after reload)
//   done(op, answer, context)      the server's answer: map ids, adopt server values
//   ok(error)                      a refusal that means it is already done (e.g. 404 on delete)

export const OUTBOX_KEY = "gymdex:outbox:v1";
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const OFFLINE_CHECK_MS = 5000;

let lastTemp = 0;
// A temporary id: negative, unique on this phone across reloads.
export function tempId(now = Date.now()) {
  lastTemp = Math.min(lastTemp - 1, -now);
  return lastTemp;
}

export const isTemp = (id) => typeof id === "number" && id < 0;

export class Outbox {
  #ops = [];
  #map = {};
  #running = false;
  #timer = null;
  #attempt = 0;
  #inFlight = null;
  #storageFailed = false;

  constructor({ storage = () => null, request, kinds, onChange = () => {}, onIdle = () => {},
    schedule = setTimeout, clear = clearTimeout, online = () => true, random = Math.random }) {
    Object.assign(this, { storage, request, kinds, onChange, onIdle, schedule, clear, online, random });
    this.completed = 0;
    this.context = {};
    this.#read();
  }

  get ops() { return this.#ops.map((op) => ({ ...op })); }
  get size() { return this.#ops.length; }
  get failed() { return this.#ops.find((op) => op.error) ?? null; }
  get syncing() { return this.#running; }
  get storageFailed() { return this.#storageFailed; }
  // Queued changes that can still be sent (none while one waits for Retry or Discard).
  get runnable() { return this.#ops.length > 0 && !this.failed; }
  get waitingForRetry() { return this.#timer !== null; }

  #read() {
    try {
      const saved = JSON.parse(this.storage()?.getItem(OUTBOX_KEY) ?? "null");
      if (saved && Array.isArray(saved.ops)) {
        this.#ops = saved.ops;
        // A screen opened now shows server ids, so the map is needed only while changes still name temporary ids.
        this.#map = saved.ops.length ? saved.map ?? {} : {};
      }
    } catch { this.#storageFailed = true; }
  }

  #write() {
    try {
      this.storage()?.setItem(OUTBOX_KEY, JSON.stringify({ ops: this.#ops, map: this.#map }));
      this.#storageFailed = false;
    } catch { this.#storageFailed = true; }
  }

  // The server id for an id, or the id itself while it has none yet.
  resolve(id) {
    let value = id;
    for (let guard = 0; isTemp(value) && this.#map[value] !== undefined && guard < 10; guard++) value = this.#map[value];
    return value;
  }

  // Whether the server knows this id yet.
  known(id) { return !isTemp(this.resolve(id)); }

  // The temporary id that became this server id, if any.
  tempFor(id) {
    const found = Object.entries(this.#map).find(([, value]) => value === id);
    return found ? Number(found[0]) : null;
  }

  enqueue(op, { next = false } = {}) {
    const queued = { ...op, id: op.id ?? `${Date.now().toString(36)}-${this.random().toString(36).slice(2, 10)}` };
    queued.request_id ??= queued.id;
    if (next && this.#inFlight) this.#ops.splice(this.#ops.indexOf(this.#inFlight) + 1, 0, queued);
    else this.#ops.push(queued);
    this.#write();
    this.onChange();
    this.kick();
    return queued;
  }

  map(from, to) {
    this.#map[from] = to;
    this.#write();
  }

  // Applies every queued change to fresh server data, so a reload shows what the phone logged.
  replay(data) {
    for (const op of this.#ops) this.kinds[op.kind]?.apply?.(data, op, this);
    return data;
  }

  kick() {
    if (this.#running || !this.runnable) return;
    // Browsers do not always fire "online" (a page reloaded offline, flaky radios), so look again soon.
    if (!this.online()) {
      this.#timer ??= this.schedule(() => { this.#timer = null; this.kick(); }, OFFLINE_CHECK_MS);
      return;
    }
    if (this.#timer !== null) { this.clear(this.#timer); this.#timer = null; }
    this.#run();
  }

  async #run() {
    this.#running = true;
    this.onChange();
    try {
      while (this.runnable && this.online()) {
        const op = this.#ops[0];
        const kind = this.kinds[op.kind];
        this.#inFlight = op;
        let answer;
        try {
          const { path, method, body } = kind.request(op, this);
          answer = await this.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        } catch (error) {
          if (!this.#ops.includes(op)) { this.#inFlight = null; continue; }
          if (kind.ok?.(error)) answer = null;
          else {
            this.#inFlight = null;
            if (!error.status || error.status >= 500 || error.status === 408 || error.status === 429) {
              const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)];
              this.#attempt += 1;
              op.attempts = (op.attempts ?? 0) + 1;
              op.lastError = error.message;
              this.#write();
              this.#timer = this.schedule(() => { this.#timer = null; this.kick(); }, delay + Math.floor(this.random() * 400));
            } else {
              op.error = error.message || "The server refused this change.";
              op.status = error.status;
              this.#write();
            }
            return;
          }
        }
        // Dropped while in flight (the workout was canceled): its answer no longer matters.
        if (!this.#ops.includes(op)) { this.#inFlight = null; continue; }
        this.#attempt = 0;
        // Changes done() queues with { next: true } go right after this one.
        try { kind.done?.(op, answer, this); }
        catch (error) { console.error("Gymdex could not apply a synced change on this phone", error); }
        this.#inFlight = null;
        this.#ops.splice(this.#ops.indexOf(op), 1);
        this.completed += 1;
        this.#write();
        this.onChange();
      }
    } finally {
      this.#running = false;
      this.onChange();
      if (!this.#ops.length) this.onIdle();
    }
  }

  // Sends the change that was refused again, as is.
  retry() {
    for (const op of this.#ops) { delete op.error; delete op.status; }
    this.#attempt = 0;
    this.#write();
    this.onChange();
    this.kick();
  }

  // Drops a refused change and every later change that names something it created, returning
  // them. The caller rebuilds its copy from the server and the remaining queue.
  discard(opId) {
    const first = this.#ops.find((op) => op.id === opId);
    if (!first) return [];
    const gone = new Set((first.creates ?? []).map(Number));
    const dropped = [first];
    for (const op of this.#ops) {
      if (op === first || !(op.uses ?? []).some((id) => gone.has(Number(id)))) continue;
      dropped.push(op);
      (op.creates ?? []).forEach((id) => gone.add(Number(id)));
    }
    this.#ops = this.#ops.filter((op) => !dropped.includes(op));
    this.#write();
    this.onChange();
    this.kick();
    return dropped;
  }

  // Forgets a workout's queued changes, after it was canceled on purpose.
  dropWorkout(workoutId) {
    this.#ops = this.#ops.filter((op) => op.workoutId !== workoutId);
    this.#write();
    this.onChange();
  }
}
