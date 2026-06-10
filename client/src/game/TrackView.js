// Builds the visible course from shared track data: guide ribbon, gates,
// item boxes, essence orbs, rock spires, start banner. Owns their per-frame
// idle animations and active/inactive state from snapshots.

import * as THREE from 'three';
import { INGREDIENTS } from '@shared/alchemy.js';

export class TrackView {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.buildRibbon();
    this.buildGates();
    this.buildBoxes();
    this.buildEssences();
    this.buildObstacles();

    this.boxOff = new Set();
    this.essOff = new Set();
  }

  buildRibbon() {
    const { samples } = this.track;
    const S = samples.length;
    const W = 9;
    const verts = new Float32Array((S + 1) * 2 * 3);
    const idx = [];
    for (let i = 0; i <= S; i++) {
      const a = samples[i % S], b = samples[(i + 1) % S];
      let nx = b[2] - a[2], nz = -(b[0] - a[0]);
      const nl = Math.hypot(nx, nz) || 1;
      nx = (nx / nl) * W; nz = (nz / nl) * W;
      verts.set([a[0] - nx, a[1] - 2.2, a[2] - nz, a[0] + nx, a[1] - 2.2, a[2] + nz], i * 6);
      if (i < S) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      color: this.track.ribbon,
      transparent: true, opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.group.add(new THREE.Mesh(geo, mat));

    // center guide line
    const linePts = samples.map(p => new THREE.Vector3(p[0], p[1] - 2.0, p[2]));
    linePts.push(linePts[0].clone());
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color: this.track.ribbon, transparent: true, opacity: 0.4 })
    );
    this.group.add(line);
  }

  buildGates() {
    this.gateMeshes = [];
    const torus = new THREE.TorusGeometry(11, 0.6, 10, 36);
    for (const g of this.track.gates) {
      const isStart = g.id === 0;
      const mat = new THREE.MeshStandardMaterial({
        color: isStart ? 0xffd24d : this.track.ribbon,
        emissive: isStart ? 0xffd24d : this.track.ribbon,
        emissiveIntensity: 0.55,
        roughness: 0.4, metalness: 0.3,
        transparent: true, opacity: 0.9,
      });
      const m = new THREE.Mesh(torus, mat);
      m.position.set(...g.pos);
      m.lookAt(g.pos[0] + g.dir[0], g.pos[1] + g.dir[1], g.pos[2] + g.dir[2]);
      this.group.add(m);
      this.gateMeshes.push(m);

      // floating rune number above the gate
      const label = makeTextSprite(String(g.id + 1), '#ffe9b0');
      label.position.set(g.pos[0], g.pos[1] + 13.5, g.pos[2]);
      this.group.add(label);
    }
  }

  buildBoxes() {
    this.boxMeshes = new Map();
    const geo = new THREE.OctahedronGeometry(1.6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc77dff, emissive: 0x7a30c0, emissiveIntensity: 0.7, roughness: 0.3,
    });
    for (const box of this.track.itemBoxes) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...box.pos);
      this.group.add(m);
      this.boxMeshes.set(box.id, m);
    }
  }

  buildEssences() {
    this.essMeshes = new Map();
    const geo = new THREE.IcosahedronGeometry(1.0);
    const mats = {};
    for (const e of this.track.essences) {
      if (!mats[e.type]) {
        const color = INGREDIENTS[e.type]?.color ?? 0xffffff;
        mats[e.type] = new THREE.MeshStandardMaterial({
          color, emissive: color, emissiveIntensity: 0.9, roughness: 0.2,
        });
      }
      const m = new THREE.Mesh(geo, mats[e.type]);
      m.position.set(...e.pos);
      this.group.add(m);
      this.essMeshes.set(e.id, m);
    }
  }

  buildObstacles() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x4a3d6b, flatShading: true });
    const rim = new THREE.MeshBasicMaterial({ color: 0x9b7bff, transparent: true, opacity: 0.18, wireframe: true });
    for (const o of this.track.obstacles) {
      const geo = new THREE.DodecahedronGeometry(o.radius, 0);
      const rock = new THREE.Mesh(geo, mat);
      rock.position.set(...o.pos);
      rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      const glow = new THREE.Mesh(geo, rim);
      glow.scale.setScalar(1.12);
      rock.add(glow);
      this.group.add(rock);
    }
  }

  // snapshot-driven availability
  setInactive(boxOff, essOff) {
    this.boxOff = new Set(boxOff);
    this.essOff = new Set(essOff);
  }

  update(time, nextGateId) {
    const t = time / 1000;
    for (const [id, m] of this.boxMeshes) {
      const off = this.boxOff.has(id);
      m.visible = !off;
      m.rotation.y = t * 1.4;
      m.rotation.x = Math.sin(t * 0.9) * 0.3;
    }
    for (const [id, m] of this.essMeshes) {
      m.visible = !this.essOff.has(id);
      m.position.y = this.track.essences[id].pos[1] + Math.sin(t * 2 + id) * 0.5;
      m.rotation.y = t * 2;
    }
    this.gateMeshes.forEach((m, i) => {
      const isNext = i === nextGateId;
      const s = isNext ? 1 + Math.sin(t * 5) * 0.04 : 1;
      m.scale.setScalar(s);
      m.material.emissiveIntensity = isNext ? 1.2 : 0.45;
      m.material.opacity = isNext ? 1 : 0.75;
    });
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse(o => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        m.map?.dispose?.(); m.dispose?.();
      });
    });
  }
}

export function makeTextSprite(text, color = '#ffffff', fontPx = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontPx}px Georgia, serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 12;
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 64);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(8, 4, 1);
  return sprite;
}
