import * as THREE from 'three';
import type { ObstacleKind, PursuerKind } from '../config/types';

/**
 * Fábrica de modelos low-poly construidos con primitivas. Todas las geometrías y
 * materiales se comparten para minimizar memoria; los vehículos miran hacia -Z.
 */
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const SPHERE = new THREE.IcosahedronGeometry(0.5, 1);
const CONE = new THREE.ConeGeometry(0.5, 1, 8);
const DODECA = new THREE.DodecahedronGeometry(0.5, 0);
const SHARED_GEOS = new Set<THREE.BufferGeometry>([BOX, CYL, SPHERE, CONE, DODECA]);

/** Marca una geometría como compartida para que disposeUnique no la libere. */
export function shareGeometry<T extends THREE.BufferGeometry>(g: T): T {
  SHARED_GEOS.add(g);
  return g;
}

const materials = new Map<string, THREE.MeshLambertMaterial>();

export function mat(color: THREE.ColorRepresentation, emissive?: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${emissive ?? ''}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    if (emissive !== undefined) m.emissive = new THREE.Color(emissive);
    materials.set(key, m);
  }
  return m;
}

/** Caja con base en y=0. */
export function box(w: number, h: number, d: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(BOX, mat(color));
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(r: number, h: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat(color));
  m.scale.set(r * 2, h, r * 2);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  return m;
}

function ball(r: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(SPHERE, mat(color));
  m.scale.setScalar(r * 2);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// ---------------------------------------------------------------- vehículos

export function motorbike(color: number, accent: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.28, 0.5, 0.55, 0x111111, 0, 0, -0.85)); // rueda delantera
  g.add(box(0.32, 0.5, 0.6, 0x111111, 0, 0, 0.8)); // rueda trasera
  g.add(box(0.5, 0.45, 1.5, color, 0, 0.35, 0)); // chasis
  g.add(box(0.42, 0.2, 0.5, accent, 0, 0.8, -0.35)); // tanque
  g.add(box(0.9, 0.08, 0.1, 0x333333, 0, 1.0, -0.65)); // manubrio
  g.add(box(0.55, 0.55, 0.45, 0x2b2b2b, 0, 0.9, 0.15)); // torso piloto
  g.add(ball(0.24, accent, 0, 1.6, 0.0)); // casco
  g.add(box(0.5, 0.35, 0.4, 0x2f7d32, 0, 1.15, 0.5)); // mochila con el botín
  const light = new THREE.Mesh(BOX, mat(0xfff4c0, 0xfff4c0));
  light.scale.set(0.25, 0.12, 0.08);
  light.position.set(0, 0.75, -1.0);
  g.add(light);
  return g;
}

export function civilianCar(color: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.9, 0.75, 4.0, color, 0, 0.25, 0));
  g.add(box(1.6, 0.55, 1.9, 0x1d2a35, 0, 1.0, 0.25)); // cabina (vidrios)
  g.add(box(1.5, 0.08, 1.6, color, 0, 1.55, 0.25)); // techo
  g.add(box(0.4, 0.15, 0.06, 0xfff4c0, -0.6, 0.6, -2.02));
  g.add(box(0.4, 0.15, 0.06, 0xfff4c0, 0.6, 0.6, -2.02));
  g.add(box(0.4, 0.15, 0.06, 0xaa1111, -0.6, 0.6, 2.02));
  g.add(box(0.4, 0.15, 0.06, 0xaa1111, 0.6, 0.6, 2.02));
  return g;
}

/** Modelo de un perseguidor; las luces de sirena solo existen en la policía. */
export interface PursuerMesh {
  group: THREE.Group;
  red: THREE.Mesh | null;
  blue: THREE.Mesh | null;
  /** Cuerpo animable (mutantes que corren). */
  body?: THREE.Object3D;
  /** Esqueleto articulado del mutante a pie. */
  rig?: MutantRig;
}

const RED_ON = mat(0xff2a2a, 0xff0000);
const RED_OFF = mat(0x551111);
const BLUE_ON = mat(0x2a6bff, 0x0044ff);
const BLUE_OFF = mat(0x112255);

export function setSiren(p: PursuerMesh, phase: boolean): void {
  if (p.red) p.red.material = phase ? RED_ON : RED_OFF;
  if (p.blue) p.blue.material = phase ? BLUE_OFF : BLUE_ON;
}

export function pursuerMesh(kind: PursuerKind): PursuerMesh {
  switch (kind) {
    case 'patrol':
    case 'moto':
    case 'suv':
    case 'swat':
      return policeVehicle(kind);
    case 'mutant': {
      const rig = mutantRig();
      const group = new THREE.Group();
      group.add(rig.root);
      return { group, red: null, blue: null, body: rig.root, rig };
    }
    case 'flyer':
      // Las harpías no usan este modelo: tienen su propia entidad voladora (ver harpy()).
      return { group: new THREE.Group(), red: null, blue: null };
    default:
      return { group: outlawVehicle(kind), red: null, blue: null };
  }
}

export function policeVehicle(kind: 'patrol' | 'moto' | 'suv' | 'swat'): PursuerMesh {
  const g = new THREE.Group();
  let red: THREE.Mesh;
  let blue: THREE.Mesh;
  if (kind === 'moto') {
    g.add(box(0.28, 0.5, 0.55, 0x111111, 0, 0, -0.85));
    g.add(box(0.32, 0.5, 0.6, 0x111111, 0, 0, 0.8));
    g.add(box(0.55, 0.45, 1.55, 0xf2f2f2, 0, 0.35, 0));
    g.add(box(0.55, 0.55, 0.45, 0x1b2a4a, 0, 0.9, 0.15));
    g.add(ball(0.24, 0xffffff, 0, 1.6, 0));
    red = box(0.2, 0.15, 0.15, 0xff0000, -0.18, 0.85, 0.75);
    blue = box(0.2, 0.15, 0.15, 0x0000ff, 0.18, 0.85, 0.75);
  } else {
    const dims = { patrol: [2.0, 4.2, 0xf4f4f4, 0x111111], suv: [2.3, 4.8, 0x1a1a1a, 0xf4f4f4], swat: [2.6, 5.6, 0x1c2b45, 0x0f1a2e] }[kind];
    const [w, l, body, trim] = dims as [number, number, number, number];
    const h = kind === 'swat' ? 1.6 : kind === 'suv' ? 1.1 : 0.75;
    g.add(box(w, h, l, body, 0, 0.25, 0));
    g.add(box(w * 1.01, h * 0.5, l * 0.24, trim, 0, 0.25, -l * 0.38)); // capó
    g.add(box(w * 1.01, h * 0.5, l * 0.2, trim, 0, 0.25, l * 0.4)); // maletero
    if (kind !== 'swat') g.add(box(w * 0.84, 0.55, l * 0.45, 0x1d2a35, 0, 0.25 + h, 0.2));
    const roofY = kind === 'swat' ? 0.25 + h : 0.8 + h;
    g.add(box(w * 0.8, 0.08, l * (kind === 'swat' ? 0.9 : 0.4), body, 0, roofY, kind === 'swat' ? 0 : 0.2));
    if (kind === 'swat') g.add(box(w * 0.6, 0.06, 1.4, 0xffffff, 0, roofY + 0.08, 0.8)); // franja "SWAT"
    red = box(w * 0.35, 0.18, 0.35, 0xff0000, -w * 0.2, roofY + 0.06, kind === 'swat' ? -l * 0.35 : 0);
    blue = box(w * 0.35, 0.18, 0.35, 0x0000ff, w * 0.2, roofY + 0.06, kind === 'swat' ? -l * 0.35 : 0);
    g.add(box(0.4, 0.15, 0.06, 0xfff4c0, -w * 0.3, 0.6, -l / 2 - 0.02));
    g.add(box(0.4, 0.15, 0.06, 0xfff4c0, w * 0.3, 0.6, -l / 2 - 0.02));
  }
  g.add(red, blue);
  return { group: g, red, blue };
}

export interface HeliMesh {
  group: THREE.Group;
  rotor: THREE.Group;
  shadow: THREE.Mesh;
  spot: THREE.Mesh;
}

export function helicopter(): HeliMesh {
  const g = new THREE.Group();
  g.add(box(2.2, 1.8, 4.5, 0x1c2b45, 0, 0, 0));
  g.add(box(1.8, 0.9, 1.4, 0x88aacc, 0, 0.6, -2.0));
  g.add(box(0.5, 0.5, 4.0, 0x1c2b45, 0, 0.8, 3.8));
  g.add(box(0.1, 1.2, 0.8, 0xffffff, 0.3, 0.6, 5.6));
  g.add(box(3.0, 0.15, 0.2, 0x111111, 0, -0.2, -0.5));
  const rotor = new THREE.Group();
  rotor.add(box(11, 0.08, 0.45, 0x111111, 0, 0, 0));
  rotor.add(box(0.45, 0.08, 11, 0x111111, 0, 0, 0));
  rotor.position.y = 2.0;
  g.add(rotor);
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(3.2, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  const spot = new THREE.Mesh(
    new THREE.CircleGeometry(4.5, 28),
    new THREE.MeshBasicMaterial({ color: 0xfff6c0, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  spot.rotation.x = -Math.PI / 2;
  return { group: g, rotor, shadow, spot };
}

// ---------------------------------------------------------------- obstáculos

/** Semiextensiones físicas (hx, hz) de cada obstáculo y si es dinámico. */
export const OBSTACLE_SPECS: Record<ObstacleKind, { hx: number; hz: number; dynamic: boolean; density: number }> = {
  rock: { hx: 1.3, hz: 1.1, dynamic: false, density: 1 },
  cactus: { hx: 0.45, hz: 0.45, dynamic: false, density: 1 },
  tumbleweed: { hx: 0.6, hz: 0.6, dynamic: true, density: 0.05 },
  barrel: { hx: 0.5, hz: 0.5, dynamic: true, density: 0.6 },
  cone: { hx: 0.3, hz: 0.3, dynamic: true, density: 0.15 },
  barrier: { hx: 2.0, hz: 0.4, dynamic: false, density: 1 },
  wreck: { hx: 1.0, hz: 2.1, dynamic: false, density: 1 },
  crate: { hx: 0.6, hz: 0.6, dynamic: true, density: 0.3 },
  dumpster: { hx: 1.1, hz: 0.75, dynamic: true, density: 6 },
  parkedCar: { hx: 0.95, hz: 2.0, dynamic: true, density: 4 },
  container: { hx: 1.25, hz: 3.0, dynamic: false, density: 1 },
  toxicBarrel: { hx: 0.5, hz: 0.5, dynamic: true, density: 0.6 },
  fuelBarrel: { hx: 0.5, hz: 0.5, dynamic: true, density: 0.7 },
  zombie: { hx: 0.4, hz: 0.4, dynamic: true, density: 0.5 },
};

export function obstacleMesh(kind: ObstacleKind, variant: number): THREE.Object3D {
  const g = new THREE.Group();
  switch (kind) {
    case 'rock': {
      const r = new THREE.Mesh(DODECA, mat(variant > 0.5 ? 0x8a6a4f : 0x9c7a5b));
      r.scale.set(2.8, 1.6 + variant, 2.4);
      r.rotation.y = variant * 6;
      r.position.y = 0.5;
      r.castShadow = true;
      g.add(r);
      break;
    }
    case 'cactus':
      g.add(cyl(0.35, 3.2, 0x3f7d3a));
      g.add(cyl(0.2, 1.2, 0x3f7d3a, 0.55, 1.2, 0));
      g.add(cyl(0.2, 1.0, 0x3f7d3a, -0.5, 1.6, 0));
      break;
    case 'tumbleweed': {
      const t = new THREE.Mesh(DODECA, mat(0xa58a55));
      t.scale.setScalar(1.2);
      t.position.y = 0.6;
      t.castShadow = true;
      g.add(t);
      break;
    }
    case 'barrel':
      g.add(cyl(0.48, 1.2, variant > 0.5 ? 0xc0392b : 0x2d6fb7));
      g.add(cyl(0.5, 0.08, 0x333333, 0, 0.6, 0));
      break;
    case 'cone':
      {
        const c = new THREE.Mesh(CONE, mat(0xff7a1a));
        c.scale.set(0.6, 0.9, 0.6);
        c.position.y = 0.45;
        c.castShadow = true;
        g.add(c);
        g.add(box(0.7, 0.08, 0.7, 0xff7a1a));
      }
      break;
    case 'barrier':
      g.add(box(4, 0.9, 0.8, 0xd8d8d8));
      for (let i = -1; i <= 1; i++) g.add(box(0.6, 0.92, 0.82, 0xd03b2a, i * 1.3, 0, 0));
      break;
    case 'wreck':
      g.add(box(1.9, 0.7, 4.0, 0x3a2f2a));
      g.add(box(1.5, 0.5, 1.8, 0x1a1512, 0, 0.7, 0.3));
      break;
    case 'crate':
      g.add(box(1.2, 1.0, 1.2, 0xb98a4b));
      g.add(box(1.22, 0.12, 1.22, 0x7a5a30, 0, 0.45, 0));
      break;
    case 'dumpster':
      g.add(box(2.2, 1.4, 1.5, 0x2f6e3e));
      g.add(box(2.25, 0.1, 1.55, 0x1f4a2a, 0, 1.4, 0));
      break;
    case 'parkedCar':
      return civilianCar(PARKED_COLORS[Math.floor(variant * PARKED_COLORS.length)]);
    case 'container':
      return container(CONTAINER_COLORS[Math.floor(variant * CONTAINER_COLORS.length)]);
    case 'toxicBarrel':
      g.add(cyl(0.48, 1.2, 0x9acd32));
      g.add(cyl(0.42, 0.06, 0x39ff14, 0, 1.2, 0));
      (g.children[1] as THREE.Mesh).material = mat(0x39ff14, 0x1f9e0a);
      g.add(box(0.98, 0.18, 0.98, 0x222222, 0, 0.5, 0));
      break;
    case 'fuelBarrel':
      // Barril de combustible: rojo intenso, franja amarilla y tapa con advertencia.
      g.add(cyl(0.5, 1.25, 0xd41f1f));
      g.add(cyl(0.52, 0.22, 0xf1c40f, 0, 0.5, 0));
      g.add(cyl(0.44, 0.05, 0x333333, 0, 1.25, 0));
      g.add(box(0.36, 0.04, 0.12, 0xf1c40f, 0, 1.28, 0));
      g.add(box(0.12, 0.04, 0.36, 0xf1c40f, 0, 1.28, 0));
      break;
    case 'zombie':
      // El primer hijo es el cuerpo animable (tambalear, caer).
      g.add(humanoid(variant > 0.5 ? 0x7d9a6a : 0x8a9a7a, variant > 0.5 ? 0x4a3f35 : 0x3b4a5a, true, 1));
      break;
  }
  return g;
}

const CONTAINER_COLORS = [0xb03a2e, 0x2e86c1, 0x1e8449, 0xd68910, 0x6c3483, 0x7f8c8d];

export function container(color: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.5, 2.6, 6, color));
  const dark = new THREE.Color(color).multiplyScalar(0.7).getHex();
  for (let z = -2.5; z <= 2.5; z += 0.85) g.add(box(2.56, 2.5, 0.12, dark, 0, 0.05, z));
  return g;
}

/** Figura humanoide (mira hacia -Z). Con brazos al frente es un zombi. */
export function humanoid(skin: number, cloth: number, armsForward: boolean, scale: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.22, 0.8, 0.25, cloth, -0.16, 0, 0));
  g.add(box(0.22, 0.8, 0.25, cloth, 0.16, 0, 0));
  g.add(box(0.62, 0.75, 0.36, cloth, 0, 0.8, 0));
  g.add(ball(0.24, skin, 0, 1.8, 0));
  for (const s of [-1, 1]) {
    const arm = box(0.18, 0.7, 0.2, skin, 0, 0, 0);
    if (armsForward) {
      arm.rotation.x = -Math.PI / 2;
      arm.position.set(s * 0.38, 1.4, -0.35);
    } else {
      arm.scale.set(0.26, 0.8, 0.26);
      arm.position.set(s * 0.45, 0.95, 0);
    }
    g.add(arm);
  }
  g.scale.setScalar(scale);
  return g;
}

// ---------------------------------------------------------------- criaturas

/** Esqueleto del mutante a pie: cada articulación es un grupo que puede rotar. */
export interface MutantRig {
  root: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  jaw: THREE.Group;
  arms: { upper: THREE.Group; lower: THREE.Group }[];
  legs: { thigh: THREE.Group; shin: THREE.Group }[];
}

/** Segmento de una extremidad: un pivote con la pieza colgando hacia abajo. */
function limb(w: number, len: number, d: number, color: number, x: number, y: number, z: number): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const m = box(w, len, d, color, 0, -len, 0);
  pivot.add(m);
  return pivot;
}

function claws(parent: THREE.Object3D, y: number, size: number): void {
  for (const x of [-0.08, 0, 0.08]) {
    const c = new THREE.Mesh(CONE, mat(0xe8e2c8));
    c.scale.set(0.07 * size, 0.28 * size, 0.07 * size);
    c.rotation.x = Math.PI;
    c.position.set(x * size, y, -0.04);
    parent.add(c);
  }
}

/**
 * Mutante a pie: encorvado, con un brazo derecho descomunal, púas en la
 * espalda, venas moradas y ojos rojos. Mira hacia -Z.
 */
export function mutantRig(): MutantRig {
  const skin = 0x9cb87a;
  const dark = 0x5e7444;
  const vein = 0x7d3f8f;
  const rags = 0x3b2a1e;
  const root = new THREE.Group();

  const pelvis = box(0.7, 0.35, 0.45, rags, 0, 1.05, 0);
  root.add(pelvis);

  const legs = [-1, 1].map((s) => {
    const thigh = limb(0.3, 0.6, 0.34, dark, s * 0.24, 1.15, 0);
    const shin = limb(0.24, 0.55, 0.28, skin, 0, -0.6, 0);
    thigh.add(shin);
    const foot = box(0.3, 0.14, 0.55, dark, 0, -0.62, -0.12);
    shin.add(foot);
    claws(foot, 0.05, 1);
    foot.children.forEach((c) => (c.rotation.x = -Math.PI / 2));
    root.add(thigh);
    return { thigh, shin };
  });

  const torso = new THREE.Group();
  torso.position.set(0, 1.25, 0);
  torso.rotation.x = -0.45;
  root.add(torso);
  torso.add(box(0.95, 0.75, 0.6, skin, 0, 0.25, 0));
  torso.add(box(0.75, 0.4, 0.5, dark, 0, -0.05, 0));
  torso.add(box(0.12, 0.6, 0.05, vein, -0.25, 0.35, -0.31));
  torso.add(box(0.08, 0.45, 0.05, vein, 0.2, 0.3, -0.31));
  // Púas en la espalda
  for (let i = 0; i < 4; i++) {
    const spike = new THREE.Mesh(CONE, mat(0xd8d0b0));
    spike.scale.set(0.16, 0.42 - i * 0.05, 0.16);
    spike.rotation.x = 0.9;
    spike.position.set(0, 0.85 - i * 0.22, 0.32);
    spike.castShadow = true;
    torso.add(spike);
  }

  const head = new THREE.Group();
  head.position.set(0, 1.05, -0.12);
  torso.add(head);
  head.add(box(0.48, 0.42, 0.5, skin, 0, 0, 0));
  head.add(box(0.5, 0.12, 0.2, dark, 0, 0.36, -0.12));
  for (const x of [-0.12, 0.12]) {
    const eye = box(0.1, 0.07, 0.04, 0xff3b1f, x, 0.2, -0.26);
    eye.material = mat(0xff3b1f, 0xff2000);
    head.add(eye);
  }
  const jaw = new THREE.Group();
  jaw.position.set(0, 0.05, 0.12);
  head.add(jaw);
  jaw.add(box(0.42, 0.12, 0.42, dark, 0, -0.12, -0.2));
  for (const x of [-0.12, 0, 0.12]) {
    const tooth = new THREE.Mesh(CONE, mat(0xf2ecd2));
    tooth.scale.set(0.05, 0.12, 0.05);
    tooth.position.set(x, 0.04, -0.38);
    jaw.add(tooth);
  }

  // Brazo izquierdo normal y brazo derecho descomunal
  const arms = [
    { s: -1, k: 1 },
    { s: 1, k: 1.6 },
  ].map(({ s, k }) => {
    const upper = limb(0.28 * k, 0.55 * k, 0.28 * k, skin, s * (0.55 + 0.1 * k), 0.75, 0);
    const lower = limb(0.25 * k, 0.55 * k, 0.25 * k, dark, 0, -0.55 * k, 0);
    upper.add(lower);
    const hand = box(0.3 * k, 0.18 * k, 0.3 * k, skin, 0, -0.62 * k, 0);
    lower.add(hand);
    claws(hand, -0.05 * k, k);
    torso.add(upper);
    return { upper, lower };
  });

  root.scale.setScalar(1.3);
  return { root, torso, head, jaw, arms, legs };
}

/**
 * Animación de carrera del mutante. `phase` avanza con la velocidad y `run`
 * (0..1) mezcla entre postura quieta y zancada completa.
 */
export function animateMutant(rig: MutantRig, phase: number, run: number): void {
  const a = Math.sin(phase);
  rig.legs.forEach((leg, i) => {
    const s = i === 0 ? 1 : -1;
    leg.thigh.rotation.x = s * a * 0.95 * run;
    // La rodilla se dobla sobre todo cuando la pierna vuelve hacia adelante.
    leg.shin.rotation.x = -(0.15 + 1.15 * Math.max(0, Math.cos(phase + (i === 0 ? 0 : Math.PI)))) * run;
  });
  rig.arms.forEach((arm, i) => {
    const s = i === 0 ? -1 : 1;
    arm.upper.rotation.x = s * a * 0.85 * run - 0.25;
    arm.upper.rotation.z = (i === 0 ? -1 : 1) * 0.18;
    arm.lower.rotation.x = 0.7 + 0.45 * Math.max(0, s * a) * run;
  });
  rig.root.position.y = Math.abs(Math.sin(phase)) * 0.18 * run;
  rig.torso.rotation.x = -0.45 - 0.15 * run + Math.sin(phase * 2) * 0.05 * run;
  rig.torso.rotation.z = a * 0.1 * run;
  rig.torso.rotation.y = a * 0.12 * run;
  rig.head.rotation.x = 0.25 * run + Math.sin(phase * 2 + 1) * 0.08;
  rig.jaw.rotation.x = -(0.12 + 0.3 * Math.abs(Math.sin(phase * 0.75)));
}

/** Pose de mutante derribado: de bruces y con las extremidades abiertas. */
export function knockOutMutant(rig: MutantRig): void {
  rig.root.rotation.x = -1.45;
  rig.root.position.y = 0.45;
  rig.arms.forEach((arm, i) => {
    arm.upper.rotation.set(-1.2, 0, (i === 0 ? -1 : 1) * 1.1);
    arm.lower.rotation.x = 0.3;
  });
  rig.legs.forEach((leg, i) => {
    leg.thigh.rotation.set(0.2, 0, (i === 0 ? -1 : 1) * 0.35);
    leg.shin.rotation.x = -0.4;
  });
  rig.jaw.rotation.x = -0.5;
}

export interface HarpyMesh {
  group: THREE.Group;
  body: THREE.Group;
  wings: { inner: THREE.Group; outer: THREE.Group }[];
  tail: THREE.Group;
  jaw: THREE.Group;
  shadow: THREE.Mesh;
}

/** Harpía mutante: criatura voladora de alas membranosas que escupe ácido. */
export function harpy(): HarpyMesh {
  const hide = 0x6b4a6e;
  const belly = 0xa08a7a;
  const membrane = 0x8a3f5a;
  const bone = 0x2e2228;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  body.add(box(0.9, 0.7, 2.2, hide, 0, -0.35, 0));
  body.add(box(0.7, 0.3, 1.6, belly, 0, -0.5, 0.1));
  // Cuello, cabeza con pico y ojos verdes
  body.add(box(0.45, 0.45, 0.9, hide, 0, -0.2, -1.4));
  const head = new THREE.Group();
  head.position.set(0, 0, -2.0);
  body.add(head);
  head.add(box(0.6, 0.5, 0.7, hide, 0, -0.25, 0));
  const beak = new THREE.Mesh(CONE, mat(0xd8c08a));
  beak.scale.set(0.35, 0.9, 0.3);
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 0.05, -0.75);
  head.add(beak);
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.1, -0.3);
  head.add(jaw);
  const lower = new THREE.Mesh(CONE, mat(0xb8a070));
  lower.scale.set(0.28, 0.6, 0.2);
  lower.rotation.x = -Math.PI / 2;
  lower.position.set(0, -0.08, -0.35);
  jaw.add(lower);
  for (const x of [-0.2, 0.2]) {
    const eye = box(0.1, 0.1, 0.06, 0x39ff14, x, 0.1, -0.34);
    eye.material = mat(0x39ff14, 0x2fd10f);
    head.add(eye);
  }
  // Cresta ósea
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(CONE, mat(bone));
    c.scale.set(0.12, 0.5 - i * 0.1, 0.12);
    c.rotation.x = 1.2;
    c.position.set(0, 0.25, 0.1 + i * 0.25);
    head.add(c);
  }
  // Alas: pivote en el hombro y segunda articulación en el "codo"
  const wings = [-1, 1].map((s) => {
    const inner = new THREE.Group();
    inner.position.set(s * 0.45, 0, -0.3);
    body.add(inner);
    inner.add(box(2.4, 0.06, 1.5, membrane, s * 1.2, 0, 0.2));
    inner.add(box(2.4, 0.12, 0.12, bone, s * 1.2, 0.03, -0.5));
    const outer = new THREE.Group();
    outer.position.set(s * 2.4, 0, 0);
    inner.add(outer);
    outer.add(box(2.3, 0.05, 1.2, membrane, s * 1.15, 0, 0.35));
    outer.add(box(2.4, 0.1, 0.1, bone, s * 1.2, 0.03, -0.2));
    const talon = new THREE.Mesh(CONE, mat(0xe8e2c8));
    talon.scale.set(0.12, 0.4, 0.12);
    talon.rotation.z = s * -Math.PI / 2;
    talon.position.set(s * 2.5, 0, -0.2);
    outer.add(talon);
    return { inner, outer };
  });
  // Cola larga terminada en púa
  const tail = new THREE.Group();
  tail.position.set(0, -0.3, 1.1);
  body.add(tail);
  tail.add(box(0.2, 0.15, 1.8, hide, 0, 0, 0.9));
  const spade = new THREE.Mesh(CONE, mat(bone));
  spade.scale.set(0.4, 0.6, 0.15);
  spade.rotation.x = Math.PI / 2;
  spade.position.set(0, 0, 2.0);
  tail.add(spade);
  // Garras colgantes
  for (const x of [-0.25, 0.25]) body.add(box(0.12, 0.5, 0.12, bone, x, -1.0, 0.3));

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.6, 0.6, 1);
  return { group, body, wings, tail, jaw, shadow };
}

/** Vehículos de la banda rival y de la tierra baldía. */
export function outlawVehicle(kind: Exclude<PursuerKind, 'patrol' | 'moto' | 'suv' | 'swat' | 'mutant' | 'flyer'>): THREE.Group {
  if (kind === 'pyro') return pyroVehicle();
  const g = new THREE.Group();
  const headlights = (w: number, l: number, y = 0.6) => {
    g.add(box(0.4, 0.15, 0.06, 0xfff4c0, -w * 0.3, y, -l / 2 - 0.02));
    g.add(box(0.4, 0.15, 0.06, 0xfff4c0, w * 0.3, y, -l / 2 - 0.02));
  };
  const spikes = (w: number, z: number, y: number) => {
    for (let x = -w / 2 + 0.3; x <= w / 2 - 0.3; x += 0.5) {
      const c = new THREE.Mesh(CONE, mat(0xb0b0b0));
      c.scale.set(0.25, 0.7, 0.25);
      c.rotation.x = -Math.PI / 2;
      c.position.set(x, y, z);
      g.add(c);
    }
  };
  switch (kind) {
    case 'muscle':
      g.add(box(2.0, 0.7, 4.4, 0x8e1b1b, 0, 0.25, 0));
      g.add(box(1.6, 0.5, 1.7, 0x111111, 0, 0.95, 0.4));
      g.add(box(0.25, 0.02, 4.42, 0xffffff, -0.25, 0.96, 0));
      g.add(box(0.25, 0.02, 4.42, 0xffffff, 0.25, 0.96, 0));
      g.add(box(0.9, 0.25, 0.9, 0x333333, 0, 0.95, -1.2)); // toma de aire
      headlights(2, 4.4);
      break;
    case 'biker':
      g.add(box(0.28, 0.5, 0.55, 0x111111, 0, 0, -0.85));
      g.add(box(0.32, 0.5, 0.6, 0x111111, 0, 0, 0.8));
      g.add(box(0.55, 0.45, 1.6, 0x1a1a1a, 0, 0.35, 0));
      g.add(box(1.0, 0.08, 0.1, 0x999999, 0, 1.0, -0.7));
      g.add(box(0.6, 0.55, 0.45, 0x2b1d14, 0, 0.9, 0.15));
      g.add(ball(0.24, 0xb03a2e, 0, 1.6, 0));
      break;
    case 'pickup':
      g.add(box(2.1, 0.8, 4.8, 0x4a5a3a, 0, 0.25, 0));
      g.add(box(1.9, 0.7, 1.6, 0x1d2a35, 0, 1.05, -0.8));
      g.add(box(1.9, 0.75, 0.1, 0x3a4a2a, 0, 1.05, 0.2)); // pared de la caja
      for (const s of [-1, 1]) g.add(box(0.1, 0.5, 2.0, 0x3a4a2a, s * 0.95, 1.05, 1.3));
      {
        const gunner = humanoid(0xd2a07a, 0x222222, false, 0.8);
        gunner.position.set(0, 1.05, 1.4);
        g.add(gunner);
      }
      headlights(2.1, 4.8);
      break;
    case 'truck': {
      // Tráiler de la banda: cabina roja con defensa de tubos y caja larga grafiteada.
      g.add(box(2.7, 1.9, 2.4, 0x7a1f1f, 0, 0.35, -3.3));
      g.add(box(2.4, 0.7, 0.1, 0x1d2a35, 0, 1.6, -4.52));
      g.add(box(2.8, 0.25, 0.4, 0x9a9a9a, 0, 0.3, -4.7));
      for (const x of [-0.9, -0.3, 0.3, 0.9]) g.add(box(0.12, 1.0, 0.12, 0x9a9a9a, x, 0.2, -4.7));
      g.add(cyl(0.16, 2.2, 0x555555, -1.2, 1.6, -2.3));
      g.add(cyl(0.16, 2.2, 0x555555, 1.2, 1.6, -2.3));
      g.add(box(2.8, 2.6, 6.2, 0xd9d4c7, 0, 0.45, 1.3));
      g.add(box(2.82, 0.6, 3.2, 0xe67e22, 0, 1.5, 1.6));
      g.add(box(2.82, 0.4, 2.0, 0x8e44ad, 0, 0.9, 0.2));
      const gunner = humanoid(0xd2a07a, 0x222222, false, 0.8);
      gunner.position.set(0, 3.05, 3.4);
      g.add(gunner);
      headlights(2.7, 9.4, 0.7);
      break;
    }
    case 'van':
      g.add(box(2.6, 1.8, 5.8, 0x2b2b2b, 0, 0.25, 0));
      g.add(box(2.2, 0.6, 0.1, 0x1d2a35, 0, 1.2, -2.92));
      for (const s of [-1, 1]) g.add(box(0.12, 1.0, 4.2, 0x6b6b6b, s * 1.33, 0.5, 0.3));
      g.add(box(0.5, 0.3, 0.5, 0xfff4c0, 0, 2.1, -2.2));
      headlights(2.6, 5.8);
      break;
    case 'buggy':
      g.add(box(1.7, 0.4, 3.4, 0x8a5a2a, 0, 0.35, 0));
      for (const [x, z] of [[-1, -1.2], [1, -1.2], [-1, 1.2], [1, 1.2]]) g.add(box(0.45, 0.8, 0.8, 0x1a1a1a, x, 0, z));
      for (const s of [-1, 1]) {
        g.add(box(0.1, 1.2, 0.1, 0x5a3a1a, s * 0.7, 0.75, -0.3));
        g.add(box(0.1, 1.2, 0.1, 0x5a3a1a, s * 0.7, 0.75, 0.9));
        g.add(box(0.1, 0.1, 1.3, 0x5a3a1a, s * 0.7, 1.9, 0.3));
      }
      g.add(box(1.5, 0.1, 0.1, 0x5a3a1a, 0, 1.9, -0.3));
      g.add(ball(0.24, 0x5fbf3a, 0, 1.2, 0.4));
      spikes(1.7, -1.8, 0.6);
      break;
    case 'raider':
      g.add(box(0.28, 0.5, 0.55, 0x111111, 0, 0, -0.85));
      g.add(box(0.32, 0.5, 0.6, 0x111111, 0, 0, 0.8));
      g.add(box(0.6, 0.45, 1.6, 0x6e4a2a, 0, 0.35, 0));
      g.add(box(0.6, 0.55, 0.45, 0x3a2a1a, 0, 0.9, 0.15));
      g.add(ball(0.26, 0x5fbf3a, 0, 1.6, 0));
      g.add(box(0.1, 0.25, 0.5, 0xd62828, 0, 1.85, 0)); // cresta
      spikes(0.6, -1.15, 0.5);
      break;
    case 'rig':
      g.add(box(2.8, 1.6, 2.2, 0x5a4632, 0, 0.3, -2.3));
      g.add(box(2.4, 0.6, 1.0, 0x1d2a35, 0, 1.5, -2.6));
      g.add(box(2.9, 2.0, 4.4, 0x4a3a2a, 0, 0.3, 1.0));
      for (let z = -0.8; z <= 2.8; z += 1.2) g.add(box(3.0, 0.15, 0.3, 0x2a2a2a, 0, 1.6, z));
      {
        const plow = box(3.4, 1.2, 0.5, 0x8a8a8a, 0, 0.1, -3.6);
        plow.rotation.x = -0.35;
        g.add(plow);
      }
      g.add(cyl(0.15, 1.6, 0x333333, -1.2, 1.9, -1.5));
      g.add(cyl(0.15, 1.6, 0x333333, 1.2, 1.9, -1.5));
      spikes(3.2, -3.9, 0.6);
      break;
  }
  return g;
}

const PARKED_COLORS = [0x7f8c8d, 0x34495e, 0x8e44ad, 0xc0392b, 0xd4ac0d, 0x16a085, 0xecf0f1];
export const CIVILIAN_COLORS = [0x2e86c1, 0xcb4335, 0xf4d03f, 0x27ae60, 0xe67e22, 0x7d3c98, 0xbdc3c7, 0x17202a];

// ---------------------------------------------------------------- recompensas

export function pickupMesh(kind: 'repair' | 'nitro' | 'ammo'): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  if (kind === 'repair') {
    inner.add(box(1.2, 1.2, 1.2, 0x2ecc71));
    inner.add(box(0.9, 0.25, 0.3, 0xffffff, 0, 0.5, -0.62));
    inner.add(box(0.3, 0.25, 0.9, 0xffffff, 0, 1.22, 0));
    inner.add(box(0.9, 0.04, 0.3, 0xffffff, 0, 1.2, 0));
  } else if (kind === 'ammo') {
    // Caja de munición amarilla con balas encima.
    inner.add(box(1.3, 0.9, 1.0, 0xf4d03f));
    inner.add(box(1.32, 0.18, 1.02, 0x3a3a3a, 0, 0.35, 0));
    for (const x of [-0.35, 0, 0.35]) {
      inner.add(cyl(0.12, 0.5, 0xc8a24a, x, 0.9, 0));
      inner.add(cyl(0.12, 0.12, 0x8a6a2a, x, 1.4, 0));
    }
  } else {
    inner.add(cyl(0.45, 1.3, 0x2a6bff));
    inner.add(cyl(0.2, 0.3, 0xdddddd, 0, 1.3, 0));
    inner.add(box(0.92, 0.3, 0.92, 0x9fd8ff, 0, 0.5, 0));
  }
  inner.position.y = 0.4;
  g.add(inner);
  const ring = new THREE.Mesh(
    shareGeometry(new THREE.RingGeometry(1.3, 1.6, 24).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: { repair: 0x2ecc71, nitro: 0x4d9dff, ammo: 0xf4d03f }[kind], transparent: true, opacity: 0.6 }),
  );
  ring.position.y = 0.05;
  g.add(ring);
  return g;
}

// ---------------------------------------------------------------- escenario

const BUILDING_COLORS = [0xb0a18f, 0x8d99ae, 0xa3785f, 0x6d7b8d, 0xc9b79c, 0x7a6c5d, 0x9aa5a8, 0xb5838d, 0x5d6d7e];

export function building(w: number, h: number, d: number, variant: number): THREE.Group {
  const g = new THREE.Group();
  const color = BUILDING_COLORS[Math.floor(variant * BUILDING_COLORS.length)];
  const b = box(w, h, d, color);
  g.add(b);
  const roof = new THREE.Color(color).multiplyScalar(0.7).getHex();
  g.add(box(w - 0.6, 0.3, d - 0.6, roof, 0, h, 0));
  // Equipos en la azotea: dan textura vista desde arriba.
  const n = 1 + Math.floor(variant * 7) % 3;
  for (let i = 0; i < n; i++) {
    const fx = ((variant * 13.7 + i * 0.37) % 1) - 0.5;
    const fz = ((variant * 7.3 + i * 0.61) % 1) - 0.5;
    g.add(box(1.2, 0.8, 1.2, 0x9b9b9b, fx * (w - 2.5), h + 0.3, fz * (d - 2.5)));
  }
  if (variant > 0.7) g.add(cyl(0.9, 1.4, 0x6b4f3a, -w * 0.25, h + 0.3, d * 0.2)); // tanque de agua
  return g;
}

export function cliff(w: number, h: number, d: number, variant: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(w, h, d, variant > 0.5 ? 0xa0643c : 0x93593a));
  g.add(box(w * 0.7, h * 0.3, d * 0.8, 0xb87a4e, (variant - 0.5) * w * 0.3, h, 0));
  return g;
}

export function tree(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.15, 1.5, 0x6b4f3a));
  g.add(ball(1.1, 0x3e8e41, 0, 2.2, 0));
  return g;
}

export function palm(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.18, 4, 0x8b6b45));
  for (let i = 0; i < 5; i++) {
    const leaf = box(0.5, 0.1, 2.2, 0x4f9a3a, 0, 4, 0);
    leaf.rotation.y = (i / 5) * Math.PI * 2;
    leaf.rotation.x = 0.25;
    g.add(leaf);
  }
  return g;
}

export function bankBuilding(width: number, depth: number, damaged: boolean, flipSign = false): THREE.Group {
  const g = new THREE.Group();
  g.add(box(width, 12, depth, 0xd9cfb8));
  g.add(box(width - 2, 0.6, depth - 2, 0xbfb49b, 0, 12, 0));
  // Domo dorado sobre la bóveda
  const dome = ball(4.5, 0xd4ac0d, 0, 12.5, 0);
  dome.scale.y = 3;
  g.add(dome);
  // Columnas y escalinata en la fachada (frente hacia -Z)
  // Columnas a ambos lados de la puerta (el centro queda libre para pasar en moto).
  for (let i = -3; i <= 3; i++) if (i !== 0) g.add(cyl(0.6, 10, 0xf2ead8, i * 3.2, 0, -depth / 2 - 1.2));
  g.add(box(24, 0.6, 1.5, 0xf2ead8, 0, 10, -depth / 2 - 1.2));
  g.add(box(26, 0.3, 4, 0xcfc4ab, 0, 0, -depth / 2 - 2));
  // Puerta
  const door = box(5, 6, 0.4, damaged ? 0x111111 : 0x6b4f2a, 0, 0, -depth / 2 - 0.1);
  door.name = 'bankDoor';
  g.add(door);
  const sign = textPlane('BANCO CENTRAL', 18, 3.2, '#1b2a4a', '#f4d03f');
  sign.position.set(0, 12.8, -depth / 2 + 3);
  if (flipSign) sign.rotation.z = Math.PI;
  g.add(sign);
  if (damaged) {
    for (let i = 0; i < 6; i++) g.add(box(1 + i * 0.3, 0.5, 1, 0x555555, -4 + i * 1.6, 0, -depth / 2 - 4 - (i % 3)));
  }
  return g;
}

export function rubble(w: number, h: number, d: number, variant: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(w, h, d, variant > 0.5 ? 0x4e4538 : 0x5a5044));
  g.add(box(w * 0.6, h * 0.4, d * 0.5, 0x3a332a, (variant - 0.5) * w * 0.4, h, d * 0.1));
  return g;
}

/** Edificio en ruinas, chamuscado y con la parte superior derruida. */
export function ruin(w: number, h: number, d: number, variant: number): THREE.Group {
  const g = new THREE.Group();
  const colors = [0x5a524a, 0x4a4038, 0x6b5d50, 0x3e3a36];
  const c = colors[Math.floor(variant * colors.length)];
  g.add(box(w, h * 0.6, d, c));
  for (let i = 0; i < 3; i++) {
    const fx = ((variant * 7.1 + i * 0.33) % 1) - 0.5;
    const fz = ((variant * 3.7 + i * 0.59) % 1) - 0.5;
    g.add(box(w * 0.35, h * (0.15 + ((variant * 5 + i) % 0.4)), d * 0.35, c, fx * w * 0.6, h * 0.6, fz * d * 0.6));
  }
  g.add(box(w * 0.5, 0.05, d * 0.4, 0x1a1a1a, 0, h * 0.6, 0)); // hueco quemado
  return g;
}

export function deadTree(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.18, 3, 0x2a221c));
  for (const [rx, rz, y] of [[0.7, 0.2, 2.2], [-0.6, -0.3, 1.6]]) {
    const b = box(0.12, 1.4, 0.12, 0x2a221c, 0, y, 0);
    b.rotation.z = rx;
    b.rotation.x = rz;
    g.add(b);
  }
  return g;
}

/** Montaña rocosa con un portal de túnel en el centro de su cara frontal (-Z). */
export function tunnelMountain(width: number, depth: number, roadWidth: number): THREE.Group {
  const g = new THREE.Group();
  for (let x = -width / 2; x < width / 2; x += 8) {
    const h = 12 + Math.abs(Math.sin(x * 1.7)) * 8 + (Math.abs(x) < roadWidth ? 2 : 0);
    g.add(box(8.4, h, depth, Math.abs(x) % 16 < 8 ? 0x7a6650 : 0x6e5b47, x + 4, 0, 0));
    g.add(box(6, h * 0.25, depth * 0.6, 0x8f7a60, x + 4, h, 0));
  }
  // Portal de concreto con la boca oscura del túnel
  g.add(box(roadWidth + 4, 9, 2, 0x9a9a95, 0, 0, -depth / 2 - 0.9));
  g.add(box(roadWidth, 6.5, 0.3, 0x080808, 0, 0, -depth / 2 - 2));
  g.add(box(roadWidth + 4.4, 0.6, 2.2, 0xe6b422, 0, 9, -depth / 2 - 0.9));
  return g;
}

/** Torre de enfriamiento (hiperboloide aproximado). */
export function coolingTower(radius: number, height: number, damaged: boolean): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(radius * 0.72, radius, height, 20, 1, true);
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: damaged ? 0x4a4a42 : 0xd0d0c8, side: THREE.DoubleSide }));
  m.position.y = height / 2;
  m.castShadow = true;
  g.add(m);
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.7, 20),
    damaged ? new THREE.MeshBasicMaterial({ color: 0x39ff14 }) : new THREE.MeshLambertMaterial({ color: 0x3a3a3a }),
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = damaged ? height * 0.5 : 0.1;
  g.add(inner);
  return g;
}

/** Planta nuclear: edificio del reactor con domo, compuerta y señal de peligro. */
export function nuclearPlant(width: number, depth: number, damaged: boolean, flipSign = false): THREE.Group {
  const g = new THREE.Group();
  g.add(box(width, 10, depth, damaged ? 0x5a5a52 : 0xb5b5ad));
  g.add(box(width - 2, 0.5, depth - 2, damaged ? 0x3a3a34 : 0x9a9a92, 0, 10, 0));
  const dome = ball(8, damaged ? 0x2f4a22 : 0xdcdcd4, 0, 10, 2);
  dome.scale.y = 1.1;
  g.add(dome);
  if (damaged) {
    const glow = ball(4, 0x39ff14, 0, 13, 2);
    glow.material = mat(0x39ff14, 0x2fd10f);
    g.add(glow);
  }
  // Franja de peligro en la base de la fachada
  for (let x = -width / 2 + 1, i = 0; x < width / 2; x += 2, i++) g.add(box(1, 1.2, 0.2, i % 2 === 0 ? 0xf1c40f : 0x111111, x, 0, -depth / 2 - 0.1));
  const door = box(10, 7, 0.4, damaged ? 0x0a0a0a : 0x6a6a5a, 0, 0, -depth / 2 - 0.25);
  door.name = 'plantDoor';
  g.add(door);
  const sign = radiationPlane(14, 4.6);
  sign.position.set(0, 10.6, -depth / 2 + 3);
  if (flipSign) sign.rotation.z = Math.PI;
  g.add(sign);
  return g;
}

/** Letrero de peligro nuclear dibujado en canvas (trébol de radiación). */
export function radiationPlane(w: number, h: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * h) / w);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f1c40f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, 10);
  ctx.fillRect(0, canvas.height - 10, canvas.width, 10);
  const r = canvas.height * 0.36;
  const cx = r + 24;
  const cy = canvas.height / 2;
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a - Math.PI / 6, a + Math.PI / 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.fillStyle = '#f1c40f';
  ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = '#111';
  ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `bold ${Math.round(canvas.height * 0.3)}px Impact, Arial Black, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText('PLANTA NUCLEAR', cx + r + 20, cy);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** Plano horizontal con texto (legible desde la cámara cenital). */
export function textPlane(text: string, w: number, h: number, bg: string, fg: string): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * h) / w);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.round(canvas.height * 0.55)}px Impact, Arial Black, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/**
 * Incinerador: semioruga blindada con dos tanques de combustible a la espalda,
 * boquilla de lanzallamas al frente con piloto encendido y conductor con máscara.
 */
function pyroVehicle(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.0, 0.7, 4.4, 0x5a4a3a, 0, 0.3, 0));
  for (const s of [-1, 1]) g.add(box(0.5, 0.75, 4.2, 0x1a1a1a, s * 1.05, 0, 0));
  g.add(box(1.6, 0.7, 1.3, 0x3d3228, 0, 1.0, -0.7));
  for (let i = 0; i < 4; i++) g.add(box(2.04, 0.1, 0.3, 0x8a5a2a, 0, 1.0, -1.9 + i * 0.95));
  for (const s of [-1, 1]) {
    g.add(cyl(0.42, 1.8, 0xb03a2e, s * 0.5, 1.0, 1.3));
    g.add(cyl(0.44, 0.15, 0xf1c40f, s * 0.5, 1.9, 1.3));
  }
  // Conductor con máscara de gas
  g.add(box(0.6, 0.6, 0.45, 0x2a2a2a, 0, 1.3, 0.1));
  g.add(ball(0.26, 0x6b6b6b, 0, 2.05, 0.1));
  g.add(box(0.36, 0.12, 0.06, 0x111111, 0, 2.08, -0.15));
  // Boquilla con piloto encendido
  g.add(box(0.22, 0.22, 1.6, 0x333333, 0, 1.0, -2.6));
  const pilot = ball(0.16, 0x9dff6a, 0, 1.11, -3.45);
  pilot.material = mat(0x9dff6a, 0x39ff14);
  g.add(pilot);
  return g;
}

/** Proyectiles lanzados en arco: granada, bomba o gota de ácido. */
export function lobMesh(kind: 'grenade' | 'bomb' | 'acid'): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'grenade') {
    g.add(ball(0.32, 0x3d4a2a));
    g.add(box(0.5, 0.12, 0.5, 0xc0c0c0, 0, -0.06, 0));
  } else if (kind === 'bomb') {
    g.add(ball(0.42, 0x111111));
    const fuse = ball(0.12, 0xffd27a, 0, 0.45, 0);
    fuse.material = mat(0xffd27a, 0xff8800);
    g.add(fuse);
  } else {
    const drop = ball(0.3, 0x6dff3a);
    drop.material = mat(0x6dff3a, 0x2fd10f);
    drop.scale.y = 1.6;
    g.add(drop);
  }
  return g;
}

/** Rampa de salto con franjas de advertencia; la parte alta mira hacia -Z. */
export function rampMesh(): THREE.Group {
  const g = new THREE.Group();
  const deck = new THREE.Group();
  deck.rotation.x = 0.26;
  deck.position.y = 0.55;
  g.add(deck);
  deck.add(box(4.4, 0.22, 3.4, 0x4a4a4a, 0, -0.11, 0));
  for (let i = 0; i < 4; i++) deck.add(box(4.42, 0.02, 0.35, i % 2 ? 0x111111 : 0xf1c40f, 0, 0, -1.4 + i * 0.85));
  for (const s of [-1, 1]) g.add(box(0.2, 1.0, 0.2, 0x333333, s * 2, 0, -1.4));
  return g;
}

/** Libera geometrías y texturas no compartidas de un objeto. */
export function disposeUnique(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry;
    if (!SHARED_GEOS.has(geo)) geo.dispose();
    const m = mesh.material as THREE.Material & { map?: THREE.Texture };
    if (m && !(m instanceof THREE.MeshLambertMaterial)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
