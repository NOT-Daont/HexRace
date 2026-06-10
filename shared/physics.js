// Deterministic broomstick flight. Runs on the server (authoritative, 30 Hz)
// and on the client (local prediction). Pure functions over plain objects so
// both sides stay bit-comparable.

import { BROOM } from './constants.js';

export function makeBroomState(x = 0, y = 20, z = 0, yaw = 0) {
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    yaw,            // heading, radians (0 = +Z)
    pitch: 0,       // radians, + = nose up
    roll: 0,        // visual bank, derived
    boost: BROOM.boostMax,
    speed: 0,       // cached |v| for HUD
  };
}

export function makeInput() {
  return { turn: 0, pitch: 0, throttle: 1, boost: false };
}

// mods: { speed, accel, handling } multipliers from potions (default 1).
export function stepBroom(s, input, dt, mods = null, surging = false) {
  const mSpeed = (mods?.speed ?? 1) * (surging ? 1.35 : 1);
  const mAccel = (mods?.accel ?? 1) * (surging ? 1.5 : 1);
  const mHandling = mods?.handling ?? 1;

  const turn = clamp(input.turn, -1, 1);
  const pit = clamp(input.pitch, -1, 1);
  const throttle = clamp(input.throttle, 0, 1);

  // Orientation
  s.yaw += turn * BROOM.turnRate * mHandling * dt;
  s.pitch += pit * BROOM.pitchRate * mHandling * dt;
  s.pitch = clamp(s.pitch, -BROOM.pitchClamp, BROOM.pitchClamp);
  if (Math.abs(pit) < 0.05) s.pitch *= Math.max(0, 1 - 2.2 * dt); // self-level
  s.roll = lerp(s.roll, -turn * 0.65, Math.min(1, 8 * dt));

  // Forward vector from yaw/pitch
  const cp = Math.cos(s.pitch), sp = Math.sin(s.pitch);
  const fx = Math.sin(s.yaw) * cp;
  const fy = sp;
  const fz = Math.cos(s.yaw) * cp;

  // Boost
  let boosting = false;
  if (input.boost && s.boost > 1) {
    boosting = true;
    s.boost = Math.max(0, s.boost - BROOM.boostDrain * dt);
  } else {
    s.boost = Math.min(BROOM.boostMax, s.boost + BROOM.boostRegen * dt);
  }

  const accel = (boosting ? BROOM.boostAccel : BROOM.accel) * mAccel * throttle;
  s.vx += fx * accel * dt;
  s.vy += fy * accel * dt;
  s.vz += fz * accel * dt;

  // Drag + speed cap
  const damp = Math.max(0, 1 - BROOM.drag * dt);
  s.vx *= damp; s.vy *= damp; s.vz *= damp;

  const maxSpeed = (boosting ? BROOM.boostMaxSpeed : BROOM.maxSpeed) * mSpeed;
  const v = Math.hypot(s.vx, s.vy, s.vz);
  if (v > maxSpeed) {
    const k = maxSpeed / v;
    s.vx *= k; s.vy *= k; s.vz *= k;
  }

  // Slow brooms sag — magic needs airspeed
  const lift = clamp(v / BROOM.liftSpeed, 0, 1);
  s.vy -= BROOM.gravity * (1 - lift) * dt;

  // Integrate
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z += s.vz * dt;

  // Ceiling + soft world boundary (steer back, never hard-stop)
  if (s.y > BROOM.maxY) { s.y = BROOM.maxY; s.vy = Math.min(0, s.vy); }
  const r = Math.hypot(s.x, s.z);
  if (r > BROOM.worldR) {
    const k = BROOM.worldR / r;
    s.x *= k; s.z *= k;
    // kill outward velocity component
    const nx = s.x / BROOM.worldR, nz = s.z / BROOM.worldR;
    const out = s.vx * nx + s.vz * nz;
    if (out > 0) { s.vx -= out * nx; s.vz -= out * nz; }
  }

  s.speed = Math.hypot(s.vx, s.vy, s.vz);
  return boosting;
}

export function copyBroom(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.roll = src.roll;
  dst.boost = src.boost; dst.speed = src.speed;
  return dst;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

export function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function dist2(ax, ay, az, bx, by, bz) {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}
