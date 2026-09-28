export const DEFAULT_REST_DURATION_SECONDS = 90;
// A countdown found finished later than this, for example when the phone is unlocked
// minutes after the rest ended, finishes without signalling: the cue would be misleading.
export const LATE_FINISH_SIGNAL_MS = 30_000;

function validDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new RangeError("Rest duration must be a whole number from 1 to 3600 seconds.");
  }
  return seconds;
}

// The deadline is a wall-clock time. Browser timers only prompt a display update;
// they are never used to determine how much rest time has actually elapsed.
export class RestTimer {
  #now;
  #schedule;
  #clear;
  #onChange;
  #onFinish;
  #timerId = null;
  #status = "idle";
  #durationSeconds;
  #remainingMs = 0;
  #deadline = null;

  constructor({ durationSeconds = DEFAULT_REST_DURATION_SECONDS,
    now = () => Date.now(), schedule = setTimeout, clear = clearTimeout,
    onChange = () => {}, onFinish = () => {} } = {}) {
    this.#durationSeconds = validDuration(durationSeconds);
    this.#now = now;
    this.#schedule = schedule;
    this.#clear = clear;
    this.#onChange = onChange;
    this.#onFinish = onFinish;
  }

  snapshot() {
    const remainingMs = this.#status === "running"
      ? Math.max(0, this.#deadline - this.#now()) : this.#remainingMs;
    return {
      status: this.#status === "running" && remainingMs === 0 ? "finished" : this.#status,
      durationSeconds: this.#durationSeconds,
      remainingSeconds: Math.ceil(remainingMs / 1000),
    };
  }

  // A new completed set can restart an already running or finished timer.
  start() {
    this.#clearScheduled();
    this.#remainingMs = this.#durationSeconds * 1000;
    this.#deadline = this.#now() + this.#remainingMs;
    this.#status = "running";
    this.#scheduleNext();
    this.#emit();
  }

  pause() {
    if (this.#status !== "running") return;
    this.#remainingMs = Math.max(0, this.#deadline - this.#now());
    if (this.#remainingMs === 0) {
      this.#finish(this.#now() - this.#deadline);
      return;
    }
    this.#clearScheduled();
    this.#deadline = null;
    this.#status = "paused";
    this.#emit();
  }

  resume() {
    if (this.#status !== "paused") return;
    this.#deadline = this.#now() + this.#remainingMs;
    this.#status = "running";
    this.#scheduleNext();
    this.#emit();
  }

  stop() {
    this.#clearScheduled();
    this.#status = "idle";
    this.#deadline = null;
    this.#remainingMs = 0;
    this.#emit();
  }

  // Changes the setting for the next set; an active countdown keeps its deadline.
  setDuration(seconds) {
    this.#durationSeconds = validDuration(seconds);
    this.#emit();
  }

  // Call on visibilitychange to reconcile after browsers throttle background tabs.
  refresh() {
    if (this.#status !== "running") return this.snapshot();
    if (this.#deadline <= this.#now()) {
      this.#finish(this.#now() - this.#deadline);
    } else {
      this.#scheduleNext();
      this.#emit();
    }
    return this.snapshot();
  }

  dispose() {
    this.#clearScheduled();
    this.#onChange = () => {};
    this.#onFinish = () => {};
  }

  #finish(lateMs) {
    this.#clearScheduled();
    this.#status = "finished";
    this.#deadline = null;
    this.#remainingMs = 0;
    this.#emit();
    // Called at most once per countdown, when a running interval is found to have
    // reached zero no more than LATE_FINISH_SIGNAL_MS after its deadline.
    if (lateMs <= LATE_FINISH_SIGNAL_MS) this.#onFinish(this.snapshot());
  }

  #scheduleNext() {
    this.#clearScheduled();
    const remainingMs = Math.max(0, this.#deadline - this.#now());
    // The next display value changes at the next whole-second boundary.
    const delay = Math.max(1, Math.min(1000, remainingMs % 1000 || 1000));
    this.#timerId = this.#schedule(() => {
      this.#timerId = null;
      this.refresh();
    }, delay);
  }

  #clearScheduled() {
    if (this.#timerId !== null) this.#clear(this.#timerId);
    this.#timerId = null;
  }

  #emit() { this.#onChange(this.snapshot()); }
}
