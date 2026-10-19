const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function browser(t, { localPlayback = false } = {}) {
  const handlers = new Map();
  const status = { textContent: '' };
  const socket = {
    connected: true, sendBuffer: [], io: { on() {} },
    on(event, callback) { handlers.set(event, callback); },

  };
  const video = Object.assign(new EventTarget(), {
    readyState: 1, volume: 1, loop: false, currentTime: 0, duration: 100,
    pauseCount: 0, playCount: 0, loadCount: 0,
    pause() { this.pauseCount++; this.paused = true; },
    play() { this.playCount++; this.paused = false; return Promise.resolve(); },
    load() { this.loadCount++; },
    hasAttribute() { return false; },
  });
  const context = { window: {}, URL, location: { href: 'http://localhost/video' }, AbortController,
    DOMException, setTimeout, clearTimeout, Date, performance };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/src/player-session.js'), 'utf8'), context);
  const player = context.window.createPlayerSession({ socket, video, statusElement: status, localPlayback, getSessionId: () => 'session' });
  const snapshot = {
    sessionId: 'session', revision: 0, media: null, paused: true, time: 0,
    volume: 1, effects: { loop: false, inversion: false, color: false, details: false, background: false },
  };
  handlers.get('state snapshot')(snapshot);
  await wait(5);
  assert.equal(player.isReady(), true);
  t.after(() => { socket.connected = false; handlers.get('disconnect')('transport close'); });
  return { socket, player, video, snapshot, status, receive: value => handlers.get('command applied')(value), handlers };
}

test('older or foreign command envelopes cannot override newer state; effects and volume preserve media playback', async t => {
  const { receive, video, snapshot } = await browser(t);
  const pauses = video.pauseCount;
  const loads = video.loadCount;
  receive({ ...snapshot, event: 'player volumeupdate', revision: 2, volume: 0.3 });
  await wait(5);
  assert.equal(video.volume, 0.3);
  receive({ ...snapshot, event: 'player volumeupdate', revision: 1, volume: 0.9 });
  receive({ ...snapshot, event: 'player volumeupdate', sessionId: 'foreign', revision: 100, volume: 0.8 });
  receive({ ...snapshot, event: 'toggle loop', revision: 3, volume: 0.3, effects: { ...snapshot.effects, loop: true } });
  await wait(5);
  assert.equal(video.volume, 0.3);
  assert.equal(video.loop, true);
  assert.equal(video.pauseCount, pauses);
  assert.equal(video.loadCount, loads);
});

test('controller timeline echoes preserve its local seek while canonical reconnect restores it', async t => {
  const { receive, handlers, video, snapshot } = await browser(t, { localPlayback: true });
  video.currentTime = 25;
  const pauses = video.pauseCount;
  receive({ ...snapshot, event: 'player timeupdate', revision: 1, time: 10 });
  await wait(5);
  assert.equal(video.currentTime, 25);
  assert.equal(video.pauseCount, pauses);
  handlers.get('state snapshot')({ ...snapshot, revision: 2, time: 10,
    media: { kind: 'local', url: '/media/session/fixture' } });
  await wait(5);
  assert.equal(video.currentTime, 10);
});

test('a delayed native play completion cannot replace a newer command state', async t => {
  const { receive, video, snapshot } = await browser(t);
  let finishPlay;
  video.play = () => new Promise(resolve => { finishPlay = resolve; });
  receive({ ...snapshot, event: 'player start', revision: 1, volume: 0.2 });
  receive({ ...snapshot, event: 'player pause', revision: 2, volume: 0.7 });
  await wait(5);
  finishPlay();
  await wait(5);
  assert.equal(video.volume, 0.7);
  assert.equal(video.paused, true);
});


test('a failed media restore keeps the live session available for a replacement source', async t => {
  const { receive, video, snapshot, player } = await browser(t);
  video.readyState = 0;
  receive({ ...snapshot, event: 'video url', revision: 1,
    media: { kind: 'youtube', url: '/youtube/brokenERR00' } });
  await wait(0);
  video.error = { code: 4 };
  video.dispatchEvent(new Event('error'));
  await wait(5);
  assert.equal(player.isReady(), true);
  video.error = null;
  video.readyState = 1;
  receive({ ...snapshot, event: 'video url', revision: 2,
    media: { kind: 'youtube', url: '/youtube/abcdefghijk' } });
  await wait(5);
  assert.equal(player.isReady(), true);
  assert.equal(video.src, '/youtube/abcdefghijk');
});

test('retrying an errored source reloads it even when the canonical URL is unchanged', async t => {
  const { receive, video, snapshot, player } = await browser(t);
  video.src = 'http://localhost/youtube/RoYXgdHafBA';
  video.error = { code: 4 };
  video.readyState = 0;
  video.load = () => { video.loadCount++; video.error = null; video.readyState = 1; };
  receive({ ...snapshot, event: 'video url', revision: 1,
    media: { kind: 'youtube', url: '/youtube/RoYXgdHafBA' } });
  await wait(5);
  assert.equal(video.loadCount, 1);
  assert.equal(player.isReady(), true);
  assert.equal(video.error, null);
});
