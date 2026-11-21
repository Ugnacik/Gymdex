import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PushNotifications } from '../static/notifications.mjs';

function fixture({ on = true } = {}) {
  const disk = new Map(on ? [['gymdex:push:v1', 'on']] : []);
  const sent = [];
  let clock = 1_000;
  const notifications = new PushNotifications({
    window: { localStorage: { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value), removeItem: (key) => disk.delete(key) } },
    navigator: { userAgent: 'test' },
    fetch: async (path, options) => { sent.push([path, JSON.parse(options.body)]); return { ok: true, json: async () => ({}) }; },
    now: () => clock,
  });
  return { notifications, sent, advance: (ms) => { clock += ms; } };
}

test('rests are reported to the server as time left, and stopping or pausing cancels Rest over', () => {
  const { notifications, sent, advance } = fixture();
  notifications.restChanged(null, 'idle');
  notifications.restChanged(121_000, 'running');
  advance(1_000);
  // Every countdown tick reports the same end time, which is sent once.
  notifications.restChanged(121_000, 'running');
  notifications.restChanged(null, 'paused');
  notifications.restChanged(150_000, 'running');
  notifications.restChanged(null, 'idle');
  assert.deepEqual(sent, [
    ['/api/push/rest', { remaining_ms: 120_000 }],
    ['/api/push/rest', { remaining_ms: null }],
    ['/api/push/rest', { remaining_ms: 148_000 }],
    ['/api/push/rest', { remaining_ms: null }],
  ]);
});

test('a finished rest is left to the server, which is sending Rest over for it', () => {
  const { notifications, sent } = fixture();
  notifications.restChanged(61_000, 'running');
  notifications.restChanged(null, 'finished');
  notifications.restChanged(null, 'idle');
  assert.deepEqual(sent, [['/api/push/rest', { remaining_ms: 60_000 }]]);
});

test('a phone without notifications turned on reports nothing', () => {
  const { notifications, sent } = fixture({ on: false });
  notifications.restChanged(61_000, 'running');
  assert.deepEqual(sent, []);
});

test('an iPhone outside the Home Screen app is told to install it', () => {
  const { notifications } = fixture();
  assert.equal(notifications.support, 'unsupported');
  const iphone = new PushNotifications({ window: {}, navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: false }, fetch });
  assert.equal(iphone.support, 'install');
});

test('a callback-style requestPermission and a worker that never starts are both handled', async () => {
  let requested = 0;
  const notifications = new PushNotifications({
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, PushManager: function PushManager() {},
      Notification: { permission: 'default', requestPermission: (callback) => { requested += 1; setTimeout(() => callback('granted'), 0); } } },
    navigator: { serviceWorker: { ready: new Promise(() => {}) } },
    fetch: async () => ({ ok: true, json: async () => ({ available: true, public_key: 'BAAA' }) }),
    readyTimeout: 20,
  });
  await assert.rejects(notifications.enable(), (error) => error.name === 'ServiceWorkerNotReady');
  assert.equal(requested, 1);
});
