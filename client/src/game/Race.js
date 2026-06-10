// Race phase controller. Owns the per-round scene (track + riders +
// projectiles), keyboard input, 30 Hz input upload, local prediction with
// soft reconciliation, remote interpolation, the chase camera and race VFX.

import * as THREE from 'three';
import { net } from '../net.js';
import { TrackView } from './TrackView.js';
import { Rider } from './Riders.js';
import { buildTrack } from '@shared/track.js';
import { makeBroomState, makeInput, stepBroom, angleLerp, lerp } from '@shared/physics.js';
import { INTERP_DELAY, STAT, EFFECT_KIND, PHASE } from '@shared/constants.js';
import { recipeById, INGREDIENTS } from '@shared/alchemy.js';

const FLAG = { FALLEN: 1, GHOST: 2, SHIELD: 4, INVIS: 8, SURGE: 16, FINISHED: 32, BOOSTING: 64 };
const SNAP_BUFFER = 24;

export class Race {
  constructor(world, effects, hud, trackIndex) {
    this.world = world;
    this.effects = effects;
    this.hud = hud;
    this.track = buildTrack(trackIndex);
    this.view = new TrackView(world.scene, this.track);
    world.setPalette(this.track);

    this.riders = new Map();           // id -> Rider
    this.projMeshes = new Map();       // id -> mesh
    this.snaps = [];                   // snapshot ring buffer
    this.latest = null;

    this.keys = {};
    this.seq = 1;
    this.pred = null;                  // predicted local broom state
    this.predInput = makeInput();
    this.localFallen = false;
    this.localFinished = false;
    this.usables = [];

    this.camPos = new THREE.Vector3(0, 60, -120);
    this.camLook = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();

    this.syncPlayers();
    this.refreshUsables();

    this.unsubs = [
      net.on('snap', (sn) => this.onSnap(sn)),
      net.on('evt', (e) => this.onEvent(e)),
      net.on('room', () => { this.syncPlayers(); this.refreshUsables(); }),
    ];

    this.onKeyDown = (e) => this.handleKey(e, true);
    this.onKeyUp = (e) => this.handleKey(e, false);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.inputTimer = setInterval(() => this.sendInput(), 33);
  }

  // ------------------------------------------------------------- players

  syncPlayers() {
    const players = net.room?.players ?? [];
    const seen = new Set();
    for (const p of players) {
      seen.add(p.id);
      if (!this.riders.has(p.id)) {
        this.riders.set(p.id, new Rider(this.world.scene, {
          id: p.id, name: p.name, color: p.color,
        }, p.id === net.myId));
      }
    }
    for (const [id, r] of this.riders) {
      if (!seen.has(id)) { r.dispose(); this.riders.delete(id); }
    }
  }

  refreshUsables() {
    this.usables = (net.you?.potions ?? [])
      .filter(po => recipeById(po.recipeId)?.kind === EFFECT_KIND.USABLE);
    this.hud.setUsables(this.usables);
  }

  localMods() {
    const me = net.room?.players.find(p => p.id === net.myId);
    const mods = { [STAT.SPEED]: 1, [STAT.ACCEL]: 1, [STAT.HANDLING]: 1 };
    if (!me) return mods;
    for (const eff of [me.permBuff, me.permNerf]) {
      const stats = eff && recipeById(eff.recipeId)?.stats;
      if (stats) for (const [k, v] of Object.entries(stats)) mods[k] *= v;
    }
    return mods;
  }

  // --------------------------------------------------------------- input

  handleKey(e, down) {
    const k = e.code;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
         'ShiftLeft', 'ShiftRight', 'Space', 'KeyE'].includes(k)) {
      e.preventDefault();
    }
    this.keys[k] = down;
    if (down && k === 'Space') net.send('race:item');
    if (down && k === 'KeyE' && this.usables.length) {
      const po = this.usables.shift();
      net.send('race:potion', { uid: po.uid });
      this.hud.setUsables(this.usables);
    }
  }

  readInput() {
    const turn = (this.keys.KeyD || this.keys.ArrowRight ? 1 : 0) -
                 (this.keys.KeyA || this.keys.ArrowLeft ? 1 : 0);
    const pitch = (this.keys.KeyS || this.keys.ArrowDown ? 1 : 0) -
                  (this.keys.KeyW || this.keys.ArrowUp ? 1 : 0);
    const boost = !!(this.keys.ShiftLeft || this.keys.ShiftRight);
    return { turn, pitch, boost };
  }

  sendInput() {
    if (net.room?.phase !== PHASE.RACE) return;
    const inp = this.readInput();
    net.send('race:input', { seq: this.seq++, ...inp });
  }

  // ----------------------------------------------------------- snapshots

  onSnap(sn) {
    this.snaps.push(sn);
    if (this.snaps.length > SNAP_BUFFER) this.snaps.shift();
    this.latest = sn;
    this.view.setInactive(sn.boxOff, sn.essOff);

    const me = sn.riders[net.myId];
    if (!me || !this.pred) return;

    const fallen = !!(me.f & FLAG.FALLEN);
    const finished = !!(me.f & FLAG.FINISHED);
    if (fallen || finished) {
      this.localFallen = fallen;
      this.localFinished = finished;
      return; // server animates these; we resync on recovery
    }
    if (this.localFallen) {
      // just respawned — hard snap to authority
      Object.assign(this.pred, {
        x: me.x, y: me.y, z: me.z, vx: me.vx, vy: me.vy, vz: me.vz,
        yaw: me.yaw, pitch: me.pitch, roll: me.roll,
      });
      this.localFallen = false;
      return;
    }
    // soft reconciliation: small drift → nudge, big divergence → snap
    const err = Math.hypot(this.pred.x - me.x, this.pred.y - me.y, this.pred.z - me.z);
    if (err > 7) {
      Object.assign(this.pred, { x: me.x, y: me.y, z: me.z, vx: me.vx, vy: me.vy, vz: me.vz, yaw: me.yaw, pitch: me.pitch });
    } else {
      const k = err > 2.5 ? 0.3 : 0.12;
      this.pred.x = lerp(this.pred.x, me.x, k);
      this.pred.y = lerp(this.pred.y, me.y, k);
      this.pred.z = lerp(this.pred.z, me.z, k);
      this.pred.vx = lerp(this.pred.vx, me.vx, k);
      this.pred.vy = lerp(this.pred.vy, me.vy, k);
      this.pred.vz = lerp(this.pred.vz, me.vz, k);
      this.pred.yaw = angleLerp(this.pred.yaw, me.yaw, k * 0.7);
      this.pred.pitch = lerp(this.pred.pitch, me.pitch, k * 0.7);
    }
    this.pred.boost = me.boost;
  }

  // interpolated remote state at render time
  sampleRider(id, renderT) {
    let a = null, b = null;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].t <= renderT && this.snaps[i].riders[id]) { a = this.snaps[i]; b = this.snaps[i + 1]; break; }
    }
    if (!a) return this.latest?.riders[id] ?? null;
    const ra = a.riders[id];
    const rb = b?.riders[id];
    if (!rb) return ra;
    const t = Math.min(1, (renderT - a.t) / Math.max(1, b.t - a.t));
    return {
      ...rb,
      x: lerp(ra.x, rb.x, t), y: lerp(ra.y, rb.y, t), z: lerp(ra.z, rb.z, t),
      yaw: angleLerp(ra.yaw, rb.yaw, t),
      pitch: lerp(ra.pitch, rb.pitch, t),
      roll: lerp(ra.roll, rb.roll, t),
    };
  }

  // -------------------------------------------------------------- events

  onEvent(e) {
    const rider = this.riders.get(e.id);
    const pos = rider?.group.position;
    const name = (id) => net.room?.players.find(p => p.id === id)?.name ?? '???';
    switch (e.type) {
      case 'knockout':
        if (pos) this.effects.burst(pos, 0xff5d5d, 40, 12);
        if (e.id === net.myId) this.hud.flash(e.cause === 'wand' ? 'HEXED!' : 'CRASHED!');
        this.hud.feed(e.cause === 'wand'
          ? `${name(e.id)} was hexed off their broom${e.by ? ` by ${name(e.by)}` : ''}!`
          : `${name(e.id)} crashed!`);
        break;
      case 'respawn':
        if (pos) this.effects.burst(pos, 0x7dff9b, 22, 7);
        break;
      case 'item':
        if (e.id === net.myId) this.hud.setItem(e.item);
        break;
      case 'essence':
        if (pos) this.effects.burst(pos, INGREDIENTS[e.etype]?.color ?? 0xffffff, 14, 5, 0.6);
        if (e.id === net.myId) this.hud.bumpEssence(e.etype);
        break;
      case 'fire':
        if (pos) this.effects.burst(pos, 0xffd24d, 10, 4, 0.4);
        break;
      case 'fizzle': {
        const m = this.projMeshes.get(e.proj);
        if (m) this.effects.burst(m.position, 0xc77dff, 16, 6, 0.5);
        break;
      }
      case 'shieldBreak':
        if (pos) this.effects.burst(pos, 0x4dd2ff, 30, 10);
        this.hud.feed(`${name(e.id)}'s shield shattered!`);
        break;
      case 'shield':
        if (e.id === net.myId) { this.hud.setItem(null); this.hud.feed('Shield up!'); }
        break;
      case 'invis':
        if (e.id === net.myId) { this.hud.setItem(null); this.hud.feed('You vanish from sight…'); }
        break;
      case 'surge':
        if (e.id === net.myId) this.hud.feed('SURGE! Hold on tight!');
        break;
      case 'finish':
        this.hud.feed(`${name(e.id)} finished! (${(e.time / 1000).toFixed(1)}s)`);
        if (e.id === net.myId) this.hud.flash('FINISHED!', '#7dff9b');
        break;
    }
  }

  // ------------------------------------------------------------ per-frame

  update(dt, time) {
    const phase = net.room?.phase;
    const racing = phase === PHASE.RACE;
    const renderT = net.serverNow() - INTERP_DELAY;
    const myServer = this.latest?.riders[net.myId];

    // --- local prediction
    if (racing && myServer && !this.pred) {
      this.pred = makeBroomState(myServer.x, myServer.y, myServer.z, myServer.yaw);
    }
    const predicting = racing && this.pred && !this.localFallen && !this.localFinished;
    if (predicting) {
      const inp = this.readInput();
      this.predInput.turn = inp.turn;
      this.predInput.pitch = inp.pitch;
      this.predInput.boost = inp.boost;
      const surging = !!(myServer && (myServer.f & FLAG.SURGE));
      stepBroom(this.pred, this.predInput, Math.min(dt, 0.05), this.localMods(), surging);
      if (this.pred.y < 1.3) { this.pred.y = 1.3; this.pred.vy = Math.max(0, this.pred.vy); }
    }

    // --- pose riders
    for (const [id, rider] of this.riders) {
      let st = null;
      if (id === net.myId && predicting) st = this.pred;
      else st = this.sampleRider(id, renderT);
      if (!st) continue;
      rider.setPose(st.x, st.y, st.z, st.yaw, st.pitch, st.roll ?? 0);

      const f = (id === net.myId ? myServer?.f : this.latest?.riders[id]?.f) ?? 0;
      rider.updateStatus({
        fallen: !!(f & FLAG.FALLEN),
        ghost: !!(f & FLAG.GHOST),
        shield: !!(f & FLAG.SHIELD),
        invis: !!(f & FLAG.INVIS),
        surge: !!(f & FLAG.SURGE),
      }, time, dt);

      // broom trail
      const speed = id === net.myId && predicting
        ? this.pred.speed
        : Math.hypot(st.vx ?? 0, st.vy ?? 0, st.vz ?? 0);
      if (speed > 6 && !(f & FLAG.FALLEN)) {
        const player = net.room?.players.find(p => p.id === id);
        const tail = rider.tailPos(this.tmp);
        const c = (f & FLAG.SURGE) ? 0xffd24d : (f & FLAG.BOOSTING ? 0x4dd2ff : (player?.color ?? 0xffffff));
        this.effects.trail(tail, c);
        if (f & (FLAG.SURGE | FLAG.BOOSTING)) this.effects.trail(tail, c);
      }
    }

    // --- projectiles
    const seen = new Set();
    for (const pr of this.latest?.proj ?? []) {
      seen.add(pr.id);
      let m = this.projMeshes.get(pr.id);
      if (!m) {
        m = new THREE.Mesh(
          new THREE.SphereGeometry(0.45, 10, 8),
          new THREE.MeshBasicMaterial({ color: pr.k === 'hexbolt' ? 0xff5d5d : 0xffd24d })
        );
        this.world.scene.add(m);
        this.projMeshes.set(pr.id, m);
        m.userData.smooth = new THREE.Vector3(pr.x, pr.y, pr.z);
      }
      m.userData.smooth.set(pr.x, pr.y, pr.z);
      m.position.lerp(m.userData.smooth, Math.min(1, dt * 14));
      this.effects.trail(m.position, pr.k === 'hexbolt' ? 0xff5d5d : 0xffd24d, 0.1);
    }
    for (const [id, m] of this.projMeshes) {
      if (!seen.has(id)) {
        this.world.scene.remove(m);
        m.geometry.dispose(); m.material.dispose();
        this.projMeshes.delete(id);
      }
    }

    // --- track animation (highlight my next gate)
    this.view.update(time, myServer?.gate ?? 0);

    // --- camera
    this.updateCamera(dt, predicting, myServer);

    // --- HUD
    if (racing || phase === PHASE.COUNTDOWN) {
      this.hud.update({
        snap: this.latest,
        myId: net.myId,
        players: net.room?.players ?? [],
        track: this.track,
        boost: predicting ? this.pred.boost : (myServer?.boost ?? 0),
        speed: predicting ? this.pred.speed : 0,
      });
    }
  }

  updateCamera(dt, predicting, myServer) {
    const cam = this.world.camera;
    let target = null;
    if (predicting) target = this.pred;
    else if (myServer) target = this.sampleRider(net.myId, net.serverNow() - INTERP_DELAY) ?? myServer;

    if (target) {
      const fx = Math.sin(target.yaw), fz = Math.cos(target.yaw);
      const wantPos = this.tmp.set(
        target.x - fx * 9.5,
        target.y + 3.4 - Math.sin(target.pitch ?? 0) * 2.5,
        target.z - fz * 9.5);
      const k = 1 - Math.exp(-dt * 7);
      this.camPos.lerp(wantPos, k);
      this.camLook.lerp(this.tmp2.set(target.x + fx * 8, target.y + 1, target.z + fz * 8), Math.min(1, k * 1.6));
      cam.position.copy(this.camPos);
      cam.lookAt(this.camLook);
      const f = myServer?.f ?? 0;
      const wantFov = (f & (FLAG.SURGE | FLAG.BOOSTING)) ? 84 : 72;
      cam.fov = lerp(cam.fov, wantFov, dt * 4);
      cam.updateProjectionMatrix();
    } else {
      // pre-spawn / spectator: slow orbit over the start line
      const t = performance.now() / 1000;
      const g0 = this.track.gates[0].pos;
      cam.position.set(g0[0] + Math.cos(t * 0.25) * 55, g0[1] + 26, g0[2] + Math.sin(t * 0.25) * 55);
      cam.lookAt(g0[0], g0[1], g0[2]);
    }
  }

  dispose() {
    clearInterval(this.inputTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    for (const u of this.unsubs) u();
    for (const r of this.riders.values()) r.dispose();
    for (const m of this.projMeshes.values()) {
      this.world.scene.remove(m);
      m.geometry.dispose(); m.material.dispose();
    }
    this.view.dispose();
  }
}
