const CACHE = "gymdex-shell-v46";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/app.mjs", "/workout-editor.mjs", "/drafts.mjs", "/rest-timer.mjs", "/keyboard.mjs", "/confirm-sheet.mjs", "/choice-field.mjs", "/exercise-search.mjs", "/records.mjs", "/outbox.mjs", "/notifications.mjs", "/workout-ops.mjs", "/routines.mjs", "/exercise-reorder.mjs", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/fonts/Geist-Variable.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("gymdex-shell-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Workout data and mutations always go directly to the server.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(event.request, { signal: controller.signal });
      if (!response.ok) throw new Error("App unavailable");
      return response;
    } catch {
      return await caches.match(url.pathname) || Response.error();
    } finally {
      clearTimeout(timeout);
    }
  })());
});

// Reminders the server sends while the app is closed (gymdex/push.py). iOS requires every push
// to show a notification, so one is always shown, even with Gymdex open.
self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data?.json() ?? {}; } catch { /* Shown as a plain Gymdex notification. */ }
  const options = {
    body: message.body || "", tag: message.tag, renotify: Boolean(message.tag),
    icon: "/icon-192.png", badge: "/icon-192.png", data: { url: message.url || "/", kind: message.kind },
  };
  // iOS ignores actions; tapping the notification opens the Still training? question instead.
  if (message.kind === "hourly") options.actions = [{ action: "keep", title: "Keep going" }, { action: "finish", title: "Finish workout" }];
  event.waitUntil(self.registration.showNotification(message.title || "Gymdex", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "keep") return;
  const { url = "/", kind } = event.notification.data || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (!open) return self.clients.openWindow(url);
    if (kind === "hourly") open.postMessage({ type: "still-training" });
    return open.focus();
  })());
});
