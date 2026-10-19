const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const turn = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function fixture(t, { withApi = true, muted = false } = {}) {
  const timers = new Map();
  let timerId = 0;
  let clock = 0;
  const scripts = [];
  const instances = [];
  const style = () => ({ display: '', setProperty(name, value) { this[name] = value; }, removeProperty(name) { const old = this[name]; delete this[name]; return old; } });
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag; this.style = style(); this.children = []; this.attributes = new Map(); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    replaceChildren(...nodes) { this.children = nodes; }
    remove() { const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); }
  }
  class Video extends Element {
    constructor() {
      super('video'); this.readyState = 1; this.duration = 60; this.currentTime = 0;
      this.paused = true; this.volume = 1; this.muted = muted; this.loop = false; this.error = null;
      this.loadCount = 0; this.value = '';
    }
    get src() { return this.value; }
    set src(value) { this.value = new URL(value, 'http://localhost/').href; this.attributes.set('src', value); }
    get currentSrc() { return this.value; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.value = ''; }
    load() { this.loadCount++; }
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
    play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  }
  class Player {
    constructor(slot, options) {
      this.slot = slot; this.options = options; this.iframe = new Element('iframe'); this.duration = 60;
      this.time = 0; this.volume = 100; this.cues = []; this.seeks = []; this.plays = 0; this.pauses = 0;
      instances.push(this);
    }
    event(name, data) { this.options.events[name]?.({ target: this, data }); }
    ready() { this.event('onReady'); }
    state(value) { this.event('onStateChange', value); }
    cueVideoById(value) { this.cues.push(value); this.time = value.startSeconds || 0; }
    getIframe() { return this.iframe; }
    getDuration() { return this.duration; }
    getCurrentTime() { return this.time; }
    setVolume(value) { this.volume = value; }
    mute() { this.muted = true; }
    unMute() { this.muted = false; }
    playVideo() { this.plays++; }
    pauseVideo() { this.pauses++; }
    seekTo(value) { this.seeks.push(value); this.time = value; }
    destroy() { this.destroyed = true; }
  }
  const window = withApi ? { YT: { Player } } : {};
  const video = new Video();
  const container = new Element('div');
  const context = { window, document: { createElement: tag => new Element(tag), head: { appendChild: node => scripts.push(node) } },
    location: { origin: 'http://localhost', href: 'http://localhost/master.html' }, performance: { now: () => clock }, URL, Event, EventTarget, DOMException, queueMicrotask,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/src/media-player.js'), 'utf8'), context);
  const facade = window.createMediaPlayer({ video, youtubeContainer: container });
  t.after(() => facade.destroy());
  return { facade, video, container, instances, scripts, window, timers, Player,
    advanceClock(ms) { clock += ms; },
    second() {
      const other = window.createMediaPlayer({ video: new Video(), youtubeContainer: new Element('div') });
      t.after(() => other.destroy());
      return other;
    },
    expire() { const jobs = [...timers.values()]; timers.clear(); for (const job of jobs) job.callback(); } };
}
async function youtube(f, id = 'RoYXgdHafBA') {
  f.facade.src = `/youtube/${id}`;
  f.facade.load();
  await turn();
  const player = f.instances.at(-1);
  assert.ok(player);
  player.ready();
  return player;
}

test('native files retain playback/events and effects apply to both separate surfaces', async t => {
  const f = fixture(t);
  let plays = 0;
  f.facade.addEventListener('play', () => plays++);
  f.facade.src = '/media/session/file';
  assert.equal(f.facade.src, 'http://localhost/media/session/file');
  assert.equal(f.facade.isYouTube, false);
  await f.facade.play();
  assert.equal(plays, 1);
  assert.equal(f.facade.paused, false);
  f.facade.pause();
  assert.equal(f.facade.paused, true);
  f.facade.volume = 0.4;
  f.facade.loop = true;
  f.facade.currentTime = 12;
  assert.equal(f.video.volume, 0.4);
  assert.equal(f.video.loop, true);
  assert.equal(f.video.currentTime, 12);
  f.facade.style.transform = 'scaleX(-1)';
  f.facade.style.setProperty('filter', 'contrast(150%)');
  assert.equal(f.video.style.transform, f.container.style.transform);
  assert.equal(f.video.style.filter, f.container.style.filter);
  assert.equal(f.container.hidden, true);
  assert.equal(f.instances.length, 0);
});

test('YouTube cues paused once, preserves preview mute, and resolves play only on actual playback', async t => {
  const f = fixture(t, { muted: true });
  let metadata = 0;
  let plays = 0;
  let pauses = 0;
  f.facade.addEventListener('loadedmetadata', () => metadata++);
  f.facade.addEventListener('play', () => plays++);
  f.facade.addEventListener('pause', () => pauses++);
  const p = await youtube(f);
  assert.equal(p.cues.length, 1);
  assert.equal(p.cues[0].videoId, 'RoYXgdHafBA');
  assert.equal(p.muted, true);
  assert.equal(p.plays, 0);
  assert.equal(f.facade.paused, true);
  assert.equal(f.facade.readyState, 1);
  assert.equal(f.facade.duration, 60);
  assert.equal(f.facade.currentSrc, 'http://localhost/youtube/RoYXgdHafBA');
  assert.equal(p.options.host, 'https://www.youtube.com');
  assert.equal(p.options.playerVars.controls, 0);
  assert.equal(p.iframe.attributes.get('title'), 'Відео YouTube');
  p.state(5);
  assert.equal(metadata, 1);
  f.facade.src = '/youtube/RoYXgdHafBA';
  f.facade.load();
  await turn();
  assert.equal(f.instances.length, 1);
  assert.equal(p.cues.length, 1);
  let finished = false;
  const started = f.facade.play().then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  p.state(1);
  await started;
  assert.equal(f.facade.paused, false);
  assert.equal(plays, 1);
  p.state(1);
  assert.equal(plays, 1);
  f.facade.pause();
  assert.equal(f.facade.paused, true);
  p.state(2);
  p.state(2);
  assert.equal(pauses, 1);
  f.facade.muted = false;
  assert.equal(p.muted, false);
  assert.equal(f.video.hidden, true);
  f.facade.style.display = 'block';
  assert.equal(f.video.style.display, 'none');
  assert.equal(f.container.style.display, 'block');
});

test('explicit YouTube seeking relays requested values and volume/loop preserve playing state', async t => {
  const f = fixture(t);
  const p = await youtube(f);
  const started = f.facade.play();
  p.state(1);
  await started;
  const seeks = [];
  f.facade.addEventListener('seeking', () => seeks.push(['seeking', f.facade.currentTime]));
  f.facade.addEventListener('seeked', () => seeks.push(['seeked', f.facade.currentTime]));
  p.seekTo = value => p.seeks.push(value); // IFrame time observation may lag the request.
  f.facade.currentTime = 17.5;
  await turn();
  assert.deepEqual(seeks, [['seeking', 17.5], ['seeked', 17.5]]);
  assert.equal(f.facade.currentTime, 17.5);
  p.time = 17.6;
  assert.equal(f.facade.currentTime, 17.6);
  f.facade.volume = 0.42;
  assert.equal(p.volume, 42);
  assert.equal(f.facade.volume, 0.42);
  f.facade.loop = true;
  const pauses = p.pauses;
  p.state(0);
  assert.equal(p.seeks.at(-1), 0);
  assert.equal(p.plays, 2);
  assert.equal(p.pauses, pauses);
  assert.equal(f.facade.paused, false);
});

test('unavailable and embedding errors are visible; autoplay rejection supports retry', async t => {
  const f = fixture(t);
  const p = await youtube(f);
  const blocked = f.facade.play();
  p.event('onAutoplayBlocked');
  await assert.rejects(blocked, error => error.name === 'NotAllowedError');
  const retry = f.facade.play();
  p.state(1);
  await retry;
  for (const [code, message] of [[100, /недоступне/], [101, /заборонив/], [150, /заборонив/], [153, /Referer/]]) {
    p.event('onError', code);
    assert.equal(f.facade.error.youtubeCode, code);
    assert.match(f.facade.error.message, message);
  }
});

test('switching media cancels pending play and ignores stale iframe metadata/play/error events', async t => {
  const f = fixture(t);
  const old = await youtube(f);
  const pending = f.facade.play();
  f.facade.src = '/media/session/new';
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(old.destroyed, true);
  let metadata = 0;
  f.facade.addEventListener('loadedmetadata', () => metadata++);
  old.ready(); old.state(1); old.event('onError', 100);
  assert.equal(metadata, 0);
  assert.equal(f.facade.isYouTube, false);
  assert.equal(f.facade.error, null);
  const next = await youtube(f, 'abcdefghijk');
  assert.equal(next.cues[0].videoId, 'abcdefghijk');
  assert.equal(f.facade.error, null);
  assert.equal(f.instances.length, 2);
});

test('lazy API loading is shared, bounded and retryable after a blocked script', async t => {
  const f = fixture(t, { withApi: false });
  assert.equal(f.scripts.length, 0);
  f.facade.src = '/youtube/RoYXgdHafBA';
  f.facade.load();
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0].src, 'https://www.youtube.com/iframe_api');
  const second = f.second();
  second.src = '/youtube/abcdefghijk'; second.load();
  assert.equal(f.scripts.length, 1, 'two surfaces share one API request');
  assert.equal([...f.timers.values()][0].ms, 15000);
  f.scripts[0].dispatchEvent(new Event('error'));
  await turn();
  assert.equal(f.scripts.length, 0);
  assert.match(f.facade.error.message, /YouTube API/);
  f.facade.load();
  assert.equal(f.scripts.length, 1);
  f.window.YT = { Player: f.Player };
  f.window.onYouTubeIframeAPIReady();
  await turn();
  f.instances.at(-1).ready();
  assert.equal(f.facade.readyState, 1);
  assert.equal(f.facade.error, null);
});

test('API deadline and playback deadline settle visibly and destroy cancels pending play', async t => {
  const loading = fixture(t, { withApi: false });
  loading.facade.src = '/youtube/RoYXgdHafBA'; loading.facade.load();
  loading.expire();
  await turn();
  assert.match(loading.facade.error.message, /API не відповідає/);
  const f = fixture(t);
  await youtube(f);
  const timed = f.facade.play();
  f.expire();
  await assert.rejects(timed, error => error.name === 'NotAllowedError');
  const pending = f.facade.play();
  f.facade.destroy();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('malformed canonical YouTube IDs never construct a remote player', async t => {
  const f = fixture(t);
  f.facade.src = '/youtube/bad';
  f.facade.load();
  await turn();
  assert.equal(f.instances.length, 0);
  assert.equal(f.facade.error.youtubeCode, 2);
  assert.match(f.facade.error.message, /Некоректне/);
});

test('metadata waits for cue when onReady has no decoded duration yet', async t => {
  const f = fixture(t);
  f.facade.src = '/youtube/RoYXgdHafBA'; f.facade.load();
  await turn();
  const p = f.instances[0];
  p.duration = 0;
  p.ready();
  assert.equal(f.facade.readyState, 0);
  p.duration = 60;
  p.state(5);
  assert.equal(f.facade.readyState, 1);
  assert.equal(f.facade.duration, 60);
});

test('API completion after choosing native media cannot create a stale iframe', async t => {
  const f = fixture(t, { withApi: false });
  f.facade.src = '/youtube/RoYXgdHafBA'; f.facade.load();
  f.facade.src = '/media/session/new';
  f.window.YT = { Player: f.Player };
  f.window.onYouTubeIframeAPIReady();
  await turn();
  assert.equal(f.instances.length, 0);
  assert.equal(f.facade.src, 'http://localhost/media/session/new');
  assert.equal(f.container.hidden, true);
});

test('seek observation falls back to actual player time after a bounded grace period', async t => {
  const f = fixture(t);
  const p = await youtube(f);
  p.seekTo = value => p.seeks.push(value);
  f.facade.currentTime = 17.5;
  await turn();
  p.time = 24; // Playback jumped past the short target-observation window.
  assert.equal(f.facade.currentTime, 17.5);
  f.advanceClock(2001);
  assert.equal(f.facade.currentTime, 24);
});

test('a cued iframe with unknown duration preserves a nonzero reconnect seek', async t => {
  const f = fixture(t);
  f.facade.src = '/youtube/RoYXgdHafBA';
  f.facade.load();
  await turn();
  const iframe = f.instances[0];
  iframe.duration = 0;
  iframe.ready();
  iframe.state(5);
  assert.equal(Number.isNaN(f.facade.duration), true);
  const handlers = {};
  const socket = { connected: true, io: { on() {} }, on(event, handler) { handlers[event] = handler; } };
  const context = { window: {}, URL, location: { href: 'http://localhost/video' },
    AbortController, DOMException, setTimeout, performance };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/src/player-session.js'), 'utf8'), context);
  const session = context.window.createPlayerSession({ socket, video: f.facade });
  handlers['state snapshot']({ sessionId: 'session', revision: 1, paused: true, time: 17,
    volume: 1, effects: {}, media: { kind: 'youtube', url: '/youtube/RoYXgdHafBA' } });
  for (let attempt = 0; attempt < 20 && !session.isReady(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(session.isReady(), true);
  assert.equal(f.facade.currentTime, 17);
  assert.equal(iframe.seeks.at(-1), 17);
});

test('YouTube pause confirms the iframe PAUSED event and pending confirmation is bounded', async t => {
  const f = fixture(t);
  const iframe = await youtube(f);
  iframe.ready();
  let playing = f.facade.play(); iframe.state(1); await playing;
  let confirmed = false;
  const pausing = f.facade.pause().then(value => { confirmed = value; });
  await turn();
  assert.equal(confirmed, false);
  iframe.state(2);
  await pausing;
  assert.equal(confirmed, true);
  playing = f.facade.play(); iframe.state(1); await playing;
  const interrupted = f.facade.pause();
  const resumed = f.facade.play();
  assert.equal(await interrupted, false);
  iframe.state(1); await resumed;
  const expired = f.facade.pause();
  f.expire();
  assert.equal(await expired, false);
});
