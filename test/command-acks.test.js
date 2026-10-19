const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { fixture, once } = require('./helpers');

function command(socket, event, ...args) {
  return new Promise((resolve, reject) => socket.timeout(2000).emit(event, ...args,
    (error, response) => error ? reject(error) : resolve(response)));
}
async function paired(f, session) {
  const display = await f.connect();
  const connected = once(display, 'masterConnected');
  display.emit('connectToMaster', session.pairingCode);
  await connected;
  return display;
}

test('acknowledgements reject malformed, unauthorized and stale-owner commands without mutation', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const display = await paired(f, session);
  const stored = f.sessionStore.sessions.get(session.sessionId);
  const before = stored.playback.snapshot();
  for (const [socket, event, args, code] of [
    [owner, 'player volumeupdate', [2], 'INVALID_PAYLOAD'],
    [owner, 'player start', [null], 'INVALID_PAYLOAD'],
    [owner, 'player start', [undefined, { revision: 1000 }], 'INVALID_PAYLOAD'],
    [owner, 'video url', ['https://example.com/watch?v=abcdefghijk'], 'INVALID_VIDEO_URL'],
    [display, 'player start', [], 'FORBIDDEN'],
  ]) {
    const result = await command(socket, event, ...args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(typeof result.error.message, 'string');
  }
  stored.controllerSocketId = null;
  await f.connectController(session);
  assert.equal((await command(owner, 'player start')).error.code, 'FORBIDDEN');
  assert.deepEqual(stored.playback.snapshot(), before);
});

test('optional acknowledgements preserve existing no-ack and legacy relay contracts', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const display = await paired(f, session);
  let delivered = once(display, 'pause');
  owner.emit('player pause');
  assert.deepEqual(await delivered, []);
  delivered = once(display, 'play');
  assert.deepEqual(await command(owner, 'player start'), { ok: true, revision: 2 });
  assert.deepEqual(await delivered, []);
  delivered = once(display, 'volumeupdate');
  assert.deepEqual(await command(owner, 'player volumeupdate', 0), { ok: true, revision: 3 });
  assert.deepEqual(await delivered, [0]);
  delivered = once(display, 'loop status');
  assert.deepEqual(await command(owner, 'toggle loop', false), { ok: true, revision: 4 });
  assert.deepEqual(await delivered, [false]);
});

test('100 sequential command acknowledgements use one monotonic client clock', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  await paired(f, session);
  const timings = [];
  for (let index = 0; index < 100; index++) {
    const started = performance.now();
    const result = await command(owner, 'player volumeupdate', index % 2 ? 0.3 : 0.7);
    timings.push(performance.now() - started);
    assert.deepEqual(result, { ok: true, revision: index + 1 });
  }
  timings.sort((a, b) => a - b);
  t.diagnostic(`100 command ack RTTs over loopback WebSocket, no media: p50=${timings[49].toFixed(3)}ms p95=${timings[94].toFixed(3)}ms max=${timings[99].toFixed(3)}ms; excludes frame presentation`);
});
