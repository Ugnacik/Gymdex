// Notifications on this phone: the Web Push subscription Settings turns on and off, and the
// rest end time the server needs to send "Rest over" while the app is closed (see gymdex/push.py).
const STORAGE_KEY = "gymdex:push:v1";
// The last permission request from this phone: its answer and how long it took. iOS lists a web app
// in Settings, Notifications only after it has shown the prompt once, and an answer within
// PROMPTLESS_MS means no prompt was shown: something else (a device management profile, Screen
// Time, or not being the Home Screen app) refused.
const ASKED_KEY = "gymdex:push-asked:v1";
const PROMPTLESS_MS = 400;

function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function sameKey(buffer, base64url) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer), b = keyBytes(base64url);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// An Error with a name, shown in the Settings diagnostic line.
function failure(name, message) {
  return Object.assign(new Error(message), { name });
}

// Rejects a promise that has not settled in time, such as serviceWorker.ready when the worker never installed.
function within(promise, ms, name, message) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(failure(name, message)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class PushNotifications {
  #window; #navigator; #fetch; #now; #readyTimeout; #endsAt = null; #info = null;

  constructor({ window, navigator, fetch, now = () => Date.now(), readyTimeout = 10_000 }) {
    this.#readyTimeout = readyTimeout;
    this.#window = window;
    this.#navigator = navigator;
    this.#fetch = fetch;
    this.#now = now;
  }

  // Whether this phone turned notifications on, as last seen; rests are reported only then.
  get on() {
    try { return this.#window.localStorage.getItem(STORAGE_KEY) === "on"; } catch { return false; }
  }

  #remember(on) {
    try {
      if (on) this.#window.localStorage.setItem(STORAGE_KEY, "on");
      else this.#window.localStorage.removeItem(STORAGE_KEY);
    } catch { /* Rests are then not reported from this page. */ }
  }

  async #send(path, body) {
    const response = await this.#fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error || "Something went wrong.");
    return answer;
  }

  // iPhone Safari offers Web Push only to a web app opened from the Home Screen (iOS 16.4+).
  get support() {
    const window = this.#window, navigator = this.#navigator;
    if (navigator.serviceWorker && window.PushManager && window.Notification) return "supported";
    return navigator.standalone === false || /iPhone|iPad/.test(navigator.userAgent ?? "") ? "install" : "unsupported";
  }

  async #registration() {
    if (!this.#navigator.serviceWorker) throw failure("NoServiceWorker", "This browser has no service worker, so it cannot receive notifications.");
    return within(this.#navigator.serviceWorker.ready, this.#readyTimeout, "ServiceWorkerNotReady",
      "Gymdex's offline worker is not running. Close Gymdex fully, open it again from the Home Screen, and retry.");
  }

  // Asks the browser; older Safari answers through a callback instead of a promise.
  // Remembers the answer and whether a prompt can have been shown (see ASKED_KEY).
  async #requestPermission() {
    const started = this.#now();
    const permission = await new Promise((resolve) => {
      const answer = this.#window.Notification.requestPermission(resolve);
      answer?.then?.(resolve);
    });
    const ms = Math.max(0, this.#now() - started);
    try { this.#window.localStorage.setItem(ASKED_KEY, JSON.stringify({ permission, ms, at: this.#now() })); } catch { /* Diagnostics only. */ }
    return permission;
  }

  // The last request's answer, or null when this phone has never asked.
  get lastAsked() {
    try { return JSON.parse(this.#window.localStorage.getItem(ASKED_KEY)); } catch { return null; }
  }

  // Why notifications read as blocked: "promptless" when iOS refused without showing its prompt
  // or before Gymdex ever asked (the phone, not you, blocks them), "refused" when you answered.
  get blockedReason() {
    const asked = this.lastAsked;
    return !asked || (asked.permission === "denied" && asked.ms < PROMPTLESS_MS) ? "promptless" : "refused";
  }

  // Facts for the Settings diagnostic line, read fresh each time.
  async diagnostics() {
    const window = this.#window, navigator = this.#navigator;
    let query = "n/a";
    try { query = (await navigator.permissions?.query?.({ name: "notifications" }))?.state ?? "n/a"; } catch { query = "error"; }
    const asked = this.lastAsked;
    return {
      asked: asked ? `${asked.permission} in ${asked.ms} ms${asked.permission === "denied" && asked.ms < PROMPTLESS_MS ? " (no prompt)" : ""}` : "never",
      permission: window.Notification?.permission ?? "no Notification",
      query,
      standalone: Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone),
      pushManager: Boolean(window.PushManager),
      serviceWorker: Boolean(navigator.serviceWorker),
      controlled: Boolean(navigator.serviceWorker?.controller),
      host: window.location?.host ?? "",
    };
  }

  // One of: install, unsupported, unavailable (the server cannot send), denied, off, on.
  async status() {
    if (this.support !== "supported") return this.support;
    this.#info ??= await this.#send("/api/push");
    if (!this.#info.available) return "unavailable";
    if (this.#window.Notification.permission === "denied") return this.blockedReason === "promptless" ? "blocked-by-device" : "denied";
    const subscription = await (await this.#registration()).pushManager.getSubscription();
    this.#remember(Boolean(subscription));
    return subscription ? "on" : "off";
  }

  // Call from a tap: iOS asks for permission only in response to one, so requestPermission runs
  // before anything else is awaited. It is called even when permission reads "denied": the
  // browser then answers at once, and only that answer counts as blocked.
  async enable() {
    if (!this.#window.Notification) {
      throw failure("NoNotification", this.support === "install"
        ? "This page cannot ask for notifications. Open Gymdex from its Home Screen icon, not in Safari."
        : "This browser cannot show notifications from Gymdex.");
    }
    const permission = await this.#requestPermission();
    if (permission !== "granted") return permission === "denied" ? (this.blockedReason === "promptless" ? "blocked-by-device" : "denied") : "off";
    if (!this.#window.PushManager) throw failure("NoPushManager", "Notifications are allowed, but this page cannot subscribe to push. Open Gymdex from its Home Screen icon.");
    this.#info ??= await this.#send("/api/push");
    if (!this.#info.available) return "unavailable";
    const manager = (await this.#registration()).pushManager;
    let subscription = await manager.getSubscription();
    // A subscription made for another server key can no longer receive anything.
    if (subscription && !sameKey(subscription.options?.applicationServerKey, this.#info.public_key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(this.#info.public_key) });
    await this.#send("/api/push/subscriptions", subscription.toJSON());
    this.#remember(true);
    return "on";
  }

  async disable() {
    const subscription = await (await this.#registration()).pushManager.getSubscription();
    this.#remember(false);
    if (!subscription) return "off";
    await this.#send("/api/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
    await subscription.unsubscribe();
    return "off";
  }

  test() { return this.#send("/api/push/test", {}); }

  // On start: re-sends this phone's subscription, so a restored server database still knows it.
  async sync() {
    if (this.support !== "supported" || !this.on) return;
    try {
      const subscription = await (await this.#registration()).pushManager.getSubscription();
      this.#remember(Boolean(subscription));
      if (subscription) await this.#send("/api/push/subscriptions", subscription.toJSON());
    } catch { /* Tried again on the next start. */ }
  }

  // Call with the rest timer's end time (null when not counting down) whenever it changes state.
  // A countdown that finishes is left alone: the server is sending "Rest over" for it.
  restChanged(endsAt, status) {
    if (!this.on) return;
    if (endsAt === this.#endsAt || (endsAt === null && status === "finished")) {
      this.#endsAt = endsAt;
      return;
    }
    this.#endsAt = endsAt;
    const remaining = endsAt === null ? null : Math.min(3_600_000, Math.max(1, endsAt - this.#now()));
    this.#send("/api/push/rest", { remaining_ms: remaining }).catch(() => {});
  }
}
