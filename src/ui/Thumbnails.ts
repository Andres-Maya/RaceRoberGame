import * as THREE from 'three';
import { PLAYER_COLORS } from '../entities/Player';
import { playerVehicleMesh } from '../fx/Meshes';

const W = 360;
const H = 220;
const cache = new Map<string, string>();

/**
 * Fotos de los vehículos para las tarjetas del garaje. Se dibujan una sola vez
 * con un renderizador aparte (vista en tres cuartos) y se guardan como imagen.
 */
export function vehicleThumbnails(ids: string[], player = 0): Record<string, string> {
  const key = (id: string) => `${id}:${player}`;
  const missing = ids.filter((id) => !cache.has(key(id)));
  if (missing.length) {
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2a1a, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(-4, 8, -3);
      scene.add(sun);
      const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
      const colors = PLAYER_COLORS[player];
      for (const id of missing) {
        const mesh = playerVehicleMesh(id, colors.body, colors.accent);
        scene.add(mesh);
        // Encuadre según el tamaño del vehículo: de frente y en diagonal.
        const box = new THREE.Box3().setFromObject(mesh);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        const dist = size * 1.55;
        camera.position.set(center.x - dist * 0.62, center.y + dist * 0.5, center.z - dist * 0.62);
        camera.lookAt(center.x, center.y - size * 0.04, center.z);
        renderer.render(scene, camera);
        cache.set(key(id), renderer.domElement.toDataURL('image/png'));
        scene.remove(mesh);
      }
    } catch {
      // Sin WebGL extra disponible: las tarjetas se muestran sin foto.
    } finally {
      renderer?.dispose();
      renderer?.forceContextLoss();
    }
  }
  return Object.fromEntries(ids.map((id) => [id, cache.get(key(id)) ?? '']));
}
