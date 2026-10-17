'use strict';

const { validateEvent } = require('./socket-payloads');
const { extractYouTubeId } = require('../public/src/video-url');

const effectEvents = {
  'toggle loop': 'loop',
  'toggle inversion': 'inversion',
  'optimize color': 'color',
  'toggle enhance details': 'details',
  'toggle back details': 'background',
};

function invalid(code, message) {
  return Object.assign(new Error(message), { code });
}

function youtubeMedia(value) {
  const id = extractYouTubeId(value);
  if (!id) throw invalid('INVALID_VIDEO_URL', 'Enter a supported YouTube video URL');
  return { kind: 'youtube', url: `/youtube/${id}` };
}

// Anchored playback time is measured in seconds; now() supplies milliseconds.
function createPlaybackState({ now = Date.now } = {}) {
  let lastClock = 0;
  function clock() {
    const value = now();
    if (Number.isFinite(value)) lastClock = Math.max(lastClock, value);
    return lastClock;
  }
  let anchor = clock();
  const state = {
    media: null,
    time: 0,
    paused: true,
    volume: 1,
    effects: { loop: false, inversion: false, color: false, details: false, background: false },
    revision: 0,
  };

  function currentTime(time) {
    return state.time + (state.paused ? 0 : Math.max(0, time - anchor) / 1000);
  }
  function snapshot() {
    return {
      ...state,
      time: currentTime(clock()),
      media: state.media && { ...state.media },
      effects: { ...state.effects },
    };
  }
  function media(value) {
    if (value !== null && (typeof value !== 'object' || Array.isArray(value) ||
        !['local', 'youtube'].includes(value.kind) || typeof value.url !== 'string' || !value.url ||
        (value.mediaId !== undefined && typeof value.mediaId !== 'string'))) {
      throw invalid('INVALID_PAYLOAD', 'Invalid media');
    }
    state.media = value === null ? null : {
      kind: value.kind, url: value.url,
      ...(value.mediaId === undefined ? {} : { mediaId: value.mediaId }),
    };
    state.time = 0;
    state.paused = true;
    anchor = clock();
    state.revision += 1;
    return snapshot();
  }
  function command(event, payload) {
    if (!['player start', 'player pause', 'stop', 'player timeupdate', 'player volumeupdate',
      'video url', ...Object.keys(effectEvents)].includes(event)) {
      throw invalid('INVALID_COMMAND', 'Unknown playback command');
    }
    if (event === 'video url') return media(youtubeMedia(payload));
    if (!validateEvent(event, [payload])) throw invalid('INVALID_PAYLOAD', 'Invalid playback command');
    const time = clock();
    state.time = currentTime(time);
    anchor = time;
    if (event === 'player start') state.paused = false;
    else if (event === 'player pause') state.paused = true;
    else if (event === 'stop') { state.time = 0; state.paused = true; }
    else if (event === 'player timeupdate') state.time = payload;
    else if (event === 'player volumeupdate') state.volume = payload;
    else state.effects[effectEvents[event]] = payload;
    state.revision += 1;
    return snapshot();
  }
  return { snapshot, command, media };
}

module.exports = { createPlaybackState };
