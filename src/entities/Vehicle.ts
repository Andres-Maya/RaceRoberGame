import type RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { clamp, damp, forwardX, forwardZ, quatY } from '../core/math';
import type { Physics, Tag } from '../world/Physics';

export interface VehicleSpec {
  maxSpeed: number;
  accel: number;
  brake: number;
  reverse: number;
  /** Velocidad angular máxima (rad/s). */
  steerRate: number;
  /** Agarre lateral: cuanto más alto, menos derrapa. */
  grip: number;
  hx: number;
  hz: number;
  density: number;
}

export interface DriveMods {
  speedMul: number;
  accelMul: number;
  gripMul: number;
}

export const NO_MODS: DriveMods = { speedMul: 1, accelMul: 1, gripMul: 1 };

/**
 * Controlador arcade compartido por motos, patrullas y civiles. La física de
 * Rapier resuelve contactos y empujones; aquí se decide la velocidad deseada
 * y se mezcla con la velocidad real según el agarre, lo que produce derrapes
 * y permite que los choques desvíen al vehículo.
 */
export class Vehicle {
  readonly body: RAPIER.RigidBody;
  heading: number;
  px: number;
  pz: number;
  vx = 0;
  vz = 0;
  /** Velocidad ordenada antes del paso físico (para medir impactos). */
  preVx = 0;
  preVz = 0;

  constructor(
    physics: Physics,
    readonly spec: VehicleSpec,
    x: number,
    z: number,
    heading: number,
    tag: Tag,
    readonly mesh: THREE.Object3D,
  ) {
    this.heading = heading;
    this.px = x;
    this.pz = z;
    this.body = physics.dynamicBox(x, z, spec.hx, spec.hz, heading, tag, {
      density: spec.density,
      events: true,
      ccd: true,
      friction: 0.1,
      restitution: 0.25,
    });
    this.syncMesh();
  }

  get d(): number {
    return -this.pz;
  }

  get speed(): number {
    return this.vx * forwardX(this.heading) + this.vz * forwardZ(this.heading);
  }

  get absSpeed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  drive(dt: number, throttle: number, brake: number, steer: number, mods: DriveMods = NO_MODS): void {
    const sp = this.spec;
    const s0 = this.speed;
    let s = s0;
    const max = sp.maxSpeed * mods.speedMul;

    if (throttle > 0) {
      s = s < max ? Math.min(max, s + sp.accel * mods.accelMul * throttle * dt) : damp(s, max, 1.5, dt);
    } else if (brake > 0) {
      s = s > 0.5 ? Math.max(0, s - sp.brake * brake * dt) : Math.max(-sp.reverse, s - sp.accel * 0.5 * dt);
    } else {
      s -= Math.sign(s) * Math.min(Math.abs(s), 7 * dt);
    }
    if (s > max) s = damp(s, max, 2, dt);

    // El giro depende de la velocidad: quieto no gira, muy rápido gira menos.
    const turnFactor = clamp(Math.abs(s) / 6, 0, 1) * (1 - 0.4 * clamp(Math.abs(s) / sp.maxSpeed, 0, 1));
    this.heading -= steer * sp.steerRate * turnFactor * (s < 0 ? -1 : 1) * dt;
    this.integrate(dt, s - s0, mods.gripMul);
  }

  /** Frena hasta detenerse sin entrar en reversa (vehículos destruidos, pánico, fin de nivel). */
  halt(dt: number, decel = 28): void {
    const s = this.speed;
    this.integrate(dt, -Math.sign(s) * Math.min(Math.abs(s), decel * dt), 1);
  }

  /**
   * Aplica el cambio de velocidad longitudinal (acelerar/frenar) directamente y
   * amortigua la componente lateral según el agarre: con poco agarre (aceite)
   * la moto conserva su inercia y derrapa.
   */
  private integrate(dt: number, deltaSpeed: number, gripMul: number): void {
    const fx = forwardX(this.heading);
    const fz = forwardZ(this.heading);
    const along = this.vx * fx + this.vz * fz;
    const keep = Math.exp(-this.spec.grip * gripMul * dt);
    const latX = (this.vx - fx * along) * keep;
    const latZ = (this.vz - fz * along) * keep;
    this.vx = fx * (along + deltaSpeed) + latX;
    this.vz = fz * (along + deltaSpeed) + latZ;
    this.apply();
  }

  /** Escribe velocidad y orientación en el cuerpo físico. */
  apply(): void {
    this.preVx = this.vx;
    this.preVz = this.vz;
    this.body.setLinvel({ x: this.vx, y: 0, z: this.vz }, true);
    this.body.setRotation(quatY(this.heading), true);
  }

  /** Lee el resultado del paso físico. */
  sync(): void {
    const t = this.body.translation();
    const v = this.body.linvel();
    this.px = t.x;
    this.pz = t.z;
    this.vx = v.x;
    this.vz = v.z;
    this.syncMesh();
  }

  /** Magnitud del cambio de velocidad causado por el último paso físico (colisión). */
  impact(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x - this.preVx, v.z - this.preVz);
  }

  teleport(x: number, z: number, heading = this.heading): void {
    this.px = x;
    this.pz = z;
    this.heading = heading;
    this.vx = this.vz = 0;
    this.body.setTranslation({ x, y: 1, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation(quatY(heading), true);
    this.syncMesh();
  }

  private syncMesh(): void {
    this.mesh.position.set(this.px, this.mesh.position.y, this.pz);
    this.mesh.rotation.y = this.heading;
  }
}
