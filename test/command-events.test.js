const { test } = require('node:test');
const assert = require('node:assert/strict');
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

test('accepted commands emit one canonical envelope to owner and each authenticated display', async t => {
  const f = await fixture(t, { playbackNow: () => 1000 });
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const first = await paired(f, session);
  const stored = f.sessionStore.sessions.get(session.sessionId);
  const second = await paired(f, { ...session, pairingCode: f.sessionStore.rotatePairing(stored).pairingCode });
  const foreignSession = await f.createSession();
  const foreign = await f.connectController(foreignSession);
  const foreignSeen = [];
  foreign.on('command applied', value => foreignSeen.push(value));
  const seen = [[], [], []];
  [owner, first, second].forEach((socket, index) => socket.on('command applied', value => seen[index].push(value)));
  const commands = [['toggle loop', true], ['toggle inversion', true], ['player timeupdate', 17], ['player volumeupdate', 0.6], ['player start'], ['player pause']];
  for (const [index, [event, ...args]] of commands.entries()) {
    const delivered = [owner, first, second].map(socket => once(socket, 'command applied'));
    const result = await command(owner, event, ...args);
    assert.deepEqual(result, { ok: true, revision: index + 1 });
    const envelopes = await Promise.all(delivered);
    assert.deepEqual(envelopes[0], envelopes[1]);
    assert.deepEqual(envelopes[1], envelopes[2]);
    assert.equal(envelopes[0][0].event, event);
    assert.equal(envelopes[0][0].sessionId, session.sessionId);
    assert.equal(envelopes[0][0].revision, index + 1);
  }
  assert.deepEqual(seen.map(values => values.length), [commands.length, commands.length, commands.length]);
  assert.deepEqual(foreignSeen, []);
  assert.equal(seen[0].at(-1).time, 17);
  assert.equal(seen[0].at(-1).effects.loop, true);
  assert.equal(seen[0].at(-1).effects.inversion, true);
});

test('upload publishes one canonical media revision to owner and paired display', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const display = await paired(f, session);
  const delivered = [owner, display].map(socket => once(socket, 'command applied'));
  const legacy = once(display, 'file uploaded');
  const form = new FormData();
  form.append('video', new Blob([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')], { type: 'video/mp4' }), 'fixture.mp4');
  const response = await fetch(f.base + '/upload?sessionId=' + session.sessionId, {
    method: 'POST', headers: { authorization: `Bearer ${session.ownerToken}` }, body: form,
  });
  assert.equal(response.status, 201);
  const media = await response.json();
  assert.deepEqual(await legacy, [media]);
  const [first, second] = await Promise.all(delivered);
  assert.deepEqual(first, second);
  assert.equal(first[0].event, 'media changed');
  assert.equal(first[0].revision, 1);
  assert.equal(first[0].sessionId, session.sessionId);
  assert.deepEqual(first[0].media, { kind: 'local', url: media.url, mediaId: media.mediaId });
});
