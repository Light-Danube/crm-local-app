const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');

test('HTTP entry points, upload, exact download and byte range', async t => {
  const { base, createSession } = await fixture(t);
  for (const route of ['/', '/master.html', '/video', '/video.html?video=sample.mp4',
    '/src/components/styles/index.css', '/socket.io/socket.io.js']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.arrayBuffer()).byteLength > 0, route);
  }
  assert.equal((await fetch(base + '/video.html')).status, 400);
  const redirect = await fetch(base + '/select?type=local', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/master.html?type=local');
  const session = await createSession();
  const headers = { authorization: `Bearer ${session.ownerToken}` };
  const bytes = Buffer.concat([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), Buffer.from('disposable media byte-range fixture')]);
  const form = new FormData();
  form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'fixture.mp4');
  const upload = await fetch(base + '/upload?sessionId=' + session.sessionId, { method: 'POST', body: form, headers });
  assert.equal(upload.status, 201);
  const media = await upload.json();
  const download = await fetch(base + media.url, { headers });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const range = await fetch(base + media.url, { headers: { ...headers, range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 10));
});
