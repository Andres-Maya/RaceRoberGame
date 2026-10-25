import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { ObstacleKind, PursuerKind } from '../config/types';
import { VEHICLES } from '../config/vehicles';
import { PLAYER_COLORS } from '../entities/Player';
import {
  animateMutant,
  CIVILIAN_COLORS,
  CIVILIAN_NAMES,
  CIVILIAN_TYPES,
  civilianCar,
  harpy,
  helicopter,
  humanoid,
  obstacleMesh,
  pickupMesh,
  playerVehicleMesh,
  pursuerMesh,
  rampMesh,
  setSiren,
  type HarpyMesh,
  type HeliMesh,
  type PursuerMesh,
} from '../fx/Meshes';
import { esc } from './html';

/*
 * Sala de exhibición (`?models=1`): todos los vehículos y personajes del juego
 * por categorías, con su nombre, girando sobre sí mismos. Se mira con la
 * cámara libre: arrastrar para girar, rueda o pellizco para acercar, clic
 * derecho o dos dedos para mover y doble clic para enfocar un modelo.
 */

interface Item {
  name: string;
  build: () => THREE.Object3D;
  /** Animación propia (sirenas, rotor, carrera, aleteo). */
  animate?: (t: number) => void;
}

/** Perseguidor con sus sirenas, y la carrera si es un mutante. */
function chaser(kind: PursuerKind, name: string): Item {
  let mesh: PursuerMesh | null = null;
  return {
    name,
    build: () => {
      mesh = pursuerMesh(kind);
      return mesh.group;
    },
    animate: (t) => {
      if (!mesh) return;
      setSiren(mesh, Math.floor(t * 6) % 2 === 0);
      if (mesh.rig) animateMutant(mesh.rig, t * 8, 1);
    },
  };
}

function obstacle(kind: ObstacleKind, name: string): Item {
  return { name, build: () => obstacleMesh(kind, 0.3) };
}

const CATEGORIES: { title: string; items: () => Item[] }[] = [
  {
    title: 'Tus vehículos',
    items: () =>
      VEHICLES.map((v) => ({
        name: `${v.name} · ${v.role}`,
        build: () => playerVehicleMesh(v.id, PLAYER_COLORS[0].body, PLAYER_COLORS[0].accent),
      })),
  },
  {
    title: 'Policía',
    items: () => {
      let heli: HeliMesh | null = null;
      return [
        chaser('patrol', 'Patrulla'),
        chaser('moto', 'Moto policial'),
        chaser('suv', 'SUV'),
        chaser('swat', 'SWAT con lanzagranadas'),
        {
          name: 'Helicóptero',
          build: () => {
            heli = helicopter();
            heli.group.position.y = 0.7;
            const g = new THREE.Group();
            g.add(heli.group);
            return g;
          },
          animate: (t) => {
            if (!heli) return;
            heli.rotor.rotation.y = t * 20;
            heli.tailRotor.rotation.x = t * 35;
          },
        },
      ];
    },
  },
  {
    title: 'Banda rival',
    items: () => [
      chaser('muscle', 'Muscle car'),
      chaser('biker', 'Motero'),
      chaser('pickup', 'Pickup armada'),
      chaser('van', 'Furgón blindado'),
      chaser('truck', 'Tráiler'),
      { name: 'Tirador', build: () => humanoid(0xd2a07a, 0x222222, 'rifle', 1) },
    ],
  },
  {
    title: 'Tierra baldía',
    items: () => {
      let bird: HarpyMesh | null = null;
      return [
        chaser('mutant', 'Mutante'),
        chaser('raider', 'Motero mutante'),
        chaser('buggy', 'Buggy'),
        chaser('pyro', 'Incinerador'),
        chaser('rig', 'Camión de guerra'),
        {
          name: 'Harpía',
          build: () => {
            bird = harpy();
            bird.group.position.y = 2.5;
            const g = new THREE.Group();
            g.add(bird.group);
            return g;
          },
          animate: (t) => {
            if (!bird) return;
            bird.wings.forEach((w, i) => {
              const s = i === 0 ? -1 : 1;
              w.inner.rotation.z = s * Math.sin(t * 7) * 0.6;
              w.outer.rotation.z = s * Math.sin(t * 7 - 0.7) * 0.5;
            });
            bird.tail.rotation.y = Math.sin(t * 3) * 0.3;
            bird.jaw.rotation.x = -Math.max(0, Math.sin(t * 2)) * 0.35;
          },
        },
        { name: 'Zombi', build: () => humanoid(0x7d9a6a, 0x4a3f35, 'zombie', 1) },
      ];
    },
  },
  {
    title: 'Tráfico',
    items: () => CIVILIAN_TYPES.map((t, i) => ({ name: CIVILIAN_NAMES[t], build: () => civilianCar(CIVILIAN_COLORS[i], t) })),
  },
  {
    title: 'En el camino',
    items: () => [
      obstacle('fuelBarrel', 'Bidón de combustible'),
      obstacle('barrel', 'Barril'),
      obstacle('toxicBarrel', 'Barril tóxico'),
      obstacle('crate', 'Caja'),
      obstacle('cone', 'Cono'),
      obstacle('barrier', 'Barrera'),
      obstacle('wreck', 'Chatarra'),
      obstacle('dumpster', 'Contenedor de basura'),
      obstacle('parkedCar', 'Auto estacionado'),
      obstacle('rock', 'Roca'),
      obstacle('cactus', 'Cactus'),
      obstacle('tumbleweed', 'Planta rodadora'),
      { name: 'Rampa', build: () => rampMesh() },
      { name: 'Reparación', build: () => pickupMesh('repair') },
      { name: 'Nitro', build: () => pickupMesh('nitro') },
      { name: 'Munición', build: () => pickupMesh('ammo') },
    ],
  },
];

export function showShowroom(container: HTMLElement): void {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  container.prepend(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(innerWidth, innerHeight);
  labels.domElement.className = 'showroom-labels';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d27);
  scene.fog = new THREE.Fog(0x1a1d27, 60, 140);
  scene.add(new THREE.HemisphereLight(0xfff0dd, 0x3a3240, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-10, 18, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 20, bottom: -20, near: 1, far: 80 });
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(90, 64), new THREE.MeshLambertMaterial({ color: 0x2c2f38 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 400);
  const controls = new OrbitControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2;
  controls.maxDistance = 90;

  // Interfaz: categorías, giro automático y volver al juego.
  const ui = document.createElement('div');
  ui.className = 'showroom-ui';
  ui.innerHTML = `<div class="showroom-title">Sala de exhibición</div>
    <div class="showroom-tabs">${CATEGORIES.map((c, i) => `<button data-cat="${i}">${esc(c.title)}</button>`).join('')}</div>
    <div class="showroom-tools">
      <label><input type="checkbox" data-spin checked /> Girar modelos</label>
      <a href="${location.pathname}">Volver al juego</a>
    </div>
    <div class="showroom-help">Arrastra para girar · rueda o pellizco para acercar · clic derecho o dos dedos para mover · doble clic en un modelo para enfocarlo</div>`;
  container.appendChild(ui);
  const spinBox = ui.querySelector<HTMLInputElement>('[data-spin]')!;

  let shown: { root: THREE.Object3D; pivot: THREE.Group; item: Item }[] = [];
  const show = (index: number) => {
    for (const s of shown) {
      scene.remove(s.root);
      s.root.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
    }
    shown = [];
    ui.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('on', Number((b as HTMLElement).dataset.cat) === index));
    const items = CATEGORIES[index].items();
    // En fila, separados según su tamaño.
    const built = items.map((item) => {
      const pivot = new THREE.Group();
      pivot.add(item.build());
      pivot.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      const size = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
      return { item, pivot, width: Math.max(3.4, Math.max(size.x, size.z) + 1.4), height: size.y };
    });
    // Con muchos modelos, dos filas (la segunda detrás); cada fila centrada.
    const turn = Number(new URLSearchParams(location.search).get('turn')) || 0;
    const perRow = built.length > 8 ? Math.ceil(built.length / 2) : built.length;
    const rows = [built.slice(0, perRow), built.slice(perRow)].filter((r) => r.length);
    const total = Math.max(...rows.map((r) => r.reduce((s, b) => s + b.width, 0)));
    const placed: { b: (typeof built)[number]; x: number; z: number }[] = [];
    rows.forEach((row, ri) => {
      let x = -row.reduce((s, b) => s + b.width, 0) / 2;
      for (const b of row) {
        placed.push({ b, x: x + b.width / 2, z: -ri * 7 });
        x += b.width;
      }
    });
    for (const { b, x, z } of placed) {
      const root = new THREE.Group();
      root.position.set(x, 0, z);
      b.pivot.rotation.y = -0.7 + turn;
      root.add(b.pivot);
      // Peana y nombre.
      const base = new THREE.Mesh(new THREE.CylinderGeometry(b.width * 0.42, b.width * 0.45, 0.12, 40), new THREE.MeshLambertMaterial({ color: 0x3a3e4a }));
      base.position.y = -0.06;
      base.receiveShadow = true;
      root.add(base);
      const tag = document.createElement('div');
      tag.className = 'showroom-tag';
      tag.textContent = b.item.name;
      const label = new CSS2DObject(tag);
      label.position.set(0, -0.2, b.width * 0.45 + 0.4);
      root.add(label);
      scene.add(root);
      shown.push({ root, pivot: b.pivot, item: b.item });
    }
    // Encuadre de toda la fila: la distancia que hace caber su ancho en el campo de visión horizontal.
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    const dist = Math.max(10, ((total / 2) / Math.tan(halfH)) * 1.08);
    const depth = (rows.length - 1) * 3.5;
    camera.position.set(0, dist * 0.42 + depth * 0.6, dist - depth);
    controls.target.set(0, 1, -depth);
    controls.update();
  };
  ui.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cat]');
    if (b) show(Number(b.dataset.cat));
  });

  // Doble clic: enfocar el modelo bajo el puntero.
  const ray = new THREE.Raycaster();
  labels.domElement.addEventListener('dblclick', (e) => {
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(shown.map((s) => s.pivot), true)[0];
    if (!hit) return;
    const owner = shown.find((s) => {
      let o: THREE.Object3D | null = hit.object;
      while (o && o !== s.pivot) o = o.parent;
      return o === s.pivot;
    });
    if (owner) focusOn(owner.pivot);
  });

  /** Acerca la cámara a un modelo manteniendo el ángulo de la vista. */
  const focusOn = (pivot: THREE.Object3D) => {
    pivot.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(pivot);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, Math.max(3, size * 1.6));
    controls.update();
  };

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    labels.setSize(innerWidth, innerHeight);
  });

  // `&cat=2` abre directamente esa categoría, `&focus=3` enfoca su cuarto modelo y `&spin=0` los deja quietos y `&turn=3` los gira (radianes).
  const params = new URLSearchParams(location.search);
  show(Math.min(CATEGORIES.length - 1, Math.max(0, Number(params.get('cat')) || 0)));
  const focused = shown[Number(params.get('focus') ?? -1)];
  if (focused) focusOn(focused.pivot);
  if (params.get('spin') === '0') spinBox.checked = false;
  const start = performance.now();
  let last = start;
  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - start) / 1000;
    for (const s of shown) {
      if (spinBox.checked) s.pivot.rotation.y += dt * 0.5;
      s.item.animate?.(t);
    }
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    requestAnimationFrame(frame);
  };
  frame();
}
