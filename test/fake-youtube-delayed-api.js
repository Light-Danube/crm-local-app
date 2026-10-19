// Local IFrame API double. Delays simulate independent iframe startup, not live YouTube.
window.YT = {
  Player: class {
    constructor(mount, options) {
      this.events = options.events;
      this.video = document.createElement('video');
      this.video.style.cssText = 'width:100%;height:100%';
      this.jobs = new Set();
      this.destroyed = false;
      this.playJob = this.pauseJob = undefined;
      mount.replaceWith(this.video);
      for (const [name, state] of [['loadeddata', 5], ['playing', 1], ['pause', 2], ['ended', 0]]) {
        this.video.addEventListener(name, () => {
          if (!this.destroyed) this.events.onStateChange?.({ target: this, data: state });
        });
      }
      this.video.addEventListener('error', () => this.events.onError?.({ target: this, data: 100 }));
      queueMicrotask(() => { if (!this.destroyed) this.events.onReady?.({ target: this }); });
    }
    later(action, delay) {
      const job = setTimeout(() => { this.jobs.delete(job); if (!this.destroyed) action(); }, delay);
      this.jobs.add(job);
      return job;
    }
    cancel(job) { clearTimeout(job); this.jobs.delete(job); }
    cueVideoById(input) {
      const id = typeof input === 'string' ? input : input.videoId;
      this.video.addEventListener('loadedmetadata', () => { this.video.currentTime = typeof input === 'string' ? 0 : (input.startSeconds || 0); }, { once: true });
      this.video.src = '/youtube/' + id;
      this.video.load();
    }
    playVideo() {
      this.cancel(this.pauseJob);
      this.cancel(this.playJob);
      this.playJob = this.later(() => this.video.play().catch(() => this.events.onAutoplayBlocked?.({ target: this })), window.fakeYoutubeDelays?.playMs || 0);
    }
    pauseVideo() {
      this.cancel(this.playJob);
      this.cancel(this.pauseJob);
      if (this.video.paused) return;
      this.pauseJob = this.later(() => this.video.pause(), window.fakeYoutubeDelays?.pauseMs || 0);
    }
    seekTo(time) { this.video.currentTime = time; }
    getCurrentTime() { return this.video.currentTime; }
    getDuration() { return this.video.duration; }
    getPlayerState() { return this.video.paused ? 2 : 1; }
    setVolume(value) { this.video.volume = value / 100; }
    mute() { this.video.muted = true; }
    unMute() { this.video.muted = false; }
    getIframe() { return this.video; }
    destroy() {
      this.destroyed = true;
      for (const job of this.jobs) clearTimeout(job);
      this.jobs.clear();
      this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video.remove();
    }
  },
};
