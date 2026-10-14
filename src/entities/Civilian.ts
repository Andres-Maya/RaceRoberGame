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

/** Tráfico civil: obstáculos móviles que siguen su carril o cruzan la vía. */
export class Civilian {
  readonly vehicle: Vehicle;
  /** Tras un choque fuerte el conductor frena en pánico. */
  panic = 0;
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

  update(dt: number, track: Track, physics: Physics): void {
    const v = this.vehicle;
    if (this.panic > 0) {
      this.panic -= dt;
      v.halt(dt);
      return;
    }
    let steer = 0;
    if (this.spawn.mode === 'lane') {
      const look = v.d + (this.oncoming ? -10 : 10);
      const tx = track.centerX(look) + this.spawn.lane;
      const desired = Math.atan2(-(tx - v.px), -(-look - v.pz));
      steer = clamp(-wrapAngle(desired - v.heading) * 2, -1, 1);
    }
    const ahead = physics.rayFixed(v.px, v.pz, -Math.sin(v.heading), -Math.cos(v.heading), 7);
    const throttle = ahead === null && v.speed < this.spawn.speed ? 1 : 0;
    const brake = ahead !== null ? 1 : 0;
    v.drive(dt, throttle, brake, steer);
  }
}
