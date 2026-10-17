'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const multer = require('multer');
const { resolveMediaPath } = require('./media-path');

const defaults = {
  maxFileBytes: 100 * 1024 * 1024,
  maxConcurrent: 2,
  maxSessionBytes: 500 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxSessionFiles: 10,
};
const formats = { 'video/mp4': '.mp4', 'video/webm': '.webm' };
const fail = (status, message) => Object.assign(new Error(message), { status });

function vint(buffer, offset, keepMarker = false) {
  const first = buffer[offset];
  if (!first) return null;
  let length = 1;
  while (length <= 8 && !(first & (128 >> (length - 1)))) length++;
  if (length > 8 || offset + length > buffer.length) return null;
  let value = keepMarker ? first : first & ((128 >> (length - 1)) - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buffer[offset + i];
  return Number.isSafeInteger(value) ? { value, length } : null;
}

// Container signatures only; actual codecs/decoding require a browser playback check.
function matchesFormat(buffer, mime, size) {
  if (mime === 'video/mp4') {
    return buffer.length >= 16 && buffer.subarray(4, 8).equals(Buffer.from('ftyp')) &&
      buffer.readUInt32BE(0) >= 16 && buffer.readUInt32BE(0) <= size;
  }
  if (mime !== 'video/webm' || buffer.length < 5 || buffer.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const header = vint(buffer, 4);
  if (!header) return false;
  const end = 4 + header.length + header.value;
  if (end > buffer.length) return false;
  let offset = 4 + header.length;
  let webm = false;
  while (offset < end) {
    const id = vint(buffer, offset, true);
    if (!id) return false;
    offset += id.length;
    const length = vint(buffer, offset);
    if (!length) return false;
    offset += length.length;
    if (offset + length.value > end) return false;
    if (id.value === 0x4282) webm = buffer.subarray(offset, offset + length.value).equals(Buffer.from('webm'));
    offset += length.value;
  }
  return webm;
}

function createMediaService({ mediaRoot, authenticate, notify = () => {}, limits = {} }) {
  if (typeof mediaRoot !== 'string' || typeof authenticate !== 'function') throw new TypeError('Media root and authentication are required');
  limits = { ...defaults, ...limits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Media limits must be positive safe integers');
  }
  mediaRoot = path.resolve(mediaRoot);
  const records = new Map();
  const usage = new Map();
  let storedBytes = 0;
  let reservedBytes = 0;
  let active = 0;
  // Existing files consume disk even though process-local sessions do not survive a restart.
  const ready = (async () => {
    await fs.mkdir(mediaRoot, { recursive: true });
    for (const entry of await fs.readdir(mediaRoot, { withFileTypes: true })) {
      if (entry.isFile()) storedBytes += (await fs.stat(path.join(mediaRoot, entry.name))).size;
    }
  })();
  // A startup failure is reported to requests, without an unhandled rejection.
  ready.catch(() => {});

  function respondError(res, error) {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    const status = error.status || (error.code === 'UNAUTHORIZED' ? 401 :
      error.code === 'LIMIT_FILE_SIZE' ? 413 : error instanceof multer.MulterError ? 400 : 500);
    const code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' :
      status === 413 ? 'MEDIA_LIMIT' : status === 429 ? 'UPLOAD_CAPACITY' : 'MEDIA_ERROR';
    const message = status === 401 ? 'Invalid session credentials' : status === 500 ? 'Media unavailable' : error.message;
    res.status(status).json({ error: { code, message } });
  }

  const storage = {
    _handleFile(req, file, callback) {
      const writing = (async () => {
        const extension = formats[file.mimetype];
        if (!extension) throw fail(415, 'Unsupported video type');
        let handle;
        let filename;
        // Exclusive creation is mandatory even if UUID generation ever collides.
        for (let attempt = 0; attempt < 5; attempt++) {
          filename = randomUUID() + extension;
          try { handle = await fs.open(path.join(mediaRoot, filename), 'wx', 0o600); break; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        if (!handle) throw fail(503, 'Unable to allocate media');
        const filePath = path.join(mediaRoot, filename);
        req.mediaPaths.add(filePath);
        let size = 0;
        let prefix = Buffer.alloc(0);
        const signal = req.mediaAbort.signal;
        try {
          const inspect = new Transform({
            transform(chunk, encoding, done) {
              size += chunk.length;
              if (size > limits.maxFileBytes) return done(fail(413, 'Video is too large'));
              if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
              done(null, chunk);
            },
          });
          await pipeline(file.stream, inspect, handle.createWriteStream(), { signal });
          if (file.stream.truncated) throw fail(413, 'Video is too large');
          if (!matchesFormat(prefix, file.mimetype, size)) throw fail(415, 'Video container does not match its type');
          return { path: filePath, filename, mediaId: filename, size, mimetype: file.mimetype };
        } catch (error) {
          await handle.close().catch(() => {});
          await fs.unlink(filePath).catch(() => {});
          throw error;
        }
      })();
      req.mediaWrites.add(writing);
      writing.then(result => callback(null, result), callback);
    },
    _removeFile(req, file, callback) { fs.unlink(file.path).then(() => callback(null), callback); },
  };
  const receive = multer({ storage, limits: { fileSize: limits.maxFileBytes, files: 1, fields: 0, parts: 1 } }).single('video');

  async function upload(req, res) {
    let reservation;
    let onAbort;
    try {
      const session = await authenticate(req);
      if (!session || typeof session.id !== 'string') throw fail(401, 'Invalid session');
      await ready;
      if (req.aborted) return;
      const used = usage.get(session.id) || { bytes: 0, files: 0, reserved: 0, pending: 0 };
      if (active >= limits.maxConcurrent) throw fail(429, 'Upload capacity reached');
      if (used.files + used.pending >= limits.maxSessionFiles ||
          used.bytes + used.reserved + limits.maxFileBytes > limits.maxSessionBytes ||
          storedBytes + reservedBytes + limits.maxFileBytes > limits.maxTotalBytes) {
        throw fail(413, 'Media quota exceeded');
      }
      usage.set(session.id, used);
      active++;
      reservedBytes += limits.maxFileBytes;
      used.reserved += limits.maxFileBytes;
      used.pending++;
      reservation = used;
      req.mediaPaths = new Set();
      req.mediaWrites = new Set();
      req.mediaAbort = new AbortController();
      await new Promise((resolve, reject) => {
        onAbort = () => {
          req.mediaAbort.abort();
          reject(fail(400, 'Upload aborted'));
        };
        req.once('aborted', onAbort);
        receive(req, res, error => error ? reject(error) : resolve());
      });
      if (req.aborted) throw fail(400, 'Upload aborted');
      if (!req.file) throw fail(400, 'A video file is required');
      const file = req.file;
      const media = { mediaId: file.mediaId, url: `/media/${encodeURIComponent(session.id)}/${file.mediaId}`, mime: file.mimetype };
      records.set(file.mediaId, { sessionId: session.id, filename: file.filename, mime: file.mimetype });
      used.bytes += file.size;
      used.files++;
      storedBytes += file.size;
      req.mediaPaths.clear();
      // Notifications cannot turn an already accepted file into an ambiguous upload failure.
      try { await notify(session, media); } catch { /* acceptance is independent of notification delivery */ }
      res.status(201).json(media);
    } catch (error) {
      if (req.mediaWrites) await Promise.allSettled([...req.mediaWrites]);
      if (req.mediaPaths) await Promise.all([...req.mediaPaths].map(file => fs.unlink(file).catch(() => {})));
      respondError(res, error);
    } finally {
      if (onAbort) req.off('aborted', onAbort);
      if (reservation) {
        active--;
        reservedBytes -= limits.maxFileBytes;
        reservation.reserved -= limits.maxFileBytes;
        reservation.pending--;
      }
    }
  }

  async function serve(req, res) {
    try {
      const session = await authenticate(req);
      if (!session || session.id !== req.params.sessionId) throw fail(403, 'Media belongs to another session');
      const media = records.get(req.params.mediaId);
      if (!media || media.sessionId !== session.id) throw fail(404, 'Media not found');
      const { mediaPath } = await resolveMediaPath(mediaRoot, media.filename);
      res.set({ 'Content-Type': media.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store' });
      res.sendFile(mediaPath, error => { if (error) respondError(res, error); });
    } catch (error) { respondError(res, error); }
  }
  return { upload, serve, ready };
}

module.exports = { createMediaService };
