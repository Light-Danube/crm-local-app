const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request } = require('node:http');
const { writeFile, mkdir, symlink } = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./helpers');
const { validateMediaFilename, resolveMediaPath } = require('../lib/media-path');

// Preserve the literal request path: fetch normalizes dot segments before sending.
function get(base, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base, { path: requestPath, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('media filenames reject path syntax before filesystem access', () => {
  for (const name of [undefined, null, [], {}, '', '.', '..', '../outside', '..\\outside',
    '/tmp/outside', 'C:\\outside', '\\\\server\\file', 'a/b', 'a\\b', 'a\0b',
    '%2e%2e%2foutside', '%252foutside', 'a%name']) {
    assert.throws(() => validateMediaFilename(name), { status: 400 }, String(name));
  }
  validateMediaFilename('звичайне відео.mp4');
});

test('all public media paths reject traversal and never return an outside sentinel', async t => {
  const { base, root, mediaRoot } = await fixture(t);
  const sentinel = Buffer.from('private disposable sentinel outside media root');
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, sentinel);
  await symlink(outside, path.join(mediaRoot, 'outside-link.mp4'));
  await mkdir(path.join(mediaRoot, 'directory.mp4'));
  await symlink(root, path.join(mediaRoot, 'outside-directory'));

  const invalidPaths = ['..%2foutside.txt', '..%5coutside.txt', '%2fetc%2fpasswd',
    'C:%5coutside.txt', '%252e%252e%252foutside.txt', '%2e', '%2e%2e',
    '.', '..', 'a%00b', '%', '%GG', 'directory.mp4', 'outside-link.mp4',
    'outside-directory%2foutside.txt', 'missing.mp4', 'nested/file.mp4'];
  for (const prefix of ['/videofile/', '/uploads/', '/video/', '/UPLOADS/']) {
    for (const filename of invalidPaths) {
      const response = await get(base, prefix + filename);
      assert.ok(response.status >= 400 && response.status < 500,
        `${prefix}${filename}: ${response.status}`);
      assert.ok(!response.bytes.includes(sentinel));
    }
  }
  for (const filename of ['outside-link.mp4', 'directory.mp4', 'outside-directory']) {
    await assert.rejects(resolveMediaPath(mediaRoot, filename), { status: 403 });
  }
  await assert.rejects(resolveMediaPath(mediaRoot, 'missing.mp4'), { status: 404 });
  assert.equal((await get(base, '/')).status, 200);
});

test('ordinary filenames, internal symlinks, downloads and byte ranges retain exact bytes', async t => {
  const { base, mediaRoot } = await fixture(t);
  const bytes = Buffer.from('disposable media fixture: \u0000\u0001\u0002\u00ff');
  const filename = 'звичайне відео.mp4';
  await writeFile(path.join(mediaRoot, filename), bytes);
  await symlink(path.join(mediaRoot, filename), path.join(mediaRoot, 'inside-link.mp4'));
  for (const prefix of ['/videofile/', '/uploads/']) {
    for (const name of [encodeURIComponent(filename), 'inside-link.mp4']) {
      const response = await get(base, prefix + name);
      assert.equal(response.status, 200);
      assert.deepEqual(response.bytes, bytes);
      const range = await get(base, prefix + name, { range: 'bytes=0-9' });
      assert.equal(range.status, 206);
      assert.equal(range.headers['content-range'], `bytes 0-9/${bytes.length}`);
      assert.deepEqual(range.bytes, bytes.subarray(0, 10));
      const head = await fetch(base + prefix + name, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get('content-length')), bytes.length);
    }
  }
});
