import type * as THREE from 'three';
import type { PoliceConfig, PoliceKind } from '../config/types';
import { clamp, lerp, wrapAngle } from '../core/math';
import type { Rng } from '../core/Rng';
import { mat, policeVehicle, setSiren, type PoliceMesh } from '../fx/Meshes';
import type { Physics } from '../world/Physics';
import type { Track } from '../world/Track';
import type { Player } from './Player';
import { Vehicle, type VehicleSpec } from './Vehicle';

interface PoliceStats {
  spec: VehicleSpec;
  hp: number;
  /** Daño base al embestir. */
  ram: number;
  /** Probabilidad de que la unidad lleve un tirador. */
  shooter: number;
  bulletDamage: number;
  label: string;
}

export const POLICE_STATS: Record<PoliceKind, PoliceStats> = {
  patrol: {
    spec: { maxSpeed: 33, accel: 20, brake: 30, reverse: 10, steerRate: 2.0, grip: 6, hx: 1.0, hz: 2.1, density: 3 },
    hp: 100,
    ram: 14,
    shooter: 0.4,
    bulletDamage: 6,
    label: 'Patrulla',
  },
  moto: {
    spec: { maxSpeed: 38, accel: 26, brake: 40, reverse: 8, steerRate: 2.8, grip: 8, hx: 0.45, hz: 1.1, density: 2 },
    hp: 40,
    ram: 6,
    shooter: 1,
    bulletDamage: 6,
    label: 'Moto policial',
  },
  suv: {
    spec: { maxSpeed: 35, accel: 22, brake: 30, reverse: 10, steerRate: 1.9, grip: 6, hx: 1.15, hz: 2.4, density: 4 },
    hp: 160,
    ram: 22,
    shooter: 0.2,
    bulletDamage: 7,
    label: 'SUV',
  },
  swat: {
    spec: { maxSpeed: 31, accel: 16, brake: 26, reverse: 8, steerRate: 1.6, grip: 5, hx: 1.3, hz: 2.8, density: 6 },
    hp: 260,
    ram: 30,
    shooter: 1,
    bulletDamage: 8,
    label: 'SWAT',
  },
};

export interface FireRequest {
  x: number;
  z: number;
  angle: number;
  damage: number;
}

export interface PoliceContext {
  dt: number;
  players: Player[];
  track: Track;
  physics: Physics;
  config: PoliceConfig;
  rng: Rng;
}

/**
 * Unidad policial con IA de persecución: predice la posición del jugador,
 * sigue la vía cuando va lejos, esquiva obstáculos fijos con "bigotes"
 * (raycasts), embiste según su agresividad y dispara si tiene línea de visión.
 */
export class PoliceUnit {
  readonly vehicle: Vehicle;
  readonly stats: PoliceStats;
  readonly model: PoliceMesh;
  hp: number;
  wrecked = false;
  readonly armed: boolean;
  private ramTimer = 0;
  private ramCooldown: number;
  private fireCooldown: number;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private sirenTimer = 0;
  private sirenPhase = false;
  smokeTimer = 0;

  constructor(
    physics: Physics,
    readonly kind: PoliceKind,
    x: number,
    z: number,
    heading: number,
    rng: Rng,
  ) {
    this.stats = POLICE_STATS[kind];
    this.hp = this.stats.hp;
    this.model = policeVehicle(kind);
    this.vehicle = new Vehicle(physics, this.stats.spec, x, z, heading, { kind: 'police', ref: this }, this.model.group);
    this.armed = rng.chance(this.stats.shooter);
    this.ramCooldown = rng.range(1, 3);
    this.fireCooldown = rng.range(1, 2.5);
  }

  update(ctx: PoliceContext): FireRequest | null {
    const v = this.vehicle;
    const dt = ctx.dt;
    if (this.wrecked) {
      v.halt(dt);
      return null;
    }

    this.sirenTimer += dt;
    if (this.sirenTimer > 0.2) {
      this.sirenTimer = 0;
      this.sirenPhase = !this.sirenPhase;
      setSiren(this.model, this.sirenPhase);
    }

    const target = this.nearest(ctx.players);
    if (!target) {
      v.halt(dt);
      return null;
    }
    const tv = target.vehicle;
    const dx = tv.px - v.px;
    const dz = tv.pz - v.pz;
    const dist = Math.hypot(dx, dz);
    const cfg = ctx.config;

    // ---- elegir punto objetivo
    const lead = clamp(dist / 35, 0, 1.2);
    let aimX = tv.px + tv.vx * lead;
    let aimZ = tv.pz + tv.vz * lead;
    if (this.ramTimer <= 0) {
      const look = v.d + 18;
      const w = clamp((dist - 20) / 40, 0, 0.8);
      aimX = lerp(aimX, ctx.track.centerX(look), w);
      aimZ = lerp(aimZ, -look, w);
    }

    // ---- embestida
    this.ramCooldown -= dt;
    this.ramTimer -= dt;
    if (this.ramTimer <= 0 && this.ramCooldown <= 0 && dist < 16 && ctx.rng.chance(cfg.aggression * dt * 3)) {
      this.ramTimer = 1.1 + cfg.aggression;
      this.ramCooldown = 4.5 - cfg.aggression * 2.5;
    }

    let desired = Math.atan2(-(aimX - v.px), -(aimZ - v.pz));

    // ---- evasión con raycasts
    const speed = Math.max(0, v.speed);
    const len = 5 + speed * 0.45;
    const hit = (a: number) => ctx.physics.rayFixed(v.px, v.pz, -Math.sin(a), -Math.cos(a), len);
    const center = hit(v.heading);
    const left = hit(v.heading + 0.4);
    const right = hit(v.heading - 0.4);
    if (center !== null) {
      const lFree = left ?? len;
      const rFree = right ?? len;
      desired = v.heading + (lFree >= rFree ? 1 : -1) * 0.9;
    } else {
      if (left !== null) desired -= 0.5 * (1 - left / len);
      if (right !== null) desired += 0.5 * (1 - right / len);
    }

    // No salirse demasiado de la vía al perseguir.
    const lat = ctx.track.lateral(v.px, v.d);
    const half = ctx.track.halfWidth(v.d);
    if (Math.abs(lat) > half + 1 && dist > 12) desired += clamp(lat / 20, -0.4, 0.4);

    const diff = wrapAngle(desired - v.heading);
    let steer = clamp(-diff * 2.5, -1, 1);
    let throttle = 1;
    let brake = 0;
    if (Math.abs(diff) > 1.3 && speed > 14) {
      throttle = 0;
      brake = 0.6;
    }

    // ---- atascado: retroceder
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      throttle = 0;
      brake = 1;
      steer = -steer;
    } else if (speed < 2 && dist > 6) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.2) {
        this.stuckTimer = 0;
        this.reverseTimer = 0.9;
      }
    } else {
      this.stuckTimer = 0;
    }

    // ---- control de velocidad (rubber banding)
    const behind = tv.d - v.d;
    let speedMul = 1;
    if (dist > 45) speedMul = 1.3;
    else if (behind > 20) speedMul = 1.1;
    else if (behind < -10) speedMul = 0.7;
    let accelMul = 1;
    if (this.ramTimer > 0) {
      speedMul = Math.max(speedMul, 1.25);
      accelMul = 1.6;
    }
    v.drive(dt, throttle, brake, steer, { speedMul, accelMul, gripMul: 1 });

    // ---- disparo
    this.fireCooldown -= dt;
    if (this.armed && this.fireCooldown <= 0 && dist < 34 && dist > 4) {
      const blocked = ctx.physics.rayFixed(v.px, v.pz, dx / dist, dz / dist, dist);
      if (blocked === null) {
        this.fireCooldown = (1 / Math.max(0.05, cfg.fireRate)) * ctx.rng.range(0.7, 1.3);
        const t = dist / 60;
        const px = tv.px + tv.vx * t * cfg.accuracy;
        const pz = tv.pz + tv.vz * t * cfg.accuracy;
        const spread = (1 - cfg.accuracy) * 0.28;
        const angle = Math.atan2(-(px - v.px), -(pz - v.pz)) + ctx.rng.range(-spread, spread);
        return { x: v.px, z: v.pz, angle, damage: this.stats.bulletDamage };
      }
    }
    return null;
  }

  /** Recibe daño; devuelve true si la unidad quedó destruida en este golpe. */
  damage(amount: number): boolean {
    if (this.wrecked) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.wrecked = true;
      this.vehicle.body.setLinearDamping(3);
      const burnt = mat(0x2a2522);
      this.model.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = burnt;
      });
      return true;
    }
    return false;
  }

  get isRamming(): boolean {
    return this.ramTimer > 0;
  }

  private nearest(players: Player[]): Player | null {
    let best: Player | null = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = Math.hypot(p.vehicle.px - this.vehicle.px, p.vehicle.pz - this.vehicle.pz);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}

