// In-race HUD: position/lap, speed + boost, item slot, usable potions,
// essence pouch, event feed, center flashes and the minimap canvas.

import { LAPS } from '@shared/constants.js';
import { INGREDIENTS, recipeById } from '@shared/alchemy.js';

const ITEM_ICON = { wand: '🪄', shield: '🛡️', invis: '👻' };
const USABLE_ICON = { surge: '⚡', veil: '🌫️', hexbolt: '💥' };
const FLAG_FINISHED = 32;

export class Hud {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-corner hud-tl">
        <div class="hud-chip hud-big hud-pos" id="hud-pos">—</div>
        <div class="hud-chip" id="hud-lap">Lap 1/${LAPS}</div>
      </div>
      <div class="hud-corner hud-tr">
        <canvas id="minimap" width="170" height="170"></canvas>
        <div class="hud-chip" id="hud-ess"></div>
      </div>
      <div class="hud-corner hud-bl">
        <div class="hud-chip" id="hud-speed">0 km/h</div>
        <div class="hud-chip"><div class="boost-bar"><div id="hud-boost" style="width:100%"></div></div>
          <div class="key-hint">SHIFT — BOOST</div></div>
      </div>
      <div class="hud-corner hud-br">
        <div class="row">
          <div class="col" id="hud-usables"></div>
          <div class="col">
            <div class="item-slot" id="hud-item"></div>
            <div class="key-hint">SPACE</div>
          </div>
        </div>
      </div>
      <div id="feed"></div>
      <div id="flash-zone"></div>
    `;
    this.pos = root.querySelector('#hud-pos');
    this.lap = root.querySelector('#hud-lap');
    this.speedEl = root.querySelector('#hud-speed');
    this.boostEl = root.querySelector('#hud-boost');
    this.itemEl = root.querySelector('#hud-item');
    this.usablesEl = root.querySelector('#hud-usables');
    this.essEl = root.querySelector('#hud-ess');
    this.feedEl = root.querySelector('#feed');
    this.flashZone = root.querySelector('#flash-zone');
    this.map = root.querySelector('#minimap');
    this.mapCtx = this.map.getContext('2d');
    this.essences = {};
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  setItem(item) {
    this.itemEl.textContent = item ? ITEM_ICON[item] ?? '✨' : '';
    this.itemEl.classList.toggle('has', !!item);
    this.itemEl.title = item ?? '';
  }

  setUsables(potions) {
    this.usablesEl.innerHTML = '';
    for (const po of potions) {
      const r = recipeById(po.recipeId);
      const d = document.createElement('div');
      d.className = 'item-slot has';
      d.style.width = '46px'; d.style.height = '46px'; d.style.fontSize = '22px';
      d.textContent = USABLE_ICON[r?.id] ?? '🧪';
      d.title = r?.name ?? '';
      this.usablesEl.appendChild(d);
    }
    if (potions.length) {
      const hint = document.createElement('div');
      hint.className = 'key-hint';
      hint.textContent = 'E — DRINK';
      this.usablesEl.appendChild(hint);
    }
  }

  setEssences(ess) {
    this.essences = { ...(ess ?? {}) };
    this.renderEssences();
  }

  bumpEssence(type) {
    this.essences[type] = (this.essences[type] ?? 0) + 1;
    this.renderEssences();
  }

  renderEssences() {
    const parts = Object.entries(this.essences)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => {
        const c = '#' + (INGREDIENTS[t]?.color ?? 0xffffff).toString(16).padStart(6, '0');
        return `<span style="color:${c}">●</span>&thinsp;${n}`;
      });
    this.essEl.innerHTML = parts.length ? parts.join(' &nbsp;') : '<span class="dim">no essences</span>';
  }

  feed(msg) {
    const d = document.createElement('div');
    d.className = 'feed-line';
    d.textContent = msg;
    this.feedEl.appendChild(d);
    setTimeout(() => d.remove(), 4200);
    while (this.feedEl.children.length > 4) this.feedEl.firstChild.remove();
  }

  flash(msg, color = '#ff5d5d') {
    const d = document.createElement('div');
    d.className = 'center-flash';
    d.style.color = color;
    d.textContent = msg;
    this.flashZone.appendChild(d);
    setTimeout(() => d.remove(), 2500);
  }

  update({ snap, myId, players, track, boost, speed }) {
    // position among riders (finished first, then by progress)
    if (snap?.riders) {
      const order = Object.entries(snap.riders)
        .sort(([, a], [, b]) =>
          ((b.f & FLAG_FINISHED) - (a.f & FLAG_FINISHED)) || (b.prog - a.prog));
      const idx = order.findIndex(([id]) => id === myId);
      if (idx >= 0) {
        this.pos.innerHTML = `${idx + 1}<sup>${ordinal(idx + 1)}</sup> <span class="dim">/ ${order.length}</span>`;
        this.lap.textContent = `Lap ${snap.riders[myId]?.lap ?? 1}/${LAPS}`;
      }
    }
    this.speedEl.textContent = `${Math.round(speed * 3.6)} km/h`;
    this.boostEl.style.width = `${boost}%`;
    this.drawMinimap(snap, myId, players, track);
  }

  drawMinimap(snap, myId, players, track) {
    const ctx = this.mapCtx, W = this.map.width, H = this.map.height;
    ctx.clearRect(0, 0, W, H);
    if (!track) return;
    // fit track bounds
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const p of track.samples) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
    }
    const pad = 16;
    const sc = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
    const px = (x, z) => [pad + (x - minX) * sc, H - pad - (z - minZ) * sc];

    ctx.strokeStyle = 'rgba(180,150,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    track.samples.forEach((p, i) => {
      const [x, y] = px(p[0], p[2]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();

    // start gate notch
    const g0 = track.gates[0];
    const [gx, gy] = px(g0.pos[0], g0.pos[2]);
    ctx.fillStyle = '#ffd24d';
    ctx.fillRect(gx - 3, gy - 3, 6, 6);

    if (!snap?.riders) return;
    for (const [id, r] of Object.entries(snap.riders)) {
      const player = players.find(p => p.id === id);
      const [x, y] = px(r.x, r.z);
      ctx.beginPath();
      ctx.arc(x, y, id === myId ? 5 : 3.6, 0, Math.PI * 2);
      ctx.fillStyle = '#' + (player?.color ?? 0xffffff).toString(16).padStart(6, '0');
      ctx.fill();
      if (id === myId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.stroke(); }
    }
  }
}

export function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][Math.min(n % 10, 4)] ?? 'th';
}
