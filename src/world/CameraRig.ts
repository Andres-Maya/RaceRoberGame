import * as THREE from 'three';
import { clamp, damp } from '../core/math';

/** Posición y velocidad de un vehículo que la cámara debe seguir. */
export interface CamTarget {
  px: number;
  pz: number;
  vx: number;
  vz: number;
}

/**
 * Cámara cenital que sigue a los jugadores: se adelanta hacia donde van, se
 * eleva con la velocidad y la separación entre ellos, y tiembla con los golpes.
 * La usan la partida local y el invitado en línea (con datos del anfitrión).
 */
export class CameraRig {
  x = 0;
  z = 0;
  h = 50;

  place(x: number, z: number): void {
    this.x = x;
    this.z = z;
  }

  update(camera: THREE.PerspectiveCamera, dt: number, targets: CamTarget[], shake: number, zoom = 0): void {
    if (targets.length) {
      let cx = 0;
      let cz = 0;
      let vx = 0;
      let vz = 0;
      for (const t of targets) {
        cx += t.px;
        cz += t.pz;
        vx += t.vx;
        vz += t.vz;
      }
      const n = targets.length;
      cx /= n;
      cz /= n;
      vx /= n;
      vz /= n;
      const spread = n > 1 ? Math.hypot(targets[0].px - targets[1].px, targets[0].pz - targets[1].pz) : 0;

      // Mirar hacia donde se va: más carretera visible por delante.
      const look = Math.min(1, 14 / Math.max(1, Math.hypot(vx, vz)));
      const tx = cx + vx * 0.4 * look;
      const tz = cz + vz * 0.4 * look - 6;
      const speed = Math.hypot(vx, vz);
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const minForWidth = 19 / (tanHalf * camera.aspect);
      const h = clamp(Math.max(36 + speed * 0.35 + spread * 0.8, minForWidth) + zoom, 28, 120);

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
