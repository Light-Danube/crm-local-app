'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { createMediaService } = require('../lib/media-service');

const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), Buffer.from('benign fixture, not a decodable video')]);
const webm = Buffer.from('1a45dfa3874282847765626d', 'hex');
async function fixture(t, limits = {}, existing) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-service-'));
  if (existing) await fs.writeFile(path.join(root, 'existing.mp4'), existing);
  const notifications = [];
  const app = express();
  const media = createMediaService({ mediaRoot: root, limits, authenticate(req) {
    const token = req.get('authorization');
    if (!/^Bearer (owner|other)$/.test(token || '')) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
    return { id: token.slice(7) };
  }, notify: (session, file) => notifications.push({ session, file }) });
  app.post('/upload', media.upload);
  app.get('/media/:sessionId/:mediaId', media.serve);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await media.ready;
  async function upload(bytes = mp4, mime = 'video/mp4', token = 'owner', filename = '../../malicious.html') {
    const form = new FormData();
    form.append('video', new Blob([bytes], { type: mime }), filename);
    return fetch(base + '/upload', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  }
  return { root, base, upload, notifications, server };
}

test('authenticated upload uses opaque identity and downloads exact bytes and ranges', async t => {
  const f = await fixture(t);
  const response = await f.upload();
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const media = JSON.parse(body);
  assert.match(media.mediaId, /^[0-9a-f-]{36}\.mp4$/);
  assert.equal(media.mime, 'video/mp4');
  assert.deepEqual(await fs.readdir(f.root), [media.mediaId]);
  assert.equal(f.notifications.length, 1);
  const downloaded = await fetch(f.base + media.url, { headers: { authorization: 'Bearer owner' } });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'video/mp4');
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  assert.match(downloaded.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), mp4);
  const ranged = await fetch(f.base + media.url, { headers: { authorization: 'Bearer owner', range: 'bytes=2-9' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), mp4.subarray(2, 10));
  const unauthenticated = await fetch(f.base + media.url);
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: { code: 'UNAUTHORIZED', message: 'Invalid session credentials' } });
  assert.equal((await fetch(f.base + media.url, { headers: { authorization: 'Bearer other' } })).status, 403);
  const otherPath = media.url.replace('/owner/', '/other/');
  assert.equal((await fetch(f.base + otherPath, { headers: { authorization: 'Bearer other' } })).status, 404);
});

test('rejects unauthenticated, active content, forged containers and oversized files, cleaning all partials', async t => {
  const f = await fixture(t, { maxFileBytes: 100 });
  for (const [bytes, mime, token, status] of [
    [mp4, 'video/mp4', 'invalid', 401],
    [Buffer.from('<html>bad</html>'), 'text/html', 'owner', 415],
    [Buffer.from('<svg/>'), 'video/mp4', 'owner', 415],
    [Buffer.from('0000001066f4797069736f6d00000000', 'hex'), 'video/mp4', 'owner', 415],
    [Buffer.from('1a45dfa387428284f7e5e2ed', 'hex'), 'video/webm', 'owner', 415],
    [webm, 'video/mp4', 'owner', 415],
    [mp4, 'video/webm', 'owner', 415],
    [Buffer.concat([mp4, Buffer.alloc(200)]), 'video/mp4', 'owner', 413],
  ]) {
    const response = await f.upload(bytes, mime, token);
    assert.equal(response.status, status, await response.text());
    assert.deepEqual(await fs.readdir(f.root), []);
  }
  assert.equal(f.notifications.length, 0);
  assert.equal((await f.upload(webm, 'video/webm')).status, 201);
});

test('identical user filenames cannot overwrite server-created media', async t => {
  const f = await fixture(t);
  const first = await (await f.upload()).json();
  const second = await (await f.upload()).json();
  assert.notEqual(first.mediaId, second.mediaId);
  assert.equal((await fs.readdir(f.root)).length, 2);
  assert.deepEqual(await fs.readFile(path.join(f.root, first.mediaId)), mp4);
});

test('quotas reserve a full upload and include files present before service startup', async t => {
  const f = await fixture(t, { maxFileBytes: mp4.length, maxTotalBytes: mp4.length * 2, maxSessionBytes: mp4.length * 2, maxSessionFiles: 1 }, mp4);
  assert.equal((await f.upload()).status, 201);
  assert.equal((await f.upload()).status, 413);
  assert.equal((await f.upload(mp4, 'video/mp4', 'other')).status, 413);
  assert.equal(f.notifications.length, 1);
});

test('session bytes quota is independent of global storage', async t => {
  const f = await fixture(t, { maxFileBytes: mp4.length, maxSessionBytes: mp4.length, maxTotalBytes: mp4.length * 3 });
  assert.equal((await f.upload()).status, 201);
  assert.equal((await f.upload()).status, 413);
  assert.equal((await f.upload(mp4, 'video/mp4', 'other')).status, 201);
});

function beginPartial(base) {
  const request = http.request(base + '/upload', { method: 'POST', headers: {
    authorization: 'Bearer owner', 'content-type': 'multipart/form-data; boundary=partial',
  } });
  request.on('error', () => {});
  request.write('--partial\r\nContent-Disposition: form-data; name="video"; filename="x.mp4"\r\nContent-Type: video/mp4\r\n\r\n');
  request.write(mp4);
  return request;
}
async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  do {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for upload cleanup');
}

test('concurrent admission is bounded and an aborted upload releases its partial file and capacity', async t => {
  const f = await fixture(t, { maxConcurrent: 1 });
  const partial = beginPartial(f.base);
  await eventually(async () => (await fs.readdir(f.root)).length === 1);
  assert.equal((await f.upload()).status, 429);
  partial.destroy();
  await eventually(async () => (await fs.readdir(f.root)).length === 0);
  assert.equal((await f.upload()).status, 201);
  assert.equal(f.notifications.length, 1);
});

test('pending uploads reserve global and session byte quotas', async t => {
  const f = await fixture(t, { maxFileBytes: mp4.length * 2, maxTotalBytes: mp4.length * 2, maxConcurrent: 2 });
  const partial = beginPartial(f.base);
  await eventually(async () => (await fs.readdir(f.root)).length === 1);
  assert.equal((await f.upload(mp4, 'video/mp4', 'other')).status, 413);
  partial.destroy();
  await eventually(async () => (await fs.readdir(f.root)).length === 0);
  assert.equal((await f.upload()).status, 201);
});

test('limits reject zero, fractional, unsafe and nonnumeric values', () => {
  for (const maxFileBytes of [0, -1, 1.2, Infinity, '100', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createMediaService({ mediaRoot: '/unused', authenticate() {}, limits: { maxFileBytes } }), TypeError);
  }
});


test('abort before the first file part also releases concurrency admission', async t => {
  const f = await fixture(t, { maxConcurrent: 1 });
  const request = http.request(f.base + '/upload', { method: 'POST', headers: {
    authorization: 'Bearer owner', 'content-type': 'multipart/form-data; boundary=partial',
  } });
  request.on('error', () => {});
  request.write('--partial\r\n');
  await eventually(async () => (await f.upload()).status === 429);
  request.destroy();
  await eventually(async () => (await f.upload()).status === 201);
  assert.equal(f.notifications.length, 1);
});

test('extra multipart fields fail without retaining files or consuming a quota slot', async t => {
  const f = await fixture(t, { maxSessionFiles: 1 });
  const form = new FormData();
  form.append('video', new Blob([mp4], { type: 'video/mp4' }), 'x.mp4');
  form.append('unexpected', 'value');
  const response = await fetch(f.base + '/upload', { method: 'POST', headers: { authorization: 'Bearer owner' }, body: form });
  assert.equal(response.status, 400);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal((await f.upload()).status, 201);
});
