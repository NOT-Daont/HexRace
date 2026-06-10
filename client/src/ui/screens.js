// DOM screens for every non-flying part of the loop: join, lobby, countdown,
// results, pantry draft, cauldron brewing, deployment, reveal and podium.
// Screens are rebuilt on every room push; sticky local state (cauldron mix)
// lives at module level so rebuilds don't lose it.

import { net } from '../net.js';
import { PHASE, SLOT_COST, LAPS } from '@shared/constants.js';
import { INGREDIENTS, RECIPES, recipeById, matchRecipe } from '@shared/alchemy.js';
import { ordinal } from './hud.js';

const USABLE_ICON = { surge: '⚡', veil: '🌫️', hexbolt: '💥' };
const KIND_LABEL = { buff: 'buff', nerf: 'nerf', antidote: 'antidote', usable: 'usable' };

export function el(tag, cls = '', html = '') {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html) d.innerHTML = html;
  return d;
}

const hex = (c) => '#' + (c ?? 0xffffff).toString(16).padStart(6, '0');
const nameOf = (st, id) => st.players.find(p => p.id === id)?.name ?? '???';
const colorOf = (st, id) => hex(st.players.find(p => p.id === id)?.color);

// ---------------------------------------------------------------- helpers

function timerBar(deadline, disposers) {
  const wrap = el('div', 'timer-bar');
  const fill = el('div');
  wrap.appendChild(fill);
  const total = Math.max(1, deadline - net.serverNow());
  const iv = setInterval(() => {
    const left = Math.max(0, deadline - net.serverNow());
    fill.style.width = `${(left / total) * 100}%`;
  }, 100);
  disposers.push(() => clearInterval(iv));
  return wrap;
}

function ingCard(ing, { qty = 0, taken = false, disabled = false, noCost = false, onClick } = {}) {
  const def = INGREDIENTS[ing];
  const card = el('div', `ing-card rar-${def.rarity}${taken ? ' taken' : ''}${disabled ? ' disabled' : ''}`);
  const cost = SLOT_COST[def.rarity];
  card.innerHTML = `
    <div class="ing-icon" style="background:${hex(def.color)};color:${hex(def.color)}"></div>
    <div class="ing-name">${def.name}</div>
    <div class="ing-cost">${noCost || !cost ? def.rarity : `${def.rarity} · ${cost} slot${cost > 1 ? 's' : ''}`}</div>
    ${qty > 1 ? `<div class="qty">${qty}</div>` : ''}
  `;
  card.title = def.desc;
  if (onClick && !taken && !disabled) card.addEventListener('click', onClick);
  return card;
}

function scoreStrip(st) {
  const strip = el('div', 'score-strip');
  for (const p of [...st.players].sort((a, b) => b.score - a.score)) {
    const fx = [];
    if (p.permBuff) fx.push(`<span title="${recipeById(p.permBuff.recipeId)?.name}">🟢</span>`);
    if (p.permNerf) fx.push(`<span title="${recipeById(p.permNerf.recipeId)?.name}">🔴</span>`);
    if (p.ward) fx.push('<span title="Warded against the next curse">🔰</span>');
    strip.appendChild(el('div', 'score-pill', `
      <span class="dot" style="background:${hex(p.color)};color:${hex(p.color)}"></span>
      <b>${p.name}</b> ${p.score} pts
      <span class="effect-icons">${fx.join('')}</span>
    `));
  }
  return strip;
}

function roundHeader(st, title) {
  return el('h2', '', `Round ${st.round}/${st.rounds} — ${title}`);
}

// ------------------------------------------------------------------- join

export function joinScreen(onJoined) {
  const panel = el('div', 'panel col');
  panel.innerHTML = `
    <h1 class="logo">HEXRACE</h1>
    <div class="tagline">BROOMSTICK ALCHEMY RACING</div>
  `;
  const input = el('input');
  input.type = 'text'; input.maxLength = 16;
  input.placeholder = 'Your witch name…';
  input.value = localStorage.getItem('hexrace-name') ?? '';
  const btn = el('button', '', 'Enter the Lobby');
  const err = el('div', 'dim center');
  const go = async () => {
    btn.disabled = true;
    const name = input.value.trim() || 'Anonymous Witch';
    localStorage.setItem('hexrace-name', name);
    const res = await net.join(name);
    if (res.ok) onJoined();
    else { err.textContent = res.error ?? 'Could not join.'; btn.disabled = false; }
  };
  btn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  panel.append(input, btn, err);
  setTimeout(() => input.focus(), 50);
  return { el: panel, dispose: () => {} };
}

// ------------------------------------------------------------------ lobby

let infoCache = null;
async function fetchInfo() {
  if (!infoCache) infoCache = fetch('/info').then(r => r.json()).catch(() => null);
  return infoCache;
}

export function lobbyScreen(st) {
  const panel = el('div', 'panel col');
  panel.append(
    el('h1', 'logo', 'HEXRACE'),
    el('div', 'tagline', 'GATHER YOUR COVEN — 2–8 RIDERS'),
  );

  const list = el('div', 'player-list');
  for (const p of st.players) {
    const row = el('div', `player-row${p.id === net.myId ? ' me' : ''}`);
    row.innerHTML = `
      <span class="dot" style="background:${hex(p.color)};color:${hex(p.color)}"></span>
      <b>${p.name}</b>
      ${p.id === st.hostId ? '<span class="host-tag">HOST</span>' : ''}
      <span class="spacer"></span>
      ${p.id === st.hostId || p.ready
        ? '<span class="ready-tag">✦ READY</span>'
        : '<span class="wait-tag">waiting…</span>'}
    `;
    list.appendChild(row);
  }
  panel.appendChild(list);

  const me = st.players.find(p => p.id === net.myId);
  const isHost = st.hostId === net.myId;
  const actions = el('div', 'row');
  if (isHost) {
    const allReady = st.players.every(p => p.id === st.hostId || p.ready);
    const start = el('button', '', st.players.length < 2 ? 'Start solo practice' : 'Start the Match');
    start.disabled = !allReady;
    start.addEventListener('click', () => net.send('lobby:start'));
    actions.appendChild(start);
    if (!allReady) actions.appendChild(el('span', 'dim', 'waiting for everyone to ready up…'));
  } else {
    const ready = el('button', me?.ready ? 'ghost' : '', me?.ready ? 'Un-ready' : 'Ready Up');
    ready.addEventListener('click', () => net.send('lobby:ready', { ready: !me?.ready }));
    actions.appendChild(ready);
  }
  panel.appendChild(actions);

  panel.appendChild(el('h3', '', 'Invite friends'));
  const urlBox = el('div', 'join-url', 'fetching join address…');
  urlBox.title = 'Click to copy';
  fetchInfo().then(info => {
    const url = info?.joinUrls?.[0] ?? window.location.href;
    urlBox.textContent = url;
    urlBox.addEventListener('click', () => navigator.clipboard?.writeText(url));
  });
  panel.appendChild(urlBox);
  panel.appendChild(el('div', 'dim', 'Anyone on your network can open this address to join. ' +
    'Hosting beyond your LAN? Forward the port or use a tunnel.'));

  return { el: panel, dispose: () => {} };
}

// -------------------------------------------------------------- countdown

export function countdownScreen(st, trackName) {
  const wrap = el('div', 'col center');
  wrap.append(
    el('h2', '', `Round ${st.round}/${st.rounds} — ${trackName}`),
    el('div', 'countdown-num', ''),
    el('div', 'dim', `${LAPS} laps · WASD to fly · SHIFT boost · SPACE item · E potion`),
  );
  const num = wrap.querySelector('.countdown-num');
  let last = null;
  const iv = setInterval(() => {
    const n = Math.max(1, Math.ceil((st.deadline - net.serverNow()) / 1000));
    if (n !== last) {
      last = n;
      num.textContent = n;
      num.style.animation = 'none';
      void num.offsetWidth;            // restart pop animation
      num.style.animation = '';
    }
  }, 60);
  return { el: wrap, dispose: () => clearInterval(iv) };
}

// ---------------------------------------------------------------- results

export function resultsScreen(st) {
  const panel = el('div', 'panel col');
  panel.appendChild(roundHeader(st, 'Race Results'));
  panel.appendChild(scoreStrip(st));
  const table = el('table', 'results');
  table.innerHTML = '<tr><th></th><th>Rider</th><th>Points</th><th>Time</th><th>Essences</th></tr>';
  for (const r of st.results ?? []) {
    const tr = el('tr');
    tr.innerHTML = `
      <td class="place-${r.place}">${r.place}${ordinal(r.place)}</td>
      <td><span class="dot" style="display:inline-block;background:${colorOf(st, r.id)}"></span> ${nameOf(st, r.id)}</td>
      <td>+${r.points}</td>
      <td>${r.time != null ? (r.time / 1000).toFixed(1) + 's' : 'DNF'}</td>
      <td>${r.essences}</td>
    `;
    table.appendChild(tr);
  }
  panel.appendChild(table);
  panel.appendChild(el('div', 'dim center', 'Next: the Pantry — slower riders draft first and carry more…'));
  return { el: panel, dispose: () => {} };
}

// ----------------------------------------------------------------- pantry

export function pantryScreen(st) {
  const disposers = [];
  const panel = el('div', 'panel col');
  panel.appendChild(roundHeader(st, 'The Pantry'));
  panel.appendChild(scoreStrip(st));

  const pan = st.pantry;
  const me = st.players.find(p => p.id === net.myId);
  const myTurn = pan?.turnId === net.myId;

  const banner = el('div', 'turn-banner',
    myTurn ? '✨ YOUR PICK — choose an ingredient!'
           : pan?.turnId ? `${nameOf(st, pan.turnId)} is choosing…` : '');
  panel.appendChild(banner);
  if (pan?.turnDeadline) panel.appendChild(timerBar(pan.turnDeadline, disposers));

  // my capacity
  const cap = el('div', 'row');
  cap.appendChild(el('span', 'dim', `Your satchel (${me.slotsUsed}/${me.slotsMax} slots):`));
  const meter = el('div', 'slot-meter');
  for (let i = 0; i < me.slotsMax; i++) {
    meter.appendChild(el('div', `slot-pip${i < me.slotsUsed ? ' used' : ''}`));
  }
  cap.appendChild(meter);
  panel.appendChild(cap);

  // stock grid
  const grid = el('div', 'card-grid');
  for (const slot of pan?.stock ?? []) {
    const cost = SLOT_COST[INGREDIENTS[slot.ing].rarity] ?? 1;
    const affordable = me.slotsUsed + cost <= me.slotsMax;
    const card = ingCard(slot.ing, {
      taken: !!slot.takenBy,
      disabled: !myTurn || !affordable,
      onClick: () => net.send('pantry:pick', { idx: slot.idx }),
    });
    if (slot.takenBy) {
      card.style.outline = `2px solid ${colorOf(st, slot.takenBy)}`;
      card.title = `Taken by ${nameOf(st, slot.takenBy)}`;
    }
    grid.appendChild(card);
  }
  panel.appendChild(grid);

  // my haul + pass
  panel.appendChild(el('h3', '', 'Your haul'));
  const haul = el('div', 'row');
  if (net.you?.inventory.length) {
    for (const ing of net.you.inventory) haul.appendChild(ingCard(ing, { disabled: true }));
  } else {
    haul.appendChild(el('span', 'dim', 'nothing yet'));
  }
  panel.appendChild(haul);

  if (!me.pantryDone) {
    const pass = el('button', 'ghost small', 'Done drafting (pass)');
    pass.addEventListener('click', () => net.send('pantry:pass'));
    panel.appendChild(pass);
  }

  return { el: panel, dispose: () => disposers.forEach(f => f()) };
}

// --------------------------------------------------------------- cauldron

let mix = [];               // ingredient ids in the cauldron (local UI state)
let mixKey = '';            // reset when round changes
let showBook = false;

export function cauldronScreen(st) {
  const key = `${st.round}`;
  if (key !== mixKey) { mix = []; mixKey = key; }
  const disposers = [];
  const panel = el('div', 'panel col');
  panel.appendChild(roundHeader(st, 'The Cauldron'));
  panel.appendChild(timerBar(st.deadline, disposers));
  panel.appendChild(scoreStrip(st));

  // pooled ingredient counts: pantry haul + essence pouch, minus mix usage
  const owned = {};
  for (const ing of net.you?.inventory ?? []) owned[ing] = (owned[ing] ?? 0) + 1;
  for (const [ess, n] of Object.entries(net.you?.essences ?? {})) {
    if (n > 0) owned[ess] = (owned[ess] ?? 0) + n;
  }
  const inMix = {};
  for (const ing of mix) inMix[ing] = (inMix[ing] ?? 0) + 1;

  panel.appendChild(el('h3', '', 'Your ingredients — click to toss into the cauldron'));
  const grid = el('div', 'card-grid');
  const entries = Object.entries(owned);
  if (!entries.length) grid.appendChild(el('span', 'dim', 'You have nothing to brew with this round.'));
  for (const [ing, n] of entries) {
    const left = n - (inMix[ing] ?? 0);
    grid.appendChild(ingCard(ing, {
      qty: left,
      noCost: true,
      disabled: left <= 0 || mix.length >= 4,
      onClick: () => { mix.push(ing); rerender(); },
    }));
  }
  panel.appendChild(grid);

  // the mix
  panel.appendChild(el('h3', '', 'In the cauldron — click to take back'));
  const zone = el('div', 'mix-zone');
  if (!mix.length) zone.appendChild(el('span', 'dim', 'empty… add 2–3 ingredients'));
  mix.forEach((ing, i) => {
    const c = ingCard(ing, { noCost: true, onClick: () => { mix.splice(i, 1); rerender(); } });
    c.style.width = '88px';
    zone.appendChild(c);
  });
  panel.appendChild(zone);

  const recipe = matchRecipe(mix);
  const brewRow = el('div', 'row');
  const brew = el('button', '', recipe ? `Brew: ${recipe.name}` : 'Brew');
  brew.disabled = !recipe;
  brew.addEventListener('click', async () => {
    brew.disabled = true;
    const res = await net.brew(mix);
    if (res?.ok) { mix = []; }
    rerender();
  });
  brewRow.appendChild(brew);
  if (recipe) {
    brewRow.appendChild(el('span', '', `<span class="kind-tag kind-${recipe.kind}">${KIND_LABEL[recipe.kind]}</span> <span class="dim">${recipe.desc}</span>`));
  } else if (mix.length >= 2) {
    brewRow.appendChild(el('span', 'dim', 'this mixture refuses to combine…'));
  }
  panel.appendChild(brewRow);

  // brewed potions
  panel.appendChild(el('h3', '', 'Your potions'));
  const shelf = el('div', 'row');
  if (!net.you?.potions.length) shelf.appendChild(el('span', 'dim', 'none yet'));
  for (const po of net.you?.potions ?? []) {
    const r = recipeById(po.recipeId);
    shelf.appendChild(el('span', 'potion-chip',
      `<span class="ing-icon" style="background:${hex(r.color)}"></span>
       ${USABLE_ICON[r.id] ?? ''} ${r.name}
       <span class="kind-tag kind-${r.kind}">${KIND_LABEL[r.kind]}</span>`));
  }
  panel.appendChild(shelf);

  // recipe book + done
  const foot = el('div', 'row spread');
  const bookBtn = el('button', 'ghost small', showBook ? 'Hide recipe book' : '📖 Recipe book');
  bookBtn.addEventListener('click', () => { showBook = !showBook; rerender(); });
  foot.appendChild(bookBtn);
  const me = st.players.find(p => p.id === net.myId);
  const done = el('button', 'small', me?.cauldronDone ? 'Waiting for others…' : 'Finish brewing');
  done.disabled = !!me?.cauldronDone;
  done.addEventListener('click', () => net.send('cauldron:done'));
  foot.appendChild(done);
  panel.appendChild(foot);

  if (showBook) {
    const book = el('div', 'col');
    for (const r of RECIPES) {
      const ings = r.ingredients.map(i =>
        `<span class="ing-icon" style="background:${hex(INGREDIENTS[i].color)};width:16px;height:16px;display:inline-block;vertical-align:-3px"
               title="${INGREDIENTS[i].name}"></span>`).join(' + ');
      book.appendChild(el('div', 'recipe-row',
        `<span class="kind-tag kind-${r.kind}">${KIND_LABEL[r.kind]}</span>
         <b>${r.name}</b> = ${ings} <span class="dim">${r.desc}</span>`));
    }
    panel.appendChild(book);
  }

  function rerender() {
    const fresh = cauldronScreen(st);
    panel.replaceWith(fresh.el);
    disposers.forEach(f => f());
    disposers.length = 0;
    disposers.push(fresh.dispose);
  }

  return { el: panel, dispose: () => disposers.forEach(f => f()) };
}

// ----------------------------------------------------------------- deploy

export function deployScreen(st) {
  const disposers = [];
  const panel = el('div', 'panel col');
  panel.appendChild(roundHeader(st, 'Deployment'));
  panel.appendChild(timerBar(st.deadline, disposers));
  panel.appendChild(el('div', 'dim center',
    'Secretly choose targets for your permanent potions. Everything is revealed at once. ' +
    'Max 1 buff + 1 curse active per rider — stronger curses overwrite, equal ones fizzle.'));
  panel.appendChild(scoreStrip(st));

  const me = st.players.find(p => p.id === net.myId);
  const deployables = (net.you?.potions ?? [])
    .filter(po => ['buff', 'nerf', 'antidote'].includes(recipeById(po.recipeId)?.kind));

  if (!deployables.length) {
    panel.appendChild(el('div', 'center dim', 'You brewed nothing deployable. Usable potions ride with you.'));
  }

  for (const po of deployables) {
    const r = recipeById(po.recipeId);
    const row = el('div', 'col');
    row.appendChild(el('div', '',
      `<span class="kind-tag kind-${r.kind}">${KIND_LABEL[r.kind]}</span> <b>${r.name}</b> <span class="dim">${r.desc}</span>`));
    const targets = el('div', 'row');
    const choices = r.kind === 'antidote'
      ? st.players.filter(p => p.id === net.myId)
      : st.players;
    const current = net.you?.deployPlan?.[po.uid];
    for (const p of choices) {
      const chip = el('div', `target-chip${current === p.id ? ' selected' : ''}`,
        `<span class="dot" style="background:${hex(p.color)}"></span>${p.id === net.myId ? 'Yourself' : p.name}`);
      if (!me?.deployConfirmed) {
        chip.addEventListener('click', () =>
          net.send('deploy:set', { uid: po.uid, target: current === p.id ? null : p.id }));
      }
      targets.appendChild(chip);
    }
    const skip = el('div', `target-chip${current == null ? ' selected' : ''}`, 'Hold back');
    if (!me?.deployConfirmed) {
      skip.addEventListener('click', () => net.send('deploy:set', { uid: po.uid, target: null }));
    }
    targets.appendChild(skip);
    row.appendChild(targets);
    panel.appendChild(row);
  }

  const foot = el('div', 'row');
  const confirm = el('button', '', me?.deployConfirmed ? 'Locked in ✓' : 'Lock in choices');
  confirm.disabled = !!me?.deployConfirmed;
  confirm.addEventListener('click', () => net.send('deploy:confirm'));
  foot.appendChild(confirm);
  const waiting = st.players.filter(p => !p.deployConfirmed).map(p => p.name);
  if (waiting.length) foot.appendChild(el('span', 'dim', `waiting: ${waiting.join(', ')}`));
  panel.appendChild(foot);

  return { el: panel, dispose: () => disposers.forEach(f => f()) };
}

// ----------------------------------------------------------------- reveal

const RESULT_TEXT = {
  applied: ['takes hold!', 'var(--green)'],
  overwrote: ['overwrites the old effect!', 'var(--gold)'],
  fizzled: ['fizzles — the slot was full.', 'var(--ink-dim)'],
  warded: ['shatters against a ward!', 'var(--teal)'],
  cleansed: ['cleanses the curse!', 'var(--teal)'],
  ward: ['weaves a protective ward.', 'var(--teal)'],
};

export function revealScreen(st) {
  const panel = el('div', 'panel col');
  panel.appendChild(roundHeader(st, 'The Reveal'));
  if (!st.reveal?.length) {
    panel.appendChild(el('div', 'center dim', 'No potions were deployed. The cauldrons sit cold…'));
  }
  st.reveal?.forEach((e, i) => {
    const r = recipeById(e.recipeId);
    const [text, color] = RESULT_TEXT[e.result] ?? ['…', 'var(--ink)'];
    const line = el('div', 'reveal-line',
      `<b style="color:${colorOf(st, e.from)}">${nameOf(st, e.from)}</b>’s
       <b>${r?.name}</b>
       <span class="kind-tag kind-${e.kind}">${KIND_LABEL[e.kind]}</span>
       → <b style="color:${colorOf(st, e.to)}">${e.from === e.to ? 'themself' : nameOf(st, e.to)}</b>
       <span style="color:${color}"> ${text}</span>`);
    line.style.animationDelay = `${i * 0.7}s`;
    panel.appendChild(line);
  });
  panel.appendChild(scoreStrip(st));
  panel.appendChild(el('div', 'dim center', st.round < st.rounds ? 'Next race begins shortly…' : 'Final standings ahead…'));
  return { el: panel, dispose: () => {} };
}

// ----------------------------------------------------------------- podium

export function podiumScreen(st) {
  const panel = el('div', 'panel col center');
  panel.appendChild(el('h1', 'logo', 'FINAL STANDINGS'));
  const sorted = [...st.players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  const table = el('table', 'results');
  sorted.forEach((p, i) => {
    const tr = el('tr');
    tr.innerHTML = `
      <td class="place-${i + 1}">${medals[i] ?? `${i + 1}${ordinal(i + 1)}`}</td>
      <td><span class="dot" style="display:inline-block;background:${hex(p.color)}"></span> <b>${p.name}</b></td>
      <td>${p.score} pts</td>
    `;
    table.appendChild(tr);
  });
  panel.appendChild(table);
  if (sorted[0]) {
    panel.appendChild(el('div', '', `👑 <b style="color:var(--gold)">${sorted[0].name}</b> wins the Hex Cup!`));
  }
  panel.appendChild(el('div', 'dim', 'Returning to the lobby…'));
  return { el: panel, dispose: () => {} };
}
