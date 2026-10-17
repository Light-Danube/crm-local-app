const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, once } = require('./helpers');

async function join(display, code) {
  const pending = once(display, 'masterConnected');
  display.emit('connectToMaster', code);
  return (await pending)[0];
}

async function disconnect(f, socket) {
  const serverSocket = f.io.of('/playerControls').sockets.get(socket.id);
  const pending = once(serverSocket, 'disconnect');
  socket.disconnect();
  await pending;
}

test('20 pairing, idempotent join, switch and disconnect cycles leave no stale rooms or deliveries', async t => {
  const f = await fixture(t, { sessionOptions: { maxPairingAttempts: 100, maxDisplays: 40 } });
  const first = await f.createSession();
  const second = await f.createSession();
  const firstOwner = await f.connectController(first);
  const secondOwner = await f.connectController(second);
  const controls = f.io.of('/playerControls');
  for (let cycle = 0; cycle < 20; cycle++) {
    const firstSession = f.sessionStore.sessions.get(first.sessionId);
    const secondSession = f.sessionStore.sessions.get(second.sessionId);
    const firstCode = f.sessionStore.rotatePairing(firstSession).pairingCode;
    const secondCode = f.sessionStore.rotatePairing(secondSession).pairingCode;
    const display = await f.connect();
    const serverDisplay = controls.sockets.get(display.id);
    let count = once(firstOwner, 'updatePuppets');
    const credentials = await join(display, firstCode);
    assert.equal((await count)[0].count, 1);
    for (let repeat = 0; repeat < 2; repeat++) {
      count = once(firstOwner, 'updatePuppets');
      assert.deepEqual(await join(display, firstCode), { sessionId: first.sessionId, displayId: credentials.displayId });
      assert.equal((await count)[0].count, 1);
    }
    assert.equal(f.sessionStore.authenticateDisplay(first.sessionId, credentials.displayToken), firstSession);
    assert.deepEqual([...serverDisplay.rooms].sort(), [display.id, first.sessionId].sort());

    const left = once(firstOwner, 'updatePuppets');
    const entered = once(secondOwner, 'updatePuppets');
    const switched = await join(display, secondCode);
    assert.equal(switched.sessionId, second.sessionId);
    assert.equal((await left)[0].count, 0);
    assert.equal((await entered)[0].count, 1);
    assert.equal(firstSession.displays.get(credentials.displayId).socketId, null);
    assert.equal(secondSession.displays.get(switched.displayId).socketId, display.id);
    assert.equal(controls.adapter.rooms.has(first.sessionId), false);
    assert.deepEqual([...serverDisplay.rooms].sort(), [display.id, second.sessionId].sort());
    assert.equal(f.sessionStore.authenticateDisplay(first.sessionId, credentials.displayToken), firstSession);
    assert.equal(f.io.of('/').adapter.rooms.has(first.sessionId), false);

    const pauses = [];
    display.on('pause', () => pauses.push('pause'));
    firstOwner.emit('player pause');
    const fence = once(display, 'timeupdate');
    secondOwner.emit('player timeupdate', cycle);
    assert.deepEqual(await fence, [cycle]);
    assert.deepEqual(pauses, []);
    const exited = once(secondOwner, 'updatePuppets');
    const displayId = display.id;
    await disconnect(f, display);
    assert.equal((await exited)[0].count, 0);
    assert.equal(secondSession.displays.get(switched.displayId).socketId, null);
    assert.equal(controls.adapter.rooms.has(second.sessionId), false);
    assert.equal(controls.adapter.rooms.has(displayId), false);
    assert.equal(serverDisplay.rooms.size, 0);
  }
});

test('failed switch preserves existing room and credentials; revoking a disconnected target releases capacity', async t => {
  const f = await fixture(t, { sessionOptions: { maxPairingAttempts: 100, maxDisplays: 1 } });
  const first = await f.createSession();
  const second = await f.createSession();
  const owner = await f.connectController(first);
  await f.connectController(second);
  const display = await f.connect();
  const occupied = await f.connect();
  const credentials = await join(display, first.pairingCode);
  const occupiedCredentials = await join(occupied, second.pairingCode);
  const code = f.sessionStore.rotatePairing(f.sessionStore.sessions.get(second.sessionId)).pairingCode;
  const rejected = once(display, 'session error');
  display.emit('connectToMaster', code);
  assert.equal((await rejected)[0].code, 'DISPLAY_LIMIT');
  assert.equal(f.sessionStore.authenticateDisplayIdentity(first.sessionId, credentials.displayToken).display.socketId, display.id);
  assert.ok(f.io.of('/playerControls').sockets.get(display.id).rooms.has(first.sessionId));
  const delivered = once(display, 'pause');
  owner.emit('player pause');
  await delivered;
  await disconnect(f, occupied);
  const revoked = await fetch(`${f.base}/api/sessions/${second.sessionId}/displays/${occupiedCredentials.displayId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${second.ownerToken}` } });
  assert.equal(revoked.status, 204);
  assert.equal((await join(display, code)).sessionId, second.sessionId);
});

test('late disconnect from an old controller cannot clear a newer authenticated owner', async t => {
  const f = await fixture(t);
  const credentials = await f.createSession();
  const old = await f.connectController(credentials);
  const session = f.sessionStore.sessions.get(credentials.sessionId);
  // Model transport replacement before an old transport delivers its disconnect.
  session.controllerSocketId = null;
  const current = await f.connectController(credentials);
  const forbidden = once(old, 'session error');
  old.emit('player pause');
  assert.equal((await forbidden)[0].code, 'FORBIDDEN');
  await disconnect(f, old);
  assert.equal(session.controllerSocketId, current.id);
  const display = await f.connect();
  await join(display, credentials.pairingCode);
  const delivered = once(display, 'pause');
  current.emit('player pause');
  await delivered;
});
