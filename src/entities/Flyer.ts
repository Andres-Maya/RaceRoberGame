import type * as THREE from 'three';
import type { PursuerConfig } from '../config/types';
import { clamp, damp, wrapAngle } from '../core/math';
import type { Rng } from '../core/Rng';
import { disposeUnique, harpy, type HarpyMesh } from '../fx/Meshes';
import type { Player } from './Player';
import type { FireRequest } from './Pursuer';

const CRUISE = 10;
const DIVE_SPEED = 34;
const LIFETIME = 45;

export interface FlyerAttack {
  player: Player;
  /** Velocidad de la moto al chocar: con turbo a fondo, la harpía cae. */
  playerSpeed: number;
}

export interface FlyerResult {
  shot: FireRequest | null;
  attack: FlyerAttack | null;
}

/**
 * Harpía mutante (nivel 3 y nivel infinito). Vuela sin física: acecha en
 * círculos por delante del jugador escupiendo ácido y, de vez en cuando, se
 * lanza en picada contra él. Tras un rato se aleja.
 */
export class Flyer {
  readonly model: HarpyMesh;
  x: number;
  y = CRUISE;
  z: number;
  dead = false;
  /** Terminó su ciclo de vida o fue derribada: el nivel la retira. */
  gone = false;
  private heading = 0;
  private t: number;
  private state: 'stalk' | 'dive' | 'climb' | 'leave' | 'fall' = 'stalk';
  private timer: number;
  private spit: number;
  private diveX = 0;
  private diveZ = 0;
  private hit = false;

  constructor(
    private scene: THREE.Scene,
    x: number,
    z: number,
    rng: Rng,
  ) {
    this.model = harpy();
    this.x = x;
    this.z = z;
    this.t = rng.range(0, 10);
    this.timer = rng.range(3, 5);
    this.spit = rng.range(1.5, 3);
    this.model.group.position.set(x, this.y, z);
    scene.add(this.model.group, this.model.shadow);
  }

  get alive(): boolean {
    return !this.dead && !this.gone;
  }

  update(dt: number, players: Player[], cfg: PursuerConfig, rng: Rng): FlyerResult {
    this.t += dt;
    const result: FlyerResult = { shot: null, attack: null };
    const targets = players.filter((p) => p.alive && !p.ghost);
    const target = targets.length ? targets[Math.floor(this.t / 10) % targets.length] : null;
    let tx = this.x;
    let tz = this.z - 20;
    let speed = 22;
    let ty = CRUISE;

    if (this.state === 'fall') {
      // Derribada: cae en espiral y se estrella.
      this.y = Math.max(0.3, this.y - dt * 9);
      this.model.body.rotation.z += dt * 8;
      if (this.y <= 0.3) this.gone = true;
      this.place(dt, this.x, this.z, 0);
      return result;
    }

    if (this.t > LIFETIME && this.state === 'stalk') this.state = 'leave';

    if (target) {
      const tv = target.vehicle;
      switch (this.state) {
        case 'stalk': {
          // Orbita por delante y a los lados del objetivo.
          tx = tv.px + tv.vx * 0.7 + Math.sin(this.t * 0.9) * 12;
          tz = tv.pz + tv.vz * 0.7 - 14 + Math.cos(this.t * 0.7) * 5;
          speed = 26 + Math.hypot(tv.vx, tv.vz);
          this.timer -= dt;
          this.spit -= dt;
          if (this.spit <= 0) {
            this.spit = (1.4 / Math.max(0.1, cfg.fireRate)) * rng.range(0.8, 1.3);
            const spread = (1 - cfg.accuracy) * 0.3;
            const angle = Math.atan2(-(tv.px - this.x), -(tv.pz - this.z)) + rng.range(-spread, spread);
            result.shot = { x: this.x, z: this.z, angle, damage: 7, faction: 'wasteland' };
          }
          if (this.timer <= 0) {
            // Picada: apunta a donde estará la moto.
            this.state = 'dive';
            this.hit = false;
            this.diveX = tv.px + tv.vx * 0.55;
            this.diveZ = tv.pz + tv.vz * 0.55;
          }
          break;
        }
        case 'dive': {
          tx = this.diveX;
          tz = this.diveZ;
          ty = 1.3;
          speed = DIVE_SPEED;
          for (const p of targets) {
            const near = Math.hypot(p.vehicle.px - this.x, p.vehicle.pz - this.z) < 2.4;
            if (!this.hit && near && this.y < 3) {
              this.hit = true;
              result.attack = { player: p, playerSpeed: Math.abs(p.vehicle.speed) };
            }
          }
          if (Math.hypot(tx - this.x, tz - this.z) < 1.5 || this.hit) {
            this.state = 'climb';
            this.timer = 0.9;
          }
          break;
        }
        case 'climb':
          tx = this.x - Math.sin(this.heading) * 10;
          tz = this.z - Math.cos(this.heading) * 10;
          this.timer -= dt;
          if (this.timer <= 0) {
            this.state = 'stalk';
            this.timer = rng.range(3.5, 6) * (1.3 - cfg.aggression * 0.6);
          }
          break;
        case 'leave':
          tx = this.x + Math.sign(this.x - tv.px || 1) * 30;
          tz = this.z - 40;
          ty = 22;
          if (this.y > 20) this.gone = true;
          break;
      }
    }

    this.y = damp(this.y, ty, this.state === 'dive' ? 3.5 : 1.6, dt);
    this.place(dt, tx, tz, speed);
    return result;
  }

  /** Abatida por la moto: cae al suelo. */
  shootDown(): void {
    this.dead = true;
    this.state = 'fall';
  }

  private place(dt: number, tx: number, tz: number, speed: number): void {
    const dx = tx - this.x;
    const dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.01 && speed > 0) {
      const step = Math.min(dist, speed * dt);
      this.x += (dx / dist) * step;
      this.z += (dz / dist) * step;
      const desired = Math.atan2(-dx, -dz);
      this.heading += wrapAngle(desired - this.heading) * (1 - Math.exp(-5 * dt));
    }
    const g = this.model.group;
    g.position.set(this.x, this.y, this.z);
    g.rotation.y = this.heading;
    // Inclinación: nariz abajo en picada y ladeo al girar.
    const diving = this.state === 'dive';
    this.model.body.rotation.x = damp(this.model.body.rotation.x, diving ? -0.5 : this.state === 'climb' ? 0.4 : 0, 6, dt);

    // Aleteo: rápido al subir, alas plegadas en la picada.
    const flap = diving ? 0.15 : this.state === 'climb' ? 1 : 0.7;
    const f = this.t * (diving ? 4 : 7.5);
    this.model.wings.forEach((w, i) => {
      const s = i === 0 ? -1 : 1;
      w.inner.rotation.z = s * (Math.sin(f) * 0.65 * flap + (diving ? 0.9 : 0));
      w.outer.rotation.z = s * Math.sin(f - 0.7) * 0.55 * flap;
    });
    this.model.tail.rotation.y = Math.sin(this.t * 3) * 0.3;
    this.model.jaw.rotation.x = diving ? 0.5 : clamp(Math.sin(this.t * 2) * 0.3, 0, 0.3);
    // La sombra se agranda y oscurece al acercarse al suelo.
    const sh = this.model.shadow;
    sh.position.set(this.x + this.y * 0.25, 0.06, this.z + this.y * 0.2);
    const k = 1.4 - this.y / 30;
    sh.scale.set(1.6 * k, 0.6 * k, 1);
  }

  dispose(): void {
    this.scene.remove(this.model.group, this.model.shadow);
    disposeUnique(this.model.shadow);
  }
}
