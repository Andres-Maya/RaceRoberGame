import * as THREE from 'three';
import type { PursuerConfig } from '../config/types';
import { damp, wrapAngle } from '../core/math';
import type { Rng } from '../core/Rng';
import { disposeUnique, helicopter, type HeliMesh } from '../fx/Meshes';
import type { Player } from './Player';
import type { FireRequest } from './Pursuer';

const ALTITUDE = 15;

/**
 * Helicóptero policial (nivel 3): sobrevuela al jugador, lo ilumina con un
 * reflector y dispara ráfagas. No colisiona: es una amenaza aérea.
 */
export class Helicopter {
  readonly model: HeliMesh;
  x: number;
  z: number;
  private t = 0;
  private burst = 0;
  private cooldown = 4;
  private spotX: number;
  private spotZ: number;

  constructor(
    private scene: THREE.Scene,
    x: number,
    z: number,
  ) {
    this.model = helicopter();
    this.x = this.spotX = x;
    this.z = this.spotZ = z;
    this.model.group.position.set(x, ALTITUDE, z);
    scene.add(this.model.group, this.model.shadow, this.model.spot);
  }

  update(dt: number, players: Player[], cfg: PursuerConfig, rng: Rng): FireRequest | null {
    this.t += dt;
    const alive = players.filter((p) => p.alive);
    if (alive.length === 0) return null;
    const target = alive[Math.floor(this.t / 8) % alive.length];
    const tv = target.vehicle;

    // Orbita por delante y a un lado del objetivo.
    const ox = Math.sin(this.t * 0.35) * 14;
    const oz = -16 + Math.cos(this.t * 0.5) * 6;
    const nx = damp(this.x, tv.px + tv.vx * 0.6 + ox, 1.4, dt);
    const nz = damp(this.z, tv.pz + tv.vz * 0.6 + oz, 1.4, dt);
    const heading = Math.atan2(-(nx - this.x), -(nz - this.z));
    this.x = nx;
    this.z = nz;
    const g = this.model.group;
    g.position.set(this.x, ALTITUDE + Math.sin(this.t * 2) * 0.3, this.z);
    g.rotation.y += wrapAngle(heading - g.rotation.y) * (1 - Math.exp(-3 * dt));
    this.model.rotor.rotation.y += dt * 25;
    this.model.shadow.position.set(this.x + 3, 0.06, this.z + 3);

    this.spotX = damp(this.spotX, tv.px, 3, dt);
    this.spotZ = damp(this.spotZ, tv.pz, 3, dt);
    this.model.spot.position.set(this.spotX, 0.07, this.spotZ);

    this.cooldown -= dt;
    if (this.cooldown <= 0 && this.burst <= 0) {
      this.burst = 3;
      this.cooldown = (1.6 / Math.max(0.1, cfg.fireRate)) * rng.range(0.8, 1.3);
    }
    if (this.burst > 0 && (this.burst === 3 || rng.chance(dt * 8))) {
      this.burst--;
      const spread = (1 - cfg.accuracy) * 0.3;
      const angle = Math.atan2(-(tv.px - this.x), -(tv.pz - this.z)) + rng.range(-spread, spread);
      return { x: this.x, z: this.z, angle, damage: 8, faction: 'police' };
    }
    return null;
  }

  dispose(): void {
    this.scene.remove(this.model.group, this.model.shadow, this.model.spot);
    disposeUnique(this.model.shadow);
    disposeUnique(this.model.spot);
  }
}
