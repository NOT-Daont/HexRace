// The match state machine. One Room per listen server:
// LOBBY → [ COUNTDOWN → RACE → RESULTS → PANTRY → CAULDRON → DEPLOY → REVEAL ] ×3 → PODIUM → LOBBY

import {
  PHASE, TIMERS, fastTimers, TICK_RATE, SNAPSHOT_RATE, MAX_PLAYERS, ROUNDS,
  RACE_POINTS, EFFECT_KIND, SLOT_COST, pantrySlotsFor,
} from '../shared/constants.js';
import { buildTrack, TRACK_COUNT } from '../shared/track.js';
import { matchRecipe, recipeById, rollPantryStock, INGREDIENTS } from '../shared/alchemy.js';
import { RaceSim } from './RaceSim.js';

const COLORS = [0xff5d5d, 0x4dd2ff, 0x7dff9b, 0xffd24d, 0xc77dff, 0xff9b4d, 0x6bf0d8, 0xff7ad9];

export class Room {
  constructor(io, { fast = false } = {}) {
    this.io = io;
    this.timers = fast ? fastTimers() : TIMERS;
    this.players = new Map();          // id -> player record
    this.sockets = new Map();          // id -> socket
    this.hostId = null;
    this.phase = PHASE.LOBBY;
    this.phaseTimer = null;
    this.deadline = 0;
    this.round = 0;
    this.trackIndex = 0;
    this.sim = null;
    this.raceStartAt = 0;
    this.lastResults = [];
    this.revealScript = [];
    this.pantry = null;
    this.potionUid = 1;

    this.lastTick = Date.now();
    this.lastSnap = 0;
    this.interval = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  // ---------------------------------------------------------------- players

  addPlayer(socket, name) {
    if (this.phase !== PHASE.LOBBY) return { error: 'Match in progress — try again after this match ends.' };
    if (this.players.size >= MAX_PLAYERS) return { error: 'Lobby is full (8 players max).' };
    const id = socket.id;
    const player = {
      id,
      name: String(name ?? '').trim().slice(0, 16) || `Witch ${this.players.size + 1}`,
      color: COLORS[this.players.size % COLORS.length],
      ready: false,
      connected: true,
      score: 0,
      essences: {},
      inventory: [],
      potions: [],
      permBuff: null,
      permNerf: null,
      ward: false,
      wardFresh: false,
      pantryDone: false,
      slotsMax: 0,
      slotsUsed: 0,
      cauldronDone: false,
      deployPlan: {},
      deployConfirmed: false,
    };
    this.players.set(id, player);
    this.sockets.set(id, socket);
    if (!this.hostId) this.hostId = id;
    this.pushRoom();
    return { ok: true, id };
  }

  removePlayer(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    this.sockets.delete(id);
    if (this.sim) this.sim.removePlayer(id);
    if (this.hostId === id) this.hostId = this.players.keys().next().value ?? null;
    if (this.players.size === 0) { this.hardReset(); return; }

    if (this.phase === PHASE.PANTRY && this.pantry) {
      if (this.pantry.turnId === id) this.advancePantryTurn();
      else this.checkPantryEnd();
    }
    if (this.phase === PHASE.CAULDRON) this.checkCauldronEnd();
    if (this.phase === PHASE.DEPLOY) this.checkDeployEnd();
    this.pushRoom();
  }

  hardReset() {
    clearTimeout(this.phaseTimer);
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.sim = null;
    this.pantry = null;
    this.lastResults = [];
    this.revealScript = [];
  }

  // Back to lobby after the podium; players stay, match data resets.
  softReset() {
    for (const p of this.players.values()) {
      p.ready = false;
      p.score = 0;
      p.essences = {};
      p.inventory = [];
      p.potions = [];
      p.permBuff = null; p.permNerf = null;
      p.ward = false; p.wardFresh = false;
    }
    this.hardReset();
    this.pushRoom();
  }

  // ------------------------------------------------------------------ lobby

  setReady(id, ready) {
    const p = this.players.get(id);
    if (!p || this.phase !== PHASE.LOBBY) return;
    p.ready = !!ready;
    this.pushRoom();
  }

  startMatch(id) {
    if (this.phase !== PHASE.LOBBY || id !== this.hostId) return;
    for (const p of this.players.values()) {
      if (p.id !== this.hostId && !p.ready) {
        this.toast(id, 'Not everyone is ready yet.');
        return;
      }
    }
    this.round = 1;
    this.startRound();
  }

  // ------------------------------------------------------------------- race

  startRound() {
    this.trackIndex = (this.round - 1) % TRACK_COUNT;
    const track = buildTrack(this.trackIndex);
    this.track = track;
    this.sim = new RaceSim(track, this.players, (e) => this.io.emit('evt', e));
    this.setPhase(PHASE.COUNTDOWN, this.timers.countdown, () => {
      this.sim.start(Date.now());
      this.raceStartAt = Date.now();
      this.setPhase(PHASE.RACE, this.timers.raceHardCap, () => this.endRace());
    });
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.phase !== PHASE.RACE || !this.sim) return;

    this.sim.tick(dt, now);

    if (this.sim.allFinished() ||
        (this.sim.firstFinishAt && now - this.sim.firstFinishAt > this.timers.raceGrace)) {
      this.endRace();
      return;
    }
    if (now - this.lastSnap >= 1000 / SNAPSHOT_RATE) {
      this.lastSnap = now;
      this.io.emit('snap', this.sim.snapshot(now));
    }
  }

  endRace() {
    if (this.phase !== PHASE.RACE) return;
    const order = this.sim.placements();
    this.lastResults = order.map((pid, i) => {
      const p = this.players.get(pid);
      const points = RACE_POINTS[Math.min(i, RACE_POINTS.length - 1)] ?? 1;
      const rider = this.sim.riders.get(pid);
      if (p) p.score += points;
      return {
        id: pid, place: i + 1, points,
        time: rider?.finished ? rider.finishTime : null,
        essences: rider?.essencesThisRace ?? 0,
      };
    });
    this.sim = null;
    this.setPhase(PHASE.RESULTS, this.timers.results, () => this.enterPantry());
  }

  raceInput(id, msg) { this.sim?.setInput(id, msg); }
  raceItem(id) { this.sim?.useItem(id, Date.now()); }
  racePotion(id, uid) { this.sim?.usePotion(id, uid, Date.now()); }

  // ----------------------------------------------------------------- pantry

  enterPantry() {
    const order = this.lastResults.map(r => r.id).filter(pid => this.players.has(pid));
    const n = order.length;
    order.forEach((pid, rankIdx) => {
      const p = this.players.get(pid);
      p.slotsMax = pantrySlotsFor(rankIdx, n);
      p.slotsUsed = 0;
      p.inventory = [];
      p.pantryDone = false;
    });
    this.pantry = {
      stock: rollPantryStock(n).map((ing, i) => ({ idx: i, ing, takenBy: null })),
      queue: [...order].reverse(),   // last place drafts first
      qPos: 0,
      turnId: null,
      turnDeadline: 0,
      turnTimer: null,
    };
    this.phase = PHASE.PANTRY;
    this.deadline = 0;
    this.beginPantryTurn(this.pantry.queue[0]);
  }

  beginPantryTurn(pid) {
    const pan = this.pantry;
    clearTimeout(pan.turnTimer);
    pan.turnId = pid;
    pan.turnDeadline = Date.now() + this.timers.pantryPick;
    pan.turnTimer = setTimeout(() => this.autoPick(pid), this.timers.pantryPick);
    this.pushRoom();
  }

  pantryPick(id, idx) {
    const pan = this.pantry;
    if (this.phase !== PHASE.PANTRY || !pan || pan.turnId !== id) return;
    const slot = pan.stock[idx];
    const p = this.players.get(id);
    if (!slot || slot.takenBy || !p) return;
    const cost = SLOT_COST[ingredientRarity(slot.ing)] ?? 1;
    if (p.slotsUsed + cost > p.slotsMax) {
      this.toast(id, 'Not enough pantry slots for that.');
      return;
    }
    slot.takenBy = id;
    p.inventory.push(slot.ing);
    p.slotsUsed += cost;
    this.advancePantryTurn();
  }

  pantryPass(id) {
    const pan = this.pantry;
    if (this.phase !== PHASE.PANTRY || !pan) return;
    const p = this.players.get(id);
    if (!p) return;
    p.pantryDone = true;
    if (pan.turnId === id) this.advancePantryTurn();
    else this.pushRoom();
  }

  autoPick(pid) {
    // Turn timed out: grab the cheapest fitting ingredient, else sit out.
    const pan = this.pantry;
    const p = this.players.get(pid);
    if (!pan || !p || pan.turnId !== pid) return;
    const fit = pan.stock
      .filter(s => !s.takenBy)
      .map(s => ({ s, cost: SLOT_COST[ingredientRarity(s.ing)] ?? 1 }))
      .filter(({ cost }) => p.slotsUsed + cost <= p.slotsMax)
      .sort((a, b) => a.cost - b.cost)[0];
    if (fit) {
      fit.s.takenBy = pid;
      p.inventory.push(fit.s.ing);
      p.slotsUsed += fit.cost;
    } else {
      p.pantryDone = true;
    }
    this.advancePantryTurn();
  }

  advancePantryTurn() {
    const pan = this.pantry;
    if (!pan) return;
    if (this.checkPantryEnd()) return;
    // next eligible drafter, cycling last → first
    for (let hop = 0; hop < pan.queue.length; hop++) {
      pan.qPos = (pan.qPos + 1) % pan.queue.length;
      const pid = pan.queue[pan.qPos];
      const p = this.players.get(pid);
      if (!p || p.pantryDone) continue;
      if (!this.canFitAnything(p)) { p.pantryDone = true; continue; }
      this.beginPantryTurn(pid);
      return;
    }
    this.finishPantry();
  }

  canFitAnything(p) {
    return this.pantry.stock.some(s =>
      !s.takenBy && p.slotsUsed + (SLOT_COST[ingredientRarity(s.ing)] ?? 1) <= p.slotsMax);
  }

  checkPantryEnd() {
    const pan = this.pantry;
    const stockLeft = pan.stock.some(s => !s.takenBy);
    const anyActive = [...this.players.values()].some(p => !p.pantryDone && this.canFitAnything(p));
    if (!stockLeft || !anyActive) { this.finishPantry(); return true; }
    return false;
  }

  finishPantry() {
    if (this.phase !== PHASE.PANTRY) return;
    clearTimeout(this.pantry?.turnTimer);
    this.pantry = null;
    this.enterCauldron();
  }

  // --------------------------------------------------------------- cauldron

  enterCauldron() {
    for (const p of this.players.values()) p.cauldronDone = false;
    this.setPhase(PHASE.CAULDRON, this.timers.cauldron, () => this.enterDeploy());
  }

  brew(id, ingredientIds, ack) {
    if (this.phase !== PHASE.CAULDRON) return ack?.({ error: 'The cauldron is cold.' });
    const p = this.players.get(id);
    if (!p) return;
    if (!Array.isArray(ingredientIds)) return ack?.({ error: 'Bad brew.' });

    const recipe = matchRecipe(ingredientIds);
    if (!recipe) return ack?.({ error: 'That mixture refuses to combine.' });

    // Verify ownership: pantry inventory items + essence pouch.
    const inv = [...p.inventory];
    const ess = { ...p.essences };
    for (const ing of ingredientIds) {
      const invIdx = inv.indexOf(ing);
      if (invIdx >= 0) { inv.splice(invIdx, 1); continue; }
      if ((ess[ing] ?? 0) > 0) { ess[ing]--; continue; }
      return ack?.({ error: `You don't have ${ing}.` });
    }
    p.inventory = inv;
    p.essences = ess;
    const potion = { uid: `pt${this.potionUid++}`, recipeId: recipe.id };
    p.potions.push(potion);
    ack?.({ ok: true, potion });
    this.pushRoom();
  }

  cauldronDone(id) {
    const p = this.players.get(id);
    if (!p || this.phase !== PHASE.CAULDRON) return;
    p.cauldronDone = true;
    if (!this.checkCauldronEnd()) this.pushRoom();
  }

  checkCauldronEnd() {
    if (this.phase !== PHASE.CAULDRON) return false;
    if ([...this.players.values()].every(p => p.cauldronDone)) {
      this.enterDeploy();
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- deploy

  enterDeploy() {
    if (this.phase === PHASE.DEPLOY) return;
    // unused pantry ingredients spoil; essences keep
    for (const p of this.players.values()) {
      p.inventory = [];
      p.deployPlan = {};
      p.deployConfirmed = false;
    }
    const anyDeployable = [...this.players.values()].some(p =>
      p.potions.some(po => isDeployable(po)));
    if (!anyDeployable) return this.afterReveal([]);
    this.setPhase(PHASE.DEPLOY, this.timers.deploy, () => this.resolveDeploy());
  }

  deploySet(id, potionUid, targetId) {
    const p = this.players.get(id);
    if (!p || this.phase !== PHASE.DEPLOY || p.deployConfirmed) return;
    const potion = p.potions.find(po => po.uid === potionUid);
    if (!potion || !isDeployable(potion)) return;
    if (targetId === null || targetId === undefined) {
      delete p.deployPlan[potionUid];
    } else {
      if (!this.players.has(targetId)) return;
      const kind = recipeById(potion.recipeId)?.kind;
      if (kind === EFFECT_KIND.ANTIDOTE && targetId !== id) return; // antidotes are self-only
      p.deployPlan[potionUid] = targetId;
    }
    this.pushRoom();
  }

  deployConfirm(id) {
    const p = this.players.get(id);
    if (!p || this.phase !== PHASE.DEPLOY) return;
    p.deployConfirmed = true;
    if (!this.checkDeployEnd()) this.pushRoom();
  }

  checkDeployEnd() {
    if (this.phase !== PHASE.DEPLOY) return false;
    if ([...this.players.values()].every(p => p.deployConfirmed)) {
      this.resolveDeploy();
      return true;
    }
    return false;
  }

  resolveDeploy() {
    if (this.phase !== PHASE.DEPLOY) return;
    const script = [];
    const plans = [];
    for (const p of this.players.values()) {
      for (const [uid, targetId] of Object.entries(p.deployPlan)) {
        const potion = p.potions.find(po => po.uid === uid);
        const target = this.players.get(targetId);
        if (!potion || !target) continue;
        plans.push({ from: p, target, potion, recipe: recipeById(potion.recipeId) });
      }
    }
    // Everything revealed & applied simultaneously: buffs, then nerfs, then antidotes.
    const kindOrder = [EFFECT_KIND.BUFF, EFFECT_KIND.NERF, EFFECT_KIND.ANTIDOTE];
    plans.sort((a, b) => kindOrder.indexOf(a.recipe.kind) - kindOrder.indexOf(b.recipe.kind));

    for (const { from, target, potion, recipe } of plans) {
      from.potions = from.potions.filter(po => po.uid !== potion.uid);
      const entry = { from: from.id, to: target.id, recipeId: recipe.id, kind: recipe.kind, result: 'applied' };

      if (recipe.kind === EFFECT_KIND.BUFF) {
        const old = target.permBuff ? recipeById(target.permBuff.recipeId) : null;
        if (old && recipe.tier < old.tier) entry.result = 'fizzled';
        else {
          if (old) entry.result = 'overwrote';
          target.permBuff = { recipeId: recipe.id, fromId: from.id };
        }
      } else if (recipe.kind === EFFECT_KIND.NERF) {
        if (target.ward) {
          target.ward = false;
          entry.result = 'warded';
        } else {
          const old = target.permNerf ? recipeById(target.permNerf.recipeId) : null;
          if (old && recipe.tier <= old.tier) entry.result = 'fizzled'; // nerf slot full
          else {
            if (old) entry.result = 'overwrote';
            target.permNerf = { recipeId: recipe.id, fromId: from.id };
          }
        }
      } else if (recipe.kind === EFFECT_KIND.ANTIDOTE) {
        if (target.permNerf) {
          target.permNerf = null;
          entry.result = 'cleansed';
        } else {
          target.ward = true;
          target.wardFresh = true; // also grants brief ghost at next race start
          entry.result = 'ward';
        }
      }
      script.push(entry);
    }
    this.afterReveal(script);
  }

  afterReveal(script) {
    this.revealScript = script;
    this.setPhase(PHASE.REVEAL, this.timers.reveal, () => {
      this.round++;
      if (this.round > ROUNDS) this.enterPodium();
      else this.startRound();
    });
  }

  // ----------------------------------------------------------------- podium

  enterPodium() {
    this.setPhase(PHASE.PODIUM, this.timers.podium, () => this.softReset());
  }

  // ------------------------------------------------------------- plumbing

  setPhase(phase, duration, onEnd) {
    clearTimeout(this.phaseTimer);
    this.phase = phase;
    this.deadline = Date.now() + duration;
    this.phaseTimer = setTimeout(onEnd, duration);
    this.pushRoom();
  }

  toast(id, msg) {
    this.sockets.get(id)?.emit('toast', { msg });
  }

  pushRoom() {
    for (const [id, socket] of this.sockets) {
      socket.emit('room', this.stateFor(id));
    }
  }

  stateFor(viewerId) {
    const now = Date.now();
    const me = this.players.get(viewerId);
    const state = {
      now,
      phase: this.phase,
      deadline: this.deadline,
      round: this.round,
      rounds: ROUNDS,
      trackIndex: this.trackIndex,
      hostId: this.hostId,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, ready: p.ready,
        score: p.score,
        permBuff: p.permBuff, permNerf: p.permNerf, ward: p.ward,
        pantryDone: p.pantryDone, cauldronDone: p.cauldronDone,
        deployConfirmed: p.deployConfirmed,
        slotsMax: p.slotsMax, slotsUsed: p.slotsUsed,
        potionCount: p.potions.length,
      })),
      you: me ? {
        id: me.id,
        essences: me.essences,
        inventory: me.inventory,
        potions: me.potions,
        deployPlan: me.deployPlan,
      } : null,
    };
    if (this.phase === PHASE.RESULTS || this.phase === PHASE.PODIUM) state.results = this.lastResults;
    if (this.phase === PHASE.PANTRY && this.pantry) {
      state.pantry = {
        stock: this.pantry.stock,
        turnId: this.pantry.turnId,
        turnDeadline: this.pantry.turnDeadline,
      };
    }
    if (this.phase === PHASE.REVEAL) state.reveal = this.revealScript;
    return state;
  }

  destroy() {
    clearInterval(this.interval);
    clearTimeout(this.phaseTimer);
    clearTimeout(this.pantry?.turnTimer);
  }
}

function isDeployable(potion) {
  const k = recipeById(potion.recipeId)?.kind;
  return k === EFFECT_KIND.BUFF || k === EFFECT_KIND.NERF || k === EFFECT_KIND.ANTIDOTE;
}

function ingredientRarity(ing) { return INGREDIENTS[ing]?.rarity ?? 'common'; }
