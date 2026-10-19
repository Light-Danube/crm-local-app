/* Shared browser recovery and playback boundary. No credentials are persisted here. */
(() => {
  'use strict';
  window.createPlayerSession = function createPlayerSession({
    socket, video, statusElement, resumeButton, getSessionId,
    beforeSnapshot = () => Promise.resolve(), onSnapshot = () => {}, onExpired = () => {},
  }) {
    let ready = false;
    let applying = false;
    let revision = -1;
    let restoredSession;
    let restore;
    let generation = 0;
    let connectedOnce = false;
    const setStatus = text => { if (statusElement) statusElement.textContent = text; };
    const setResume = visible => { if (resumeButton) resumeButton.hidden = !visible; };
    let mediaFailed = false;
    video.addEventListener('error', () => {
      if ((!video.hasAttribute('src') && !video.currentSrc) || !video.error || video.error.code === 1) return;
      mediaFailed = true;
      setStatus('Не вдалося завантажити відео. Перевірте посилання, формат і з’єднання.');
    });
    video.addEventListener('loadedmetadata', () => {
      if (!mediaFailed) return;
      mediaFailed = false;
      if (resumeButton?.hidden === false) {
        setStatus('Натисніть «Відновити відтворення», щоб дозволити відео.');
      } else if (socket.connected) setStatus('Підключено');
    });
    const current = (job, epoch) => !job.signal.aborted && generation === epoch && socket.connected;
    const abortRestore = () => { generation++; restore?.abort(); restore = undefined; applying = false; };
    const authCodes = new Set(['UNAUTHORIZED', 'SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'INVALID_SESSION', 'CONTROLLER_OCCUPIED', 'DISPLAY_OCCUPIED']);

    async function attemptPlay(isCurrent = () => true) {
      try {
        await video.play();
        if (!isCurrent()) return false;
        setResume(false);
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        // Browser autoplay policy and media failures are observable, never rejected globally.
        setResume(true);
        setStatus(error?.name === 'NotAllowedError'
          ? 'Натисніть «Відновити відтворення», щоб дозволити відео.'
          : 'Не вдалося відтворити відео. Спробуйте відновити відтворення.');
        return false;
      }
    }
    function metadata(signal) {
      if (video.readyState >= 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', loaded);
          video.removeEventListener('error', failed);
          signal.removeEventListener('abort', aborted);
        };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Не вдалося завантажити відео.')); };
        const aborted = () => { cleanup(); reject(new DOMException('Restore cancelled', 'AbortError')); };
        video.addEventListener('loadedmetadata', loaded, { once: true });
        video.addEventListener('error', failed, { once: true });
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
    async function applySnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object' || !Number.isInteger(snapshot.revision)) return;
      const expected = getSessionId?.();
      if (expected && expected !== snapshot.sessionId) return;
      if (snapshot.sessionId === restoredSession && snapshot.revision <= revision) return;
      abortRestore();
      restoredSession = snapshot.sessionId;
      revision = snapshot.revision;
      ready = false;
      applying = true;
      const job = restore = new AbortController();
      const epoch = generation;
      try {
        await beforeSnapshot(snapshot);
        if (!current(job, epoch)) return;
        video.pause();
        if (snapshot.media?.url) {
          const url = new URL(snapshot.media.url, location.href).href;
          if (video.currentSrc !== url && video.src !== url) {
            video.src = snapshot.media.url;
            video.load();
          }
          await metadata(job.signal);
          if (!current(job, epoch)) return;
          if (Number.isFinite(snapshot.time) && snapshot.time >= 0) {
            video.currentTime = Number.isFinite(video.duration)
              ? snapshot.effects?.loop && video.duration > 0
                ? snapshot.time % video.duration : Math.min(snapshot.time, video.duration)
              : snapshot.time;
          }
        } else if (video.hasAttribute('src')) {
          video.removeAttribute('src');
          video.load();
        }
        if (Number.isFinite(snapshot.volume)) video.volume = Math.max(0, Math.min(1, snapshot.volume));
        video.loop = Boolean(snapshot.effects?.loop);
        await onSnapshot(snapshot);
        if (!current(job, epoch)) return;
        if (snapshot.media && !snapshot.paused) await attemptPlay(() => current(job, epoch));
        else { video.pause(); setResume(false); }
        if (!current(job, epoch)) return;
        // Native play, pause and seeking events are queued; keep them inside restore.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!current(job, epoch)) return;
        ready = true;
        if (resumeButton?.hidden !== false) setStatus('Підключено');
      } catch (error) {
        if (error?.name !== 'AbortError' && current(job, epoch)) {
          setStatus(error.message || 'Не вдалося відновити стан. Повторіть підключення.');
        }
      } finally {
        if (restore === job) { applying = false; restore = undefined; }
      }
    }
    socket.on('state snapshot', snapshot => { void applySnapshot(snapshot); });
    socket.on('connect', () => {
      connectedOnce = true;
      ready = false;
      // Reconnection can legitimately send the same persisted revision again.
      revision = -1;
      setStatus('Підключено. Відновлення стану…');
    });
    socket.on('disconnect', reason => {
      ready = false;
      abortRestore();
      socket.sendBuffer.length = 0;
      setStatus(reason === 'io server disconnect' ? 'Відключено' : 'З’єднання втрачено. Повторне підключення…');
      if (reason === 'io server disconnect') onExpired(new Error('Сесію завершено. Потрібне повторне підключення.'));
    });
    socket.io.on('reconnect_attempt', () => setStatus('Повторне підключення…'));
    socket.on('connect_error', error => {
      ready = false;
      abortRestore();
      socket.sendBuffer.length = 0;
      if (authCodes.has(error?.data?.code)) {
        setStatus('Сесію завершено. Створіть сесію або введіть новий код доступу.');
        onExpired(error);
      } else setStatus(connectedOnce ? 'Повторне підключення…' : 'Не вдалося підключитися. Повторна спроба…');
    });
    function playWhenReady() {
      if (!socket.connected || !ready || applying) return Promise.resolve(false);
      const epoch = generation;
      return attemptPlay(() => socket.connected && generation === epoch);
    }
    resumeButton?.addEventListener('click', () => { void playWhenReady(); });
    setResume(false);
    setStatus(socket.connected ? 'Підключено. Очікування стану…' : 'Підключення…');
    return {
      send(event, payload) {
        if (!socket.connected || !ready || applying) return false;
        if (arguments.length > 1) socket.emit(event, payload);
        else socket.emit(event);
        return true;
      },
      play: playWhenReady,
      isApplying: () => applying,
      isReady: () => ready,
    };
  };
})();
