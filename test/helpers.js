const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createApplication } = require('../server');

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'player-test-'));
  const mediaRoot = path.join(root, 'uploads');
  const logDirectory = path.join(root, 'logs');
  await Promise.all([mkdir(mediaRoot), mkdir(logDirectory)]);
  const application = createApplication({ mediaRoot, logDirectory, ...options });
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    await application.stop();
    await rm(root, { recursive: true, force: true });
  });
  const { port } = await application.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  async function connect(auth = {}, extra = {}) {
    const socket = io(`${base}/playerControls`, { auth, transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false, ...extra });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', () => { socket.off('connect_error', reject); resolve(); });
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }
  async function createSession() {
    const response = await fetch(base + '/api/sessions', { method: 'POST' });
    if (response.status !== 201) throw new Error('Could not create test session');
    return response.json();
  }
  async function connectController(session) {
    return connect({ role: 'controller', sessionId: session.sessionId, token: session.ownerToken });
  }
  return { ...application, root, mediaRoot, base, logDirectory, connect, createSession, connectController };
}

module.exports = { fixture, once };
