'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { extractYouTubeId } = require('../public/src/video-url');

test('shared parser accepts supported video links and arbitrary watch query order', () => {
  for (const url of [
    'https://youtu.be/abcDEF12_-3', 'https://youtu.be/abcDEF12_-3?si=xyz',
    'https://www.youtube.com/watch?v=abcDEF12_-3',
    'https://youtube.com/watch?list=playlist&v=abcDEF12_-3&t=20',
    'http://m.youtube.com/watch?v=abcDEF12_-3',
    'https://www.youtube.com/shorts/abcDEF12_-3?feature=share',
  ]) assert.equal(extractYouTubeId(url), 'abcDEF12_-3', url);
});

test('shared parser rejects unsupported URLs and malformed values', () => {
  for (const value of [null, undefined, 42, {}, '', 'abcDEF12_-3',
    'https://youtube.com/playlist?list=abcdefghijklmnopqrstuvwx',
    'https://youtube.com/watch?v=short', 'https://youtu.be/abcDEF12_-3/extra',
    'https://youtube.com/watch?v=abcDEF12_-3extra', 'https://youtube.com.evil.test/watch?v=abcDEF12_-3',
    'https://evil.test/abcDEF12_-3', 'ftp://youtu.be/abcDEF12_-3',
    'https://user@youtube.com/watch?v=abcDEF12_-3',
    'https://user:password@youtube.com/watch?v=abcDEF12_-3',
    'https://youtu.be:8443/abcDEF12_-3', '//youtu.be/abcDEF12_-3',
  ]) assert.equal(extractYouTubeId(value), null, String(value));
});

test('same parser exports a browser global without CommonJS', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(require.resolve('../public/src/video-url'), 'utf8'), context);
  assert.equal(context.videoUrls.extractYouTubeId('https://youtu.be/abcDEF12_-3'), 'abcDEF12_-3');
  assert.equal(context.videoUrls.extractYouTubeId('https://foreign.test/abcDEF12_-3'), null);
});
