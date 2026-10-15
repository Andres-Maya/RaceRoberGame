import type * as THREE from 'three';
import { motorbike } from '../fx/Meshes';
import type { Physics } from '../world/Physics';
import { Vehicle, type VehicleSpec } from './Vehicle';

export const BIKE_SPEC: VehicleSpec = {
  maxSpeed: 34,
  accel: 24,
  brake: 42,
  reverse: 9,
  steerRate: 2.7,
  grip: 8,
  hx: 0.45,
  hz: 1.1,
  density: 2,
};

export const PLAYER_COLORS = [
  { body: 0xd62828, accent: 0xfcbf49, css: '#ff4d4d', name: 'Rojo' },
  { body: 0x1d4ed8, accent: 0x7dd3fc, css: '#4d9dff', name: 'Azul' },
];

export const TURBO_MUL = 1.4;

/** Vida máxima de la moto. */
export const BIKE_HP = 150;

export class Player {
  readonly vehicle: Vehicle;
  readonly maxHp = BIKE_HP;
  hp = BIKE_HP;
  /** Medidor de turbo 0..1 */
  turbo = 1;
  turboActive = false;
  alive = true;
  /** Invulnerabilidad temporal tras un golpe fuerte o reaparición. */
  invuln = 1.5;
  oilTimer = 0;
  spikeTimer = 0;
  flash = 0;
  /** Segundos desde el último daño recibido. */
  sinceHit = 0;
  steer = 0;
  offroad = false;
  /** Escena automática en curso: entrar a la estructura final o salir de la inicial. */
  cutscene: 'enter' | 'exit' | null = null;
  /** Segundos de vuelo restantes durante el salto de salida. */
  airTime = 0;
  /** Sin colisiones: la moto atraviesa puertas y escombros durante las escenas. */
  ghost = false;
  /** Salto desde una rampa: segundos de vuelo restantes y duración total. */
  air = 0;
  airDur = 0;
  /** Enfriamiento de daño por cada objeto contra el que choca. */
  readonly hitCooldown = new Map<unknown, number>();

  constructor(
    physics: Physics,
    readonly index: number,
    x: number,
    z: number,
    heading: number,
    readonly mesh: THREE.Group = motorbike(PLAYER_COLORS[index].body, PLAYER_COLORS[index].accent),
  ) {
    this.vehicle = new Vehicle(physics, BIKE_SPEC, x, z, heading, { kind: 'player', ref: null }, mesh);
    // La etiqueta apunta al propio jugador para resolver colisiones.
    const tag = physics.tagOf(this.vehicle.body.collider(0).handle);
    if (tag) tag.ref = this;
  }

  get color(): string {
    return PLAYER_COLORS[this.index].css;
  }

  setGhost(on: boolean): void {
    this.ghost = on;
    this.vehicle.body.collider(0).setSensor(on);
  }

  canTakeHit(source: unknown, now: number, cooldown = 0.45): boolean {
    const last = this.hitCooldown.get(source) ?? -Infinity;
    if (now - last < cooldown) return false;
    this.hitCooldown.set(source, now);
    return true;
  }

  /** Aplica daño; devuelve true si la moto quedó destruida. */
  damage(amount: number): boolean {
    if (!this.alive || this.invuln > 0) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.flash = 0.25;
    this.sinceHit = 0;
    if (this.hp <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }
}
