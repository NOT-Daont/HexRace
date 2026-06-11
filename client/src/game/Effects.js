// Pooled particle system (one Points draw call) for trails, pickup sparkles,
// knockout bursts and projectile fizzles.

import * as THREE from 'three';

const CAP = 2600;

export class Effects {
  constructor(scene) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(CAP * 3);
    this.col = new Float32Array(CAP * 3);
    this.vel = new Float32Array(CAP * 3);
    this.life = new Float32Array(CAP);     // seconds remaining
    this.maxLife = new Float32Array(CAP);
    this.baseCol = new Float32Array(CAP * 3);
    this.head = 0;

    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));

    this.points = new THREE.Points(this.geo, new THREE.PointsMaterial({
      size: 0.55,
      map: makeGlowTexture(),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.scene = scene;
    this.tmpColor = new THREE.Color();
  }

  spawn(x, y, z, vx, vy, vz, color, life) {
    const i = this.head;
    this.head = (this.head + 1) % CAP;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.tmpColor.set(color);
    this.baseCol.set([this.tmpColor.r, this.tmpColor.g, this.tmpColor.b], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  burst(p, color, n = 28, speed = 9, life = 0.9) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.5) * Math.PI;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.spawn(p.x, p.y, p.z,
        Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s, Math.sin(a) * Math.cos(e) * s,
        color, life * (0.6 + Math.random() * 0.4));
    }
  }

  trail(p, color, spread = 0.25) {
    this.spawn(
      p.x + (Math.random() - 0.5) * spread,
      p.y + (Math.random() - 0.5) * spread,
      p.z + (Math.random() - 0.5) * spread,
      (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6,
      color, 0.45 + Math.random() * 0.25);
  }

  update(dt) {
    for (let i = 0; i < CAP; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) {
        this.col[j] = this.col[j + 1] = this.col[j + 2] = 0;
        this.pos[j + 1] = -9999;
        continue;
      }
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.vel[j + 1] -= 2.5 * dt;            // soft gravity
      const f = this.life[i] / this.maxLife[i];
      this.col[j] = this.baseCol[j] * f;
      this.col[j + 1] = this.baseCol[j + 1] * f;
      this.col[j + 2] = this.baseCol[j + 2] * f;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// soft radial glow so particles read as motes, not squares
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
