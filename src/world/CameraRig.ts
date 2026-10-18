import * as THREE from 'three';
import { clamp, damp } from '../core/math';

/** Posición y velocidad de un vehículo que la cámara debe seguir. */
export interface CamTarget {
  px: number;
  pz: number;
  vx: number;
  vz: number;
}

/** Vehículo de un jugador para la cámara (en línea viaja por la red). */
export interface CamPlayer extends CamTarget {
  alive: boolean;
}

/**
 * A quién sigue la cámara de un dispositivo: a su propio jugador; si está
 * caído esperando reaparecer, a un compañero vivo.
 */
export function cameraFocus<T extends CamPlayer>(players: T[], me: number): T | null {
  const own = players[me];
  if (own?.alive) return own;
  return players.find((p) => p.alive) ?? own ?? null;
}

/**
 * Cámara cenital que sigue a un vehículo: se adelanta hacia donde va, se eleva
 * con la velocidad y tiembla con los golpes. En línea cada jugador tiene la
 * suya, así que no se aleja aunque el compañero se separe.
 */
export class CameraRig {
  x = 0;
  z = 0;
  h = 50;

  place(x: number, z: number): void {
    this.x = x;
    this.z = z;
  }

  update(camera: THREE.PerspectiveCamera, dt: number, target: CamTarget | null, shake: number, zoom = 0): void {
    if (target) {
      const cx = target.px;
      const cz = target.pz;
      const vx = target.vx;
      const vz = target.vz;

      // Mirar hacia donde se va: más carretera visible por delante.
      const look = Math.min(1, 14 / Math.max(1, Math.hypot(vx, vz)));
      const tx = cx + vx * 0.4 * look;
      const tz = cz + vz * 0.4 * look - 6;
      const speed = Math.hypot(vx, vz);
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const minForWidth = 19 / (tanHalf * camera.aspect);
      const h = clamp(Math.max(36 + speed * 0.35, minForWidth) + zoom, 28, 120);

      this.x = damp(this.x, tx, 5, dt);
      this.z = damp(this.z, tz, 5, dt);
      this.h = damp(this.h, h, 2, dt);
    }
    const s = shake * shake * 1.4;
    const sx = (Math.random() - 0.5) * s;
    const sz = (Math.random() - 0.5) * s;
    camera.up.set(0, 0, -1);
    camera.position.set(this.x + sx, this.h, this.z + sz + 0.01);
    camera.lookAt(this.x + sx, 0, this.z + sz);
  }
}
