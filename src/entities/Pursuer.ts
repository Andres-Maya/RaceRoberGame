import type * as THREE from 'three';
import type { Faction, PursuerConfig, PursuerKind } from '../config/types';
import { clamp, lerp, wrapAngle } from '../core/math';
import type { Rng } from '../core/Rng';
import { animateMutant, knockOutMutant, mat, pursuerMesh, setSiren, type PursuerMesh } from '../fx/Meshes';
import type { Physics } from '../world/Physics';
import type { Track } from '../world/Track';
import type { Player } from './Player';
import { Vehicle, type VehicleSpec } from './Vehicle';

interface PursuerStats {
  faction: Faction;
  spec: VehicleSpec;
  hp: number;
  /** Daño base al embestir. */
  ram: number;
  /** Probabilidad de que la unidad lleve un tirador. */
  shooter: number;
  bulletDamage: number;
  label: string;
  /** Mutantes a pie: mueren al ser atropellados. */
  onFoot?: boolean;
  /** Harpías: vuelan, no usan física (ver Flyer). */
  flying?: boolean;
}

const spec = (maxSpeed: number, accel: number, steerRate: number, grip: number, hx: number, hz: number, density: number): VehicleSpec => ({
  maxSpeed,
  accel,
  brake: 30,
  reverse: 9,
  steerRate,
  grip,
  hx,
  hz,
  density,
});

export const PURSUER_STATS: Record<PursuerKind, PursuerStats> = {
  // ---- Policía
  patrol: { faction: 'police', spec: spec(33, 20, 2.0, 6, 1.0, 2.1, 3), hp: 100, ram: 14, shooter: 0.4, bulletDamage: 6, label: 'Patrulla' },
  moto: { faction: 'police', spec: spec(38, 26, 2.8, 8, 0.45, 1.1, 2), hp: 40, ram: 6, shooter: 1, bulletDamage: 6, label: 'Moto policial' },
  suv: { faction: 'police', spec: spec(35, 22, 1.9, 6, 1.15, 2.4, 4), hp: 160, ram: 22, shooter: 0.2, bulletDamage: 7, label: 'SUV' },
  swat: { faction: 'police', spec: spec(31, 16, 1.6, 5, 1.3, 2.8, 6), hp: 260, ram: 30, shooter: 1, bulletDamage: 8, label: 'SWAT' },
  // ---- Banda rival
  muscle: { faction: 'gang', spec: spec(37, 24, 2.1, 6, 1.0, 2.2, 3), hp: 110, ram: 18, shooter: 0.25, bulletDamage: 6, label: 'Muscle car' },
  biker: { faction: 'gang', spec: spec(38, 26, 2.8, 8, 0.45, 1.1, 2), hp: 40, ram: 6, shooter: 1, bulletDamage: 6, label: 'Motero' },
  pickup: { faction: 'gang', spec: spec(33, 18, 1.9, 6, 1.1, 2.5, 4), hp: 150, ram: 18, shooter: 1, bulletDamage: 7, label: 'Pickup armada' },
  truck: { faction: 'gang', spec: spec(30, 13, 1.25, 5, 1.45, 4.6, 6), hp: 380, ram: 38, shooter: 0.7, bulletDamage: 8, label: 'Tráiler' },
  van: { faction: 'gang', spec: spec(30, 15, 1.6, 5, 1.3, 2.9, 6), hp: 260, ram: 30, shooter: 0.5, bulletDamage: 8, label: 'Furgón blindado' },
  // ---- Tierra baldía
  buggy: { faction: 'wasteland', spec: spec(39, 28, 2.6, 7, 0.95, 1.8, 2.5), hp: 70, ram: 14, shooter: 0.3, bulletDamage: 6, label: 'Buggy saqueador' },
  mutant: { faction: 'wasteland', spec: spec(26, 40, 4.5, 12, 0.45, 0.45, 1.5), hp: 25, ram: 10, shooter: 0, bulletDamage: 0, label: 'Mutante', onFoot: true },
  flyer: { faction: 'wasteland', spec: spec(30, 30, 3, 8, 0.5, 0.5, 1), hp: 1, ram: 12, shooter: 1, bulletDamage: 7, label: 'Harpía mutante', flying: true },
  raider: { faction: 'wasteland', spec: spec(39, 26, 2.8, 8, 0.45, 1.1, 2), hp: 45, ram: 7, shooter: 1, bulletDamage: 7, label: 'Motero mutante' },
  rig: { faction: 'wasteland', spec: spec(29, 14, 1.4, 5, 1.5, 3.4, 7), hp: 340, ram: 36, shooter: 0.6, bulletDamage: 9, label: 'Camión de guerra' },
};

export interface FireRequest {
  x: number;
  z: number;
  angle: number;
  damage: number;
  /** Bando del tirador: define el color de la bala. */
  faction: Faction;
}

export interface PursuerContext {
  dt: number;
  players: Player[];
  track: Track;
  physics: Physics;
  config: PursuerConfig;
  rng: Rng;
}

/**
 * Perseguidor con IA: predice la posición del jugador, sigue la vía cuando va
 * lejos, esquiva obstáculos fijos con "bigotes" (raycasts), embiste según su
 * agresividad y dispara si tiene línea de visión. Sirve para la policía, la
 * banda rival y los saqueadores de la tierra baldía (incluidos mutantes a pie).
 */
export class Pursuer {
  readonly vehicle: Vehicle;
  readonly stats: PursuerStats;
  readonly model: PursuerMesh;
  hp: number;
  wrecked = false;
  /** Segundos que lleva destruido (se retira al consumirse). */
  wreckTime = 0;
  readonly armed: boolean;
  smokeTimer = 0;
  private ramTimer = 0;
  private ramCooldown: number;
  private fireCooldown: number;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private sirenTimer = 0;
  private sirenPhase = false;
  private t = 0;
  private stride = 0;

  constructor(
    physics: Physics,
    readonly kind: PursuerKind,
    x: number,
    z: number,
    heading: number,
    rng: Rng,
  ) {
    this.stats = PURSUER_STATS[kind];
    this.hp = this.stats.hp;
    this.model = pursuerMesh(kind);
    this.vehicle = new Vehicle(physics, this.stats.spec, x, z, heading, { kind: 'pursuer', ref: this }, this.model.group);
    this.armed = rng.chance(this.stats.shooter);
    this.ramCooldown = rng.range(1, 3);
    this.fireCooldown = rng.range(1, 2.5);
  }

  update(ctx: PursuerContext): FireRequest | null {
    const v = this.vehicle;
    const dt = ctx.dt;
    this.t += dt;
    if (this.wrecked) {
      this.wreckTime += dt;
      v.halt(dt);
      return null;
    }

    if (this.model.red) {
      this.sirenTimer += dt;
      if (this.sirenTimer > 0.2) {
        this.sirenTimer = 0;
        this.sirenPhase = !this.sirenPhase;
        setSiren(this.model, this.sirenPhase);
      }
    }
    // Mutantes: carrera articulada; la zancada se acelera con la velocidad.
    if (this.model.rig) {
      const sp = Math.abs(v.speed);
      this.stride += dt * (3 + sp * 0.42);
      animateMutant(this.model.rig, this.stride, clamp(sp / 9, 0.15, 1));
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

    // ---- punto objetivo
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
      desired = v.heading + ((left ?? len) >= (right ?? len) ? 1 : -1) * 0.9;
    } else {
      if (left !== null) desired -= 0.5 * (1 - left / len);
      if (right !== null) desired += 0.5 * (1 - right / len);
    }

    // No alejarse demasiado de la vía al perseguir.
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
    if (dist > 45) speedMul = this.stats.onFoot ? 1 : 1.3;
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
        return { x: v.px, z: v.pz, angle, damage: this.stats.bulletDamage, faction: this.stats.faction };
      }
    }
    return null;
  }

  /** Recibe daño; devuelve true si quedó destruido en este golpe. */
  damage(amount: number): boolean {
    if (this.wrecked) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.wrecked = true;
      this.vehicle.body.setLinearDamping(3);
      if (this.model.rig) {
        // El mutante cae de bruces.
        knockOutMutant(this.model.rig);
      } else {
        const burnt = mat(0x2a2522);
        this.model.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.material = burnt;
        });
      }
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
      if (!p.alive || p.ghost) continue;
      const d = Math.hypot(p.vehicle.px - this.vehicle.px, p.vehicle.pz - this.vehicle.pz);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}
