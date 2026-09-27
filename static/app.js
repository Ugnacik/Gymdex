import { createApp } from "./app.mjs";

createApp({
  window,
  document,
  navigator,
  fetch: window.fetch.bind(window),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
}).load();
