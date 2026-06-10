// End-to-end: boots the real server (HEXRACE_FAST shrinks every timer ×40),
// connects three real Socket.io clients and plays a full 3-round match:
// lobby → race (snapshot-steered flying) → pantry draft → cauldron brews →
// deployment reveal → … → podium. White-box assists only where the race is
// too short to farm essences deterministically.

process.env.HEXRACE_FAST = '1';
process.env.PORT = process.env.PORT || '3199';

import assert from 'node:assert';
import { io as connect } from 'socket.io-client';
import { PHASE, SLOT_COST } from '../../shared/constants.js';
import { INGREDIENTS } from '../../shared/alchemy.js';
import { buildTrack } from '../../shared/track.js';

const { server, room } = await import('../index.js');
const URL = `http://localhost:${process.env.PORT}`;

const watchdog = setTimeout(() => {
  console.error('✗ e2e watchdog: match did not complete in 90 s');
  process.exit(1);
}, 90_000);

function makeClient(name) {
  const socket = connect(URL, { transports: ['websocket'] });
  const c = {
    name, socket, id: null,
    room: null, snap: null,
    gates: 0, knockouts: 0,
    seq: 1,
    pickedAtTurn: 0,
  };
  socket.on('room', (st) => { c.room = st; });
  socket.on('snap', (sn) => { c.snap = sn; });
  socket.on('evt', (e) => {
    if (e.type === 'gate' && e.id === c.id) c.gates++;
    if (e.type === 'knockout' && e.id === c.id) c.knockouts++;
  });
  return c;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function waitFor(label, pred, timeout = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = pred();
    if (v) return v;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const phaseOf = (c) => c.room?.phase;
const seenPhases = new Set();

// ---------------------------------------------------------------- lobby
const [a, b, c3] = ['Ada', 'Bea', 'Cyx'].map(makeClient);
const clients = [a, b, c3];

for (const c of clients) {
  const res = await emitAck(c.socket, 'join', { name: c.name });
  assert.ok(res.ok, `${c.name} failed to join: ${res.error}`);
  c.id = res.id;
}
console.log('✓ 3 players joined the lobby');

b.socket.emit('lobby:ready', { ready: true });
c3.socket.emit('lobby:ready', { ready: true });
await waitFor('readies visible', () =>
  a.room?.players.filter(p => p.ready).length === 2);
a.socket.emit('lobby:start');

// ------------------------------------------------------------- race loop
// Steer toward the next gate using server snapshots (proportional control).
function startFlying(c) {
  c.flyTimer = setInterval(() => {
    if (phaseOf(c) !== PHASE.RACE || !c.snap) return;
    const me = c.snap.riders[c.id];
    if (!me) return;
    const track = buildTrack(c.room.trackIndex);
    const gate = track.gates[me.gate];
    const dx = gate.pos[0] - me.x, dy = gate.pos[1] - me.y, dz = gate.pos[2] - me.z;
    const wantYaw = Math.atan2(dx, dz);
    let dyaw = wantYaw - me.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    const horiz = Math.hypot(dx, dz) || 1;
    const wantPitch = Math.atan2(dy, horiz);
    c.socket.emit('race:input', {
      seq: c.seq++,
      turn: Math.max(-1, Math.min(1, dyaw * 2)),
      pitch: Math.max(-1, Math.min(1, (wantPitch - me.pitch) * 2)),
      boost: false,
    });
  }, 33);
}
clients.forEach(startFlying);

// ------------------------------------------------- per-phase auto-pilots
function startPhaseBots(c) {
  c.botTimer = setInterval(async () => {
    const st = c.room;
    if (!st) return;
    seenPhases.add(st.phase);

    if (st.phase === PHASE.PANTRY && st.pantry?.turnId === c.id &&
        st.pantry.turnDeadline !== c.pickedAtTurn) {
      c.pickedAtTurn = st.pantry.turnDeadline;
      const meP = st.players.find(p => p.id === c.id);
      const free = st.pantry.stock.find(s => !s.takenBy &&
        meP.slotsUsed + (SLOT_COST[INGREDIENTS[s.ing].rarity] ?? 1) <= meP.slotsMax);
      if (free) c.socket.emit('pantry:pick', { idx: free.idx });
      else c.socket.emit('pantry:pass');
    }

    if (st.phase === PHASE.DEPLOY) {
      const meY = st.you;
      if (!c.deployed) {
        c.deployed = true;
        for (const po of meY.potions) {
          // target nerfs at the next player over; everything else at self
          const others = st.players.filter(p => p.id !== c.id);
          const target = others[0]?.id ?? c.id;
          c.socket.emit('deploy:set', { uid: po.uid, target: po.recipeId === 'leadweight' ? target : c.id });
        }
        c.socket.emit('deploy:confirm');
      }
    } else {
      c.deployed = false;
    }
  }, 25);
}
clients.forEach(startPhaseBots);

// --------------------------------------------------------------- round 1
await waitFor('race 1 start', () => phaseOf(a) === PHASE.RACE);
console.log('✓ round 1 race started on track', a.room.trackIndex);

await waitFor('snapshots flowing', () => a.snap && Object.keys(a.snap.riders).length === 3);
console.log('✓ snapshots carry all 3 riders');

await waitFor('race 1 over', () => phaseOf(a) === PHASE.RESULTS, 20_000);
const totalGates = a.gates + b.gates + c3.gates;
console.log(`✓ race 1 finished — results phase (gates passed: ${totalGates})`);
assert.ok(totalGates >= 1, 'steered riders should pass at least one gate');
assert.ok(a.room.results?.length === 3, 'results listed for all players');
assert.ok(a.room.results.every(r => r.points > 0), 'everyone scored points');

// --------------------------------------------------------------- pantry 1
await waitFor('pantry open', () => phaseOf(a) === PHASE.PANTRY);
const slotSpread = a.room.players.map(p => p.slotsMax).sort((x, y) => x - y);
assert.deepStrictEqual(slotSpread, [3, 5, 7], 'rubberband slots: 1st=3 … last=7');
console.log('✓ pantry rubberband slots:', slotSpread.join('/'));

await waitFor('cauldron open', () => phaseOf(a) === PHASE.CAULDRON, 25_000);
const drafted = room.players.get(a.id).inventory.length +
  room.players.get(b.id).inventory.length + room.players.get(c3.id).inventory.length;
assert.ok(drafted >= 3, `players drafted ingredients (got ${drafted})`);
console.log(`✓ pantry draft complete — ${drafted} ingredients drafted`);

// --------------------------------------------------------------- cauldron
// The fast race is too short to farm essences reliably, so seed pouches
// white-box and exercise the brew protocol over the socket.
for (const c of clients) {
  const p = room.players.get(c.id);
  p.essences = { embercap: 2, moondew: 2, frostbloom: 2, glimmerleaf: 1 };
}
room.players.get(a.id).inventory.push('nettle');

const bad = await emitAck(a.socket, 'cauldron:brew', { ingredients: ['embercap', 'embercap'] });
assert.ok(bad.error, 'nonsense mixture must fail');

const surge = await emitAck(b.socket, 'cauldron:brew', { ingredients: ['embercap', 'moondew'] });
assert.ok(surge.ok && surge.potion.recipeId === 'surge', 'Bea brews a Surge Vial');

const nerf = await emitAck(a.socket, 'cauldron:brew', { ingredients: ['nettle', 'frostbloom', 'frostbloom'] });
assert.ok(nerf.ok && nerf.potion.recipeId === 'leadweight', 'Ada brews Leadweight');
console.log('✓ cauldron: bad mix rejected, Surge + Leadweight brewed');

for (const c of clients) c.socket.emit('cauldron:done');

// ----------------------------------------------------------- deploy/reveal
await waitFor('deploy phase', () => phaseOf(a) === PHASE.DEPLOY, 10_000);
console.log('✓ deployment phase opened');
await waitFor('reveal phase', () => phaseOf(a) === PHASE.REVEAL, 10_000);
const script = a.room.reveal;
assert.ok(script.some(e => e.recipeId === 'leadweight' && e.result === 'applied'),
  'Leadweight applied in reveal');
const victim = script.find(e => e.recipeId === 'leadweight').to;
assert.ok(room.players.get(victim).permNerf?.recipeId === 'leadweight', 'victim carries the nerf');
console.log('✓ reveal: Leadweight landed on', room.players.get(victim).name);

// ------------------------------------------------------------ rounds 2..3
await waitFor('round 2 race', () => phaseOf(a) === PHASE.RACE && a.room.round === 2, 20_000);
console.log('✓ round 2 race started (track', a.room.trackIndex + ')');
await waitFor('round 3 race', () => phaseOf(a) === PHASE.RACE && a.room.round === 3, 60_000);
console.log('✓ round 3 race started (track', a.room.trackIndex + ')');

// ---------------------------------------------------------------- podium
await waitFor('podium', () => phaseOf(a) === PHASE.PODIUM, 60_000);
const standings = [...a.room.players].sort((x, y) => y.score - x.score);
assert.ok(standings[0].score >= standings[2].score, 'standings sorted');
assert.ok(standings.every(p => p.score >= 3), 'three races worth of points each');
console.log('✓ podium reached. Final scores:',
  standings.map(p => `${p.name}:${p.score}`).join('  '));

console.log(`\nPhases seen: ${[...seenPhases].join(' → ')}`);
console.log('\n✅ e2e: full 3-round match completed over real sockets\n');

clearTimeout(watchdog);
for (const c of clients) {
  clearInterval(c.flyTimer); clearInterval(c.botTimer);
  c.socket.close();
}
room.destroy();
server.close();
process.exit(0);
