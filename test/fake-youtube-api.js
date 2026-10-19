// Browser-test double: exercise IFrame API calls with local decodable media.
// It does not contact YouTube or prove that a public video permits embedding.
window.YT = {
  PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: class {
    constructor(mount, options) {
      this.events = options.events;
      this.state = -1;
      this.video = document.createElement('video');
      this.video.style.cssText = 'width:100%;height:100%';
      mount.replaceWith(this.video);
      for (const [name, state] of [['loadeddata', 5], ['play', 1], ['pause', 2], ['ended', 0]]) {
        this.video.addEventListener(name, () => {
          this.state = state;
          this.events.onStateChange?.({ target: this, data: state });
        });
      }
      this.video.addEventListener('error', () => this.events.onError?.({ target: this, data: 100 }));
      queueMicrotask(() => this.events.onReady?.({ target: this }));
    }
    cueVideoById(input) {
      const id = typeof input === 'string' ? input : input.videoId;
      this.video.src = '/youtube/' + id;
      this.video.load();
    }
    playVideo() { this.video.play().catch(() => this.events.onAutoplayBlocked?.({ target: this })); }
    pauseVideo() { this.video.pause(); }
    seekTo(time) { this.video.currentTime = time; }
    getCurrentTime() { return this.video.currentTime; }
    getDuration() { return this.video.duration; }
    getPlayerState() { return this.state; }
    setVolume(value) { this.video.volume = value / 100; }
    getVolume() { return this.video.volume * 100; }
    mute() { this.video.muted = true; }
    unMute() { this.video.muted = false; }
    getIframe() { return this.video; }
    destroy() { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video.remove(); }
  },
};
