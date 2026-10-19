const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

test('reconnect restores loop phase and preserves non-loop/unknown-duration behavior', async () => {
  for (const [duration, loop, time, expected] of [
    [60, true, 120.5, 0.5], [60, true, 60, 0],
    [60, false, 120.5, 60], [0, true, 10, 0], [Infinity, true, 10, 10],
  ]) {
    const handlers = {};
    const video = Object.assign(new EventTarget(), {
      duration, readyState: 1, currentTime: 0,
      pause() {}, play() { return Promise.resolve(); }, load() {},
      hasAttribute() { return false; },
    });
    const socket = { connected: true, io: { on() {} }, on(event, handler) { handlers[event] = handler; } };
    const context = { window: {}, URL, location: { href: 'http://localhost/video' },
      AbortController, DOMException, setTimeout };
    runInNewContext(readFileSync(join(__dirname, '../public/src/player-session.js'), 'utf8'), context);
    const player = context.window.createPlayerSession({ socket, video });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Snapshot did not restore')), 1000);
      const poll = () => {
        if (!player.isReady()) return setTimeout(poll, 1);
        clearTimeout(timeout); resolve();
      };
      handlers['state snapshot']({ revision: 1, sessionId: 'session', time, paused: true,
        volume: 1, effects: { loop }, media: { url: '/media/session/fixture' } });
      poll();
    });
    assert.equal(video.currentTime, expected, `duration=${duration}, loop=${loop}`);
    assert.equal(video.loop, loop);
  }
});
