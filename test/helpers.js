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
  async function connect(query = {}) {
    const socket = io(`${base}/playerControls`, { query, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  }
  return { ...application, root, mediaRoot, base, connect };
}

module.exports = { fixture, once };
