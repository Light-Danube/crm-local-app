'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');

test('public media configuration exposes configured upload size and accepted types only', async t => {
  const app = await fixture(t, { mediaLimits: { maxFileBytes: 1234567 } });
  const response = await fetch(app.base + '/api/media/config');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { maxFileBytes: 1234567, acceptedMimeTypes: ['video/mp4', 'video/webm'] });
  assert.ok(Object.isFrozen(app.mediaService.config));
  assert.ok(Object.isFrozen(app.mediaService.config.acceptedMimeTypes));
});
