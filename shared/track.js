// Track definitions. A track is a closed Catmull-Rom spline; gates, item
// boxes, essences and obstacles are derived deterministically from it so the
// server and every client agree without sending geometry over the wire.

import { GATE_RADIUS } from './constants.js';

// Three handcrafted loops, one per round. y = altitude.
const TRACK_DEFS = [
  {
    id: 'emberspire',
    name: 'Emberspire Circuit',
    sky: 0xff8c5a, fog: 0x2a1530, ribbon: 0xff6b35,
    points: [
      [0, 24, -180], [120, 30, -140], [190, 44, -30], [170, 58, 90],
      [80, 70, 170], [-40, 62, 190], [-150, 46, 130], [-200, 34, 0],
      [-160, 26, -120], [-70, 22, -180],
    ],
  },
  {
    id: 'glimmerfen',
    name: 'Glimmerfen Hollow',
    sky: 0x6ee7b7, fog: 0x0c2526, ribbon: 0x34d399,
    points: [
      [0, 20, -200], [150, 35, -150], [210, 55, 0], [140, 80, 120],
      [20, 95, 160], [-90, 80, 100], [-60, 55, -10], [-140, 40, -80],
      [-210, 28, -160], [-110, 20, -210],
    ],
  },
  {
    id: 'stormcrown',
    name: 'Stormcrown Peaks',
    sky: 0x93c5fd, fog: 0x101a33, ribbon: 0x818cf8,
    points: [
      [0, 30, -190], [110, 55, -160], [200, 85, -60], [180, 110, 80],
      [60, 125, 180], [-80, 105, 160], [-170, 75, 60], [-130, 95, -40],
      [-190, 55, -130], [-90, 35, -200],
    ],
  },
];

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = 0.5 * (
      2 * p1[i] +
      (-p0[i] + p2[i]) * t +
      (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
      (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3
    );
  }
  return out;
}

// Deterministic PRNG so item layouts match everywhere.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLES_PER_SEG = 24;
const GATE_COUNT = 12;
const ITEMBOX_ROWS = 8;
const ESSENCE_CLUSTERS = 10;
const OBSTACLE_COUNT = 26;

export function buildTrack(index) {
  const def = TRACK_DEFS[index % TRACK_DEFS.length];
  const pts = def.points;
  const n = pts.length;

  // Densely sample the closed spline.
  const samples = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i];
    const p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let j = 0; j < SAMPLES_PER_SEG; j++) {
      samples.push(catmullRom(p0, p1, p2, p3, j / SAMPLES_PER_SEG));
    }
  }
  const S = samples.length;

  // Cumulative arc length for even placement.
  const cum = new Array(S + 1).fill(0);
  for (let i = 0; i < S; i++) {
    const a = samples[i], b = samples[(i + 1) % S];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const length = cum[S];

  const at = (dist) => {
    let d = ((dist % length) + length) % length;
    let lo = 0, hi = S;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid + 1] < d) lo = mid + 1; else hi = mid; }
    const a = samples[lo], b = samples[(lo + 1) % S];
    const seg = cum[lo + 1] - cum[lo] || 1;
    const t = (d - cum[lo]) / seg;
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  };

  const tangentAt = (dist) => {
    const a = at(dist - 1), b = at(dist + 1);
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  // Gates evenly along the loop; gate 0 is start/finish.
  const gates = [];
  for (let g = 0; g < GATE_COUNT; g++) {
    const d = (g / GATE_COUNT) * length;
    const p = at(d), t = tangentAt(d);
    gates.push({ id: g, pos: p, dir: t, radius: GATE_RADIUS });
  }

  const rng = mulberry32(index * 7919 + 17);
  const sideAt = (dist, offset, lift = 0) => {
    const p = at(dist), t = tangentAt(dist);
    // horizontal normal (perpendicular to tangent, flat-ish)
    const nx = t[2], nz = -t[0];
    const nl = Math.hypot(nx, nz) || 1;
    return [p[0] + (nx / nl) * offset, p[1] + lift, p[2] + (nz / nl) * offset];
  };

  // Item boxes: rows of 3 across the track between gates.
  const itemBoxes = [];
  for (let r = 0; r < ITEMBOX_ROWS; r++) {
    const d = ((r + 0.5) / ITEMBOX_ROWS) * length;
    for (const off of [-7, 0, 7]) {
      itemBoxes.push({ id: itemBoxes.length, pos: sideAt(d, off, 0) });
    }
  }

  // Essence clusters: small arcs of 3 orbs, slightly off the racing line.
  const ESSENCE_TYPES = ['moondew', 'embercap', 'glimmerleaf', 'frostbloom'];
  const essences = [];
  for (let c = 0; c < ESSENCE_CLUSTERS; c++) {
    const d = ((c + 0.23) / ESSENCE_CLUSTERS) * length;
    const side = rng() < 0.5 ? -1 : 1;
    const type = ESSENCE_TYPES[Math.floor(rng() * ESSENCE_TYPES.length)];
    for (let k = 0; k < 3; k++) {
      essences.push({
        id: essences.length,
        type,
        pos: sideAt(d + k * 6, side * (10 + rng() * 4), 2 + rng() * 3),
      });
    }
  }

  // Obstacles: floating rock spires beside / inside the corridor.
  const obstacles = [];
  for (let o = 0; o < OBSTACLE_COUNT; o++) {
    const d = rng() * length;
    const off = (rng() < 0.3 ? 0 : (rng() < 0.5 ? -1 : 1)) * (6 + rng() * 14);
    const p = sideAt(d, off, -2 + rng() * 8);
    // keep spawn-straight clear
    if (d < 60 || d > length - 30) continue;
    obstacles.push({ id: obstacles.length, pos: p, radius: 2.2 + rng() * 1.8 });
  }

  // Start grid: behind gate 0, fanned out.
  const startDir = tangentAt(0);
  const startYaw = Math.atan2(startDir[0], startDir[2]);
  const grid = [];
  for (let i = 0; i < 8; i++) {
    const row = Math.floor(i / 3), col = (i % 3) - 1;
    grid.push({ pos: sideAt(-14 - row * 8, col * 6, 0), yaw: startYaw });
  }

  return {
    id: def.id, name: def.name,
    sky: def.sky, fog: def.fog, ribbon: def.ribbon,
    length, samples, gates, itemBoxes, essences, obstacles, grid,
    gateCount: GATE_COUNT,
  };
}

export const TRACK_COUNT = TRACK_DEFS.length;
