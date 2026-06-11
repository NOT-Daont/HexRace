// Tunables shared by client and server. Times in ms unless noted.
// HEXRACE_FAST (server env) shrinks phase timers for automated tests.

export const TICK_RATE = 30;          // server simulation Hz
export const SNAPSHOT_RATE = 20;      // server -> client snapshots Hz
export const INTERP_DELAY = 100;      // client render delay for remote entities

export const MAX_PLAYERS = 8;
export const ROUNDS = 3;
export const LAPS = 2;

export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  RACE: 'race',
  RESULTS: 'results',
  PANTRY: 'pantry',
  CAULDRON: 'cauldron',
  DEPLOY: 'deploy',
  REVEAL: 'reveal',
  PODIUM: 'podium',
};

export const TIMERS = {
  countdown: 3000,
  raceGrace: 45000,      // after first finisher, stragglers get this long
  raceHardCap: 240000,   // absolute race length cap
  results: 6000,
  pantryPick: 10000,     // per draft turn
  cauldron: 60000,
  deploy: 25000,
  reveal: 6000,
  podium: 15000,
};

// Finishing points by place (index 0 = 1st).
export const RACE_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

// --- Broom flight ---------------------------------------------------------
export const BROOM = {
  accel: 26,             // m/s^2 forward
  maxSpeed: 36,          // m/s base
  boostMaxSpeed: 50,
  boostAccel: 40,
  drag: 0.55,            // /s velocity damping
  turnRate: 2.1,         // rad/s yaw at full input
  pitchRate: 1.5,        // rad/s
  pitchClamp: 0.9,       // rad
  gravity: 9,            // pulls down when slow
  liftSpeed: 14,         // full lift at/above this speed
  boostMax: 100,         // boost charge units
  boostDrain: 45,        // /s while boosting
  boostRegen: 12,        // /s
  minY: 1.2,             // ground crash plane (terrain is ~flat under track)
  maxY: 140,
  worldR: 520,           // soft world boundary radius
};

export const KNOCKOUT = {
  fallTime: 2500,        // tumbling before respawn
  ghostTime: 3000,       // post-respawn immunity
  respawnBoost: 1500,    // post-respawn speed surge
};

export const ITEMS = {
  WAND: 'wand',
  SHIELD: 'shield',
  INVIS: 'invis',
};
export const ITEM_POOL = [ITEMS.WAND, ITEMS.WAND, ITEMS.SHIELD, ITEMS.INVIS]; // weighted

export const ITEM_RESPAWN = 5000;     // item box respawn
export const ESSENCE_RESPAWN = 12000;
export const SHIELD_DURATION = 6000;
export const INVIS_DURATION = 6000;

export const PROJECTILE = {
  speed: 60,
  turnRate: 2.4,         // homing rad/s
  lifetime: 4000,
  hitRadius: 3.2,
  acquireDot: 0.55,      // homing acquisition cone (cos)
  acquireRange: 90,
};

export const PICKUP_RADIUS = 4.5;
export const GATE_RADIUS = 11;
export const OBSTACLE_HIT_PAD = 1.4;

// --- Pantry ---------------------------------------------------------------
export const SLOT_COST = { common: 1, rare: 2, legendary: 3 };
export const PANTRY_SLOTS_MIN = 3;    // 1st place
export const PANTRY_SLOTS_MAX = 7;    // last place

export function pantrySlotsFor(rankIndex, playerCount) {
  if (playerCount <= 1) return PANTRY_SLOTS_MAX;
  const t = rankIndex / (playerCount - 1); // 0 = 1st place, 1 = last
  return Math.round(PANTRY_SLOTS_MIN + t * (PANTRY_SLOTS_MAX - PANTRY_SLOTS_MIN));
}

// --- Potions / effects ----------------------------------------------------
export const EFFECT_KIND = { BUFF: 'buff', NERF: 'nerf', ANTIDOTE: 'antidote', USABLE: 'usable' };

// Stat modifiers applied multiplicatively to broom params.
export const STAT = { SPEED: 'speed', ACCEL: 'accel', HANDLING: 'handling' };

export const USABLE_DURATION = { surge: 4000, veil: 5000 };

export function fastTimers(divisor = 40) {
  const t = {};
  for (const k of Object.keys(TIMERS)) t[k] = Math.max(60, Math.floor(TIMERS[k] / divisor));
  return t;
}
