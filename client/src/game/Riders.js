// Procedural broomstick witch: broom shaft + bristles, robed rider, pointy
// hat, name tag. One Rider per player; handles pose, status FX (ghost,
// shield, invisibility, tumble) and the broom-tip sparkle trail hook.

import * as THREE from 'three';
import { makeTextSprite } from './TrackView.js';

export class Rider {
  constructor(scene, { id, name, color }, isLocal) {
    this.id = id;
    this.isLocal = isLocal;
    this.scene = scene;

    this.group = new THREE.Group();      // world transform (pos + yaw/pitch)
    this.body = new THREE.Group();       // roll/bank + tumble + bob
    this.group.add(this.body);
    scene.add(this.group);

    this.materials = [];
    const mat = (opts) => {
      const m = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05, ...opts });
      this.materials.push(m);
      return m;
    };

    const teamColor = new THREE.Color(color);
    const robeMat = mat({ color: teamColor });
    const darkMat = mat({ color: 0x241a3a });
    const woodMat = mat({ color: 0x6b4a2f, roughness: 0.9 });
    const strawMat = mat({ color: 0xc9a35c, roughness: 1 });
    const skinMat = mat({ color: 0xf0c8a8 });

    // Broom: shaft along +Z (flight direction), bristles at the back.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 8), woodMat);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = 0.1;
    const bristles = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.1, 10), strawMat);
    bristles.rotation.x = -Math.PI / 2;
    bristles.position.z = -1.45;
    const binding = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.25, 8), darkMat);
    binding.rotation.x = Math.PI / 2;
    binding.position.z = -0.95;

    // Rider: robe (cone), torso lean, head + hat.
    const robe = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.15, 9), robeMat);
    robe.position.set(0, 0.45, -0.1);
    robe.rotation.x = -0.35;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), skinMat);
    head.position.set(0, 1.06, 0.08);
    const hatCone = new THREE.Mesh(new THREE.ConeGeometry(0.27, 0.75, 9), darkMat);
    hatCone.position.set(0, 1.5, 0.02);
    hatCone.rotation.x = 0.15;
    const hatBrim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.07, 8, 18), darkMat);
    hatBrim.rotation.x = Math.PI / 2 - 0.1;
    hatBrim.position.set(0, 1.23, 0.04);
    const hatBand = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.26, 0.12, 9), robeMat);
    hatBand.position.set(0, 1.3, 0.03);
    // little gripping hands
    const handGeo = new THREE.SphereGeometry(0.09, 8, 6);
    const handL = new THREE.Mesh(handGeo, skinMat); handL.position.set(-0.14, 0.12, 0.78);
    const handR = new THREE.Mesh(handGeo, skinMat); handR.position.set(0.14, 0.12, 0.78);

    this.body.add(shaft, bristles, binding, robe, head, hatCone, hatBrim, hatBand, handL, handR);

    // Shield bubble + status visuals
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.9, 18, 12),
      new THREE.MeshBasicMaterial({
        color: 0x4dd2ff, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    this.shieldMesh.visible = false;
    this.body.add(this.shieldMesh);

    // Name tag (hidden for local player — you know who you are)
    this.tag = makeTextSprite(name, '#ffffff', 44);
    this.tag.scale.set(7, 3.5, 1);
    this.tag.position.y = 2.4;
    this.tag.visible = !isLocal;
    this.group.add(this.tag);

    this.tumbleSpin = new THREE.Vector3(
      1.5 + Math.random(), 2 + Math.random() * 2, 1 + Math.random());
    this.bobPhase = Math.random() * Math.PI * 2;
  }

  // pose from physics/snapshot state
  setPose(x, y, z, yaw, pitch, roll) {
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, 0, 0);
    this.group.rotateY(yaw);
    this.group.rotateX(-pitch);
    this.body.rotation.z = roll;
  }

  /**
   * flags: { fallen, ghost, shield, invis, surge, boosting }
   */
  updateStatus(flags, time, dt) {
    const t = time / 1000;

    if (flags.fallen) {
      this.body.rotation.x += this.tumbleSpin.x * dt;
      this.body.rotation.y += this.tumbleSpin.y * dt;
      this.body.rotation.z += this.tumbleSpin.z * dt;
    } else {
      this.body.rotation.x = Math.sin(t * 2.4 + this.bobPhase) * 0.03;
      this.body.rotation.y = 0;
      this.body.position.y = Math.sin(t * 2.1 + this.bobPhase) * 0.07;
    }

    this.shieldMesh.visible = !!flags.shield;
    if (flags.shield) this.shieldMesh.material.opacity = 0.16 + Math.sin(t * 6) * 0.07;

    // Opacity layering: invis beats ghost. Remote invis riders vanish almost
    // entirely; your own stays faintly visible so you can still steer.
    let opacity = 1;
    if (flags.ghost) opacity = 0.35 + Math.sin(t * 14) * 0.15;
    if (flags.invis) opacity = this.isLocal ? 0.18 : 0.03;
    for (const m of this.materials) {
      m.transparent = opacity < 1;
      m.opacity = opacity;
    }
    this.tag.visible = !this.isLocal && !flags.invis;
  }

  // world position of the broom tail (trail emitter)
  tailPos(out) {
    out.set(0, 0, -1.6);
    return this.body.localToWorld(out);
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
