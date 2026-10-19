'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, once } = require('./helpers');

async function pair(f, owner, code, socket) {
  const display = socket || await f.connect();
  const connected = once(display, 'masterConnected');
  const updated = once(owner, 'pairing updated');
  const count = once(owner, 'updatePuppets');
  display.emit('connectToMaster', code);
  const [credentials] = await connected;
  const [pairing] = await updated;
  return { display, credentials, pairing, state: (await count)[0] };
}

async function disconnect(f, socket) {
  const pending = once(f.io.of('/playerControls').sockets.get(socket.id), 'disconnect');
  socket.disconnect();
  await pending;
}

const auth = (session, credentials) => ({ role: 'display', sessionId: session.sessionId, token: credentials.displayToken });
const bearer = token => ({ Authorization: `Bearer ${token}` });
const revoke = (f, session, id, token) => fetch(`${f.base}/api/sessions/${session.sessionId}/displays/${id}`, {
  method: 'DELETE', headers: token ? bearer(token) : {},
});

test('three displays use the same code and receive commands and uploads exactly once within their room', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const other = await f.createSession();
  const otherOwner = await f.connectController(other);
  const outsider = await pair(f, otherOwner, other.pairingCode);
  const displays = [];
  const code = session.pairingCode;
  for (let index = 0; index < 3; index++) {
    const paired = await pair(f, owner, code);
    displays.push(paired);
    assert.equal(paired.state.count, index + 1);
    assert.equal(paired.state.maxDisplays, 5);
    assert.equal(paired.state.displays.length, index + 1);
    assert.equal(paired.pairing.pairingCode, code);
    assert.equal(paired.pairing.expiresAt, session.expiresAt);
    assert.equal(f.sessionStore.authenticateDisplayIdentity(session.sessionId, paired.credentials.displayToken).display.id, paired.credentials.displayId);
    await assert.rejects(f.connect(auth(session, paired.credentials)), error => error.data.code === 'DISPLAY_OCCUPIED');
  }
  assert.equal(new Set(displays.map(item => item.credentials.displayToken)).size, 3);
  assert.equal(new Set(displays.map(item => item.credentials.displayId)).size, 3);
  await assert.rejects(f.connectController(session), error => error.data.code === 'CONTROLLER_OCCUPIED');
  const events = displays.map(() => ({ play: [], pause: [], timeupdate: [], volumeupdate: [], uploaded: [] }));
  const foreign = [];
  outsider.display.on('play', () => foreign.push('play'));
  outsider.display.on('file uploaded', () => foreign.push('upload'));
  displays.forEach(({ display }, index) => {
    for (const event of ['play', 'pause', 'timeupdate', 'volumeupdate']) display.on(event, value => events[index][event].push(value));
    display.on('file uploaded', value => events[index].uploaded.push(value));
  });
  const volume = displays.map(({ display }) => once(display, 'volumeupdate'));
  owner.emit('player start');
  owner.emit('player pause');
  owner.emit('player timeupdate', 12);
  owner.emit('player volumeupdate', 0.4);
  await Promise.all(volume);
  const bytes = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
  const form = new FormData();
  form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'fixture.mp4');
  const notices = displays.map(({ display }) => once(display, 'file uploaded'));
  const response = await fetch(`${f.base}/upload?sessionId=${session.sessionId}`, { method: 'POST', headers: bearer(session.ownerToken), body: form });
  assert.equal(response.status, 201);
  const media = await response.json();
  await Promise.all(notices);
  // Socket fences ensure every preceding room event was processed before checking duplicates.
  const fences = displays.map(({ display }) => once(display, 'timeupdate'));
  const foreignFence = once(outsider.display, 'timeupdate');
  owner.emit('player timeupdate', 13);
  otherOwner.emit('player timeupdate', 99);
  await Promise.all([...fences, foreignFence]);
  for (const seen of events) assert.deepEqual(seen, { play: [undefined], pause: [undefined], timeupdate: [12, 13], volumeupdate: [0.4], uploaded: [media] });
  assert.deepEqual(foreign, []);
  for (const { credentials } of displays) {
    const download = await fetch(f.base + media.url, { headers: bearer(credentials.displayToken) });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  }
  const state = f.sessionStore.sessions.get(session.sessionId);
  for (const display of state.displays.values()) assert.deepEqual(Object.keys(display).sort(), ['id', 'socketId']);
});

test('reserved display slots, owner-only revocation and reconnect preserve other identities', async t => {
  const f = await fixture(t, { sessionOptions: { maxDisplays: 2, maxPairingAttempts: 20 } });
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const first = await pair(f, owner, session.pairingCode);
  const second = await pair(f, owner, first.pairing.pairingCode);
  const pending = await f.connect();
  let error = once(pending, 'session error');
  pending.emit('connectToMaster', second.pairing.pairingCode);
  assert.equal((await error)[0].code, 'DISPLAY_LIMIT');
  const count = once(owner, 'updatePuppets');
  await disconnect(f, first.display);
  const [state] = await count;
  assert.equal(state.count, 1);
  assert.deepEqual(state.displays, [{ displayId: first.credentials.displayId, connected: false }, { displayId: second.credentials.displayId, connected: true }]);
  const stillConnected = once(second.display, 'pause');
  owner.emit('player pause');
  await stillConnected;
  error = once(pending, 'session error');
  pending.emit('connectToMaster', second.pairing.pairingCode);
  assert.equal((await error)[0].code, 'DISPLAY_LIMIT');
  const resumed = await f.connect(auth(session, first.credentials));
  assert.equal(f.sessionStore.authenticateDisplayIdentity(session.sessionId, first.credentials.displayToken).display.socketId, resumed.id);
  const other = await f.createSession();
  for (const token of [undefined, 'wrong', other.ownerToken, first.credentials.displayToken, second.credentials.displayToken]) {
    assert.equal((await revoke(f, session, first.credentials.displayId, token)).status, 401);
  }
  const disconnected = once(resumed, 'disconnect');
  assert.equal((await revoke(f, session, first.credentials.displayId, session.ownerToken)).status, 204);
  await disconnected;
  assert.equal((await revoke(f, session, first.credentials.displayId, session.ownerToken)).status, 404);
  await assert.rejects(f.connect(auth(session, first.credentials)), error => error.data.code === 'UNAUTHORIZED');
  assert.throws(() => f.sessionStore.authenticateDisplay(session.sessionId, first.credentials.displayToken), error => error.code === 'UNAUTHORIZED');
  const replacement = await pair(f, owner, second.pairing.pairingCode, pending);
  assert.notEqual(replacement.credentials.displayId, first.credentials.displayId);
  assert.equal(replacement.state.count, 2);
  assert.equal(replacement.state.displays.length, 2);
  const received = [once(second.display, 'pause'), once(replacement.display, 'pause')];
  owner.emit('player pause');
  await Promise.all(received);
});

test('pairing again in the same session rotates only that display token without consuming another slot', async t => {
  const f = await fixture(t, { sessionOptions: { maxDisplays: 1 } });
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const first = await pair(f, owner, session.pairingCode);
  const freshCode = f.sessionStore.rotatePairing(f.sessionStore.sessions.get(session.sessionId)).pairingCode;
  const repaired = await pair(f, owner, freshCode, first.display);
  assert.equal(repaired.credentials.displayId, first.credentials.displayId);
  assert.notEqual(repaired.credentials.displayToken, first.credentials.displayToken);
  assert.equal(repaired.state.count, 1);
  assert.equal(repaired.state.displays.length, 1);
  assert.throws(() => f.sessionStore.authenticateDisplay(session.sessionId, first.credentials.displayToken), error => error.code === 'UNAUTHORIZED');
  assert.equal(f.sessionStore.authenticateDisplay(session.sessionId, repaired.credentials.displayToken).displays.size, 1);
});

test('late disconnect from an old display cannot clear a resumed identity or affect sibling displays', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const first = await pair(f, owner, session.pairingCode);
  const second = await pair(f, owner, first.pairing.pairingCode);
  const identity = f.sessionStore.authenticateDisplayIdentity(session.sessionId, first.credentials.displayToken).display;
  // Model a replacement transport before the old transport reports its disconnect.
  identity.socketId = null;
  const current = await f.connect(auth(session, first.credentials));
  const rejected = once(first.display, 'session error');
  first.display.emit('connectToMaster', first.pairing.pairingCode);
  assert.equal((await rejected)[0].code, 'FORBIDDEN');
  await disconnect(f, first.display);
  assert.equal(identity.socketId, current.id);
  assert.equal(f.sessionStore.authenticateDisplayIdentity(session.sessionId, second.credentials.displayToken).display.socketId, second.display.id);
  const delivered = [once(current, 'pause'), once(second.display, 'pause')];
  owner.emit('player pause');
  await Promise.all(delivered);
});
