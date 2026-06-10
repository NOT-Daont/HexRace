// HexRace listen server. The hosting player runs this; it serves the built
// client and the authoritative game over one port so friends just open a URL.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Room } from './Room.js';

const PORT = Number(process.env.PORT || 3001);
const FAST = process.env.HEXRACE_FAST === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'client', 'dist');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

function lanIPs() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

app.get('/info', (_req, res) => {
  res.json({
    name: 'HexRace listen server',
    port: PORT,
    ips: lanIPs(),
    joinUrls: lanIPs().map(ip => `http://${ip}:${PORT}`),
  });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!socket\.io|info).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) => res
    .status(200)
    .send('HexRace server running. Client not built yet — run "npm run build", or use "npm run dev" and open http://localhost:5173'));
}

const room = new Room(io, { fast: FAST });

io.on('connection', (socket) => {
  let joined = false;

  socket.on('join', (msg, ack) => {
    if (joined) return ack?.({ error: 'Already joined.' });
    const res = room.addPlayer(socket, msg?.name);
    if (res.ok) joined = true;
    ack?.(res);
  });

  socket.on('lobby:ready', (msg) => joined && room.setReady(socket.id, msg?.ready));
  socket.on('lobby:start', () => joined && room.startMatch(socket.id));

  socket.on('race:input', (msg) => joined && room.raceInput(socket.id, msg ?? {}));
  socket.on('race:item', () => joined && room.raceItem(socket.id));
  socket.on('race:potion', (msg) => joined && room.racePotion(socket.id, msg?.uid));

  socket.on('pantry:pick', (msg) => joined && room.pantryPick(socket.id, msg?.idx));
  socket.on('pantry:pass', () => joined && room.pantryPass(socket.id));

  socket.on('cauldron:brew', (msg, ack) => joined && room.brew(socket.id, msg?.ingredients, ack));
  socket.on('cauldron:done', () => joined && room.cauldronDone(socket.id));

  socket.on('deploy:set', (msg) => joined && room.deploySet(socket.id, msg?.uid, msg?.target));
  socket.on('deploy:confirm', () => joined && room.deployConfirm(socket.id));

  socket.on('disconnect', () => joined && room.removePlayer(socket.id));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🧹 HexRace listen server on port ${PORT}${FAST ? ' (FAST mode)' : ''}`);
  for (const url of lanIPs().map(ip => `http://${ip}:${PORT}`)) {
    console.log(`     share with friends: ${url}`);
  }
  console.log('');
});

export { server, room };
