import * as THREE from 'three';
import { humanoid, motorbike, mutantRig, outlawVehicle, playerVehicleMesh, policeVehicle } from '../fx/Meshes';

/**
 * Solo desarrollo (`?models=1`): los motociclistas, conductores y personajes a
 * pie en fila, para revisar sus modelos. `&view=top` los muestra desde arriba,
 * como se ven durante el juego.
 */
export function showGallery(container: HTMLElement): void {
  const top = new URLSearchParams(location.search).get('view') === 'top';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  container.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9a878);
  scene.add(new THREE.HemisphereLight(0xfff0dd, 0x6a4a3a, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-6, 12, -8);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 10, bottom: -10 });
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 40), new THREE.MeshLambertMaterial({ color: 0x3a3836 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const models: THREE.Object3D[] = [
    motorbike(0xd62828, 0xfcbf49),
    policeVehicle('moto').group,
    outlawVehicle('biker'),
    outlawVehicle('raider'),
    outlawVehicle('buggy'),
    playerVehicleMesh('buggy', 0xd62828, 0xfcbf49),
    humanoid(0xd2a07a, 0x222222, false, 1),
    humanoid(0x7d9a6a, 0x4a3f35, true, 1),
    mutantRig().root,
  ];
  // `&i=3`: solo ese modelo, de cerca.
  const only = new URLSearchParams(location.search).get('i');
  models.forEach((m, i) => {
    if (only !== null && Number(only) !== i) return;
    m.position.x = only !== null ? 0 : (i - (models.length - 1) / 2) * 3.2;
    // De costado y un poco de frente.
    m.rotation.y = top ? 0 : Number(new URLSearchParams(location.search).get('rot') ?? -0.9);
    m.traverse((o) => (o.castShadow = true));
    scene.add(m);
  });
  const camera = new THREE.PerspectiveCamera(top ? 40 : 32, innerWidth / innerHeight, 0.1, 200);
  if (top) {
    camera.position.set(0, 26, 0.01);
    camera.up.set(0, 0, -1);
  } else if (only !== null) camera.position.set(0, 2.6, 6.5);
  else camera.position.set(0, 4.5, 21);
  camera.lookAt(0, top ? 0 : 1, 0);
  const frame = () => {
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  frame();
}
