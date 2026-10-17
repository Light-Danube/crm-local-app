const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdir } = require('node:fs/promises');
const { fixture, once } = require('./helpers');

const bytes = Buffer.concat([
  Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'),
  Buffer.from('disposable signed media fixture; exact byte comparison'),
]);
const bearer = token => ({ authorization: `Bearer ${token}` });

function upload(f, sessionId, token) {
  const form = new FormData();
  form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'client-chosen.mp4');
  return fetch(`${f.base}/upload?sessionId=${sessionId}`, {
    method: 'POST', body: form, headers: token ? bearer(token) : {},
  });
}

async function paired(f) {
  const session = await f.createSession();
  const controller = await f.connectController(session);
  const display = await f.connect();
  const pending = once(display, 'masterConnected');
  display.emit('connectToMaster', session.pairingCode);
  const [credentials] = await pending;
  return { session, controller, display, displayToken: credentials.displayToken };
}

test('anonymous, spoofed identity and display uploads authenticate before creating files', async t => {
  const f = await fixture(t);
  const { session, display, displayToken } = await paired(f);
  const notifications = [];
  display.on('file uploaded', media => notifications.push(media));
  for (const token of [undefined, 'wrong', displayToken]) {
    const response = await upload(f, session.sessionId, token);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
    assert.deepEqual(await readdir(f.mediaRoot), []);
  }
  const spoof = await fetch(`${f.base}/upload?userID=${session.sessionId}`, {
    method: 'POST', headers: bearer(session.ownerToken), body: 'benign request without a server session ID',
  });
  assert.equal(spoof.status, 401);
  assert.deepEqual(await readdir(f.mediaRoot), []);
  assert.deepEqual(notifications, []);
});

test('owner upload sends one notification to its display and preserves authorized download/range bytes', async t => {
  const f = await fixture(t);
  const owner = await paired(f);
  const other = await paired(f);
  const seen = { display: [], controller: [], other: [] };
  owner.display.on('file uploaded', media => seen.display.push(media));
  owner.controller.on('file uploaded', media => seen.controller.push(media));
  other.display.on('file uploaded', media => seen.other.push(media));
  const notification = once(owner.display, 'file uploaded');
  const response = await upload(f, owner.session.sessionId, owner.session.ownerToken);
  assert.equal(response.status, 201);
  const media = await response.json();
  assert.deepEqual(Object.keys(media).sort(), ['mediaId', 'mime', 'url']);
  assert.equal(media.mime, 'video/mp4');
  assert.notEqual(media.mediaId, 'client-chosen.mp4');
  assert.equal(media.url, `/media/${owner.session.sessionId}/${media.mediaId}`);
  assert.deepEqual(await notification, [media]);
  assert.deepEqual(await readdir(f.mediaRoot), [media.mediaId]);
  const fence = once(owner.display, 'timeupdate');
  owner.controller.emit('player timeupdate', 0);
  await fence;
  assert.deepEqual(seen, { display: [media], controller: [], other: [] });

  for (const token of [owner.session.ownerToken, owner.displayToken]) {
    const full = await fetch(f.base + media.url, { headers: bearer(token) });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const range = await fetch(f.base + media.url, { headers: { ...bearer(token), range: 'bytes=0-9' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-9/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 10));
    const head = await fetch(f.base + media.url, { method: 'HEAD', headers: bearer(token) });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), bytes.length);
  }
  for (const prefix of ['/uploads/', '/videofile/', '/video/']) {
    assert.equal((await fetch(f.base + prefix + media.mediaId)).status, 404);
  }
  assert.equal((await fetch(f.base + media.url)).status, 401);
  assert.equal((await fetch(f.base + media.url + '?token=' + owner.session.ownerToken)).status, 401);
  for (const token of [other.session.ownerToken, other.displayToken]) {
    assert.equal((await fetch(f.base + media.url, { headers: bearer(token) })).status, 401);
  }
  const wrongSessionUrl = `/media/${other.session.sessionId}/${media.mediaId}`;
  assert.equal((await fetch(f.base + wrongSessionUrl, { headers: bearer(other.session.ownerToken) })).status, 404);
});

test('owner and paired display obtain session-scoped HttpOnly media cookies; foreign credentials fail', async t => {
  const f = await fixture(t, { secureCookies: true });
  const owner = await paired(f);
  const other = await f.createSession();
  const uploaded = await upload(f, owner.session.sessionId, owner.session.ownerToken);
  assert.equal(uploaded.status, 201);
  const media = await uploaded.json();
  const accessUrl = `${f.base}/api/sessions/${owner.session.sessionId}/media-access`;
  assert.equal((await fetch(accessUrl, { method: 'POST' })).status, 401);
  assert.equal((await fetch(accessUrl, { method: 'POST', headers: bearer(other.ownerToken) })).status, 401);
  for (const token of [owner.session.ownerToken, owner.displayToken]) {
    const response = await fetch(accessUrl, { method: 'POST', headers: bearer(token) });
    assert.equal(response.status, 204);
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie.startsWith('mediaAccess='));
    assert.ok(cookie.includes(`Path=/media/${owner.session.sessionId}/;`));
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Strict(?:;|$)/);
    assert.match(cookie, /; Secure(?:;|$)/);
    const headers = { cookie: cookie.split(';')[0] };
    const download = await fetch(f.base + media.url, { headers });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const foreign = `/media/${other.sessionId}/${media.mediaId}`;
    assert.equal((await fetch(f.base + foreign, { headers })).status, 401);
    // A cookie must not authorize token issuance or an owner-only upload.
    assert.equal((await fetch(accessUrl, { method: 'POST', headers })).status, 401);
    const form = new FormData();
    form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'cookie-only.mp4');
    const cookieUpload = await fetch(`${f.base}/upload?sessionId=${owner.session.sessionId}`, { method: 'POST', headers, body: form });
    assert.equal(cookieUpload.status, 401);
  }
});
