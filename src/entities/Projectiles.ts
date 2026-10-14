import * as THREE from 'three';
import { mat } from '../fx/Meshes';
import type { Physics } from '../world/Physics';
import type { Player } from './Player';

const SPEED = 62;
const LIFE = 1.1;
const HIT_RADIUS = 0.95;

interface Bullet {
  x: number;
  z: number;
  vx: number;
  vz: number;
  life: number;
  damage: number;
  /** Disparada desde el aire: ignora paredes. */
  aerial: boolean;
  mesh: THREE.Mesh;
  /** Distancia mínima a cada jugador (para métricas de esquive). */
  closest: number;
}

export interface BulletEvents {
  onHit(player: Player, damage: number, x: number, z: number): void;
  onWall(x: number, z: number): void;
  onExpire(nearMiss: boolean): void;
}

const GEO = new THREE.BoxGeometry(0.16, 0.16, 1.3);
/** Color de las balas según quién dispara. */
const MATS = {
  police: mat(0xffe066, 0xffc400),
  gang: mat(0xff9a3c, 0xff6a00),
  wasteland: mat(0x9dff6a, 0x39ff14),
};

export class Projectiles {
  private bullets: Bullet[] = [];

  constructor(private scene: THREE.Scene) {}

  fire(x: number, z: number, angle: number, damage: number, aerial = false, style: keyof typeof MATS = 'police'): void {
    const mesh = new THREE.Mesh(GEO, MATS[style]);
    mesh.position.set(x, 1.3, z);
    mesh.rotation.y = angle;
    this.scene.add(mesh);
    const fx = -Math.sin(angle);
    const fz = -Math.cos(angle);
    // Nace delante del tirador para no impactar su propio vehículo.
    this.bullets.push({ x: x + fx * 2.6, z: z + fz * 2.6, vx: fx * SPEED, vz: fz * SPEED, life: LIFE, damage, aerial, mesh, closest: Infinity });
  }

  update(dt: number, players: Player[], physics: Physics, ev: BulletEvents): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const step = SPEED * dt;
      let done = false;

      if (!b.aerial) {
        const wall = physics.rayFixed(b.x, b.z, b.vx / SPEED, b.vz / SPEED, step);
        if (wall !== null) {
          ev.onWall(b.x + (b.vx / SPEED) * wall, b.z + (b.vz / SPEED) * wall);
          done = true;
        }
      }

      if (!done) {
        const nx = b.x + b.vx * dt;
        const nz = b.z + b.vz * dt;
        for (const p of players) {
          if (!p.alive) continue;
          const dist = segmentDistance(b.x, b.z, nx, nz, p.vehicle.px, p.vehicle.pz);
          b.closest = Math.min(b.closest, dist);
          if (dist < HIT_RADIUS) {
            ev.onHit(p, b.damage, p.vehicle.px, p.vehicle.pz);
            done = true;
            break;
          }
        }
        b.x = nx;
        b.z = nz;
      }

      b.life -= dt;
      if (!done && b.life <= 0) {
        ev.onExpire(b.closest < 3);
        done = true;
      }
      if (done) {
        this.scene.remove(b.mesh);
        this.bullets.splice(i, 1);
      } else {
        b.mesh.position.set(b.x, 1.3, b.z);
      }
    }
  }

  clear(): void {
    for (const b of this.bullets) this.scene.remove(b.mesh);
    this.bullets.length = 0;
  }
}

function segmentDistance(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
