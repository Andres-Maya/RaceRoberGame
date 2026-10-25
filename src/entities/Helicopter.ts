import * as THREE from 'three';
import type { PursuerConfig } from '../config/types';
import { damp, wrapAngle } from '../core/math';
import type { Rng } from '../core/Rng';
import { disposeUnique, helicopter, type HeliMesh } from '../fx/Meshes';
import type { Player } from './Player';
import type { FireRequest } from './Pursuer';

const ALTITUDE = 15;
/** Duración de la retirada (s): sube, se aleja y se pierde de vista. */
const LEAVE_TIME = 4.5;
/** Radio que ocupa el modelo visto desde arriba (rotor y cola). */
const REACH = 7;
/** Distancia entre los patines y el techo más alto que sobrevuela. */
const CLEARANCE = 2;

/** Lo que el helicóptero necesita saber del mapa para no atravesar edificios. */
export interface HeliWorld {
  /** Techo más alto de las estructuras alrededor de (x, z) en un radio r (0 si no hay). */
  ceiling(x: number, z: number, r: number): number;
  /** Centro de la vía y desplazamiento lateral máximo para volar sobre la calle a la altura de z. */
  corridor(z: number): { cx: number; half: number };
}

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
  /** Segundos desde que empezó a retirarse (-1 = sigue persiguiendo). */
  private leaving = -1;
  private exitHeading = 0;
  private speed = 0;
  /** Altura suavizada que exigen los techos de alrededor: sube rápido y baja despacio. */
  private lift = 0;
  private placed = false;
  /** Terminó de irse: el nivel lo retira. */
  gone = false;

  constructor(
    private scene: THREE.Scene,
    x: number,
    z: number,
  ) {
    this.model = helicopter();
    this.x = this.spotX = x;
    this.z = this.spotZ = z;
    this.model.group.position.set(x, ALTITUDE, z);
    // Rumbo y luego cabeceo local: al acelerar baja la nariz en cualquier dirección.
    this.model.group.rotation.order = 'YXZ';
    scene.add(this.model.group, this.model.shadow, this.model.spot);
  }

  /** Sigue persiguiendo (no se está retirando). */
  get chasing(): boolean {
    return this.leaving < 0;
  }

  /**
   * Los jugadores escaparon: deja de disparar, apaga el reflector y se va
   * hacia adelante y hacia afuera del lado en que está (`fromX`: posición de
   * los jugadores; `road`: rumbo de la carretera).
   */
  leave(fromX: number, road: number): void {
    if (this.leaving >= 0) return;
    this.leaving = 0;
    const side = Math.sign(this.x - fromX) || 1;
    // Con rumbo 0 avanza hacia -Z; hacia +X el ángulo baja.
    this.exitHeading = road - side * 0.75;
    this.speed = 10;
  }

  /**
   * Altitud para no atravesar nada: mira el techo bajo el helicóptero y hacia
   * donde va (`base` es la altitud que tendría sin edificios).
   */
  private climb(dt: number, base: number, vx: number, vz: number, world?: HeliWorld): number {
    let need = base;
    if (world) {
      const roof = Math.max(world.ceiling(this.x, this.z, REACH), world.ceiling(this.x + vx * 0.8, this.z + vz * 0.8, REACH));
      if (roof > 0) need = Math.max(base, roof + CLEARANCE);
    }
    // Aparece fuera de la pantalla: la primera vez se coloca a la altura necesaria.
    if (!this.placed) this.lift = need;
    this.placed = true;
    this.lift = damp(this.lift, need, need > this.lift ? 4 : 0.8, dt);
    return Math.max(base, this.lift);
  }

  /** Retirada: gira hacia la salida, sube, acelera con la nariz abajo y se desvanece. */
  private retreat(dt: number, world?: HeliWorld): void {
    this.leaving += dt;
    const k = this.leaving;
    const g = this.model.group;
    g.rotation.y += wrapAngle(this.exitHeading - g.rotation.y) * (1 - Math.exp(-2.2 * dt));
    this.speed = Math.min(52, this.speed + dt * 18);
    const vx = -Math.sin(g.rotation.y) * this.speed;
    const vz = -Math.cos(g.rotation.y) * this.speed;
    this.x += vx * dt;
    this.z += vz * dt;
    const alt = this.climb(dt, ALTITUDE + Math.min(30, k * k * 2.2), vx, vz, world);
    g.position.set(this.x, alt, this.z);
    g.rotation.x = damp(g.rotation.x, -0.32, 3, dt);
    this.model.rotor.rotation.y += dt * 38;
    this.model.tailRotor.rotation.x += dt * 60;
    // El reflector se apaga en un momento; la sombra crece, se aleja y se desvanece con la altura.
    const spot = this.model.spot.material as THREE.MeshBasicMaterial;
    spot.opacity = Math.max(0, 0.22 * (1 - k / 0.7));
    this.model.spot.visible = spot.opacity > 0.01;
    const shadow = this.model.shadow.material as THREE.MeshBasicMaterial;
    shadow.opacity = Math.max(0, 0.3 * (1 - k / LEAVE_TIME));
    this.model.shadow.scale.setScalar(1 + (alt - ALTITUDE) * 0.04);
    this.model.shadow.position.set(this.x + alt * 0.2, 0.06, this.z + alt * 0.2);
    if (k >= LEAVE_TIME) this.gone = true;
  }

  update(dt: number, players: Player[], cfg: PursuerConfig, rng: Rng, world?: HeliWorld): FireRequest | null {
    this.t += dt;
    if (this.leaving >= 0) {
      this.retreat(dt, world);
      return null;
    }
    const alive = players.filter((p) => p.alive);
    if (alive.length === 0) return null;
    const target = alive[Math.floor(this.t / 8) % alive.length];
    const tv = target.vehicle;

    // Orbita por delante y a un lado del objetivo.
    const ox = Math.sin(this.t * 0.35) * 14;
    const oz = -16 + Math.cos(this.t * 0.5) * 6;
    let tx = tv.px + tv.vx * 0.6 + ox;
    const tz = tv.pz + tv.vz * 0.6 + oz;
    if (world) {
      // Sobre la calle, no sobre las manzanas: así casi nunca tiene que subir.
      const lane = world.corridor(tz);
      const half = Math.max(0, lane.half);
      tx = Math.min(lane.cx + half, Math.max(lane.cx - half, tx));
    }
    const nx = damp(this.x, tx, 1.4, dt);
    const nz = damp(this.z, tz, 1.4, dt);
    const heading = Math.atan2(-(nx - this.x), -(nz - this.z));
    const vx = (nx - this.x) / Math.max(dt, 1e-6);
    const vz = (nz - this.z) / Math.max(dt, 1e-6);
    this.x = nx;
    this.z = nz;
    const g = this.model.group;
    g.position.set(this.x, this.climb(dt, ALTITUDE, vx, vz, world) + Math.sin(this.t * 2) * 0.3, this.z);
    g.rotation.y += wrapAngle(heading - g.rotation.y) * (1 - Math.exp(-3 * dt));
    this.model.rotor.rotation.y += dt * 25;
    this.model.tailRotor.rotation.x += dt * 45;
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
