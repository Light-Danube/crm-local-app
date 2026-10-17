'use strict';

function createOriginPolicy({ allowedOrigins, allowNoOrigin = true } = {}) {
  if (typeof allowNoOrigin !== 'boolean') throw new TypeError('allowNoOrigin must be boolean');
  const configured = allowedOrigins !== undefined;
  if (configured && (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0)) {
    throw new TypeError('allowedOrigins must be a nonempty array');
  }
  const origins = new Set(allowedOrigins || ['http://localhost:3000', 'http://127.0.0.1:3000']);
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new TypeError('Allowed origins must be exact HTTP(S) origins');
    }
  }
  const isAllowed = origin => origin === undefined ? allowNoOrigin : origins.has(origin);
  return {
    isAllowed,
    addLocalPort(port) {
      if (!configured) {
        origins.add(`http://localhost:${port}`);
        origins.add(`http://127.0.0.1:${port}`);
      }
    },
    middleware(req, res, next) {
      if (!isAllowed(req.get('origin'))) return res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed' } });
      next();
    },
    corsOrigin(origin, callback) { callback(null, isAllowed(origin)); },
  };
}

module.exports = { createOriginPolicy };
