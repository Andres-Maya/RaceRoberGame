import * as THREE from 'three';
import type { Effects } from '../fx/Particles';
import type { Track } from '../world/Track';

/**
 * Tormenta de arena del nivel 0: un muro de polvo que avanza detrás de los
 * jugadores. Obliga a mantener el ritmo y sirve a la IA para medir la sangre
 * fría (tiempo conduciendo cerca del peligro).
 */
export class Sandstorm {
  /** Posición (en d) del frente de la tormenta. */
  front = -45;
  private layers: THREE.Mesh[] = [];
  private t = 0;

  constructor(
    private scene: THREE.Scene,
    private duration: number,
    /** Ritmo según el vehículo más lento (1 = moto): con un blindado la tormenta avanza más despacio. */
    private pace = 1,
  ) {
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 90),
        new THREE.MeshBasicMaterial({ color: i % 2 ? 0xc89a5c : 0xb0814a, transparent: true, opacity: 0.32, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      scene.add(m);
      this.layers.push(m);
    }
  }

  get speed(): number {
    if (this.t < 4) return 6;
    const p = Math.min(1, this.t / this.duration);
    return (19 + p * 11) * this.pace;
  }

  update(dt: number, slowestD: number, track: Track, fx: Effects): void {
    this.t += dt;
    this.front += this.speed * dt;
    // Nunca queda demasiado lejos: la presión es constante.
    this.front = Math.max(this.front, slowestD - 70);

    const cx = track.centerX(this.front);
    this.layers.forEach((m, i) => {
      m.position.set(cx + Math.sin(this.t * 0.7 + i) * 4, 0.6 + i * 1.6, -(this.front - 45 + i * 1.5 + Math.sin(this.t * 1.3 + i * 2) * 1.5));
    });
    for (let i = 0; i < 3; i++) {
      fx.dust(cx + (Math.random() - 0.5) * 70, -(this.front + Math.random() * 3), 0xc9a066, 1, 3.5);
    }
  }

  /** Cuántas unidades dentro de la tormenta está un punto (<= 0: fuera). */
  depth(d: number): number {
    return this.front - d;
  }

  dispose(): void {
    for (const m of this.layers) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
