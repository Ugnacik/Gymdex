const CACHE = "gymdex-shell-v13-premium";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/app.mjs", "/workout-editor.mjs", "/drafts.mjs", "/rest-timer.mjs", "/keyboard.mjs", "/confirm-sheet.mjs", "/choice-field.mjs", "/routines.mjs", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/fonts/Geist-Variable.woff2"];

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
