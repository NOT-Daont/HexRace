// Ingredients, recipes and potion effects — the alchemy layer.
// Pure data + matching helpers, shared verbatim by server and client.

import { EFFECT_KIND, STAT } from './constants.js';

// rarity: 'essence' ingredients are collected during the race (no slot cost);
// the rest are drafted in the pantry and cost slots (common 1 / rare 2 / legendary 3).
export const INGREDIENTS = {
  // essences (race pickups)
  moondew:     { name: 'Moondew',         rarity: 'essence',   color: 0x9bd8ff, desc: 'Condensed moonlight, cool to the touch.' },
  embercap:    { name: 'Embercap',        rarity: 'essence',   color: 0xff7a45, desc: 'A mushroom that smolders but never burns.' },
  glimmerleaf: { name: 'Glimmerleaf',     rarity: 'essence',   color: 0x7dff9b, desc: 'Its veins pulse with green light.' },
  frostbloom:  { name: 'Frostbloom',      rarity: 'essence',   color: 0xbfe3ff, desc: 'A flower that blooms only in cold winds.' },
  // commons
  batwing:     { name: 'Bat Wing',        rarity: 'common',    color: 0x8b7bb5, desc: 'Standard issue. Sustainably sourced.' },
  neweye:      { name: 'Newt Eye',        rarity: 'common',    color: 0xc8e06b, desc: 'Sees in every direction at once.' },
  toadstool:   { name: 'Toadstool',       rarity: 'common',    color: 0xe06b6b, desc: 'Spotted, squishy, surprisingly potent.' },
  nettle:      { name: 'Gravenettle',     rarity: 'common',    color: 0x6bbf8e, desc: 'Stings the brewer and the target alike.' },
  // rares
  phoenix:     { name: 'Phoenix Feather', rarity: 'rare',      color: 0xffb347, desc: 'Still warm. Probably always will be.' },
  dragonscale: { name: 'Dragon Scale',    rarity: 'rare',      color: 0xd94f4f, desc: 'Shed, not stolen. Mostly.' },
  bansheetear: { name: 'Banshee Tear',    rarity: 'rare',      color: 0xa8c6e8, desc: 'Bottled sorrow, strangely purifying.' },
  // legendaries
  unicornhair: { name: 'Unicorn Hair',    rarity: 'legendary', color: 0xfff1f8, desc: 'Freely given, impossibly strong.' },
  starcore:    { name: 'Stardust Core',   rarity: 'legendary', color: 0xc9b8ff, desc: 'The heavy heart of a fallen star.' },
};

// Recipes are matched as ingredient multisets (order-independent).
// tier decides nerf-overwrite priority during deployment reveal.
export const RECIPES = [
  // --- permanent buffs ---
  { id: 'swiftdraft',  name: 'Swiftdraft',        kind: EFFECT_KIND.BUFF, tier: 1, color: 0x4dd2ff,
    stats: { [STAT.SPEED]: 1.10 }, ingredients: ['neweye', 'moondew', 'moondew'],
    desc: '+10% top speed. The wind files a complaint.' },
  { id: 'stormgrip',   name: 'Stormgrip Oil',     kind: EFFECT_KIND.BUFF, tier: 1, color: 0x7dff9b,
    stats: { [STAT.HANDLING]: 1.18 }, ingredients: ['batwing', 'glimmerleaf', 'glimmerleaf'],
    desc: '+18% handling. Corners become suggestions.' },
  { id: 'emberheart',  name: 'Emberheart Brew',   kind: EFFECT_KIND.BUFF, tier: 1, color: 0xff7a45,
    stats: { [STAT.ACCEL]: 1.18 }, ingredients: ['toadstool', 'embercap', 'embercap'],
    desc: '+18% acceleration. Launches like a startled cat.' },
  { id: 'comet',       name: 'Comet Elixir',      kind: EFFECT_KIND.BUFF, tier: 2, color: 0xfff1f8,
    stats: { [STAT.SPEED]: 1.08, [STAT.ACCEL]: 1.10 }, ingredients: ['unicornhair', 'phoenix'],
    desc: 'Speed AND acceleration. Legendary for a reason.' },
  // --- permanent nerfs ---
  { id: 'leadweight',  name: 'Leadweight Tonic',  kind: EFFECT_KIND.NERF, tier: 1, color: 0x9aa0b5,
    stats: { [STAT.SPEED]: 0.90 }, ingredients: ['nettle', 'frostbloom', 'frostbloom'],
    desc: 'Target loses 10% top speed.' },
  { id: 'fumblebrew',  name: 'Fumblebrew',        kind: EFFECT_KIND.NERF, tier: 1, color: 0x6bbf8e,
    stats: { [STAT.HANDLING]: 0.82 }, ingredients: ['nettle', 'glimmerleaf', 'glimmerleaf'],
    desc: 'Target steers like a haunted shopping trolley.' },
  { id: 'sputter',     name: 'Sputterdraught',    kind: EFFECT_KIND.NERF, tier: 1, color: 0xd97f4f,
    stats: { [STAT.ACCEL]: 0.82 }, ingredients: ['nettle', 'embercap', 'embercap'],
    desc: 'Target loses 18% acceleration.' },
  { id: 'anchors',     name: 'Curse of Anchors',  kind: EFFECT_KIND.NERF, tier: 2, color: 0xc9b8ff,
    stats: { [STAT.SPEED]: 0.92, [STAT.ACCEL]: 0.90 }, ingredients: ['starcore', 'bansheetear'],
    desc: 'Slower AND sluggish. Overwrites lesser curses.' },
  // --- antidote ---
  { id: 'purify',      name: 'Purifying Tonic',   kind: EFFECT_KIND.ANTIDOTE, tier: 1, color: 0xa8c6e8,
    ingredients: ['bansheetear', 'moondew'],
    desc: 'Cleanses your active curse — or shields you from the next one if clean.' },
  // --- one-time usables (key E during the race) ---
  { id: 'surge',       name: 'Surge Vial',        kind: EFFECT_KIND.USABLE, tier: 1, color: 0xffd24d,
    ingredients: ['embercap', 'moondew'],
    desc: '4 s of raw speed, drink mid-race.' },
  { id: 'veil',        name: 'Veil Philtre',      kind: EFFECT_KIND.USABLE, tier: 1, color: 0xbfe3ff,
    ingredients: ['frostbloom', 'frostbloom', 'glimmerleaf'],
    desc: '5 s of invisibility, drink mid-race.' },
  { id: 'hexbolt',     name: 'Hexbolt Charge',    kind: EFFECT_KIND.USABLE, tier: 1, color: 0xd94f4f,
    ingredients: ['dragonscale', 'embercap'],
    desc: 'Bottled lightning: fires a homing hex when drunk.' },
];

const recipeIndex = new Map(RECIPES.map(r => [r.ingredients.slice().sort().join('+'), r]));

export function matchRecipe(ingredientIds) {
  if (!Array.isArray(ingredientIds) || ingredientIds.length < 2 || ingredientIds.length > 4) return null;
  return recipeIndex.get(ingredientIds.slice().sort().join('+')) ?? null;
}

export function recipeById(id) {
  return RECIPES.find(r => r.id === id) ?? null;
}

// Pantry stock for a round, scaled to player count. Returns ingredient ids
// (commons are plentiful, legendaries scarce — drafting order matters).
export function rollPantryStock(playerCount, rand = Math.random) {
  const commons = ['batwing', 'neweye', 'toadstool', 'nettle'];
  const rares = ['phoenix', 'dragonscale', 'bansheetear'];
  const legendaries = ['unicornhair', 'starcore'];
  const stock = [];
  const push = (pool, count) => {
    for (let i = 0; i < count; i++) stock.push(pool[Math.floor(rand() * pool.length)]);
  };
  push(commons, 4 * playerCount);
  push(rares, 2 * playerCount);
  push(legendaries, Math.max(2, Math.ceil(playerCount * 0.75)));
  // shuffle
  for (let i = stock.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [stock[i], stock[j]] = [stock[j], stock[i]];
  }
  return stock;
}
