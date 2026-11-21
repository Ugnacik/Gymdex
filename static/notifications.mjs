// Notifications on this phone: the Web Push subscription Settings turns on and off, and the
// rest end time the server needs to send "Rest over" while the app is closed (see gymdex/push.py).
const STORAGE_KEY = "gymdex:push:v1";

function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function sameKey(buffer, base64url) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer), b = keyBytes(base64url);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class PushNotifications {
  #window; #navigator; #fetch; #now; #endsAt = null; #info = null;

  constructor({ window, navigator, fetch, now = () => Date.now() }) {
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

  async #registration() { return this.#navigator.serviceWorker.ready; }

  // One of: install, unsupported, unavailable (the server cannot send), denied, off, on.
  async status() {
    if (this.support !== "supported") return this.support;
    this.#info ??= await this.#send("/api/push");
    if (!this.#info.available) return "unavailable";
    if (this.#window.Notification.permission === "denied") return "denied";
    const subscription = await (await this.#registration()).pushManager.getSubscription();
    this.#remember(Boolean(subscription));
    return subscription ? "on" : "off";
  }

  // Call from a tap: iOS asks for permission only in response to one.
  async enable() {
    const permission = await this.#window.Notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "denied" : "off";
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
