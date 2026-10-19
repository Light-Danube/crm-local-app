/* Native local video and official YouTube IFrame API playback share one boundary. */
(() => {
  'use strict';
  const deadline = 15000;
  let apiPromise;
  function youtubeApi() {
    if (typeof window.YT?.Player === 'function') return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const previousReady = window.onYouTubeIframeAPIReady;
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('YouTube API не відповідає. Перевірте з’єднання та блокування вмісту.')), deadline);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        script.removeEventListener('error', failed);
        if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previousReady;
        if (error) {
          script.remove();
          reject(error);
        } else resolve(window.YT);
      }
      function failed() { finish(new Error('Не вдалося завантажити YouTube API. Перевірте з’єднання та блокування вмісту.')); }
      function ready() {
        try { previousReady?.(); } catch { /* Another consumer must not block this player. */ }
        if (typeof window.YT?.Player !== 'function') failed();
        else finish();
      }
      window.onYouTubeIframeAPIReady = ready;
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      script.addEventListener('error', failed, { once: true });
      try { document.head.appendChild(script); } catch (error) { finish(error); }
    });
    // A failed API load can be retried by selecting a source again.
    const attempt = apiPromise;
    void attempt.catch(() => { if (apiPromise === attempt) apiPromise = undefined; });
    return attempt;
  }

  const youtubeErrors = {
    2: 'Некоректне посилання на відео YouTube.',
    5: 'YouTube не зміг відтворити відео в цьому браузері.',
    100: 'Відео YouTube недоступне, приватне або видалене.',
    101: 'Автор відео заборонив вбудоване відтворення YouTube.',
    150: 'Автор відео заборонив вбудоване відтворення YouTube.',
    153: 'YouTube не підтвердив сайт відтворення. Перевірте налаштування Referer.',
  };
  const aborted = () => new DOMException('Відтворення скасовано через зміну медіа.', 'AbortError');
  const autoplay = () => new DOMException('Браузер заблокував YouTube. Натисніть кнопку відтворення ще раз.', 'NotAllowedError');

  window.createMediaPlayer = function createMediaPlayer({ video, youtubeContainer }) {
    if (!video || !youtubeContainer) throw new TypeError('Native video and YouTube container are required');
    const facade = new EventTarget();
    let mode = 'local';
    let source = '';
    let id;
    let generation = 0;
    let destroyed = false;
    let started = false;
    let player;
    let apiReady = false;
    let metadataTimer;
    let stateReady = 0;
    let stateError = null;
    let metadataSent = false;
    let currentSource = '';
    let requestedTime = 0;
    let seekRequest;
    let requestedMuted = Boolean(video.muted);
    let requestedVolume = Number.isFinite(video.volume) ? video.volume : 1;
    let requestedLoop = Boolean(video.loop);
    let paused = true;
    let lastPaused = true;
    let wantsPlay = false;
    let playJob;
    let display = video.style.display || 'block';
    const nativeListeners = [];
    const emit = event => facade.dispatchEvent(new Event(event));
    const valid = epoch => !destroyed && mode === 'youtube' && generation === epoch;
    function visible() {
      video.hidden = mode === 'youtube';
      youtubeContainer.hidden = mode !== 'youtube';
      video.style.display = mode === 'youtube' ? 'none' : display;
      youtubeContainer.style.display = mode === 'youtube' ? display : 'none';
    }
    function settlePlay(error) {
      if (!playJob) return;
      const job = playJob;
      playJob = undefined;
      clearTimeout(job.timer);
      if (error) job.reject(error); else job.resolve();
    }
    function reset() {
      generation++;
      clearTimeout(metadataTimer);
      metadataTimer = undefined;
      settlePlay(aborted());
      const previous = player;
      player = undefined;
      apiReady = false;
      started = false;
      stateReady = 0;
      stateError = null;
      metadataSent = false;
      currentSource = '';
      requestedTime = 0;
      seekRequest = undefined;
      paused = lastPaused = true;
      wantsPlay = false;
      try { previous?.destroy(); } catch { /* A removed iframe may already be gone. */ }
      youtubeContainer.replaceChildren();
    }
    function fail(error, youtubeCode) {
      clearTimeout(metadataTimer);
      metadataTimer = undefined;
      stateError = { code: youtubeCode === 5 ? 3 : 4, message: error.message,
        ...(youtubeCode === undefined ? {} : { youtubeCode }) };
      stateReady = 0;
      wantsPlay = false;
      paused = true;
      settlePlay(error);
      emit('error');
    }
    function playback(nextPaused) {
      paused = nextPaused;
      if (lastPaused === nextPaused) return;
      lastPaused = nextPaused;
      emit(nextPaused ? 'pause' : 'play');
    }
    function metadata(epoch) {
      if (!valid(epoch) || metadataSent) return;
      clearTimeout(metadataTimer);
      metadataTimer = undefined;
      stateReady = 1;
      stateError = null;
      currentSource = source;
      metadataSent = true;
      emit('loadedmetadata');
      emit('durationchange');
    }
    async function loadYoutube() {
      if (destroyed || mode !== 'youtube' || started) return;
      reset();
      const epoch = generation;
      started = true;
      if (!id) {
        fail(new Error(youtubeErrors[2]), 2);
        started = false;
        return;
      }
      try {
        const YT = await youtubeApi();
        if (!valid(epoch)) return;
        const slot = document.createElement('div');
        youtubeContainer.replaceChildren(slot);
        metadataTimer = setTimeout(() => {
          if (valid(epoch)) fail(new Error('Не вдалося підготувати відео YouTube. Перевірте доступність відео та з’єднання.'));
        }, deadline);
        player = new YT.Player(slot, {
          host: 'https://www.youtube.com', width: '100%', height: '100%', videoId: id,
          playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
          events: {
            onReady(event) {
              if (!valid(epoch)) return;
              player = event.target;
              apiReady = true;
              player.getIframe?.()?.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
              const iframe = player.getIframe?.();
              iframe?.setAttribute('title', 'Відео YouTube');
              const allow = iframe?.getAttribute?.('allow') || '';
              if (!/(?:^|;)\s*autoplay(?:\s|;|$)/.test(allow)) {
                iframe?.setAttribute('allow', allow ? `${allow}; autoplay` : 'autoplay');
              }
              if (requestedMuted) player.mute(); else player.unMute();
              player.setVolume(requestedVolume * 100);
              player.cueVideoById({ videoId: id, startSeconds: requestedTime });
              if (Number.isFinite(player.getDuration()) && player.getDuration() > 0) metadata(epoch);
              if (wantsPlay) player.playVideo();
            },
            onStateChange(event) {
              if (!valid(epoch)) return;
              if (event.data === 5) metadata(epoch);
              else if (event.data === 1) {
                if (!wantsPlay) { player?.pauseVideo(); return; }
                metadata(epoch);
                playback(false);
                settlePlay();
              } else if (event.data === 2) playback(true);
              else if (event.data === 0) {
                if (requestedLoop && wantsPlay) {
                  player.seekTo(0, true);
                  player.playVideo();
                } else {
                  wantsPlay = false;
                  playback(true);
                  emit('ended');
                }
              }
            },
            onAutoplayBlocked() {
              if (!valid(epoch)) return;
              wantsPlay = false;
              paused = true;
              settlePlay(autoplay());
            },
            onError(event) {
              if (!valid(epoch)) return;
              fail(new Error(youtubeErrors[event.data] || 'Не вдалося відтворити відео YouTube.'), event.data);
            },
          },
        });
      } catch (error) {
        if (valid(epoch)) { fail(error); started = false; }
      }
    }
    function setSource(value) {
      if (destroyed) return;
      const url = value ? new URL(String(value), location.href) : null;
      const youtube = url?.origin === location.origin && url.pathname.startsWith('/youtube/');
      if (youtube && mode === 'youtube' && source === url.href && !stateError) return;
      // Stop old native playback before hiding it; queued native events are ignored
      // as soon as the active surface changes to YouTube.
      mode = youtube ? 'youtube' : 'local';
      reset();
      id = youtube ? /^\/youtube\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1] : undefined;
      source = youtube ? url.href : '';
      visible();
      if (youtube) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } else if (url) {
        video.volume = requestedVolume;
        video.loop = requestedLoop;
        video.muted = requestedMuted;
        video.src = String(value);
      } else video.removeAttribute('src');
      emit('sourcechange');
    }
    const style = new Proxy(video.style, {
      get(target, key) {
        if (key === 'display') return display;
        if (key === 'setProperty') return (name, value, priority) => {
          target.setProperty(name, value, priority);
          youtubeContainer.style.setProperty(name, value, priority);
          if (name === 'display') { display = value; visible(); }
        };
        if (key === 'removeProperty') return name => {
          const previous = target.removeProperty(name);
          youtubeContainer.style.removeProperty(name);
          if (name === 'display') { display = 'block'; visible(); }
          return previous;
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) {
        if (key === 'display') { display = value; visible(); }
        else { target[key] = value; youtubeContainer.style[key] = value; }
        return true;
      },
    });
    Object.defineProperties(facade, {
      src: { get: () => mode === 'youtube' ? source : video.src, set: setSource },
      currentSrc: { get: () => mode === 'youtube' ? currentSource : video.currentSrc },
      isYouTube: { get: () => mode === 'youtube' },
      readyState: { get: () => mode === 'youtube' ? stateReady : video.readyState },
      duration: { get: () => {
        if (mode !== 'youtube') return video.duration;
        const value = apiReady ? player.getDuration() : NaN;
        return value > 0 ? value : NaN;
      } },
      currentTime: {
        get() {
          if (mode !== 'youtube') return video.currentTime;
          const actual = apiReady ? player.getCurrentTime() : requestedTime;
          if (seekRequest) {
            if (!seekRequest.reported || (Math.abs(actual - seekRequest.time) > 0.5 && performance.now() < seekRequest.expires)) return seekRequest.time;
            seekRequest = undefined;
          }
          return actual;
        },
        set(value) {
          if (mode !== 'youtube') { video.currentTime = value; return; }
          if (!Number.isFinite(value) || value < 0) throw new TypeError('Playback time must be a nonnegative finite number');
          requestedTime = value;
          const request = seekRequest = { time: value, reported: false, expires: performance.now() + 2000 };
          const epoch = generation;
          if (apiReady) player.seekTo(value, true);
          emit('seeking');
          queueMicrotask(() => {
            if (!valid(epoch) || seekRequest !== request) return;
            emit('seeked');
            request.reported = true;
          });
        },
      },
      paused: { get: () => mode === 'youtube' ? paused : video.paused },
      volume: {
        get: () => mode === 'youtube' ? requestedVolume : video.volume,
        set(value) {
          if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('Volume must be between zero and one');
          requestedVolume = value;
          if (mode === 'youtube') { if (apiReady) player.setVolume(value * 100); emit('volumechange'); }
          else video.volume = value;
        },
      },
      muted: {
        get: () => mode === 'youtube' ? requestedMuted : video.muted,
        set(value) {
          requestedMuted = Boolean(value);
          if (mode === 'youtube') {
            if (apiReady) { if (requestedMuted) player.mute(); else player.unMute(); }
          } else video.muted = requestedMuted;
        },
      },
      loop: {
        get: () => mode === 'youtube' ? requestedLoop : video.loop,
        set(value) { requestedLoop = Boolean(value); if (mode !== 'youtube') video.loop = requestedLoop; },
      },
      error: { get: () => mode === 'youtube' ? stateError : video.error },
      style: { value: style },
    });
    facade.load = () => { if (mode === 'youtube') void loadYoutube(); else video.load(); };
    facade.pause = () => {
      if (mode !== 'youtube') { video.pause(); return; }
      wantsPlay = false;
      paused = true;
      settlePlay(aborted());
      if (apiReady) player.pauseVideo();
    };
    facade.play = () => {
      if (destroyed) return Promise.reject(aborted());
      if (mode !== 'youtube') return video.play();
      if (stateError) return Promise.reject(new Error(stateError.message));
      if (!paused) return Promise.resolve();
      if (playJob) return playJob.promise;
      if (!started) void loadYoutube();
      if (stateError) return Promise.reject(new Error(stateError.message));
      wantsPlay = true;
      const promise = new Promise((resolve, reject) => {
        playJob = { resolve, reject, timer: setTimeout(() => {
          wantsPlay = false;
          paused = true;
          settlePlay(autoplay());
        }, deadline) };
      });
      playJob.promise = promise;
      if (apiReady) {
        try { player.playVideo(); } catch (error) { settlePlay(error); }
      }
      return promise;
    };
    facade.hasAttribute = name => name === 'src' && mode === 'youtube' ? Boolean(source) : video.hasAttribute(name);
    facade.removeAttribute = name => { if (name === 'src') setSource(''); else video.removeAttribute(name); };
    facade.destroy = () => {
      if (destroyed) return;
      destroyed = true;
      reset();
      video.pause();
      for (const [event, listener] of nativeListeners) video.removeEventListener(event, listener);
    };
    for (const event of ['play', 'pause', 'seeking', 'seeked', 'loadedmetadata', 'durationchange', 'timeupdate', 'ended', 'volumechange', 'error', 'loadeddata', 'canplay']) {
      const listener = () => {
        if (destroyed || mode !== 'local') return;
        if (event === 'volumechange') { requestedVolume = video.volume; requestedMuted = video.muted; }
        emit(event);
      };
      video.addEventListener(event, listener);
      nativeListeners.push([event, listener]);
    }
    visible();
    return facade;
  };
})();
