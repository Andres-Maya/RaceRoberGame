import type * as THREE from 'three';
import { VEHICLES, type VehicleDef } from '../config/vehicles';
import { playerVehicleMesh } from '../fx/Meshes';
import type { Physics } from '../world/Physics';
import { Vehicle } from './Vehicle';

export const PLAYER_COLORS = [
  { body: 0xd62828, accent: 0xfcbf49, css: '#ff4d4d', name: 'Rojo' },
  { body: 0x1d4ed8, accent: 0x7dd3fc, css: '#4d9dff', name: 'Azul' },
];

export class Player {
  readonly vehicle: Vehicle;
  readonly maxHp: number;
  hp: number;
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
  /** Se desconectó en una partida en línea: no vuelve a aparecer. */
  dropped = false;
  /** Se quedó muy atrás y lo capturaron: reaparece junto al compañero tras la cuenta regresiva. */
  captured = false;
  /** Munición del arma de la moto. */
  ammo: number;
  readonly maxAmmo: number;
  fireCooldown = 0;
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
    /** Vehículo elegido en el garaje. */
    readonly def: VehicleDef = VEHICLES[0],
    readonly mesh: THREE.Group = playerVehicleMesh(def.id, PLAYER_COLORS[index].body, PLAYER_COLORS[index].accent),
  ) {
    this.maxHp = this.hp = def.hp;
    this.ammo = def.ammoStart;
    this.maxAmmo = def.ammoMax;
    this.vehicle = new Vehicle(physics, def.spec, x, z, heading, { kind: 'player', ref: null }, mesh);
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
