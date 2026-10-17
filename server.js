const express = require('express');
const { createServer } = require('http');
const fs = require("fs");
const path = require('path');
const { Server } = require("socket.io");
const cors = require('cors');

const ytdl = require('ytdl-core');

const { validateEvent } = require('./lib/socket-payloads');
const { validateMediaFilename, resolveMediaPath } = require('./lib/media-path');
const { createSessionStore } = require('./lib/session-store');
const { createMediaService } = require('./lib/media-service');
const { createOriginPolicy } = require('./lib/origin-policy');
const { createYoutubeHandler } = require('./lib/youtube-route');

function createApplication(options = {}) {

const app = express();
const server = createServer(app);
const originPolicy = createOriginPolicy({ allowedOrigins: options.allowedOrigins, allowNoOrigin: options.allowNoOrigin });
const io = new Server(server, {
  cors: { origin: originPolicy.corsOrigin, credentials: true },
  allowRequest: (req, callback) => callback(null, originPolicy.isAllowed(req.headers.origin)),
});
io.engine.use((req, res, next) => {
  if (!originPolicy.isAllowed(req.headers.origin)) return next(new Error('Origin not allowed'));
  next();
});
const mediaRoot = options.mediaRoot || path.join(__dirname, 'uploads');

const sessionStore = createSessionStore(options.sessionOptions);

app.use(originPolicy.middleware);
app.use(cors({ origin: originPolicy.corsOrigin, credentials: true }));

function sessionHttpError(res, error) {
  const code = ['RATE_LIMITED', 'SESSION_LIMIT'].includes(error.code) ? error.code : 'UNAUTHORIZED';
  const status = code === 'RATE_LIMITED' ? 429 : code === 'SESSION_LIMIT' ? 503 : 401;
  res.status(status).json({ error: { code, message: code === 'UNAUTHORIZED' ? 'Invalid session credentials' : error.message } });
}

app.post('/api/sessions', (req, res) => {
  try {
    const { sessionId, ownerToken, pairingCode, expiresAt } = sessionStore.create();
    res.status(201).json({ sessionId, ownerToken, pairingCode, expiresAt });
  } catch (error) {
    sessionHttpError(res, error);
  }
});

app.post('/api/sessions/:sessionId/pairing', (req, res) => {
  try {
    const authorization = req.get('authorization');
    const token = typeof authorization === 'string' && /^Bearer ([^\s]+)$/.exec(authorization)?.[1];
    const session = sessionStore.authenticateOwner(req.params.sessionId, token);
    res.json(sessionStore.rotatePairing(session));
  } catch (error) {
    sessionHttpError(res, error);
  }
});

// Run before public static middleware, which otherwise normalizes dot segments
// and can redirect malformed media paths before the media routes see them.
app.use((req, res, next) => {
   const match = /^\/(?:videofile|uploads|video)\/(.*)$/i.exec(req.path);
   if (!match) return next();
   try {
     validateMediaFilename(decodeURIComponent(match[1]));
     next();
   } catch (error) {
     mediaError(res, error instanceof URIError ? { status: 400 } : error);
   }
});

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Redirect users to the /index route when they access the root URL
app.get('/', (req, res) => {
   res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle the selection made by the user and redirect to the appropriate page
app.get('/select', (req, res) => {
   const uploadType = req.query.type;

   if (uploadType === 'local' || uploadType === 'url') {
       // Redirect to the master.html page with the appropriate upload type
       res.redirect(`/master.html?type=${uploadType}`);
   } else {
       // Redirect to the master.html page with the default upload type (local)
       res.redirect('/master.html?type=local');
   }
});

// Serve the master.html file
app.get('/master.html', (req, res) => {
   // Send the master.html file
   res.sendFile(path.join(__dirname, 'master.html'));
});



// Serve the video.html file with query parameters
app.get('/video.html', (req, res) => {
   // Extract the video parameter from the query string
   const videoParam = req.query.video;
   if (videoParam) {
       // If a video parameter is provided, render the video.html file with that parameter
       res.sendFile(path.join(__dirname, 'video.html'));
   } else {
       // If no video parameter is provided, send a 400 Bad Request response
       res.status(400).send('No video parameter provided');
   }
});

// Страница для проигрывания видео
app.get('/video', (req, res) => {
   res.sendFile(path.join(__dirname, 'video.html'));
});

// Legacy public media routes deliberately have no file-serving handlers.
function mediaError(res, error) {
  if (res.headersSent) return res.destroy();
  res.status(error.status || 400).send('Media unavailable');
}

function bearer(req) {
  return /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '')?.[1];
}
function authenticateMedia(req, ownerOnly = false) {
  const id = req.params.sessionId || req.query.sessionId;
  let token = bearer(req);
  if (!token && !ownerOnly) {
    token = (req.get('cookie') || '').split(';').map(value => value.trim())
      .find(value => value.startsWith('mediaAccess='))?.slice('mediaAccess='.length);
  }
  try { return sessionStore.authenticateOwner(id, token); }
  catch (error) {
    if (ownerOnly) throw error;
    return sessionStore.authenticateDisplay(id, token);
  }
}

// A path-scoped HttpOnly cookie lets the native video element authenticate requests
// without placing owner/display tokens in media URLs or exposing cookies to JS.
app.post('/api/sessions/:sessionId/media-access', (req, res) => {
  try {
    if (!bearer(req)) throw Object.assign(new Error(), { code: 'UNAUTHORIZED' });
    const session = authenticateMedia(req);
    const secure = options.secureCookies || req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `mediaAccess=${bearer(req)}; Path=/media/${session.id}/; HttpOnly; SameSite=Strict${secure}`);
    res.status(204).end();
  } catch (error) { sessionHttpError(res, error); }
});
const mediaService = createMediaService({
  mediaRoot,
  limits: options.mediaLimits,
  authenticate: req => authenticateMedia(req, req.method === 'POST'),
  notify: (session, media) => io.of('/playerControls').to(session.id).emit('file uploaded', media),
});
app.post('/upload', mediaService.upload);
app.get('/media/:sessionId/:mediaId', mediaService.serve);

// Metadata and media share a bounded deadline and cancellation lifecycle.
app.get('/youtube/:videoId', createYoutubeHandler({ ytdl: options.ytdl || ytdl, ...options.youtubeOptions }));

//LOGGING:
// Centralized logging configuration
const logDirectory = options.logDirectory || path.join(__dirname, 'logs'); // Create a "logs" directory if it doesn't exist
const logFileName = `connections-${new Date().toISOString().slice(0, 10)}.log`;
const logFilePath = path.join(logDirectory, logFileName);

const logStream = fs.createWriteStream(logFilePath, { flags: 'a' }); // Open log file in append mode

// Function to write a log message
async function log(message) {
  await logStream.write(`${message}\n`);
}

// Log socket metadata only: credentials and pairing codes never enter logs.
async function logCurrentConnections() {
  await log(`** Current Connections (${new Date().toLocaleString()}):\n`);
  for (const session of sessionStore.sessions.values()) {
    await log(`- Controller: ${session.controllerSocketId || '-'}; Display: ${session.displaySocketId || '-'}\n`);
  }
}

const controls = io.of('/playerControls');
function sessionFailure(socket, code, message, event) {
  socket.emit('session error', { code, message, ...(event ? { event } : {}) });
}
function updateDisplayCount(session) {
  if (session.controllerSocketId) {
    controls.to(session.controllerSocketId).emit('updatePuppets', session.displaySocketId || '');
  }
}

controls.use((socket, next) => {
  const auth = socket.handshake.auth;
  if (auth && typeof auth === 'object' && !Array.isArray(auth) && Object.keys(auth).length === 0) {
    socket.data.role = 'pending';
    return next();
  }
  try {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) ||
        !['controller', 'display'].includes(auth.role)) {
      throw Object.assign(new Error('Invalid session credentials'), { code: 'UNAUTHORIZED' });
    }
    const session = auth.role === 'controller'
      ? sessionStore.authenticateOwner(auth.sessionId, auth.token)
      : sessionStore.authenticateDisplay(auth.sessionId, auth.token);
    const field = auth.role === 'controller' ? 'controllerSocketId' : 'displaySocketId';
    if (session[field]) {
      throw Object.assign(new Error(`A ${auth.role} is already connected`), {
        code: auth.role === 'controller' ? 'CONTROLLER_OCCUPIED' : 'DISPLAY_OCCUPIED',
      });
    }
    session[field] = socket.id;
    socket.data.role = auth.role;
    socket.data.session = session;
    next();
  } catch (error) {
    const rejected = new Error(error.message);
    rejected.data = { code: error.code || 'UNAUTHORIZED' };
    next(rejected);
  }
});

controls.on('connection', socket => {
  if (socket.data.role === 'display') {
    socket.join(socket.data.session.id);
    socket.emit('masterConnected', { sessionId: socket.data.session.id });
  }
  if (socket.data.session) updateDisplayCount(socket.data.session);
  void log(`** ${new Date().toLocaleString()} - Socket ${socket.id} connected`);

  socket.use(([event, ...args], next) => {
    if (!validateEvent(event, args)) {
      socket.emit('error', `Invalid payload for ${event}`);
      return;
    }
    const session = socket.data.session;
    const allowed = event === 'connectToMaster'
      ? socket.data.role === 'pending'
      : socket.data.role === 'controller' && session?.controllerSocketId === socket.id;
    if (!allowed) {
      sessionFailure(socket, 'FORBIDDEN', 'This role cannot perform this command', event);
      return;
    }
    next();
  });

  socket.on('connectToMaster', code => {
    try {
      const { session, sessionId, displayToken } = sessionStore.pair(
        code, socket.handshake.address,
        session => !session.displaySocketId && Boolean(session.controllerSocketId),
      );
      session.displaySocketId = socket.id;
      socket.data.role = 'display';
      socket.data.session = session;
      socket.join(session.id);
      socket.emit('masterConnected', { sessionId, displayToken });
      updateDisplayCount(session);
    } catch (error) {
      sessionFailure(socket, error.code || 'INVALID_PAIRING_CODE', error.message, 'connectToMaster');
    }
  });

  socket.on('disconnect', () => {
    const session = socket.data.session;
    if (session) {
      const field = socket.data.role === 'controller' ? 'controllerSocketId' : 'displaySocketId';
      if (session[field] === socket.id) session[field] = null;
      updateDisplayCount(session);
    }
    void log(`** ${new Date().toLocaleString()} - Socket ${socket.id} disconnected`);
  });

  // Rooms are selected exclusively from the authenticated server-side session.
  const relay = (event, value, hasValue = true) => {
    const target = socket.to(socket.data.session.id);
    if (hasValue) target.emit(event, value); else target.emit(event);
  };
  socket.on('player start', () => relay('play', undefined, false));
  socket.on('player pause', () => relay('pause', undefined, false));
  socket.on('stop', () => relay('stop', undefined, false));
  socket.on('player timeupdate', time => relay('timeupdate', time));
  socket.on('player volumeupdate', volume => relay('volumeupdate', volume));
  socket.on('video url', url => relay('video url', url));
  socket.on('toggle loop', enabled => relay('loop status', enabled));
  socket.on('toggle inversion', enabled => relay('inversion status', enabled));
  socket.on('optimize color', enabled => relay('color optimization status', enabled));
  socket.on('toggle enhance details', enabled => relay('enhance details status', enabled));
  socket.on('toggle back details', enabled => relay('background optimization status', enabled));
});

// Explicit lifecycle lets each regression test own its server and runtime files.
let periodicLogging;
async function start(port = 3000, host) {
  await mediaService.ready;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      originPolicy.addLocalPort(server.address().port);
      resolve();
    });
  });
  await logCurrentConnections();
  periodicLogging = setInterval(() => { void logCurrentConnections(); }, 60_000);
  return server.address();
}

async function stop() {
  clearInterval(periodicLogging);
  await new Promise(resolve => io.close(resolve));
  sessionStore.clear();
  await new Promise(resolve => logStream.end(resolve));
}

return { app, server, io, start, stop, sessionStore, mediaService };
}

module.exports = { createApplication };

if (require.main === module) {
  const mediaLimitNames = {
    maxFileBytes: 'UPLOAD_MAX_FILE_BYTES', maxConcurrent: 'UPLOAD_MAX_CONCURRENT',
    maxSessionBytes: 'UPLOAD_MAX_SESSION_BYTES', maxTotalBytes: 'UPLOAD_MAX_TOTAL_BYTES',
    maxSessionFiles: 'UPLOAD_MAX_SESSION_FILES',
  };
  const mediaLimits = Object.fromEntries(Object.entries(mediaLimitNames)
    .filter(([, name]) => process.env[name] !== undefined)
    .map(([key, name]) => [key, Number(process.env[name])]));
  const application = createApplication({
    mediaLimits,
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').map(origin => origin.trim()),
    allowNoOrigin: process.env.ALLOW_NO_ORIGIN !== 'false',
  });
  application.start().then(address => {
    console.log(`Server is running on http://localhost:${address.port}`);
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
  process.once('SIGINT', () => { void application.stop(); });
}
