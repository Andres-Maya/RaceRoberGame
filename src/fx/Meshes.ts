import * as THREE from 'three';
import type { ObstacleKind, PoliceKind } from '../config/types';

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

export interface PoliceMesh {
  group: THREE.Group;
  red: THREE.Mesh;
  blue: THREE.Mesh;
}

const RED_ON = mat(0xff2a2a, 0xff0000);
const RED_OFF = mat(0x551111);
const BLUE_ON = mat(0x2a6bff, 0x0044ff);
const BLUE_OFF = mat(0x112255);

export function setSiren(p: PoliceMesh, phase: boolean): void {
  p.red.material = phase ? RED_ON : RED_OFF;
  p.blue.material = phase ? BLUE_OFF : BLUE_ON;
}

export function policeVehicle(kind: PoliceKind): PoliceMesh {
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
  }
  return g;
}

const PARKED_COLORS = [0x7f8c8d, 0x34495e, 0x8e44ad, 0xc0392b, 0xd4ac0d, 0x16a085, 0xecf0f1];
export const CIVILIAN_COLORS = [0x2e86c1, 0xcb4335, 0xf4d03f, 0x27ae60, 0xe67e22, 0x7d3c98, 0xbdc3c7, 0x17202a];

// ---------------------------------------------------------------- recompensas

export function pickupMesh(kind: 'repair' | 'nitro'): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  if (kind === 'repair') {
    inner.add(box(1.2, 1.2, 1.2, 0x2ecc71));
    inner.add(box(0.9, 0.25, 0.3, 0xffffff, 0, 0.5, -0.62));
    inner.add(box(0.3, 0.25, 0.9, 0xffffff, 0, 1.22, 0));
    inner.add(box(0.9, 0.04, 0.3, 0xffffff, 0, 1.2, 0));
  } else {
    inner.add(cyl(0.45, 1.3, 0x2a6bff));
    inner.add(cyl(0.2, 0.3, 0xdddddd, 0, 1.3, 0));
    inner.add(box(0.92, 0.3, 0.92, 0x9fd8ff, 0, 0.5, 0));
  }
  inner.position.y = 0.4;
  g.add(inner);
  const ring = new THREE.Mesh(
    shareGeometry(new THREE.RingGeometry(1.3, 1.6, 24).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: kind === 'repair' ? 0x2ecc71 : 0x4d9dff, transparent: true, opacity: 0.6 }),
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
  for (let i = -3; i <= 3; i++) g.add(cyl(0.6, 10, 0xf2ead8, i * 3.2, 0, -depth / 2 - 1.2));
  g.add(box(24, 0.6, 1.5, 0xf2ead8, 0, 10, -depth / 2 - 1.2));
  g.add(box(26, 0.3, 4, 0xcfc4ab, 0, 0, -depth / 2 - 2));
  // Puerta
  g.add(box(5, 6, 0.4, damaged ? 0x111111 : 0x6b4f2a, 0, 0, -depth / 2 - 0.1));
  const sign = textPlane('BANCO CENTRAL', 18, 3.2, '#1b2a4a', '#f4d03f');
  sign.position.set(0, 12.8, -depth / 2 + 3);
  if (flipSign) sign.rotation.z = Math.PI;
  g.add(sign);
  if (damaged) {
    for (let i = 0; i < 6; i++) g.add(box(1 + i * 0.3, 0.5, 1, 0x555555, -4 + i * 1.6, 0, -depth / 2 - 4 - (i % 3)));
  }
  return g;
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
