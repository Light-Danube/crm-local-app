'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaybackState } = require('../lib/playback-state');

function setup() {
  let time = 1000;
  return {
    state: createPlaybackState({ now: () => time }),
    advance: ms => { time += ms; },
    setClock: value => { time = value; },
  };
}
const fails = (fn, code) => assert.throws(fn, error => error.code === code);

test('initial snapshot has the complete canonical defaults and reads do not change revision', () => {
  const { state, advance } = setup();
  const expected = {
    media: null, time: 0, paused: true, volume: 1,
    effects: { loop: false, inversion: false, color: false, details: false, background: false },
    revision: 0,
  };
  assert.deepEqual(state.snapshot(), expected);
  advance(3000);
  assert.deepEqual(state.snapshot(), expected);
});

test('play, pause, seek, resume and stop anchor elapsed seconds correctly', () => {
  const { state, advance } = setup();
  state.command('player start');
  advance(2500);
  assert.equal(state.snapshot().time, 2.5);
  assert.equal(state.snapshot().revision, 1);
  state.command('player pause');
  advance(2000);
  assert.equal(state.snapshot().time, 2.5);
  state.command('player timeupdate', 20);
  advance(1000);
  assert.equal(state.snapshot().time, 20);
  state.command('player start');
  advance(1500);
  assert.equal(state.snapshot().time, 21.5);
  state.command('player timeupdate', 5);
  advance(500);
  assert.equal(state.snapshot().time, 5.5);
  const stopped = state.command('stop');
  assert.equal(stopped.time, 0);
  assert.equal(stopped.paused, true);
  assert.equal(stopped.revision, 6);
  advance(2000);
  assert.equal(state.snapshot().time, 0);
});

test('volume and every effect preserve elapsed playback and advance the revision once', () => {
  const { state, advance } = setup();
  state.command('player start');
  advance(1000);
  state.command('player volumeupdate', 0.4);
  const events = ['toggle loop', 'toggle inversion', 'optimize color', 'toggle enhance details', 'toggle back details'];
  for (const event of events) {
    advance(1000);
    state.command(event, true);
  }
  const snap = state.snapshot();
  assert.equal(snap.time, 6);
  assert.equal(snap.volume, 0.4);
  assert.deepEqual(Object.values(snap.effects), [true, true, true, true, true]);
  assert.equal(snap.revision, 7);
  advance(500);
  assert.equal(state.snapshot().time, 6.5);
});

test('new media pauses and resets time, copies input, and snapshots cannot mutate state', () => {
  const { state, advance } = setup();
  state.command('player start');
  advance(2000);
  const input = { kind: 'local', url: '/uploads/media.mp4', mediaId: 'media' };
  const result = state.media(input);
  assert.equal(result.time, 0);
  assert.equal(result.paused, true);
  assert.equal(result.revision, 2);
  input.url = 'changed';
  result.media.url = 'also changed';
  result.effects.loop = true;
  result.revision = -1;
  assert.deepEqual(state.snapshot().media, { kind: 'local', url: '/uploads/media.mp4', mediaId: 'media' });
  assert.equal(state.snapshot().effects.loop, false);
  assert.equal(state.snapshot().revision, 2);
  assert.equal(state.media(null).media, null);
});

test('watch, shorts and short YouTube URLs produce the canonical server playback URL', () => {
  const { state } = setup();
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=whatever',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=30',
  ]) {
    state.command('player start');
    const snap = state.command('video url', url);
    assert.deepEqual(snap.media, { kind: 'youtube', url: '/youtube/dQw4w9WgXcQ' });
    assert.equal(snap.paused, true);
    assert.equal(snap.time, 0);
  }
});

test('invalid YouTube URLs cannot change state or revision', () => {
  const { state } = setup();
  for (const url of [undefined, null, {}, '', 'not a URL', 'javascript:alert(1)',
    'https://evil.example/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/playlist?list=dQw4w9WgXcQ', 'https://youtu.be/short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQBAD', 'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://user@youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com:9999/watch?v=dQw4w9WgXcQ']) {
    fails(() => state.command('video url', url), 'INVALID_VIDEO_URL');
    assert.equal(state.snapshot().revision, 0);
  }
});

test('backwards and nonfinite clocks never rewind playback or poison future commands', () => {
  const { state, advance, setClock } = setup();
  state.command('player start');
  advance(1000);
  assert.equal(state.snapshot().time, 1);
  setClock(500);
  assert.equal(state.snapshot().time, 1);
  state.command('player volumeupdate', 0);
  setClock(NaN);
  assert.equal(state.snapshot().time, 1);
  setClock(Infinity);
  state.command('toggle loop', true);
  setClock(2500);
  assert.equal(state.snapshot().time, 1.5);
});

test('standalone command/media guards reject malformed values before changing state', () => {
  const { state } = setup();
  fails(() => state.command('unknown', true), 'INVALID_COMMAND');
  for (const [event, value] of [['player timeupdate', -1], ['player timeupdate', Infinity],
    ['player volumeupdate', 2], ['toggle loop', 'true'], ['player start', {}]]) {
    fails(() => state.command(event, value), 'INVALID_PAYLOAD');
  }
  for (const value of [undefined, [], {}, { kind: 'local', url: 1 }, { kind: 'other', url: '/x' }]) {
    fails(() => state.media(value), 'INVALID_PAYLOAD');
  }
  assert.equal(state.snapshot().revision, 0);
});
