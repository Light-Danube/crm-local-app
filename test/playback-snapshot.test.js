const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { fixture, once } = require('./helpers');

async function connectSnapshot(t, f, auth) {
  const socket = io(`${f.base}/playerControls`, { auth, transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false });
  t.after(() => socket.disconnect());
  const snapshot = once(socket, 'state snapshot');
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  socket.connect();
  await connected;
  return { socket, snapshot: (await snapshot)[0] };
}
async function pair(f, code) {
  const display = await f.connect();
  const paired = once(display, 'masterConnected');
  const snapshot = once(display, 'state snapshot');
  display.emit('connectToMaster', code);
  return { display, credentials: (await paired)[0], snapshot: (await snapshot)[0] };
}
async function disconnect(f, socket) {
  const serverSocket = f.io.of('/playerControls').sockets.get(socket.id);
  const disconnected = once(serverSocket, 'disconnect');
  socket.disconnect();
  await disconnected;
}
function auth(session, role = 'controller', token = session.ownerToken) {
  return { role, sessionId: session.sessionId, token };
}

function upload(f, session) {
  const form = new FormData();
  form.append('video', new Blob([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')], { type: 'video/mp4' }), 'test.mp4');
  return fetch(`${f.base}/upload?sessionId=${session.sessionId}`, {
    method: 'POST', headers: { authorization: `Bearer ${session.ownerToken}` }, body: form,
  });
}

test('controller and paired displays restore canonical elapsed playback and effects at latest revision', async t => {
  let clock = 1000;
  const f = await fixture(t, { playbackNow: () => clock });
  const session = await f.createSession();
  const owner = await connectSnapshot(t, f, auth(session));
  assert.deepEqual(owner.snapshot, {
    sessionId: session.sessionId, media: null, time: 0, paused: true, volume: 1,
    effects: { loop: false, inversion: false, color: false, details: false, background: false }, revision: 0,
  });
  const first = await pair(f, session.pairingCode);
  assert.deepEqual(first.snapshot, owner.snapshot);
  const commands = [
    ['video url', 'https://youtu.be/dQw4w9WgXcQ', 'video url'],
    ['player timeupdate', 12, 'timeupdate'], ['player volumeupdate', 0.3, 'volumeupdate'],
    ['toggle loop', true, 'loop status'], ['toggle inversion', true, 'inversion status'],
    ['optimize color', true, 'color optimization status'], ['toggle enhance details', true, 'enhance details status'],
    ['toggle back details', true, 'background optimization status'], ['player start', undefined, 'play'],
  ];
  for (const [event, value, delivered] of commands) {
    const pending = once(first.display, delivered);
    if (value === undefined) owner.socket.emit(event);
    else owner.socket.emit(event, value);
    await pending;
  }
  clock += 2500;
  const code = f.sessionStore.rotatePairing(f.sessionStore.sessions.get(session.sessionId)).pairingCode;
  const later = await pair(f, code);
  assert.equal(later.snapshot.time, 14.5);
  assert.equal(later.snapshot.paused, false);
  assert.equal(later.snapshot.revision, 9);
  assert.equal(later.snapshot.volume, 0.3);
  assert.deepEqual(later.snapshot.media, { kind: 'youtube', url: '/youtube/dQw4w9WgXcQ' });
  assert.deepEqual(Object.values(later.snapshot.effects), [true, true, true, true, true]);

  await disconnect(f, first.display);
  clock += 1000;
  const recovered = await connectSnapshot(t, f, auth(session, 'display', first.credentials.displayToken));
  assert.equal(recovered.snapshot.time, 15.5);
  assert.equal(recovered.snapshot.revision, 9);
  const paused = once(recovered.socket, 'pause');
  owner.socket.emit('player pause');
  await paused;
  clock += 3000;
  await disconnect(f, owner.socket);
  const ownerAgain = await connectSnapshot(t, f, auth(session));
  assert.equal(ownerAgain.snapshot.time, 15.5);
  assert.equal(ownerAgain.snapshot.paused, true);
  assert.equal(ownerAgain.snapshot.revision, 10);
  const repeated = once(later.display, 'state snapshot');
  later.display.emit('connectToMaster', code);
  assert.deepEqual((await repeated)[0], ownerAgain.snapshot);
});

test('upload persists latest media while owner is offline and notifies every current display exactly once', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const first = await pair(f, session.pairingCode);
  const stored = f.sessionStore.sessions.get(session.sessionId);
  const second = await pair(f, f.sessionStore.rotatePairing(stored).pairingCode);
  const seen = [[], []];
  first.display.on('file uploaded', media => seen[0].push(media));
  second.display.on('file uploaded', media => seen[1].push(media));
  await disconnect(f, owner);
  const delivered = [once(first.display, 'file uploaded'), once(second.display, 'file uploaded')];
  const response = await upload(f, session);
  assert.equal(response.status, 201);
  const media = await response.json();
  assert.deepEqual(await Promise.all(delivered), [[media], [media]]);
  const recovered = await connectSnapshot(t, f, auth(session));
  assert.deepEqual(recovered.snapshot.media, { kind: 'local', url: media.url, mediaId: media.mediaId });
  assert.equal(recovered.snapshot.revision, 1);
  assert.equal(recovered.snapshot.time, 0);
  assert.equal(recovered.snapshot.paused, true);
  const later = await pair(f, f.sessionStore.rotatePairing(stored).pairingCode);
  assert.deepEqual(later.snapshot, recovered.snapshot);
  assert.deepEqual(seen, [[media], [media]]);
});

test('invalid media URL, unauthorized display and stale controller cannot alter canonical state', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const owner = await f.connectController(session);
  const paired = await pair(f, session.pairingCode);
  const stored = f.sessionStore.sessions.get(session.sessionId);
  const before = stored.playback.snapshot();
  const relayed = [];
  paired.display.on('video url', value => relayed.push(value));
  const invalid = once(owner, 'session error');
  owner.emit('video url', 'https://evil.example/watch?v=dQw4w9WgXcQ');
  assert.equal((await invalid)[0].code, 'INVALID_VIDEO_URL');
  const forbidden = once(paired.display, 'session error');
  paired.display.emit('player timeupdate', 33);
  assert.equal((await forbidden)[0].code, 'FORBIDDEN');
  stored.controllerSocketId = null;
  const current = await connectSnapshot(t, f, auth(session));
  const stale = once(owner, 'session error');
  owner.emit('player start');
  assert.equal((await stale)[0].code, 'FORBIDDEN');
  assert.deepEqual(stored.playback.snapshot(), before);
  assert.deepEqual(current.snapshot, { sessionId: session.sessionId, ...before });
  const fence = once(paired.display, 'volumeupdate');
  current.socket.emit('player volumeupdate', 1);
  await fence;
  assert.deepEqual(relayed, []);
});

test('fresh server instance rejects owner and display credentials from previous server', async t => {
  const old = await fixture(t);
  const session = await old.createSession();
  await old.connectController(session);
  const paired = await pair(old, session.pairingCode);
  const restarted = await fixture(t);
  for (const identity of [auth(session), auth(session, 'display', paired.credentials.displayToken)]) {
    await assert.rejects(restarted.connect(identity), error => error.data?.code === 'UNAUTHORIZED');
  }
});
