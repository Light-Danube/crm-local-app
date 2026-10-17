const fs = require('node:fs/promises');
const path = require('node:path');

class MediaPathError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateMediaFilename(filename) {
  // Express has already decoded route parameters. Reject remaining escapes too,
  // so a later layer cannot reinterpret a nested encoded separator.
  if (typeof filename !== 'string' || filename.length === 0 ||
      filename === '.' || filename === '..' || /[/\\%\0]/.test(filename) ||
      path.isAbsolute(filename) || path.win32.isAbsolute(filename)) {
    throw new MediaPathError(400, 'Invalid media filename');
  }
}

async function resolveMediaPath(mediaRoot, filename) {
  validateMediaFilename(filename);
  try {
    const root = await fs.realpath(mediaRoot);
    const mediaPath = await fs.realpath(path.join(root, filename));
    const relative = path.relative(root, mediaPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new MediaPathError(403, 'Media path outside root');
    }
    const stat = await fs.stat(mediaPath);
    if (!stat.isFile()) throw new MediaPathError(403, 'Media is not a regular file');
    return { mediaPath, stat };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new MediaPathError(404, 'Media not found');
    }
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ELOOP') {
      throw new MediaPathError(403, 'Media unavailable');
    }
    throw error;
  }
}

module.exports = { MediaPathError, validateMediaFilename, resolveMediaPath };
