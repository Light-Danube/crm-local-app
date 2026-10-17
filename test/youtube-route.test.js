const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const { createYoutubeHandler } = require('../lib/youtube-route');

const id = 'abcdefghijk';
async function fixture(t, ytdl, options = {}) {
  const app = express();
  app.set('trust proxy', true); // Rate limits must still use the socket address.
  app.get('/youtube/:videoId', createYoutubeHandler({ ytdl, ...options }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/youtube/`;
}
function fake() {
  const streams = [];
  const options = [];
  const calls = [];
  const ytdl = (url, settings) => {
    calls.push(url);
    options.push(settings);
    const stream = new PassThrough();
    streams.push(stream);
    return stream;
  };
  return { ytdl, streams, options, calls };
}
async function started(upstream, count = 1) {
  const deadline = Date.now() + 1000;
  while (upstream.streams.length < count) {
    if (Date.now() > deadline) throw new Error('Request did not start');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('streams video with a safe title and one metadata lookup', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl);
  const responsePromise = fetch(base + id);
  await started(upstream);
  upstream.streams[0].emit('info', { videoDetails: { title: '../Привіт\r\n"world' + 'a'.repeat(140) + '😀' } });
  upstream.streams[0].end('video bytes');
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.match(response.headers.get('content-disposition'), /%D0/);
  assert.equal(await response.text(), 'video bytes');
  assert.deepEqual(upstream.calls, [`https://www.youtube.com/watch?v=${id}`]);
  assert.equal(upstream.options[0].filter({ container: 'mp4', hasAudio: true, hasVideo: true }), true);
});

test('rejects malformed IDs before calling upstream', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl);
  for (const bad of ['short', 'abcdefghij!', 'abcdefghijkl']) {
    assert.equal((await fetch(base + encodeURIComponent(bad))).status, 400);
  }
  assert.equal(upstream.calls.length, 0);
});

test('bounds concurrent requests and releases capacity after completion', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl, { maxConcurrent: 1 });
  const first = fetch(base + id);
  await started(upstream);
  assert.equal((await fetch(base + id)).status, 503);
  assert.equal(upstream.calls.length, 1);
  upstream.streams[0].end('one');
  assert.equal(await (await first).text(), 'one');
  const next = fetch(base + id);
  await started(upstream, 2);
  upstream.streams[1].end('two');
  assert.equal(await (await next).text(), 'two');
});

test('limits actual socket address despite spoofed forwarding headers and resets the window', async t => {
  let timestamp = 100;
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl, { maxRequests: 1, windowMs: 1000, now: () => timestamp });
  const first = fetch(base + id, { headers: { 'X-Forwarded-For': '192.0.2.1' } });
  await started(upstream);
  upstream.streams[0].end('one');
  await (await first).text();
  const limited = await fetch(base + id, { headers: { 'X-Forwarded-For': '192.0.2.2' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  timestamp += 1000;
  const next = fetch(base + id);
  await started(upstream, 2);
  upstream.streams[1].end('two');
  assert.equal((await next).status, 200);
});

test('metadata deadline aborts upstream requests and prevents late network work', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl, { timeoutMs: 60, maxConcurrent: 1 });
  const pending = fetch(base + id);
  await started(upstream);
  const metadata = new PassThrough();
  upstream.options[0].requestCallback(metadata);
  // Match miniget's nonstandard destruction: network closes, text() itself
  // only settles through its error listener, never through close.
  metadata._destroy = () => {};
  const metadataRejected = once(metadata, 'error');
  const response = await pending;
  const [cancelError] = await metadataRejected;
  assert.equal(cancelError.code, 'ABORT_ERR');
  assert.equal(response.status, 504);
  assert.equal(metadata.destroyed, true);
  assert.equal(upstream.streams[0].destroyed, true);
  assert.equal(upstream.options[0].requestOptions.signal.aborted, true);
  const late = new PassThrough();
  upstream.options[0].requestCallback(late);
  assert.equal(late.destroyed, true);
  const next = fetch(base + id);
  await started(upstream, 2);
  upstream.streams[1].end('released');
  assert.equal(await (await next).text(), 'released');
});

test('disconnect midstream destroys upstream once and releases its slot', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl, { maxConcurrent: 1 });
  const request = http.get(base + id);
  request.on('error', () => {});
  await started(upstream);
  let destroys = 0;
  const originalDestroy = upstream.streams[0].destroy;
  upstream.streams[0].destroy = function (...args) { destroys++; return originalDestroy.apply(this, args); };
  const responsePromise = once(request, 'response');
  upstream.streams[0].write('first chunk');
  const [response] = await responsePromise;
  response.on('error', () => {});
  request.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(upstream.streams[0].destroyed, true);
  assert.equal(upstream.options[0].requestOptions.signal.aborted, true);
  assert.equal(destroys, 1);
  const next = fetch(base + id);
  await started(upstream, 2);
  upstream.streams[1].end('released');
  assert.equal(await (await next).text(), 'released');
});

test('disconnect while metadata is pending cancels captured metadata requests', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl);
  const request = http.get(base + id);
  request.on('error', () => {});
  await started(upstream);
  const metadata = new PassThrough();
  upstream.options[0].requestCallback(metadata);
  request.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(metadata.destroyed, true);
  assert.equal(upstream.options[0].requestOptions.signal.aborted, true);
});

for (const phase of ['metadata', 'stream']) {
  test(`${phase} error returns 502 and releases capacity`, async t => {
    const upstream = fake();
    const base = await fixture(t, upstream.ytdl, { maxConcurrent: 1 });
    const pending = fetch(base + id);
    await started(upstream);
    if (phase === 'stream') upstream.streams[0].emit('info', { videoDetails: { title: 'test' } });
    upstream.streams[0].destroy(new Error(`${phase} failed`));
    assert.equal((await pending).status, 502);
    const next = fetch(base + id);
    await started(upstream, 2);
    upstream.streams[1].end('released');
    assert.equal(await (await next).text(), 'released');
  });
}

test('an error after streaming starts closes the response without hanging', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl);
  const pending = fetch(base + id);
  await started(upstream);
  upstream.streams[0].write('chunk');
  const response = await pending;
  const body = response.text();
  upstream.streams[0].destroy(new Error('midstream'));
  await assert.rejects(body);
});

test('synchronous upstream errors release capacity', async t => {
  let calls = 0;
  const base = await fixture(t, () => { calls++; throw new Error('setup'); }, { maxConcurrent: 1 });
  assert.equal((await fetch(base + id)).status, 502);
  assert.equal((await fetch(base + id)).status, 502);
  assert.equal(calls, 2);
});


test('the same deadline covers a stalled media stream after metadata completes', async t => {
  const upstream = fake();
  const base = await fixture(t, upstream.ytdl, { timeoutMs: 60, maxConcurrent: 1 });
  const pending = fetch(base + id);
  await started(upstream);
  upstream.streams[0].emit('info', { videoDetails: { title: 'video' } });
  upstream.streams[0].write('partial');
  const response = await pending;
  await assert.rejects(response.text());
  assert.equal(upstream.streams[0].destroyed, true);
  const next = fetch(base + id);
  await started(upstream, 2);
  upstream.streams[1].end('released');
  assert.equal(await (await next).text(), 'released');
});
