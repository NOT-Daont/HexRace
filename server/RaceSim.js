// Authoritative race simulation, ticked at 30 Hz by Room while phase === RACE.
// Owns rider physics, projectiles, pickups, gates/laps, knockouts and finishes.

import {
  LAPS, ITEMS, ITEM_POOL, ITEM_RESPAWN, ESSENCE_RESPAWN,
  SHIELD_DURATION, INVIS_DURATION, PROJECTILE, PICKUP_RADIUS,
  KNOCKOUT, USABLE_DURATION, BROOM, OBSTACLE_HIT_PAD, STAT,
} from '../shared/constants.js';
import { makeBroomState, makeInput, stepBroom, dist2 } from '../shared/physics.js';
import { recipeById } from '../shared/alchemy.js';

const FLAG = { FALLEN: 1, GHOST: 2, SHIELD: 4, INVIS: 8, SURGE: 16, FINISHED: 32, BOOSTING: 64 };
export { FLAG };

export class RaceSim {
  /**
   * @param {object} track  built track from shared/track.js
   * @param {Map} players   id -> player (Room player records)
   * @param {function} emitEvent  (event) => void  broadcast race event
   */
  constructor(track, players, emitEvent) {
    this.track = track;
    this.players = players;
    this.emitEvent = emitEvent;
    this.riders = new Map();
    this.projectiles = [];
    this.nextProjId = 1;
    this.boxTakenUntil = new Map();      // boxId -> time
    this.essenceTakenUntil = new Map();  // essenceId -> time
    this.firstFinishAt = 0;
    this.startedAt = 0;
    this.frozen = true;                  // countdown

    let slot = 0;
    for (const p of players.values()) {
      const g = track.grid[slot % track.grid.length];
      const broom = makeBroomState(g.pos[0], g.pos[1], g.pos[2], g.yaw);
      this.riders.set(p.id, {
        id: p.id,
        broom,
        input: makeInput(),
        lastSeq: 0,
        totalGates: 0,
        nextGate: 0,
        progress: 0,
        finished: false,
        finishTime: 0,
        place: 0,
        item: null,
        usables: (p.potions ?? []).filter(po => recipeById(po.recipeId)?.kind === 'usable'),
        shieldUntil: 0, invisUntil: 0, ghostUntil: 0,
        respawnBoostUntil: 0, surgeUntil: 0,
        fallenUntil: 0,
        fallen: false,
        mods: computeMods(p),
        essencesThisRace: 0,
      });
      slot++;
    }
  }

  start(now) {
    this.frozen = false;
    this.startedAt = now;
    // Antidote ward doubles as a race-start blessing: brief ghost.
    for (const r of this.riders.values()) {
      const p = this.players.get(r.id);
      if (p?.wardFresh) { r.ghostUntil = now + KNOCKOUT.ghostTime; p.wardFresh = false; }
    }
  }

  setInput(playerId, msg) {
    const r = this.riders.get(playerId);
    if (!r) return;
    if (typeof msg.seq === 'number' && msg.seq > r.lastSeq) r.lastSeq = msg.seq;
    r.input.turn = num(msg.turn);
    r.input.pitch = num(msg.pitch);
    r.input.boost = !!msg.boost;
    r.input.throttle = 1;
  }

  useItem(playerId, now) {
    const r = this.riders.get(playerId);
    if (!r || r.fallen || r.finished || this.frozen || !r.item) return;
    const item = r.item;
    r.item = null;
    if (item === ITEMS.WAND) this.fireProjectile(r, now, 'wand');
    else if (item === ITEMS.SHIELD) {
      r.shieldUntil = now + SHIELD_DURATION;
      this.emitEvent({ type: 'shield', id: r.id });
    } else if (item === ITEMS.INVIS) {
      r.invisUntil = now + INVIS_DURATION;
      this.emitEvent({ type: 'invis', id: r.id });
    }
  }

  usePotion(playerId, uid, now) {
    const r = this.riders.get(playerId);
    if (!r || r.fallen || r.finished || this.frozen) return;
    const i = r.usables.findIndex(po => po.uid === uid);
    if (i < 0) return;
    const recipe = recipeById(r.usables[i].recipeId);
    r.usables.splice(i, 1);
    const p = this.players.get(playerId);
    if (p) p.potions = p.potions.filter(po => po.uid !== uid);
    if (recipe.id === 'surge') {
      r.surgeUntil = now + USABLE_DURATION.surge;
      this.emitEvent({ type: 'surge', id: r.id });
    } else if (recipe.id === 'veil') {
      r.invisUntil = now + USABLE_DURATION.veil;
      this.emitEvent({ type: 'invis', id: r.id });
    } else if (recipe.id === 'hexbolt') {
      this.fireProjectile(r, now, 'hexbolt');
    }
  }

  fireProjectile(r, now, kind) {
    const b = r.broom;
    const cp = Math.cos(b.pitch);
    this.projectiles.push({
      id: this.nextProjId++,
      kind,
      ownerId: r.id,
      x: b.x, y: b.y + 0.5, z: b.z,
      dx: Math.sin(b.yaw) * cp, dy: Math.sin(b.pitch), dz: Math.cos(b.yaw) * cp,
      targetId: null,
      bornAt: now,
    });
    this.emitEvent({ type: 'fire', id: r.id, kind });
  }

  tick(dt, now) {
    if (this.frozen) return;
    for (const r of this.riders.values()) this.tickRider(r, dt, now);
    this.tickProjectiles(dt, now);
  }

  tickRider(r, dt, now) {
    if (r.finished) {
      // glide on autopilot past the finish line
      r.input.turn = 0; r.input.pitch = 0; r.input.boost = false;
      stepBroom(r.broom, r.input, dt, r.mods, false);
      return;
    }
    if (r.fallen) {
      // tumble down, decelerating
      const b = r.broom;
      b.vx *= Math.max(0, 1 - 2.5 * dt); b.vz *= Math.max(0, 1 - 2.5 * dt);
      b.vy = Math.max(b.vy - 18 * dt, -22);
      b.x += b.vx * dt; b.y = Math.max(2, b.y + b.vy * dt); b.z += b.vz * dt;
      if (now >= r.fallenUntil) this.respawn(r, now);
      return;
    }

    const surging = now < r.surgeUntil || now < r.respawnBoostUntil;
    stepBroom(r.broom, r.input, dt, r.mods, surging);

    const b = r.broom;
    const ghost = now < r.ghostUntil;

    // Crashes (ground / obstacles) — ghosts are intangible.
    if (!ghost) {
      if (b.y <= BROOM.minY) { this.knockout(r, now, 'ground'); return; }
      for (const o of this.track.obstacles) {
        const rr = o.radius + OBSTACLE_HIT_PAD;
        if (dist2(b.x, b.y, b.z, o.pos[0], o.pos[1], o.pos[2]) < rr * rr) {
          this.knockout(r, now, 'rock');
          return;
        }
      }
    } else if (b.y < BROOM.minY) {
      b.y = BROOM.minY; b.vy = Math.max(0, b.vy);
    }

    // Gate progression
    const gate = this.track.gates[r.nextGate];
    const gd2 = dist2(b.x, b.y, b.z, gate.pos[0], gate.pos[1], gate.pos[2]);
    if (gd2 < gate.radius * gate.radius) {
      r.totalGates++;
      r.nextGate = (r.nextGate + 1) % this.track.gateCount;
      this.emitEvent({ type: 'gate', id: r.id, gate: gate.id, lap: this.lapOf(r) });
      if (r.totalGates >= LAPS * this.track.gateCount + 1) {
        r.finished = true;
        r.finishTime = now - this.startedAt;
        if (!this.firstFinishAt) this.firstFinishAt = now;
        this.emitEvent({ type: 'finish', id: r.id, time: r.finishTime });
        return;
      }
    }
    // progress = gates passed + how close we are to the next one (for ranking)
    const span2 = 80 * 80;
    r.progress = r.totalGates + Math.max(0, 1 - Math.sqrt(Math.min(gd2, span2) / span2));

    // Item boxes
    for (const box of this.track.itemBoxes) {
      if ((this.boxTakenUntil.get(box.id) ?? 0) > now) continue;
      if (dist2(b.x, b.y, b.z, box.pos[0], box.pos[1], box.pos[2]) < PICKUP_RADIUS * PICKUP_RADIUS) {
        this.boxTakenUntil.set(box.id, now + ITEM_RESPAWN);
        if (!r.item) {
          r.item = ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)];
          this.emitEvent({ type: 'item', id: r.id, item: r.item, box: box.id });
        } else {
          this.emitEvent({ type: 'boxPop', id: r.id, box: box.id });
        }
      }
    }

    // Essences
    for (const e of this.track.essences) {
      if ((this.essenceTakenUntil.get(e.id) ?? 0) > now) continue;
      if (dist2(b.x, b.y, b.z, e.pos[0], e.pos[1], e.pos[2]) < PICKUP_RADIUS * PICKUP_RADIUS) {
        this.essenceTakenUntil.set(e.id, now + ESSENCE_RESPAWN);
        const p = this.players.get(r.id);
        if (p) p.essences[e.type] = (p.essences[e.type] ?? 0) + 1;
        r.essencesThisRace++;
        this.emitEvent({ type: 'essence', id: r.id, essence: e.id, etype: e.type });
      }
    }
  }

  tickProjectiles(dt, now) {
    const alive = [];
    for (const pr of this.projectiles) {
      if (now - pr.bornAt > PROJECTILE.lifetime) {
        this.emitEvent({ type: 'fizzle', proj: pr.id });
        continue;
      }
      // Homing: acquire / track a target ahead.
      if (!pr.targetId) this.acquireTarget(pr, now);
      const target = pr.targetId ? this.riders.get(pr.targetId) : null;
      if (target && !target.fallen && !target.finished && now >= target.invisUntil) {
        steerToward(pr, target.broom, dt);
      } else {
        pr.targetId = null;
      }
      pr.x += pr.dx * PROJECTILE.speed * dt;
      pr.y += pr.dy * PROJECTILE.speed * dt;
      pr.z += pr.dz * PROJECTILE.speed * dt;

      // World / obstacle hits
      if (pr.y < 0.5) { this.emitEvent({ type: 'fizzle', proj: pr.id }); continue; }
      let dead = false;
      for (const o of this.track.obstacles) {
        if (dist2(pr.x, pr.y, pr.z, o.pos[0], o.pos[1], o.pos[2]) < o.radius * o.radius) {
          this.emitEvent({ type: 'fizzle', proj: pr.id });
          dead = true; break;
        }
      }
      if (dead) continue;

      // Rider hits
      for (const r of this.riders.values()) {
        if (r.id === pr.ownerId || r.fallen || r.finished) continue;
        if (now < r.ghostUntil) continue;
        const b = r.broom;
        if (dist2(pr.x, pr.y, pr.z, b.x, b.y, b.z) < PROJECTILE.hitRadius * PROJECTILE.hitRadius) {
          if (now < r.shieldUntil) {
            r.shieldUntil = 0;
            this.emitEvent({ type: 'shieldBreak', id: r.id, proj: pr.id });
          } else {
            this.knockout(r, now, 'wand', pr.ownerId);
          }
          dead = true;
          break;
        }
      }
      if (!dead) alive.push(pr);
    }
    this.projectiles = alive;
  }

  acquireTarget(pr, now) {
    let best = null, bestD = PROJECTILE.acquireRange * PROJECTILE.acquireRange;
    for (const r of this.riders.values()) {
      if (r.id === pr.ownerId || r.fallen || r.finished) continue;
      if (now < r.invisUntil || now < r.ghostUntil) continue;
      const b = r.broom;
      const dx = b.x - pr.x, dy = b.y - pr.y, dz = b.z - pr.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > bestD) continue;
      const d = Math.sqrt(d2) || 1;
      const dot = (dx * pr.dx + dy * pr.dy + dz * pr.dz) / d;
      if (dot < PROJECTILE.acquireDot) continue;
      best = r; bestD = d2;
    }
    if (best) pr.targetId = best.id;
  }

  knockout(r, now, cause, byId = null) {
    r.fallen = true;
    r.fallenUntil = now + KNOCKOUT.fallTime;
    r.item = null;
    r.shieldUntil = 0; r.invisUntil = 0; r.surgeUntil = 0;
    this.emitEvent({ type: 'knockout', id: r.id, cause, by: byId });
  }

  respawn(r, now) {
    const g = this.track.gates[(r.nextGate - 1 + this.track.gateCount) % this.track.gateCount];
    const b = r.broom;
    b.x = g.pos[0]; b.y = g.pos[1] + 2; b.z = g.pos[2];
    b.yaw = Math.atan2(g.dir[0], g.dir[2]);
    b.pitch = 0; b.roll = 0;
    b.vx = g.dir[0] * 18; b.vy = 0; b.vz = g.dir[2] * 18;
    r.fallen = false;
    r.ghostUntil = now + KNOCKOUT.ghostTime;
    r.respawnBoostUntil = now + KNOCKOUT.respawnBoost;
    this.emitEvent({ type: 'respawn', id: r.id });
  }

  lapOf(r) {
    if (r.totalGates < 1) return 1;
    return Math.min(LAPS, Math.floor((r.totalGates - 1) / this.track.gateCount) + 1);
  }

  removePlayer(id) {
    this.riders.delete(id);
    this.projectiles = this.projectiles.filter(p => p.ownerId !== id);
  }

  allFinished() {
    for (const r of this.riders.values()) if (!r.finished) return false;
    return this.riders.size > 0;
  }

  // Final placements: finishers by time, then DNFs by progress.
  placements() {
    const rs = [...this.riders.values()];
    rs.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    return rs.map(r => r.id);
  }

  snapshot(now) {
    const riders = {};
    for (const r of this.riders.values()) {
      const b = r.broom;
      let f = 0;
      if (r.fallen) f |= FLAG.FALLEN;
      if (now < r.ghostUntil) f |= FLAG.GHOST;
      if (now < r.shieldUntil) f |= FLAG.SHIELD;
      if (now < r.invisUntil) f |= FLAG.INVIS;
      if (now < r.surgeUntil || now < r.respawnBoostUntil) f |= FLAG.SURGE;
      if (r.finished) f |= FLAG.FINISHED;
      if (r.input.boost && b.boost > 1) f |= FLAG.BOOSTING;
      riders[r.id] = {
        x: rnd(b.x), y: rnd(b.y), z: rnd(b.z),
        vx: rnd(b.vx), vy: rnd(b.vy), vz: rnd(b.vz),
        yaw: rnd(b.yaw), pitch: rnd(b.pitch), roll: rnd(b.roll),
        boost: Math.round(b.boost),
        f,
        lap: this.lapOf(r),
        gate: r.nextGate,
        prog: rnd(r.progress),
        item: r.item,
        seq: r.lastSeq,
      };
    }
    return {
      t: now,
      riders,
      proj: this.projectiles.map(p => ({ id: p.id, k: p.kind, x: rnd(p.x), y: rnd(p.y), z: rnd(p.z) })),
      boxOff: [...this.boxTakenUntil.entries()].filter(([, u]) => u > now).map(([id]) => id),
      essOff: [...this.essenceTakenUntil.entries()].filter(([, u]) => u > now).map(([id]) => id),
    };
  }
}

function computeMods(player) {
  const mods = { [STAT.SPEED]: 1, [STAT.ACCEL]: 1, [STAT.HANDLING]: 1 };
  for (const eff of [player.permBuff, player.permNerf]) {
    if (!eff) continue;
    const recipe = recipeById(eff.recipeId);
    if (!recipe?.stats) continue;
    for (const [k, v] of Object.entries(recipe.stats)) mods[k] *= v;
  }
  return mods;
}

function steerToward(pr, b, dt) {
  const dx = b.x - pr.x, dy = b.y - pr.y, dz = b.z - pr.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  const maxTurn = PROJECTILE.turnRate * dt;
  // slerp-ish: nudge direction vector toward target, renormalize
  pr.dx += (dx / d - pr.dx) * maxTurn * 2;
  pr.dy += (dy / d - pr.dy) * maxTurn * 2;
  pr.dz += (dz / d - pr.dz) * maxTurn * 2;
  const l = Math.hypot(pr.dx, pr.dy, pr.dz) || 1;
  pr.dx /= l; pr.dy /= l; pr.dz /= l;
}

function num(v) { return typeof v === 'number' && isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0; }
function rnd(v) { return Math.round(v * 100) / 100; }
