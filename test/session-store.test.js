'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore } = require('../lib/session-store');

const fails = (fn, code) => assert.throws(fn, error => error.code === code && typeof error.message === 'string');

function clocked(options = {}) {
  let time = 1000;
  return { store: createSessionStore({ now: () => time, ...options }), advance: ms => { time += ms; } };
}

test('server identities, role tokens and pairing codes are unique and contain no plaintext stored tokens', () => {
  const store = createSessionStore();
  const created = Array.from({ length: 100 }, () => store.create());
  for (const key of ['sessionId', 'ownerToken', 'pairingCode']) {
    assert.equal(new Set(created.map(item => item[key])).size, created.length);
  }
  for (const item of created) {
    assert.match(item.pairingCode, /^\d{6}$/);
    assert.ok(item.ownerToken.length >= 43);
    assert.equal(item.session.controllerSocketId, null);
    assert.equal(item.session.displays.size, 0);
    assert.equal(store.authenticateOwner(item.sessionId, item.ownerToken), item.session);
    assert.ok(!JSON.stringify([...store.sessions]).includes(item.ownerToken));
  }
});

test('tokens authenticate only their session and role; malformed auth has a fixed safe error', () => {
  const store = createSessionStore();
  const one = store.create();
  const two = store.create();
  const display = store.pair(one.pairingCode, 'ip-one');
  assert.equal(store.authenticateDisplay(one.sessionId, display.displayToken), one.session);
  for (const token of [undefined, null, {}, '', 'x'.repeat(129), two.ownerToken, display.displayToken]) {
    fails(() => store.authenticateOwner(one.sessionId, token), 'UNAUTHORIZED');
  }
  fails(() => store.authenticateDisplay(one.sessionId, one.ownerToken), 'UNAUTHORIZED');
  fails(() => store.authenticateDisplay(two.sessionId, display.displayToken), 'UNAUTHORIZED');
  fails(() => store.authenticateOwner('unknown', one.ownerToken), 'UNAUTHORIZED');
  fails(() => store.authenticateDisplay(one.sessionId, one.ownerToken), 'UNAUTHORIZED');
});

test('pairing expires exactly at TTL without expiring owner authentication', () => {
  const { store, advance } = clocked({ pairingTtlMs: 100 });
  const one = store.create();
  const two = store.create();
  advance(99);
  assert.equal(store.pair(one.pairingCode, 'ip-one').session, one.session);
  advance(1);
  fails(() => store.pair(two.pairingCode, 'ip-two'), 'INVALID_PAIRING_CODE');
  assert.equal(store.authenticateOwner(two.sessionId, two.ownerToken), two.session);
});

test('one code admits independent displays until original TTL; owner rotation invalidates it', () => {
  const { store, advance } = clocked({ pairingTtlMs: 100 });
  const created = store.create();
  const old = created.pairingCode;
  advance(50);
  const rotated = store.rotatePairing(created.session);
  assert.notEqual(rotated.pairingCode, old);
  assert.equal(rotated.expiresAt, 1150);
  fails(() => store.pair(old, 'ip-one'), 'INVALID_PAIRING_CODE');
  advance(99);
  const paired = store.pair(rotated.pairingCode, 'ip-one');
  const sibling = store.pair(rotated.pairingCode, 'ip-two');
  assert.notEqual(sibling.displayToken, paired.displayToken);
  assert.equal(sibling.pairing.expiresAt, rotated.expiresAt);
  advance(1);
  fails(() => store.pair(rotated.pairingCode, 'ip-three'), 'INVALID_PAIRING_CODE');
  const next = store.rotatePairing(created.session);
  const replaced = store.pair(next.pairingCode, 'ip-two');
  assert.equal(store.authenticateDisplay(created.sessionId, paired.displayToken), created.session);
  assert.equal(store.authenticateDisplay(created.sessionId, replaced.displayToken), created.session);
  fails(() => store.rotatePairing({ id: created.sessionId }), 'UNAUTHORIZED');
});

test('admission rejects duplicate displays without consuming the code or replacing display credentials', () => {
  const store = createSessionStore();
  const created = store.create();
  const first = store.pair(created.pairingCode, 'ip-one');
  const next = store.rotatePairing(created.session);
  fails(() => store.pair(next.pairingCode, 'ip-two', session => {
    assert.equal(session, created.session);
    return false;
  }), 'DISPLAY_OCCUPIED');
  assert.equal(store.authenticateDisplay(created.sessionId, first.displayToken), created.session);
  assert.equal(store.pair(next.pairingCode, 'ip-two').session, created.session);
});

test('five attempts per IP across codes, including successful attempts; window resets at boundary', () => {
  const { store, advance } = clocked();
  const created = store.create();
  store.pair(created.pairingCode, 'attacker');
  for (const code of ['000000', '000001', null, {}]) {
    fails(() => store.pair(code, 'attacker'), 'INVALID_PAIRING_CODE');
  }
  const next = store.rotatePairing(created.session);
  fails(() => store.pair(next.pairingCode, 'attacker'), 'RATE_LIMITED');
  advance(59_999);
  fails(() => store.pair(next.pairingCode, 'attacker'), 'RATE_LIMITED');
  advance(1);
  assert.equal(store.pair(next.pairingCode, 'attacker').session, created.session);
});

test('attempt tracking is bounded and fails closed without evicting live counters, then cleans expired entries', () => {
  const { store, advance } = clocked({ maxTrackedAttempts: 2, maxPairingAttempts: 1, attemptWindowMs: 100 });
  fails(() => store.pair('000000', 'one'), 'INVALID_PAIRING_CODE');
  advance(50);
  fails(() => store.pair('000000', 'two'), 'INVALID_PAIRING_CODE');
  fails(() => store.pair('000000', 'three'), 'RATE_LIMITED');
  fails(() => store.pair('000000', 'one'), 'RATE_LIMITED');
  advance(50);
  fails(() => store.pair('000000', 'three'), 'INVALID_PAIRING_CODE');
  fails(() => store.pair('000000', 'two'), 'RATE_LIMITED');
  for (const key of [undefined, null, {}, '', 'x'.repeat(256)]) {
    fails(() => store.pair('000000', key), 'RATE_LIMITED');
  }
});

test('session capacity and injected limits bound allocation', () => {
  const store = createSessionStore({ maxSessions: 1 });
  store.create();
  fails(() => store.create(), 'SESSION_LIMIT');
  assert.equal(store.sessions.size, 1);
  for (const name of ['pairingTtlMs', 'maxSessions', 'maxDisplays', 'maxPairingAttempts', 'attemptWindowMs', 'maxTrackedAttempts', 'idleTtlMs']) {
    for (const value of [0, -1, 1.5, Infinity]) {
      assert.throws(() => createSessionStore({ [name]: value }), TypeError);
    }
  }
});

test('idle sessions expire at the boundary, deleting owner/display credentials and pairing codes', () => {
  const { store, advance } = clocked({ idleTtlMs: 100, pairingTtlMs: 1000 });
  const owner = store.create();
  const display = store.pair(owner.pairingCode, 'display');
  const next = store.rotatePairing(owner.session);
  advance(99);
  assert.equal(store.cleanupIdle(), 0);
  advance(1);
  assert.equal(store.cleanupIdle(), 1);
  assert.equal(store.sessions.size, 0);
  fails(() => store.authenticateOwner(owner.sessionId, owner.ownerToken), 'UNAUTHORIZED');
  fails(() => store.authenticateDisplay(owner.sessionId, display.displayToken), 'UNAUTHORIZED');
  fails(() => store.pair(next.pairingCode, 'display'), 'INVALID_PAIRING_CODE');
  assert.equal(store.remove(owner.session), false);
  fails(() => store.touch(owner.session), 'UNAUTHORIZED');
});

test('active sockets never expire and disconnect touch starts a fresh idle interval', () => {
  const { store, advance } = clocked({ idleTtlMs: 100 });
  const owner = store.create();
  owner.session.controllerSocketId = 'controller';
  advance(1000);
  assert.equal(store.cleanupIdle(), 0);
  owner.session.controllerSocketId = null;
  owner.session.displays.set('display', { id: 'display', socketId: 'display' });
  advance(1000);
  assert.equal(store.cleanupIdle(), 0);
  owner.session.displays.get('display').socketId = null;
  store.touch(owner.session);
  advance(99);
  assert.equal(store.cleanupIdle(), 0);
  assert.equal(store.authenticateOwner(owner.sessionId, owner.ownerToken), owner.session);
  advance(99);
  assert.equal(store.cleanupIdle(), 0);
  advance(1);
  assert.equal(store.cleanupIdle(), 1);
});

test('create, authentication and pairing reclaim idle sessions without expiring active ones', () => {
  for (const operation of ['create', 'authenticate', 'pair']) {
    const { store, advance } = clocked({ idleTtlMs: 100, pairingTtlMs: 1000, maxSessions: 2 });
    const idle = store.create();
    const active = store.create();
    active.session.controllerSocketId = 'controller';
    advance(100);
    if (operation === 'create') store.create();
    if (operation === 'authenticate') store.authenticateOwner(active.sessionId, active.ownerToken);
    if (operation === 'pair') store.pair(active.pairingCode, 'display');
    assert.equal(store.sessions.has(idle.sessionId), false);
    assert.equal(store.sessions.has(active.sessionId), true);
  }
});
