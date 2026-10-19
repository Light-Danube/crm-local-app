'use strict';

const { createHash, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');

const digest = token => createHash('sha256').update(token).digest();
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// All state is process-local. TTLs are milliseconds; now() returns epoch milliseconds.
function createSessionStore({
  now = Date.now,
  pairingTtlMs = 5 * 60_000,
  maxSessions = 1000,
  maxDisplays = 5,
  maxPairingAttempts = 5,
  attemptWindowMs = 60_000,
  maxTrackedAttempts = 10_000,
  idleTtlMs = 30 * 60_000,
} = {}) {
  for (const value of [pairingTtlMs, maxSessions, maxDisplays, maxPairingAttempts, attemptWindowMs, maxTrackedAttempts, idleTtlMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Session limits must be positive safe integers');
  }
  if (maxSessions >= 1_000_000) throw new TypeError('Session capacity must leave space for pairing rotation');
  const sessions = new Map();
  const credentials = new Map();
  const pairings = new Map();
  const attempts = new Map();

  function remove(session) {
    if (sessions.get(session?.id) !== session) return false;
    sessions.delete(session.id);
    credentials.delete(session.id);
    for (const [code, owner] of pairings) if (owner === session) pairings.delete(code);
    return true;
  }

  function touch(session) {
    if (sessions.get(session?.id) !== session) throw failure('UNAUTHORIZED', 'Invalid session credentials');
    session.touchedAt = now();
  }

  function cleanupIdle(time = now()) {
    let removed = 0;
    for (const session of sessions.values()) {
      if (!session.controllerSocketId && ![...session.displays.values()].some(display => display.socketId) && time - session.touchedAt >= idleTtlMs) {
        if (remove(session)) removed++;
      }
    }
    return removed;
  }

  function cleanup(time) {
    cleanupIdle(time);
    for (const [key, entry] of attempts) if (time >= entry.expiresAt) attempts.delete(key);
    for (const [code, session] of pairings) if (time >= session.expiresAt) pairings.delete(code);
  }

  function rateLimit(key, time) {
    if (typeof key !== 'string' || !key || key.length > 255) {
      throw failure('RATE_LIMITED', 'Pairing is temporarily unavailable');
    }
    let entry = attempts.get(key);
    if (!entry) {
      // Do not evict live counters: an attacker could otherwise reset another IP's limit.
      if (attempts.size >= maxTrackedAttempts) throw failure('RATE_LIMITED', 'Pairing is temporarily unavailable');
      entry = { count: 0, expiresAt: time + attemptWindowMs };
      attempts.set(key, entry);
    }
    if (entry.count >= maxPairingAttempts) throw failure('RATE_LIMITED', 'Too many pairing attempts');
    entry.count += 1;
  }

  function rotatePairing(session) {
    cleanup(now());
    if (sessions.get(session?.id) !== session) throw failure('UNAUTHORIZED', 'Invalid session credentials');
    touch(session);
    pairings.delete(session.pairingCode);
    // Six decimal digits include leading zeroes. Unexpired codes are globally unique.
    let pairingCode;
    do { pairingCode = String(randomInt(1_000_000)).padStart(6, '0'); }
    while (pairings.has(pairingCode) || pairingCode === session.pairingCode);
    session.pairingCode = pairingCode;
    session.expiresAt = now() + pairingTtlMs;
    pairings.set(pairingCode, session);
    return { pairingCode, expiresAt: session.expiresAt };
  }

  function create() {
    cleanup(now());
    if (sessions.size >= maxSessions) throw failure('SESSION_LIMIT', 'Session capacity reached');
    let sessionId;
    do { sessionId = randomBytes(24).toString('base64url'); } while (sessions.has(sessionId));
    const ownerToken = randomBytes(32).toString('base64url');
    const session = { id: sessionId, controllerSocketId: null, displays: new Map(), touchedAt: now() };
    sessions.set(sessionId, session);
    credentials.set(sessionId, { owner: digest(ownerToken), displays: new Map() });
    const pairing = rotatePairing(session);
    return { session, sessionId, ownerToken, ...pairing };
  }

  function authenticate(sessionId, token, role) {
    cleanup(now());
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    const expected = session && credentials.get(sessionId)[role];
    if (!expected || typeof token !== 'string' || token.length > 128 ||
        !timingSafeEqual(expected, digest(token))) {
      throw failure('UNAUTHORIZED', 'Invalid session credentials');
    }
    touch(session);
    return session;
  }

  function authenticateDisplayIdentity(sessionId, token) {
    cleanup(now());
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (session && typeof token === 'string' && token.length <= 128) {
      const hash = digest(token);
      for (const [displayId, expected] of credentials.get(sessionId).displays) {
        if (timingSafeEqual(expected, hash)) {
          touch(session);
          return { session, display: session.displays.get(displayId) };
        }
      }
    }
    throw failure('UNAUTHORIZED', 'Invalid session credentials');
  }

  function revokeDisplay(session, displayId) {
    touch(session);
    const display = session.displays.get(displayId);
    if (!display) return null;
    session.displays.delete(displayId);
    credentials.get(session.id).displays.delete(displayId);
    return display;
  }

  // Admission runs before credential creation; joining does not extend the code TTL.
  function pair(code, attemptKey, admission = () => true, existingDisplay) {
    const time = now();
    cleanup(time);
    rateLimit(attemptKey, time);
    const session = typeof code === 'string' && /^\d{6}$/.test(code) ? pairings.get(code) : undefined;
    if (!session) throw failure('INVALID_PAIRING_CODE', 'Invalid or expired pairing code');
    if (!admission(session)) throw failure('DISPLAY_OCCUPIED', 'A display is already connected');
    const reuse = existingDisplay && session.displays.get(existingDisplay.id) === existingDisplay;
    if (!reuse && session.displays.size >= maxDisplays) throw failure('DISPLAY_LIMIT', 'Display capacity reached');
    const displayToken = randomBytes(32).toString('base64url');
    let displayId = reuse ? existingDisplay.id : undefined;
    if (!reuse) {
      do { displayId = randomBytes(24).toString('base64url'); } while (session.displays.has(displayId));
    }
    const display = reuse ? existingDisplay : { id: displayId, socketId: null };
    session.displays.set(displayId, display);
    credentials.get(session.id).displays.set(displayId, digest(displayToken));
    touch(session);
    const pairing = { pairingCode: session.pairingCode, expiresAt: session.expiresAt };
    return { session, sessionId: session.id, display, displayId, displayToken, pairing };
  }

  // sessions contains mutable socket metadata, never plaintext role tokens or token hashes.
  return {
    create, pair, rotatePairing, sessions, touch, remove, cleanupIdle, maxDisplays, revokeDisplay, authenticateDisplayIdentity,
    clear() { sessions.clear(); credentials.clear(); pairings.clear(); attempts.clear(); },
    authenticateOwner: (id, token) => authenticate(id, token, 'owner'),
    authenticateDisplay: (id, token) => authenticateDisplayIdentity(id, token).session,
  };
}

module.exports = { createSessionStore };
