const { PassThrough, pipeline } = require('node:stream');
const sanitizeFilename = require('sanitize-filename');

function createYoutubeHandler({ ytdl, maxConcurrent = 2, timeoutMs = 15000, maxRequests = 10, windowMs = 60000, now = Date.now }) {
  for (const [name, value] of Object.entries({ maxConcurrent, timeoutMs, maxRequests, windowMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  if (typeof ytdl !== 'function') throw new TypeError('ytdl must be a function');
  let active = 0;
  // Fail closed when the bounded address table is full; never evict a live quota.
  const clients = new Map();
  const maxClients = 1024;

  return function youtubeHandler(req, res) {
    const videoId = req.params.videoId;
    if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).send('Invalid YouTube video ID');
    }
    const timestamp = now();
    for (const [address, entry] of clients) {
      if (timestamp >= entry.expires) clients.delete(address);
    }
    const address = req.socket.remoteAddress || 'unknown';
    let entry = clients.get(address);
    if (!entry) {
      if (clients.size >= maxClients) return res.status(503).send('YouTube service busy');
      entry = { requests: 0, expires: timestamp + windowMs };
      clients.set(address, entry);
    }
    if (entry.requests >= maxRequests) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.expires - timestamp) / 1000))));
      return res.status(429).send('Too many YouTube requests');
    }
    entry.requests++;
    if (active >= maxConcurrent) return res.status(503).send('YouTube service busy');
    active++;

    const controller = new AbortController();
    const requests = new Set();
    const bridge = new PassThrough();
    let upstream;
    let settled = false;
    const timer = setTimeout(() => finish(504, 'YouTube request timed out'), timeoutMs);
    timer.unref();

    function cancelMetadata(request) {
      if (!request.destroyed) request.destroy();
      // miniget 4 overrides _destroy without completing its callback: destroy
      // closes its socket but does not reject text(). Let ytdl install text's
      // error listener, then settle that promise as well (including late work).
      queueMicrotask(() => {
        if (request.listenerCount('error')) {
          request.emit('error', Object.assign(new Error('YouTube request cancelled'), { code: 'ABORT_ERR' }));
        }
      });
    }
    function finish(status, message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active--;
      req.removeListener('aborted', onAbort);
      res.removeListener('close', onClose);
      res.removeListener('finish', onFinish);
      if (upstream) upstream.removeListener('info', onInfo);
      bridge.unpipe(res);
      controller.abort();
      for (const request of requests) cancelMetadata(request);
      requests.clear();
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (!bridge.destroyed) bridge.destroy();
      if (status && !res.destroyed) {
        if (res.headersSent) res.destroy();
        else {
          res.removeHeader('Content-Disposition');
          res.removeHeader('Content-Type');
          res.status(status).send(message);
        }
      }
    }
    function onAbort() { finish(); }
    function onClose() { finish(); }
    function onFinish() { finish(); }
    function onInfo(info) {
      if (settled || res.headersSent) return;
      const title = sanitizeFilename(String(info?.videoDetails?.title || 'video')).slice(0, 150) || 'video';
      res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(title.toWellFormed())}.mp4"`);
    }
    req.once('aborted', onAbort);
    res.once('close', onClose);
    res.once('finish', onFinish);
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="video.mp4"');

    try {
      // ytdl obtains metadata internally. Its output's destroy() alone does not
      // cancel metadata: capture those miniget requests and abort their sockets.
      // The signal also prevents late metadata requests from opening sockets.
      upstream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
        filter: format => format.container === 'mp4' && format.hasAudio && format.hasVideo,
        requestOptions: { signal: controller.signal, maxRetries: 0, maxReconnects: 0 },
        requestCallback(request) {
          if (settled) {
            cancelMetadata(request);
            return;
          }
          requests.add(request);
          request.once('close', () => requests.delete(request));
          request.once('end', () => requests.delete(request));
        },
      });
      upstream.once('info', onInfo);
      // Keep the HTTP response outside the pipeline so an early upstream error
      // can still return a useful status instead of destroying its socket.
      bridge.pipe(res);
      pipeline(upstream, bridge, error => {
        if (error) finish(502, 'Error fetching YouTube video');
      });
    } catch {
      finish(502, 'Error fetching YouTube video');
    }
  };
}

module.exports = { createYoutubeHandler };
