const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');
const { fixture, once } = require('./helpers');

async function pair(f, session) {
  const display = await f.connect();
  const pending = once(display, 'masterConnected');
  display.emit('connectToMaster', session.pairingCode);
  const [credentials] = await pending;
  return { display, credentials };
}

async function forbidden(socket, event, ...args) {
  const pending = once(socket, 'session error');
  socket.emit(event, ...args);
  const [error] = await pending;
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal(error.event, event);
}

async function disconnect(f, socket) {
  const pending = once(f.io.of('/playerControls').sockets.get(socket.id), 'disconnect');
  socket.disconnect();
  await pending;
}

test('HTTP creates server identities and rotates pairing only for an authenticated owner', async t => {
  const f = await fixture(t, { sessionOptions: { maxSessions: 2 } });
  const session = await f.createSession();
  assert.deepEqual(Object.keys(session).sort(), ['expiresAt', 'ownerToken', 'pairingCode', 'sessionId']);
  assert.match(session.pairingCode, /^\d{6}$/);
  for (const token of [undefined, 'Bearer wrong', `Bearer ${session.ownerToken} extra`]) {
    const response = await fetch(`${f.base}/api/sessions/${session.sessionId}/pairing`, {
      method: 'POST', headers: token ? { authorization: token } : {},
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: 'UNAUTHORIZED', message: 'Invalid session credentials' } });
  }
  const second = await f.createSession();
  const wrongOwner = await fetch(`${f.base}/api/sessions/${session.sessionId}/pairing`, {
    method: 'POST', headers: { authorization: `Bearer ${second.ownerToken}` },
  });
  assert.equal(wrongOwner.status, 401);
  const response = await fetch(`${f.base}/api/sessions/${session.sessionId}/pairing`, {
    method: 'POST', headers: { authorization: `Bearer ${session.ownerToken}` },
  });
  assert.equal(response.status, 200);
  const rotated = await response.json();
  assert.notEqual(rotated.pairingCode, session.pairingCode);
  assert.equal(typeof rotated.expiresAt, 'number');
  const full = await fetch(f.base + '/api/sessions', { method: 'POST' });
  assert.equal(full.status, 503);
  assert.equal((await full.json()).error.code, 'SESSION_LIMIT');
});

test('anonymous, legacy identity spoof and display commands cannot control either session', async t => {
  const f = await fixture(t);
  const first = await f.createSession();
  const second = await f.createSession();
  const owner = await f.connectController(first);
  const otherOwner = await f.connectController(second);
  const { display } = await pair(f, first);
  const other = await pair(f, second);
  const stranger = await f.connect();
  const spoof = await f.connect({}, { query: { userID: first.sessionId } });
  const received = [];
  display.on('pause', () => received.push('first'));
  other.display.on('pause', () => received.push('second'));
  for (const attacker of [stranger, spoof, display, other.display]) {
    await forbidden(attacker, 'player pause');
    await forbidden(attacker, 'toggle inversion', true);
  }
  await forbidden(owner, 'connectToMaster', second.pairingCode);
  const seen = once(display, 'timeupdate');
  owner.emit('player timeupdate', 2);
  await seen;
  assert.deepEqual(received, []);
  const delivered = once(other.display, 'pause');
  otherOwner.emit('player pause');
  await delivered;
  assert.deepEqual(received, ['second']);
});

test('invalid tokens and duplicate sockets reject; only disconnected owners and displays resume', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const { display, credentials } = await pair(f, session);
  for (const auth of [
    { role: 'controller', sessionId: session.sessionId, token: 'wrong' },
    { role: 'display', sessionId: session.sessionId, token: session.ownerToken },
    { role: 'controller', sessionId: session.sessionId, token: credentials.displayToken },
    { role: 'controller', sessionId: 'missing', token: session.ownerToken },
    { userID: session.sessionId },
  ]) {
    await assert.rejects(f.connect(auth), error => error.data.code === 'UNAUTHORIZED');
  }
  await assert.rejects(f.connectController(session), error => error.data.code === 'CONTROLLER_OCCUPIED');
  const displayAuth = { role: 'display', sessionId: session.sessionId, token: credentials.displayToken };
  await assert.rejects(f.connect(displayAuth), error => error.data.code === 'DISPLAY_OCCUPIED');
  await disconnect(f, owner);
  const resumedOwner = await f.connectController(session);
  const pending = once(display, 'pause');
  resumedOwner.emit('player pause');
  await pending;
  const count = once(resumedOwner, 'updatePuppets');
  await disconnect(f, display);
  assert.deepEqual(await count, ['']);
  const resumedDisplay = await f.connect(displayAuth);
  const delivered = once(resumedDisplay, 'timeupdate');
  resumedOwner.emit('player timeupdate', 10);
  assert.deepEqual(await delivered, [10]);
  const logs = await readdir(f.logDirectory);
  const contents = (await Promise.all(logs.map(name => readFile(path.join(f.logDirectory, name), 'utf8')))).join('');
  for (const secret of [session.ownerToken, credentials.displayToken, session.pairingCode]) {
    assert.ok(!contents.includes(secret));
  }
});

test('pairing TTL and per-address rate limit apply to real Socket.IO clients', async t => {
  let now = 10_000;
  const f = await fixture(t, { sessionOptions: { now: () => now, pairingTtlMs: 1000, maxPairingAttempts: 1, attemptWindowMs: 2000 } });
  const session = await f.createSession();
  await f.connectController(session);
  const first = await f.connect({}, { extraHeaders: { 'x-forwarded-for': '192.0.2.1' } });
  now += 1000;
  const expired = once(first, 'session error');
  first.emit('connectToMaster', session.pairingCode);
  assert.equal((await expired)[0].code, 'INVALID_PAIRING_CODE');
  const refreshed = await fetch(`${f.base}/api/sessions/${session.sessionId}/pairing`, {
    method: 'POST', headers: { authorization: `Bearer ${session.ownerToken}` },
  });
  const { pairingCode } = await refreshed.json();
  const second = await f.connect({}, { extraHeaders: { 'x-forwarded-for': '192.0.2.2' } });
  const limited = once(second, 'session error');
  second.emit('connectToMaster', pairingCode);
  assert.equal((await limited)[0].code, 'RATE_LIMITED');
  now += 2000;
  const fresh = await fetch(`${f.base}/api/sessions/${session.sessionId}/pairing`, {
    method: 'POST', headers: { authorization: `Bearer ${session.ownerToken}` },
  });
  const active = await fresh.json();
  const paired = once(second, 'masterConnected');
  second.emit('connectToMaster', active.pairingCode);
  assert.equal((await paired)[0].sessionId, session.sessionId);
});
