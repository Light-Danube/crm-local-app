const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { setTimeout: delay } = require('node:timers/promises');

test('snapshot restores a cleared source while currentSrc still reports the old resource', async () => {
  const handlers = {};
  const video = Object.assign(new EventTarget(), {
    src: '', currentSrc: 'http://localhost/media/session/fixture', readyState: 0,
    duration: 60, loads: 0, pause() {},
    load() { this.loads++; }, hasAttribute() { return Boolean(this.src); },
  });
  const socket = { connected: true, io: { on() {} }, on(event, handler) { handlers[event] = handler; } };
  const context = { window: {}, URL, location: { href: 'http://localhost/video' }, AbortController, DOMException, setTimeout };
  runInNewContext(readFileSync(join(__dirname, '../public/src/player-session.js'), 'utf8'), context);
  const player = context.window.createPlayerSession({ socket, video });
  handlers['state snapshot']({ sessionId: 'session', revision: 1, time: 7, paused: true,
    volume: 1, effects: {}, media: { url: '/media/session/fixture' } });
  await delay(0);
  assert.equal(video.src, '/media/session/fixture');
  assert.equal(video.loads, 1);
  assert.equal(player.isReady(), false);
  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  for (let attempt = 0; attempt < 20 && !player.isReady(); attempt++) await delay(5);
  assert.equal(player.isReady(), true);
  assert.equal(video.currentTime, 7);
});
