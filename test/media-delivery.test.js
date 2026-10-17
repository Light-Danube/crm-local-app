'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./helpers');

const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex').copy(bytes);
const bearer = token => ({ authorization: `Bearer ${token}` });

// Native fetch adds request Cache-Control: no-cache to conditional requests,
// deliberately bypassing freshness. Use raw HTTP for the 304 contract.
function conditional(url, etag, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { ...headers, 'if-none-match': etag }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(response.headers), arrayBuffer: async () => Buffer.concat(chunks) }));
    });
    request.setTimeout(2000, () => request.destroy(new Error('Conditional request deadline')));
    request.on('error', reject);
  });
}

async function uploaded(f) {
  const owner = await f.createSession();
  const form = new FormData();
  form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'disposable.mp4');
  const response = await fetch(`${f.base}/upload?sessionId=${owner.sessionId}`, { method: 'POST', headers: bearer(owner.ownerToken), body: form });
  assert.equal(response.status, 201);
  return { owner, media: await response.json() };
}

async function assertAlive(f) {
  const response = await fetch(f.base + '/');
  assert.equal(response.status, 200);
  assert.ok((await response.text()).length > 0);
}

test('cache policy revalidates HTML and JS, briefly caches CSS/images and retains ETag conditionals', async t => {
  const f = await fixture(t);
  for (const resource of ['/', '/master.html', '/video', '/video.html?video=sample.mp4', '/src/player-session.js', '/src/video-url.js']) {
    const response = await fetch(f.base + resource);
    assert.equal(response.status, 200, resource);
    assert.equal(response.headers.get('cache-control'), 'no-cache', resource);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    const etag = response.headers.get('etag');
    assert.ok(etag, resource);
    const cached = await conditional(f.base + resource, etag);
    assert.equal(cached.status, 304, resource);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
  }
  for (const resource of ['/src/components/styles/index.css', '/src/components/img/download.svg']) {
    const response = await fetch(f.base + resource);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    const cached = await conditional(f.base + resource, response.headers.get('etag'));
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
  }
  // Socket.IO's vendor handler precedes Express and keeps its own revalidation policy.
  const vendor = await fetch(f.base + '/socket.io/socket.io.js');
  assert.equal(vendor.status, 200);
  assert.equal(vendor.headers.get('cache-control'), 'public, max-age=0');
  assert.ok((await vendor.arrayBuffer()).byteLength > 0);
  const vendorConditional = await conditional(f.base + '/socket.io/socket.io.js', vendor.headers.get('etag'));
  assert.equal(vendorConditional.status, 304);
});

test('authorized sendFile serves closed/open/suffix ranges, HEAD, 416 and conditional requests after authentication', async t => {
  const f = await fixture(t);
  const { owner, media } = await uploaded(f);
  const headers = bearer(owner.ownerToken);
  for (const [range, start, end] of [['bytes=0-9', 0, 9], ['bytes=1048576-', 1048576, bytes.length - 1], ['bytes=-17', bytes.length - 17, bytes.length - 1]]) {
    const response = await fetch(f.base + media.url, { headers: { ...headers, range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const unsatisfied = await fetch(f.base + media.url, { headers: { ...headers, range: `bytes=${bytes.length}-` } });
  assert.equal(unsatisfied.status, 416);
  assert.equal(unsatisfied.headers.get('content-range'), `bytes */${bytes.length}`);
  await unsatisfied.arrayBuffer();
  const head = await fetch(f.base + media.url, { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const etag = head.headers.get('etag');
  assert.ok(etag);
  const fresh = await conditional(f.base + media.url, etag, headers);
  assert.equal(fresh.status, 304);
  assert.equal(fresh.headers.get('cache-control'), 'private, no-store');
  const foreign = await f.createSession();
  for (const token of [undefined, 'invalid', foreign.ownerToken]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(f.base + media.url, { method, headers: { ...(token ? bearer(token) : {}), 'if-none-match': etag, range: 'bytes=0-9' } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('content-range'), null);
      await response.arrayBuffer();
    }
  }
});

test('aborting a media download closes its server response; later range requests and application still work', async t => {
  const f = await fixture(t);
  const { owner, media } = await uploaded(f);
  const original = f.app.response.sendFile;
  let serverClosed;
  const closed = new Promise(resolve => { serverClosed = resolve; });
  f.app.response.sendFile = function(filename, callback) {
    if (filename.endsWith(media.mediaId)) this.once('close', serverClosed);
    return original.call(this, filename, callback);
  };
  t.after(() => { f.app.response.sendFile = original; });
  const transferred = await new Promise((resolve, reject) => {
    const request = http.get(f.base + media.url, { headers: bearer(owner.ownerToken), agent: false }, response => {
      response.once('data', chunk => {
        response.destroy();
        request.destroy();
        resolve(chunk.length);
      });
      response.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    request.setTimeout(2000, () => request.destroy(new Error('Abort test deadline')));
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  assert.ok(transferred > 0 && transferred < bytes.length);
  await closed;
  const subsequent = await fetch(f.base + media.url, { headers: { ...bearer(owner.ownerToken), range: 'bytes=0-9' } });
  assert.equal(subsequent.status, 206);
  assert.deepEqual(Buffer.from(await subsequent.arrayBuffer()), bytes.subarray(0, 10));
  await assertAlive(f);
});

test('sendFile callback errors after headers close partial responses rather than hanging', async t => {
  const f = await fixture(t);
  const { owner, media } = await uploaded(f);
  const original = f.app.response.sendFile;
  let injected = false;
  f.app.response.sendFile = function(filename, callback) {
    if (!filename.endsWith(media.mediaId)) return original.call(this, filename, callback);
    this.status(200).set('Content-Length', '1024');
    this.write('partial');
    assert.equal(this.headersSent, true);
    injected = true;
    const timer = setTimeout(() => callback(Object.assign(new Error('Disposable stream failure'), { code: 'EIO' })), 10);
    this.once('close', () => clearTimeout(timer));
  };
  t.after(() => { f.app.response.sendFile = original; });
  const received = await new Promise((resolve, reject) => {
    const request = http.get(f.base + media.url, { headers: bearer(owner.ownerToken), agent: false }, response => {
      let count = 0;
      response.on('data', chunk => { count += chunk.length; });
      response.once('aborted', () => resolve(count));
      response.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      response.once('end', () => reject(new Error('Partial response must be terminated')));
    });
    request.setTimeout(2000, () => request.destroy(new Error('Stream error test deadline')));
    request.on('error', reject);
  });
  assert.equal(injected, true);
  assert.equal(received, Buffer.byteLength('partial'));
  f.app.response.sendFile = original;
  await assertAlive(f);
});

test('stat permission failures and removed media return controlled responses without terminating the server', async t => {
  const f = await fixture(t);
  const { owner, media } = await uploaded(f);
  const mediaPath = path.join(f.mediaRoot, media.mediaId);
  const stat = fs.stat;
  fs.stat = async function(filename, ...args) {
    if (filename === mediaPath) throw Object.assign(new Error('Disposable permission failure'), { code: 'EACCES' });
    return stat.call(this, filename, ...args);
  };
  try {
    const denied = await fetch(f.base + media.url, { headers: bearer(owner.ownerToken) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'FORBIDDEN');
  } finally { fs.stat = stat; }
  await fs.unlink(mediaPath);
  const missing = await fetch(f.base + media.url, { headers: bearer(owner.ownerToken) });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'MEDIA_ERROR');
  await assertAlive(f);
});
