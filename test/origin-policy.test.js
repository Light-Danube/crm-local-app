const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { fixture } = require('./helpers');
const { createOriginPolicy } = require('../lib/origin-policy');

test('origin allowlist is exact and no-Origin policy is explicit', () => {
  const policy = createOriginPolicy({ allowedOrigins: ['https://display.example'], allowNoOrigin: false });
  assert.equal(policy.isAllowed('https://display.example'), true);
  for (const origin of [undefined, 'null', 'https://display.example.evil', 'http://display.example', 'https://display.example/']) {
    assert.equal(policy.isAllowed(origin), false);
  }
  policy.addLocalPort(4321);
  assert.equal(policy.isAllowed('http://127.0.0.1:4321'), false);
  assert.equal(createOriginPolicy().isAllowed(undefined), true);
  const local = createOriginPolicy();
  local.addLocalPort(4321);
  assert.equal(local.isAllowed('http://127.0.0.1:4321'), true);
  for (const allowedOrigins of [[], ['*'], ['https://example.org/path'], ['file:///tmp/a']]) {
    assert.throws(() => createOriginPolicy({ allowedOrigins }));
  }
});

async function handshake(base, transport, origin) {
  const socket = io(`${base}/playerControls`, {
    forceNew: true, reconnection: false, transports: [transport],
    extraHeaders: origin ? { Origin: origin } : {}, autoConnect: false,
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect();
    });
  } finally { socket.disconnect(); }
}

test('HTTP and both Socket.IO transports enforce the same origin boundary', async t => {
  const f = await fixture(t, { allowedOrigins: ['https://display.example'], allowNoOrigin: true });
  const allowed = await fetch(f.base, { headers: { Origin: 'https://display.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://display.example');
  assert.equal((await fetch(f.base)).status, 200);
  for (const origin of ['https://evil.example', 'null']) {
    const rejected = await fetch(f.base + '/api/sessions', { method: 'POST', headers: { Origin: origin } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, 'ORIGIN_DENIED');
  }
  for (const transport of ['websocket', 'polling']) {
    await handshake(f.base, transport, 'https://display.example');
    await handshake(f.base, transport);
    await assert.rejects(handshake(f.base, transport, 'https://evil.example'));
  }
});

test('explicit no-Origin denial applies to HTTP and WebSocket handshakes', async t => {
  const f = await fixture(t, { allowedOrigins: ['https://display.example'], allowNoOrigin: false });
  assert.equal((await fetch(f.base)).status, 403);
  await assert.rejects(handshake(f.base, 'websocket'));
  await handshake(f.base, 'websocket', 'https://display.example');
});
