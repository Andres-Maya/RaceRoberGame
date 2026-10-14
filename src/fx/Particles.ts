import * as THREE from 'three';

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  c0: THREE.Color;
  c1: THREE.Color;
  drag: number;
  rise: number;
}

export interface EmitOptions {
  x: number;
  y?: number;
  z: number;
  count: number;
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  colors: [THREE.ColorRepresentation, THREE.ColorRepresentation];
  drag?: number;
  rise?: number;
  spread?: number;
  /** Dirección base (radianes en XZ); si se omite, radial. */
  dir?: number;
}

/** Sistema de partículas con un único InstancedMesh (una llamada de dibujo). */
class ParticleSystem {
  readonly mesh: THREE.InstancedMesh;
  private ps: Particle[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(capacity: number, additive: boolean) {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: additive ? 0.95 : 0.5,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 0), material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) {
      this.ps.push({
        alive: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        size0: 1,
        size1: 1,
        c0: new THREE.Color(),
        c1: new THREE.Color(),
        drag: 1,
        rise: 0,
      });
      this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
      this.mesh.setColorAt(i, this.c.set(0xffffff));
    }
  }

  emit(o: EmitOptions): void {
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    for (let i = 0; i < o.count; i++) {
      const p = this.ps[this.next];
      this.next = (this.next + 1) % this.ps.length;
      const angle = o.dir !== undefined ? o.dir + (Math.random() - 0.5) * (o.spread ?? 0.6) : Math.random() * Math.PI * 2;
      const sp = rnd(o.speed[0], o.speed[1]);
      p.alive = true;
      p.pos.set(o.x + (Math.random() - 0.5) * 0.6, o.y ?? 0.8, o.z + (Math.random() - 0.5) * 0.6);
      p.vel.set(-Math.sin(angle) * sp, rnd(0, sp * 0.3), -Math.cos(angle) * sp);
      p.life = 0;
      p.maxLife = rnd(o.life[0], o.life[1]);
      p.size0 = o.size[0] * rnd(0.7, 1.2);
      p.size1 = o.size[1] * rnd(0.7, 1.2);
      p.c0.set(o.colors[0]);
      p.c1.set(o.colors[1]);
      p.drag = o.drag ?? 2;
      p.rise = o.rise ?? 0;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        continue;
      }
      const t = p.life / p.maxLife;
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.y += p.rise * dt;
      p.pos.addScaledVector(p.vel, dt);
      const size = p.size0 + (p.size1 - p.size0) * t;
      this.s.setScalar(size);
      this.m.compose(p.pos, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.copy(p.c0).lerp(p.c1, t));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.ps.length; i++) {
      this.ps[i].alive = false;
      this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/** Efectos de alto nivel: explosiones, chispas, polvo, fogonazos. */
export class Effects {
  private fire = new ParticleSystem(700, true);
  private smoke = new ParticleSystem(700, false);

  constructor(scene: THREE.Scene) {
    scene.add(this.fire.mesh, this.smoke.mesh);
  }

  /** Explosión de fuego normal o tóxica (verde, para la planta nuclear). */
  explosion(x: number, z: number, scale = 1, toxic = false): void {
    const core: [number, number] = toxic ? [0xeaffc0, 0x39ff14] : [0xfff1a8, 0xff4500];
    const smoke: [number, number] = toxic ? [0x4f7a32, 0x1e3314] : [0x6a6058, 0x3a3a3a];
    const sparks: [number, number] = toxic ? [0xd9ff9a, 0x2fd10f] : [0xffd27a, 0xff6a00];
    this.fire.emit({ x, z, y: 1, count: Math.round(40 * scale), speed: [4, 16 * scale], life: [0.3, 0.8], size: [2.2 * scale, 0.4], colors: core, drag: 3, rise: 3 });
    this.smoke.emit({ x, z, y: 1.5, count: Math.round(30 * scale), speed: [2, 8 * scale], life: [1.2, 2.6], size: [1.5 * scale, 5 * scale], colors: smoke, drag: 2, rise: 1.5 });
    this.fire.emit({ x, z, y: 1, count: Math.round(20 * scale), speed: [12, 26], life: [0.4, 0.9], size: [0.35, 0.1], colors: sparks, drag: 1 });
  }

  /** Salpicadura verde (zombis, mutantes, ácido). */
  splatter(x: number, z: number, count = 14): void {
    this.smoke.emit({ x, z, y: 0.8, count, speed: [3, 9], life: [0.3, 0.7], size: [0.5, 0.15], colors: [0x6dbf3a, 0x2f5a1a], drag: 4 });
  }

  sparks(x: number, z: number, count = 10): void {
    this.fire.emit({ x, z, y: 1, count, speed: [6, 16], life: [0.15, 0.4], size: [0.3, 0.05], colors: [0xffffcc, 0xffa500], drag: 4 });
  }

  dust(x: number, z: number, color: THREE.ColorRepresentation = 0xd9bf8a, count = 2, size = 1.2): void {
    this.smoke.emit({ x, z, y: 0.4, count, speed: [0.5, 2.5], life: [0.5, 1.1], size: [size * 0.5, size * 1.8], colors: [color, color], drag: 2, rise: 0.4 });
  }

  muzzle(x: number, z: number, dir: number): void {
    this.fire.emit({ x, z, y: 1.3, count: 4, speed: [5, 12], life: [0.05, 0.12], size: [0.6, 0.1], colors: [0xffffaa, 0xff8800], dir, spread: 0.4, drag: 6 });
  }

  turbo(x: number, z: number, dir: number): void {
    this.fire.emit({ x, z, y: 0.7, count: 2, speed: [6, 10], life: [0.08, 0.2], size: [0.5, 0.1], colors: [0x9fd8ff, 0x2a6bff], dir, spread: 0.3, drag: 5 });
  }

  smokeTrail(x: number, z: number, toxic = false): void {
    const colors: [number, number] = toxic ? [0x5fae3a, 0x1e3314] : [0x444444, 0x111111];
    this.smoke.emit({ x, z, y: 1.2, count: 1, speed: [0.3, 1.2], life: [0.6, 1.4], size: [0.6, 2.2], colors, drag: 1, rise: 1 });
  }

  update(dt: number): void {
    this.fire.update(dt);
    this.smoke.update(dt);
  }

  dispose(): void {
    this.fire.dispose();
    this.smoke.dispose();
  }
}
