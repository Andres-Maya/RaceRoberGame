import { clamp, wrapAngle } from '../core/math';
import { civilianCar, CIVILIAN_COLORS } from '../fx/Meshes';
import type { CivilianSpawn } from '../world/ChunkManager';
import type { Physics } from '../world/Physics';
import type { Track } from '../world/Track';
import { Vehicle, type VehicleSpec } from './Vehicle';

const CIVILIAN_SPEC: VehicleSpec = {
  maxSpeed: 18,
  accel: 10,
  brake: 25,
  reverse: 5,
  steerRate: 1.5,
  grip: 6,
  hx: 0.95,
  hz: 2.0,
  density: 3,
};

/** Busca el obstáculo más cercano por delante: (x, d, dirección) → posición y distancia. */
export type ObstacleProbe = (x: number, d: number, dir: number) => { x: number; dist: number } | null;

/** Tráfico civil: obstáculos móviles que siguen su carril o cruzan la vía. */
export class Civilian {
  readonly vehicle: Vehicle;
  /** Tras un choque fuerte el conductor frena en pánico. */
  panic = 0;
  /** Desvío lateral temporal para esquivar un obstáculo en su carril. */
  private dodge = 0;
  private dodgeTimer = 0;
  readonly oncoming: boolean;

  constructor(
    physics: Physics,
    private spawn: CivilianSpawn,
    colorIndex: number,
  ) {
    const mesh = civilianCar(CIVILIAN_COLORS[colorIndex % CIVILIAN_COLORS.length]);
    this.vehicle = new Vehicle(physics, CIVILIAN_SPEC, spawn.x, -spawn.d, spawn.heading, { kind: 'civilian', ref: this }, mesh);
    this.oncoming = spawn.mode === 'lane' && Math.abs(wrapAngle(spawn.heading)) > Math.PI / 2;
    // Arranca ya en movimiento.
    this.vehicle.vx = -Math.sin(spawn.heading) * spawn.speed;
    this.vehicle.vz = -Math.cos(spawn.heading) * spawn.speed;
  }

  get mode(): CivilianSpawn['mode'] {
    return this.spawn.mode;
  }

  update(dt: number, track: Track, physics: Physics, probe?: ObstacleProbe): void {
    const v = this.vehicle;
    if (this.panic > 0) {
      this.panic -= dt;
      v.halt(dt);
      return;
    }
    let steer = 0;
    let blockedClose = false;
    if (this.spawn.mode === 'lane') {
      const dir = this.oncoming ? -1 : 1;
      // Esquivar obstáculos del carril cambiándose de lado un momento.
      this.dodgeTimer -= dt;
      const obstacle = probe?.(v.px, v.d, dir);
      if (obstacle) {
        if (this.dodgeTimer <= 0) {
          const half = track.halfWidth(v.d);
          let shift = obstacle.x > v.px ? -3.6 : 3.6;
          if (Math.abs(this.spawn.lane + shift) > half - 1.4) shift = -shift;
          this.dodge = shift;
        }
        this.dodgeTimer = 1.2;
        blockedClose = obstacle.dist < 5 && Math.abs(obstacle.x - v.px) < 1.8;
      } else if (this.dodgeTimer <= 0) {
        this.dodge = 0;
      }
      const look = v.d + dir * 10;
      const tx = track.centerX(look) + this.spawn.lane + this.dodge;
      const desired = Math.atan2(-(tx - v.px), -(-look - v.pz));
      steer = clamp(-wrapAngle(desired - v.heading) * 2, -1, 1);
    }
    const ahead = physics.rayFixed(v.px, v.pz, -Math.sin(v.heading), -Math.cos(v.heading), 7);
    const stop = ahead !== null || blockedClose;
    const throttle = !stop && v.speed < this.spawn.speed ? 1 : 0;
    v.drive(dt, throttle, stop ? 1 : 0, steer);
  }
}
