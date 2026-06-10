// Scene foundation: renderer, camera, lights, gradient sky dome, low-poly
// terrain and a distant mountain ring. Everything procedural — no assets.

import * as THREE from 'three';

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 2200);
    this.camera.position.set(0, 60, -120);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Lights
    this.hemi = new THREE.HemisphereLight(0xbfb2ff, 0x1a0f2e, 0.9);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    this.sun.position.set(180, 260, 120);
    this.scene.add(this.hemi, this.sun, new THREE.AmbientLight(0x404060, 0.5));

    // Sky dome: vertical gradient shader, BackSide.
    this.skyUniforms = {
      topColor: { value: new THREE.Color(0x1b1240) },
      horizonColor: { value: new THREE.Color(0xff8c5a) },
      bottomColor: { value: new THREE.Color(0x0d0a1a) },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1500, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: this.skyUniforms,
        vertexShader: /* glsl */`
          varying vec3 vPos;
          void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
          uniform vec3 topColor, horizonColor, bottomColor;
          varying vec3 vPos;
          void main() {
            float h = normalize(vPos).y;
            vec3 c = h > 0.0
              ? mix(horizonColor, topColor, smoothstep(0.0, 0.5, h))
              : mix(horizonColor, bottomColor, smoothstep(0.0, -0.25, h));
            gl_FragColor = vec4(c, 1.0);
          }`,
      })
    );
    this.scene.add(sky);

    // Stars (upper hemisphere points)
    const starGeo = new THREE.BufferGeometry();
    const starPos = [];
    for (let i = 0; i < 600; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.acos(Math.random() * 0.85);     // bias toward zenith
      const r = 1400;
      starPos.push(r * Math.cos(a) * Math.sin(e), r * Math.cos(e) + 100, r * Math.sin(a) * Math.sin(e));
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xcfd6ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.8,
    })));

    this.scene.fog = new THREE.Fog(0x2a1530, 220, 1100);

    this.scene.add(this.makeTerrain(), this.makeMountains());
  }

  makeTerrain() {
    const R = 700, SEG = 72;
    const geo = new THREE.CircleGeometry(R, SEG, 0, Math.PI * 2);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const deep = new THREE.Color(0x141028);
    const mid = new THREE.Color(0x241a44);
    const glow = new THREE.Color(0x37255f);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const d = Math.hypot(x, z) / R;
      // gentle rolling noise, flat near center so crashes read clearly
      const h = (Math.sin(x * 0.018) * Math.cos(z * 0.022) + Math.sin(x * 0.05 + z * 0.04) * 0.4) * 6 * d;
      pos.setY(i, h - 0.5);
      const c = d < 0.4 ? mid.clone().lerp(glow, d * 2.5) : mid.clone().lerp(deep, (d - 0.4) / 0.6);
      // mystic patches
      if (Math.sin(x * 0.07) * Math.cos(z * 0.06) > 0.86) c.lerp(new THREE.Color(0x3b6b5a), 0.35);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  }

  makeMountains() {
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x1c1336, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const r = 760 + Math.random() * 160;
      const h = 90 + Math.random() * 160;
      const m = new THREE.Mesh(new THREE.ConeGeometry(60 + Math.random() * 70, h, 5), mat);
      m.position.set(Math.cos(a) * r, h / 2 - 20, Math.sin(a) * r);
      m.rotation.y = Math.random() * Math.PI;
      group.add(m);
    }
    return group;
  }

  // Retint sky/fog to the round's track palette.
  setPalette(track) {
    const horizon = new THREE.Color(track.sky);
    const fog = new THREE.Color(track.fog);
    this.skyUniforms.horizonColor.value.copy(horizon);
    this.skyUniforms.topColor.value.copy(fog).multiplyScalar(1.6).offsetHSL(0, 0.05, 0.05);
    this.scene.fog.color.copy(fog);
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
