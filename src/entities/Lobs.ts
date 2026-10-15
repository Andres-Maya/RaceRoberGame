import * as THREE from 'three';
import { lobMesh } from '../fx/Meshes';

export type LobKind = 'grenade' | 'bomb' | 'acid';

export interface Lob {
  kind: LobKind;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  t: number;
  dur: number;
  /** Daño máximo a la moto al caer. */
  damage: number;
  /** Explosión verde (tierra baldía). */
  toxic: boolean;
  mesh: THREE.Object3D;
  marker: THREE.Mesh;
}

const RING = new THREE.RingGeometry(0.75, 1, 28).rotateX(-Math.PI / 2);
const MARKER_MATS: Record<LobKind, THREE.MeshBasicMaterial> = {
  grenade: new THREE.MeshBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.8, depthWrite: false }),
  bomb: new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.8, depthWrite: false }),
  acid: new THREE.MeshBasicMaterial({ color: 0x6dff3a, transparent: true, opacity: 0.7, depthWrite: false }),
};
/** Radio del anillo de aviso en el suelo: la zona donde hará daño. */
const MARKER_RADIUS: Record<LobKind, number> = { grenade: 4.5, bomb: 3.6, acid: 1.4 };

/**
 * Proyectiles lanzados en arco (granadas, bombas, lluvia de ácido). Cada uno
 * marca con un anillo parpadeante dónde va a caer, para poder esquivarlo.
 */
export class Lobs {
  private list: Lob[] = [];

  constructor(private scene: THREE.Scene) {}

  get count(): number {
    return this.list.length;
  }

  launch(kind: LobKind, x0: number, z0: number, x1: number, z1: number, dur: number, damage: number, toxic: boolean): void {
    const mesh = lobMesh(kind);
    const marker = new THREE.Mesh(RING, MARKER_MATS[kind]);
    marker.position.set(x1, 0.08, z1);
    marker.scale.setScalar(MARKER_RADIUS[kind]);
    this.scene.add(mesh, marker);
    this.list.push({ kind, x0, z0, x1, z1, t: 0, dur, damage, toxic, mesh, marker });
  }

  update(dt: number, onLand: (lob: Lob) => void): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const l = this.list[i];
      l.t += dt;
      const k = Math.min(1, l.t / l.dur);
      // Parábola: más alta cuanto más largo el vuelo.
      const height = l.kind === 'acid' ? 0 : l.dur * 7;
      const y = l.kind === 'acid' ? 14 * (1 - k) : 1.2 + 4 * height * k * (1 - k);
      l.mesh.position.set(l.x0 + (l.x1 - l.x0) * k, y, l.z0 + (l.z1 - l.z0) * k);
      l.mesh.rotation.x += dt * 8;
      // El aviso parpadea más rápido al acercarse la caída.
      l.marker.visible = Math.sin(l.t * (10 + k * 30)) > -0.3;
      l.marker.scale.setScalar(MARKER_RADIUS[l.kind] * (1.15 - 0.15 * k));
      if (k >= 1) {
        this.scene.remove(l.mesh, l.marker);
        this.list.splice(i, 1);
        onLand(l);
      }
    }
  }

  clear(): void {
    for (const l of this.list) this.scene.remove(l.mesh, l.marker);
    this.list.length = 0;
  }
}
