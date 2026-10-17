const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, once } = require('./helpers');
const { validateEvent } = require('../lib/socket-payloads');

test('malformed application packets cannot crash or reach a display', async t => {
  const { base, connect, createSession, connectController } = await fixture(t);
  const session = await createSession();
  const master = await connectController(session);
  const display = await connect();
  const paired = once(display, 'masterConnected');
  display.emit('connectToMaster', session.pairingCode);
  await paired;
  const forwarded = [];
  display.onAny((...args) => forwarded.push(args));
  const cases = [
    ['video uploaded', [undefined, null, [], 1, 'file', {}, { videoId: null }, { videoId: [] }]],
    ['player timeupdate', [null, [], {}, '0', -1, NaN, Infinity]],
    ['player volumeupdate', [null, [], {}, '0.5', -0.1, 1.1, NaN, Infinity]],
    ['video url', [null, [], {}, 1, '', 'javascript:alert(1)', 'file:///tmp/a']],
    ['connectToMaster', [null, [], {}, 1234, '']],
    ...['toggle loop', 'toggle inversion', 'optimize color', 'toggle enhance details', 'toggle back details']
      .map(event => [event, [undefined, null, [], {}, 'false', 0]]),
    ...['player start', 'player pause', 'stop'].map(event => [event, [null, [], {}, 'play', true]]),
  ];
  for (const [event, values] of cases) {
    for (const value of values) {
      const error = once(master, 'error');
      master.emit(event, value);
      assert.match((await error)[0], /Invalid payload/);
    }
  }
  assert.deepEqual(forwarded, []);
  assert.equal((await fetch(base)).status, 200);
  const delivered = once(display, 'timeupdate');
  master.emit('player timeupdate', 0);
  assert.deepEqual(await delivered, [0]);
});

test('valid boundary values relay only normalized event fields', async t => {
  const { connect, createSession, connectController } = await fixture(t);
  const session = await createSession();
  const master = await connectController(session);
  const display = await connect();
  const paired = once(display, 'masterConnected');
  display.emit('connectToMaster', session.pairingCode);
  await paired;
  for (const [event, received, value] of [
    ['player start', 'play', undefined], ['player pause', 'pause', undefined], ['stop', 'stop', undefined],
    ['player timeupdate', 'timeupdate', 0], ['player volumeupdate', 'volumeupdate', 0],
    ['player volumeupdate', 'volumeupdate', 1], ['video url', 'video url', 'https://youtu.be/abcdefghijk'],
    ['toggle loop', 'loop status', false], ['toggle inversion', 'inversion status', true],
    ['optimize color', 'color optimization status', false],
    ['toggle enhance details', 'enhance details status', false],
    ['toggle back details', 'background optimization status', true],
  ]) {
    const pending = once(display, received);
    if (value === undefined) master.emit(event); else master.emit(event, value);
    assert.deepEqual(await pending, value === undefined ? [] : [value]);
  }
  const pending = once(display, 'file uploaded');
  master.emit('video uploaded', { videoId: 'Відео 1.mp4', masterPageID: 'another-room', role: 'controller' });
  assert.deepEqual(await pending, [{ videoId: 'Відео 1.mp4' }]);
});

test('nonfinite numbers and excess arguments are rejected before transport', () => {
  for (const event of ['player timeupdate', 'player volumeupdate']) {
    for (const value of [NaN, Infinity, -Infinity]) assert.equal(validateEvent(event, [value]), false);
  }
  assert.equal(validateEvent('video url', ['https://example.org', { role: 'controller' }]), false);
  assert.equal(validateEvent('unknown', []), false);
});

test('independent servers have isolated pairing state', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const session = await first.createSession();
  await first.connectController(session);
  const stranger = await second.connect();
  const error = once(stranger, 'session error');
  stranger.emit('connectToMaster', session.pairingCode);
  assert.equal((await error)[0].code, 'INVALID_PAIRING_CODE');
  assert.equal((await fetch(second.base)).status, 200);
});
