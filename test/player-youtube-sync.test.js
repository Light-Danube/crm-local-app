const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const wait = () => new Promise(resolve => setTimeout(resolve, 5));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

async function fixture(t, { localPlayback = false } = {}) {
  let clock = 0;
  const handlers = {};
  const socket = { connected: true, sendBuffer: [], io: { on() {} }, on(event, listener) { handlers[event] = listener; } };
  const video = Object.assign(new EventTarget(), {
    isYouTube: true, readyState: 1, duration: 60, currentTime: 0, volume: 1, paused: true, loop: false,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
    hasAttribute() { return false; }, load() {},
  });
  const context = { window: {}, URL, location: { href: 'http://localhost/video' }, AbortController, DOMException,
    setTimeout, performance: { now: () => clock } };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../public/src/player-session.js'), 'utf8'), context);
  const session = context.window.createPlayerSession({ socket, video, localPlayback });
  const snapshot = { sessionId: 'session', revision: 0, paused: true, time: 0,
    media: { kind: 'youtube', url: '/youtube/RoYXgdHafBA' }, volume: 1, effects: { loop: false } };
  handlers['state snapshot'](snapshot);
  for (let attempt = 0; attempt < 20 && !session.isReady(); attempt++) await wait();
  assert.equal(session.isReady(), true);
  t.after(() => { socket.connected = false; handlers.disconnect('transport close'); });
  return { video, session, socket, handlers, snapshot, advance: ms => { clock += ms; },
    command: value => handlers['command applied']({ ...snapshot, revision: 1, ...value }) };
}

test('pause waits for actual iframe confirmation and then aligns the canonical paused position', async t => {
  const f = await fixture(t);
  const pause = deferred();
  f.video.currentTime = 9;
  f.video.pause = () => pause.promise;
  f.command({ event: 'player pause', time: 10 });
  f.advance(150); f.video.currentTime = 9.15;
  assert.equal(f.video.currentTime, 9.15);
  pause.resolve(true); await wait();
  assert.equal(f.video.currentTime, 10);
});

test('start compensates iframe startup delay once, using the received canonical timeline', async t => {
  const f = await fixture(t);
  const play = deferred();
  f.video.currentTime = 9;
  f.video.play = () => play.promise;
  f.command({ event: 'player start', paused: false, time: 10 });
  f.advance(600); f.video.currentTime = 9.6;
  play.resolve(); await wait();
  assert.equal(f.video.currentTime, 10.6);
  f.advance(5000); await wait();
  assert.equal(f.video.currentTime, 10.6, 'no periodic seeks are introduced');
});

test('playing reconnect includes metadata and play delays; paused reconnect does not advance time', async t => {
  for (const paused of [false, true]) {
    const f = await fixture(t);
    const play = deferred();
    f.video.readyState = 0;
    f.video.play = () => play.promise;
    f.handlers['state snapshot']({ ...f.snapshot, revision: 1, time: 10, paused });
    await wait(); f.advance(600);
    f.video.readyState = 1; f.video.dispatchEvent(new Event('loadedmetadata'));
    await wait(); f.advance(400); play.resolve();
    for (let attempt = 0; attempt < 20 && !f.session.isReady(); attempt++) await wait();
    assert.equal(f.session.isReady(), true);
    assert.equal(f.video.currentTime, paused ? 10 : 11);
  }
});

test('a newer pause or disconnect prevents a delayed start from seeking an obsolete timeline', async t => {
  const f = await fixture(t);
  const play = deferred();
  f.video.play = () => play.promise;
  f.command({ event: 'player start', paused: false, time: 10 });
  f.command({ event: 'player pause', revision: 2, time: 11 });
  await wait();
  f.advance(600); play.resolve(); await wait();
  assert.equal(f.video.currentTime, 11);
  const pause = deferred();
  f.video.pause = () => pause.promise;
  f.command({ event: 'player pause', revision: 3, time: 20 });
  f.socket.connected = false; f.handlers.disconnect('transport close');
  pause.resolve(true); await wait();
  assert.equal(f.video.currentTime, 11);
});

test('loop boundaries wrap the aligned position and controller echoes preserve local playback', async t => {
  for (const localPlayback of [false, true]) {
    const f = await fixture(t, { localPlayback });
    f.video.loop = true; f.video.currentTime = 59.8;
    const play = deferred(); f.video.play = () => play.promise;
    f.command({ event: 'player start', paused: false, time: 59.8, effects: { loop: true } });
    f.advance(600); play.resolve(); await wait();
    assert.ok(Math.abs(f.video.currentTime - (localPlayback ? 59.8 : 0.4)) < 0.001);
  }
});

test('blocked autoplay skips the post-PLAYING correction and replacement media does not await an old pause', async t => {
  const f = await fixture(t);
  f.video.play = async () => { f.advance(600); throw new DOMException('Blocked', 'NotAllowedError'); };
  f.handlers['state snapshot']({ ...f.snapshot, revision: 1, paused: false, time: 10 });
  for (let attempt = 0; attempt < 20 && !f.session.isReady(); attempt++) await wait();
  assert.equal(f.video.currentTime, 10, 'no correction for playback that never started');
  f.video.pause = () => deferred().promise;
  f.handlers['state snapshot']({ ...f.snapshot, revision: 2, media: { kind: 'youtube', url: '/youtube/abcdefghijk' } });
  for (let attempt = 0; attempt < 20 && !f.session.isReady(); attempt++) await wait();
  assert.equal(f.video.src, '/youtube/abcdefghijk');
  assert.equal(f.session.isReady(), true);
});
