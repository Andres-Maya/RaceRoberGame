import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

type V3 = [number, number, number];
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const GLASS = 0x1d2a35;
const CHROME = 0xc9ccd1;

/** Barra recta entre dos puntos (pilares, tubos, brazos, mangueras); `t` es su grosor en X y `t2` el otro. */
function rod(a: V3, b: V3, t: number, color: number, t2 = t): THREE.Mesh {
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const m = new THREE.Mesh(BOX, mat(color));
  m.scale.set(t, t2, dir.length());
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  m.quaternion.setFromUnitVectors(Z_AXIS, dir.normalize());
  m.castShadow = true;
  return m;
}

/** Luz encendida (faros, pilotos, letreros): caja con brillo propio. */
function lamp(w: number, h: number, d: number, color: number, glow: number, x: number, y: number, z: number): THREE.Mesh {
  const m = box(w, h, d, color, x, y, z);
  m.material = mat(color, glow);
  return m;
}

/** Rueda de auto con llanta, rin y tapacubos; el eje va a lo largo de X. */
function carWheel(r: number, tw: number, x: number, z: number, rim: number): THREE.Group {
  const g = new THREE.Group();
  for (const [rr, w, color] of [[r, tw, 0x161616], [r * 0.62, tw + 0.04, rim], [r * 0.24, tw + 0.08, 0x2a2a2a]]) {
    const m = new THREE.Mesh(CYL, mat(color));
    m.scale.set(2 * rr, w, 2 * rr);
    m.rotation.z = Math.PI / 2;
    m.castShadow = true;
    g.add(m);
  }
  g.position.set(x, r, z);
  return g;
}

const prisms = new Map<string, THREE.BufferGeometry>();

/**
 * Prisma de perfil trapezoidal con base en y=0: la base mide `lb` a lo largo de Z
 * y la cara de arriba `lt`, corrida `shift`. Sirve para cabinas con parabrisas inclinado.
 */
function prism(w: number, h: number, lb: number, lt: number, shift: number): THREE.BufferGeometry {
  const key = [w, h, lb, lt, shift].map((v) => v.toFixed(3)).join();
  let geo = prisms.get(key);
  if (!geo) {
    geo = new THREE.BoxGeometry(w, h, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getY(i) > 0 ? shift + p.getZ(i) * lt : p.getZ(i) * lb);
    geo.translate(0, h / 2, 0);
    geo.computeVertexNormals();
    prisms.set(key, shareGeometry(geo));
  }
  return geo;
}

function prismMesh(w: number, h: number, lb: number, lt: number, shift: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(prism(w, h, lb, lt, shift), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Color marcador de la pintura en los modelos horneados: se cambia por el color real en cada copia. */
const PAINT = 0xff00fe;
const bakedParts = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material }[]>();

/**
 * Hornea un modelo estático en una geometría por material, calculada una sola vez
 * por `key` y compartida por todas las copias: muchas piezas cuestan pocas llamadas
 * de dibujo y, en el juego en línea, la geometría viaja una sola vez.
 */
function baked(key: string, build: () => THREE.Object3D, paint?: number): THREE.Group {
  let parts = bakedParts.get(key);
  if (!parts) {
    const src = build();
    src.updateMatrixWorld(true);
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      geo.deleteAttribute('uv');
      geo.applyMatrix4(mesh.matrixWorld);
      const m = mesh.material as THREE.Material;
      const list = byMat.get(m);
      if (list) list.push(geo);
      else byMat.set(m, [geo]);
    });
    parts = [...byMat].map(([m, geos]) => {
      const geo = mergeGeometries(geos);
      for (const gg of geos) gg.dispose();
      geo.computeBoundingSphere();
      return { geo: shareGeometry(geo), mat: m };
    });
    bakedParts.set(key, parts);
  }
  const g = new THREE.Group();
  const paintMat = mat(PAINT);
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geo, p.mat === paintMat && paint !== undefined ? mat(paint) : p.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

// ---------------------------------------------------------------- motos y personajes

/** Rueda de moto: llanta y rin, con el eje a lo largo de X (la moto mira hacia -Z). */
function bikeWheel(r: number, w: number, z: number, rim: number): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(CYL, mat(0x141414));
  tire.scale.set(2 * r, w, 2 * r);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  const hub = new THREE.Mesh(CYL, mat(rim));
  hub.scale.set(r * 1.05, w * 1.12, r * 1.05);
  hub.rotation.z = Math.PI / 2;
  g.add(tire, hub);
  g.position.set(0, r, z);
  return g;
}

/** Tubo cilíndrico orientado a lo largo de Z (escapes, horquillas tumbadas). */
function pipe(r: number, len: number, color: number, x: number, y: number, z: number, tilt = 0): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat(color));
  m.scale.set(2 * r, len, 2 * r);
  m.rotation.x = Math.PI / 2 + tilt;
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

export type BikeStyle = 'sport' | 'police' | 'chopper' | 'dirt';

/**
 * Moto detallada (mira hacia -Z): ruedas con rin, horquilla, motor con aletas,
 * escapes cromados, tanque, asiento, guardabarros, faro y piloto trasero.
 * Cada estilo agrega lo suyo: carenado deportivo, parabrisas y alforjas de
 * policía, horquilla larga y manubrio alto del chopper, o púas de la moto de cross.
 */
export function motorcycle(style: BikeStyle, color: number, accent: number): THREE.Group {
  const g = new THREE.Group();
  const chrome = 0xc9ccd1;
  const chopper = style === 'chopper';
  const dirt = style === 'dirt';
  const frontZ = chopper ? -1.0 : -0.8;
  g.add(bikeWheel(dirt ? 0.37 : 0.34, chopper ? 0.14 : 0.18, frontZ, dirt ? 0x7a5a3a : chrome));
  g.add(bikeWheel(0.36, chopper ? 0.3 : 0.24, 0.8, dirt ? 0x7a5a3a : chrome));
  // Chasis, motor con aletas y escapes.
  g.add(box(0.12, 0.1, 1.35, 0x1d1d1d, 0, 0.42, 0.05));
  g.add(box(0.4, 0.32, 0.5, dirt ? 0x5a4a3a : 0x4a4d52, 0, 0.24, 0.02));
  for (let i = 0; i < 3; i++) g.add(box(0.46, 0.04, 0.42, dirt ? 0x7a6a5a : chrome, 0, 0.33 + i * 0.07, 0.02));
  for (const sx of dirt ? [1] : [-1, 1]) g.add(pipe(0.055, 0.95, dirt ? 0x6b4a2a : chrome, sx * 0.22, dirt ? 0.62 : 0.3, 0.55, dirt ? -0.35 : 0.05));
  // Tanque, asiento y guardabarros.
  g.add(box(0.42, 0.24, 0.55, color, 0, 0.6, -0.22));
  g.add(box(0.36, 0.1, 0.62, 0x161616, 0, 0.64, 0.32));
  g.add(box(0.3, 0.06, 0.55, color, 0, dirt ? 0.82 : 0.72, 0.78));
  g.add(box(0.24, 0.05, 0.42, color, 0, dirt ? 0.86 : 0.72, frontZ));
  const tail = box(0.18, 0.07, 0.05, 0xff2020, 0, 0.74, 1.05);
  tail.material = mat(0xff2020, 0xaa0000);
  g.add(tail);
  // Horquilla (más inclinada y larga en el chopper) y manubrio.
  const rake = chopper ? 0.62 : 0.32;
  const forkLen = chopper ? 1.15 : 0.82;
  for (const sx of [-1, 1]) {
    const fork = pipe(0.035, forkLen, chrome, sx * 0.11, 0.34 + Math.cos(rake) * forkLen * 0.5, frontZ + Math.sin(rake) * forkLen * 0.5, -Math.PI / 2 + rake);
    g.add(fork);
  }
  const barY = chopper ? 1.32 : 1.0;
  const barZ = chopper ? -0.55 : -0.58;
  g.add(box(chopper ? 0.9 : 0.78, 0.05, 0.06, 0x2a2a2a, 0, barY, barZ));
  for (const sx of [-1, 1]) {
    g.add(box(0.1, 0.07, 0.08, 0x111111, sx * (chopper ? 0.43 : 0.37), barY - 0.01, barZ));
    if (chopper) g.add(box(0.05, 0.36, 0.05, chrome, sx * 0.3, barY - 0.34, barZ));
    if (!dirt) g.add(box(0.12, 0.07, 0.03, chrome, sx * 0.3, barY + 0.16, barZ - 0.02)); // espejos
  }
  // Faro encendido, montado en la horquilla con su soporte y carcasa.
  const lampY = 0.34 + Math.cos(rake) * forkLen * 0.72;
  const lampZ = frontZ + Math.sin(rake) * forkLen * 0.72 - 0.16;
  g.add(box(0.26, 0.06, 0.2, 0x2a2a2a, 0, lampY - 0.03, lampZ + 0.1));
  g.add(box(0.26, 0.21, 0.12, 0x2a2a2a, 0, lampY - 0.02, lampZ + 0.04));
  g.add(lamp(0.22, 0.17, 0.05, 0xfff4c0, 0xfff1a0, 0, lampY, lampZ - 0.03));

  switch (style) {
    case 'sport':
      // Carenado y colín con el color secundario.
      g.add(box(0.5, 0.36, 0.42, color, 0, 0.62, -0.68));
      g.add(box(0.36, 0.22, 0.06, 0x1d2a35, 0, 0.98, -0.72));
      g.add(box(0.44, 0.03, 0.56, accent, 0, 0.85, -0.22));
      g.add(box(0.32, 0.16, 0.36, color, 0, 0.74, 0.62));
      break;
    case 'police':
      // Franjas azules, parabrisas, alforjas y torreta sobre un mástil.
      g.add(box(0.44, 0.06, 0.57, accent, 0, 0.7, -0.22));
      g.add(box(0.5, 0.36, 0.05, 0xa9c8e6, 0, 0.98, -0.66));
      for (const sx of [-1, 1]) {
        g.add(box(0.2, 0.3, 0.46, 0xf2f2f2, sx * 0.3, 0.42, 0.68));
        g.add(box(0.21, 0.06, 0.47, accent, sx * 0.3, 0.6, 0.68));
      }
      g.add(box(0.05, 0.4, 0.05, 0x333333, 0, 0.78, 0.95));
      break;
    case 'chopper':
      // Llamas en el tanque y respaldo alto.
      for (const [x, w] of [[-0.12, 0.08], [0.05, 0.1], [0.16, 0.06]] as const) g.add(box(w, 0.02, 0.3, accent, x, 0.85, -0.12));
      g.add(box(0.04, 0.6, 0.04, chrome, -0.14, 0.7, 1.0));
      g.add(box(0.04, 0.6, 0.04, chrome, 0.14, 0.7, 1.0));
      g.add(box(0.32, 0.04, 0.04, chrome, 0, 1.28, 1.0));
      break;
    case 'dirt': {
      // Púas al frente, calavera en el faro y placa con número.
      for (const sx of [-0.15, 0, 0.15]) {
        const c = new THREE.Mesh(CONE, mat(0xb0b0b0));
        c.scale.set(0.12, 0.42, 0.12);
        c.rotation.x = -Math.PI / 2;
        c.position.set(sx, 0.55, frontZ - 0.35);
        g.add(c);
      }
      g.add(ball(0.12, 0xe8e2c8, 0, lampY + 0.26, lampZ + 0.04));
      g.add(box(0.26, 0.2, 0.03, 0xd8d0b0, 0, 0.95, 1.02));
      break;
    }
  }
  return g;
}

export interface RiderLook {
  /** Chaqueta, pantalón, botas y piel. */
  jacket: number;
  pants: number;
  boots: number;
  skin: number;
  /** Casco (null = cabeza descubierta) y su visera. */
  helmet: number | null;
  visor?: number;
  /** Detalles de la cabeza descubierta. */
  hair?: number;
  bandana?: number;
  shades?: boolean;
  mohawk?: number;
  goggles?: boolean;
  mask?: boolean;
  /** Máscara de gas con filtros, bajo el visor del casco. */
  gasmask?: boolean;
  /** Mochila (el botín del jugador) y hombreras con púas (saqueadores). */
  backpack?: number;
  spikes?: boolean;
  /** Parche en la espalda (chaleco de la banda). */
  patch?: number;
}

/** Cabeza con casco o descubierta (pañuelo, gafas, cresta, máscara), mirando hacia -Z. */
function riderHead(o: RiderLook): THREE.Group {
  const h = new THREE.Group();
  if (o.helmet !== null) {
    h.add(ball(0.25, o.helmet, 0, 0, 0));
    h.add(box(0.34, 0.14, 0.08, o.visor ?? 0x1b2530, 0, -0.07, -0.21));
    h.add(box(0.06, 0.04, 0.4, o.visor ?? 0x1b2530, 0, 0.21, 0)); // cresta del casco
    if (o.gasmask) {
      h.add(box(0.2, 0.15, 0.12, 0x2a2a2a, 0, -0.27, -0.2));
      for (const sx of [-1, 1]) h.add(pipe(0.07, 0.12, 0x4a4a4a, sx * 0.13, -0.22, -0.25));
    }
  } else {
    h.add(box(0.34, 0.38, 0.34, o.skin, 0, -0.17, 0));
    if (o.hair !== undefined) h.add(box(0.36, 0.1, 0.36, o.hair, 0, 0.14, 0.02));
    if (o.bandana !== undefined) h.add(box(0.37, 0.09, 0.37, o.bandana, 0, 0.08, 0));
    if (o.shades) h.add(box(0.34, 0.07, 0.04, 0x0b0b0b, 0, -0.03, -0.18));
    if (o.goggles) {
      for (const x of [-0.08, 0.08]) h.add(box(0.12, 0.1, 0.05, 0x7fd0c0, x, -0.02, -0.19));
      h.add(box(0.38, 0.04, 0.38, 0x3a2a1a, 0, -0.02, 0));
    }
    if (o.mask) h.add(box(0.28, 0.14, 0.08, 0x2a2a2a, 0, -0.2, -0.19));
    if (o.mohawk !== undefined) h.add(box(0.07, 0.2, 0.36, o.mohawk, 0, 0.1, 0));
  }
  return h;
}

/**
 * Motociclista sentado (mira hacia -Z): piernas a los pedales, torso inclinado
 * hacia el manubrio, brazos con guantes y la cabeza según su bando.
 * `lean`: inclinación del torso; `reach` y `barY`: posición de los puños.
 */
export function rider(o: RiderLook, barY = 1.0, barZ = -0.58, lean = 0.45): THREE.Group {
  const g = new THREE.Group();
  // Cadera sobre el asiento, muslos hacia adelante, piernas a los pedales y botas.
  g.add(box(0.42, 0.18, 0.32, o.pants, 0, 0.68, 0.3));
  for (const sx of [-1, 1]) {
    g.add(box(0.16, 0.15, 0.5, o.pants, sx * 0.18, 0.7, 0.08));
    g.add(box(0.15, 0.46, 0.16, o.pants, sx * 0.21, 0.28, -0.16));
    g.add(box(0.17, 0.13, 0.3, o.boots, sx * 0.21, 0.2, -0.22));
  }
  // Torso inclinado (pivote en la cadera).
  const torso = new THREE.Group();
  torso.position.set(0, 0.84, 0.3);
  torso.rotation.x = -lean;
  g.add(torso);
  torso.add(box(0.5, 0.58, 0.3, o.jacket, 0, 0, 0));
  torso.add(box(0.52, 0.06, 0.32, 0x2a1d14, 0, 0.02, 0)); // cinturón
  if (o.patch !== undefined) torso.add(box(0.3, 0.26, 0.02, o.patch, 0, 0.3, 0.16));
  if (o.backpack !== undefined) {
    torso.add(box(0.46, 0.4, 0.26, o.backpack, 0, 0.2, 0.26));
    torso.add(box(0.2, 0.1, 0.02, 0xf1c40f, 0, 0.26, 0.4)); // signo de dinero
  }
  if (o.spikes) {
    for (const sx of [-1, 1]) {
      const c = new THREE.Mesh(CONE, mat(0xb8b8b8));
      c.scale.set(0.1, 0.24, 0.1);
      c.position.set(sx * 0.3, 0.62, 0);
      c.rotation.z = -sx * 0.6;
      torso.add(c);
    }
  }
  const head = riderHead(o);
  head.position.set(0, 0.84, -0.04);
  head.rotation.x = lean * 0.8; // mira al frente aunque vaya inclinado
  torso.add(head);
  // Brazos: del hombro a los puños del manubrio, con guantes.
  const shoulderY = 0.84 + Math.cos(lean) * 0.5;
  const shoulderZ = 0.3 - Math.sin(lean) * 0.5;
  for (const sx of [-1, 1]) {
    const sxw = sx * 0.3;
    const hx = sx * 0.36;
    const dy = barY - shoulderY;
    const dz = barZ - shoulderZ;
    const len = Math.hypot(dy, dz, hx - sxw);
    const arm = new THREE.Mesh(BOX, mat(o.jacket));
    arm.scale.set(0.13, 0.13, len);
    arm.position.set((sxw + hx) / 2, (shoulderY + barY) / 2, (shoulderZ + barZ) / 2);
    arm.rotation.x = Math.atan2(dy, -dz);
    arm.castShadow = true;
    g.add(arm);
    g.add(box(0.13, 0.12, 0.14, 0x1a1a1a, hx, barY - 0.06, barZ));
  }
  return g;
}

/**
 * Conductor sentado al volante de un vehículo abierto (buggy): torso erguido,
 * brazos al volante y la cabeza según el personaje. Mira hacia -Z.
 */
export function seatedDriver(o: RiderLook, seatY: number, seatZ: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.5, 0.5, 0.12, 0x2a2a2a, 0, seatY, seatZ + 0.32)); // respaldo
  g.add(box(0.5, 0.1, 0.5, 0x2a2a2a, 0, seatY - 0.06, seatZ + 0.05)); // cojín
  for (const sx of [-1, 1]) g.add(box(0.17, 0.15, 0.55, o.pants, sx * 0.14, seatY + 0.05, seatZ - 0.2));
  const torso = new THREE.Group();
  torso.position.set(0, seatY + 0.2, seatZ);
  torso.rotation.x = -0.12;
  g.add(torso);
  torso.add(box(0.5, 0.56, 0.3, o.jacket, 0, 0, 0));
  if (o.spikes) {
    for (const sx of [-1, 1]) {
      const c = new THREE.Mesh(CONE, mat(0xb8b8b8));
      c.scale.set(0.1, 0.24, 0.1);
      c.position.set(sx * 0.3, 0.6, 0);
      c.rotation.z = -sx * 0.6;
      torso.add(c);
    }
  }
  const head = riderHead(o);
  head.position.set(0, 0.82, -0.02);
  torso.add(head);
  // Volante inclinado; la columna de dirección sale de su centro hacia adelante y
  // abajo hasta el tablero, que baja hasta el piso.
  const wheelZ = seatZ - 0.62;
  const wheelY = seatY + 0.55;
  const tilt = Math.PI / 2 - 0.5;
  const steer = new THREE.Mesh(CYL, mat(0x1a1a1a));
  steer.scale.set(0.42, 0.05, 0.42);
  steer.rotation.x = tilt;
  steer.position.set(0, wheelY, wheelZ);
  steer.castShadow = true;
  g.add(steer);
  const dashY = wheelY - Math.cos(tilt) * 0.42;
  const dashZ = wheelZ - Math.sin(tilt) * 0.42;
  g.add(rod([0, wheelY, wheelZ], [0, dashY, dashZ], 0.06, 0x333333));
  g.add(box(0.7, dashY + 0.07 - (seatY - 0.06), 0.24, 0x2a2a2a, 0, seatY - 0.06, dashZ - 0.08));
  g.add(lamp(0.16, 0.06, 0.02, 0x9dff6a, 0x2a7a10, 0, dashY - 0.02, dashZ + 0.05));
  // Brazos del hombro a las manos en el volante.
  const shoulderY = seatY + 0.2 + Math.cos(0.12) * 0.5;
  const shoulderZ = seatZ - Math.sin(0.12) * 0.5;
  for (const sx of [-1, 1]) {
    g.add(rod([sx * 0.28, shoulderY, shoulderZ], [sx * 0.17, wheelY + 0.02, wheelZ + 0.05], 0.13, o.jacket));
    g.add(box(0.12, 0.12, 0.12, 0x1a1a1a, sx * 0.17, wheelY - 0.04, wheelZ + 0.05));
  }
  return g;
}

/** Aspecto de los motociclistas y conductores de cada bando. */
export const LOOKS = {
  police: { jacket: 0x1b2a4a, pants: 0x1b2a4a, boots: 0x111111, skin: 0xd2a07a, helmet: 0xf4f4f4, visor: 0x1b2530 },
  biker: { jacket: 0x2b1d14, pants: 0x2a3a5a, boots: 0x1a120c, skin: 0xc68a5a, helmet: null, hair: 0x2a1a10, bandana: 0xb03a2e, shades: true, patch: 0xe67e22 },
  raider: { jacket: 0x4a3626, pants: 0x3a3226, boots: 0x2a1a10, skin: 0x8fb070, helmet: null, mohawk: 0xd62828, goggles: true, mask: true, spikes: true },
  driver: { jacket: 0x3a2a1a, pants: 0x3a3226, boots: 0x2a1a10, skin: 0x8fb070, helmet: null, goggles: true, mask: true, hair: 0x3a2a1a, spikes: true },
  /** Traje ignífugo aluminizado, capucha con visor dorado y máscara de gas. */
  pyro: { jacket: 0xb5b0a0, pants: 0xb5b0a0, boots: 0x2a2a2a, skin: 0xd2a07a, helmet: 0xb5b0a0, visor: 0xd4a017, gasmask: true },
} satisfies Record<string, RiderLook>;

// ---------------------------------------------------------------- vehículos

export function motorbike(color: number, accent: number): THREE.Group {
  const g = motorcycle('sport', color, accent);
  g.add(rider({ jacket: 0x2b2b2b, pants: 0x1e1e24, boots: 0x111111, skin: 0xd2a07a, helmet: accent, visor: 0x101820, backpack: 0x2f7d32 }));
  return g;
}

/**
 * Vehículos que puede elegir el jugador en el garaje (miran hacia -Z).
 * `color` es el color del jugador y `accent` su color secundario; cada
 * combinación se hornea una sola vez.
 */
export function playerVehicleMesh(id: string, color: number, accent: number): THREE.Group {
  return baked(`player:${id}:${color}:${accent}`, () => playerBody(id, color, accent));
}

/** Piloto del jugador con casco de su color. */
function playerLook(accent: number): RiderLook {
  return { jacket: 0x2b2b2b, pants: 0x1e1e24, boots: 0x111111, skin: 0xd2a07a, helmet: accent, visor: 0x101820 };
}

function playerBody(id: string, color: number, accent: number): THREE.Group {
  switch (id) {
    case 'cacharro': {
      // Hatchback viejo: óxido, una puerta de otro color, un faro apagado, parabrisas
      // rajado, parrilla de techo con equipaje amarrado, antena con banderín y escape con cinta.
      const g = carBody({ w: 1.9, l: 3.9, r: 0.34, tw: 0.28, axles: [-1.2, 1.25], rim: 0x8a8a8a, y0: 0.3, h: 0.62, cab: [-0.45, 1.75], cabH: 0.58, rake: [0.5, 0.15], paint: color, bumper: 0x555555, doors: 1 });
      const top = 0.92;
      const rust = 0x8a4a22;
      for (const [x, z, w, d] of [[-0.5, -1.45, 0.5, 0.4], [0.4, -0.8, 0.35, 0.3], [-0.3, 1.85, 0.4, 0.15]]) g.add(box(w, 0.02, d, rust, x, top, z));
      g.add(box(0.02, 0.25, 0.5, rust, -0.955, 0.45, 1.3));
      g.add(box(0.03, 0.5, 1.4, accent, 0.96, 0.36, 0.35)); // puerta de otro color
      g.add(box(0.4, 0.16, 0.05, 0x3a3a3a, -0.627, 0.6, -1.99)); // faro apagado
      // Grieta en el parabrisas.
      const glass = (x: number, t: number): V3 => [x, top + 0.58 * t + 0.013, -0.45 + 0.5 * t - 0.015];
      g.add(rod(glass(-0.35, 0.2), glass(0.05, 0.7), 0.02, 0xdde6ee, 0.02));
      g.add(rod(glass(-0.12, 0.45), glass(0.3, 0.38), 0.02, 0xdde6ee, 0.02));
      // Parrilla de techo con maleta y bolsa del botín amarradas.
      for (const sx of [-1, 1]) g.add(box(0.06, 0.08, 1.4, 0x555555, sx * 0.55, 1.55, 0.8));
      for (const z of [0.3, 1.3]) g.add(box(1.3, 0.06, 0.06, 0x555555, 0, 1.6, z));
      g.add(box(0.7, 0.32, 0.6, 0x6b4a2a, -0.15, 1.63, 0.7));
      g.add(box(0.5, 0.26, 0.42, 0x2f7d32, 0.35, 1.63, 1.15));
      g.add(box(0.2, 0.1, 0.02, 0xf1c40f, 0.35, 1.72, 1.37));
      for (const z of [0.55, 0.85]) g.add(box(0.74, 0.03, 0.05, accent, -0.15, 1.95, z));
      // Antena con banderín y escape amarrado con cinta.
      g.add(rod([0.8, top, 1.8], [0.8, 2.3, 1.9], 0.025, 0x222222));
      g.add(box(0.02, 0.2, 0.32, accent, 0.8, 2.08, 2.06));
      g.add(pipe(0.09, 0.5, 0x777777, 0.6, 0.22, 2.05));
      g.add(box(0.22, 0.22, 0.06, 0xc9b27a, 0.6, 0.11, 2.12));
      return g;
    }
    case 'sport': {
      // Deportivo bajo en cuña: franja central, alerón con aletas, faldones, difusor y cuatro escapes.
      const g = carBody({ w: 1.9, l: 4.0, r: 0.35, tw: 0.34, axles: [-1.3, 1.3], rim: 0x222222, y0: 0.22, h: 0.46, cab: [-0.3, 1.0], cabH: 0.4, rake: [0.65, 0.45], paint: color, bumper: 0x111111, doors: 1 });
      const top = 0.68;
      g.add(box(0.4, 0.02, 1.7, accent, 0, top, -1.15));
      g.add(box(0.4, 0.02, 0.28, accent, 0, 1.13, 0.45));
      g.add(box(0.4, 0.02, 1.0, accent, 0, top, 1.5));
      g.add(box(1.8, 0.06, 0.4, color, 0, top + 0.38, 1.82)); // alerón
      for (const sx of [-1, 1]) {
        g.add(box(0.05, 0.25, 0.45, accent, sx * 0.9, top + 0.2, 1.82));
        g.add(box(0.07, 0.38, 0.1, 0x222222, sx * 0.55, top, 1.82));
        g.add(box(0.06, 0.12, 1.9, accent, sx * 0.97, 0.22, 0)); // faldones
        g.add(box(0.03, 0.2, 0.4, 0x111111, sx * 0.955, 0.38, 0.75)); // tomas laterales
        g.add(box(0.3, 0.02, 0.4, 0x111111, sx * 0.5, top, -1.2)); // rejillas del capó
      }
      g.add(box(2.0, 0.05, 0.3, 0x111111, 0, 0.12, -2.05)); // alerón delantero
      g.add(box(1.2, 0.1, 0.12, 0x111111, 0, 0.12, 2.06)); // difusor
      for (const x of [-0.5, -0.36, 0.36, 0.5]) g.add(pipe(0.06, 0.2, CHROME, x, 0.26, 2.1));
      return g;
    }
    case 'truck': {
      // Camioneta 4x4: guardabarros anchos, platón con repuesto, barra antivuelco con
      // faros, defensa de tubos con cabrestante, snorkel y barra de luces en el techo.
      const g = carBody({ w: 2.2, l: 4.8, r: 0.5, tw: 0.44, axles: [-1.55, 1.55], rim: 0x9a9a9a, y0: 0.58, h: 0.72, cab: [-0.8, 0.6], cabH: 0.7, rake: [0.45, 0.04], paint: color, bumper: 0x333333, doors: 1 });
      const top = 1.3;
      for (const z of [-1.55, 1.55]) for (const sx of [-1, 1]) g.add(box(0.22, 0.12, 1.2, 0x1a1a1a, sx * 1.12, 1.0, z));
      g.add(box(2.24, 0.1, 2.6, accent, 0, 0.95, -0.5)); // franja
      g.add(box(2.0, 0.02, 1.8, 0x2a2a2a, 0, top, 1.5)); // platón
      for (const sx of [-1, 1]) g.add(box(0.1, 0.45, 1.8, color, sx * 1.05, top, 1.5));
      g.add(box(2.2, 0.45, 0.1, color, 0, top, 2.35));
      g.add(cyl(0.45, 0.3, 0x161616, 0, top, 1.6)); // repuesto
      g.add(cyl(0.25, 0.32, 0x9a9a9a, 0, top, 1.6));
      for (const sx of [-1, 1]) g.add(rod([sx * 0.95, top, 0.75], [sx * 0.95, top + 0.85, 0.75], 0.12, accent));
      g.add(rod([-0.95, top + 0.85, 0.75], [0.95, top + 0.85, 0.75], 0.12, accent));
      g.add(rod([-0.95, top + 0.85, 0.75], [0.95, top, 1.3], 0.1, accent));
      for (const x of [-0.6, -0.2, 0.2, 0.6]) g.add(lamp(0.26, 0.2, 0.12, 0xfff4c0, 0x8a7a40, x, top + 0.9, 0.72));
      pushBar(g, 1.9, 1.15, -2.55, 0x9a9a9a);
      g.add(box(0.5, 0.22, 0.16, 0x333333, 0, 0.62, -2.47)); // cabrestante
      g.add(rod([1.15, 1.1, -1.15], [1.15, 2.1, -0.85], 0.12, 0x111111)); // snorkel
      g.add(box(0.16, 0.14, 0.26, 0x111111, 1.15, 2.05, -0.95));
      g.add(lamp(1.2, 0.12, 0.15, 0xfff4c0, 0x8a7a40, 0, 2.05, -0.2));
      for (const sx of [-1, 1]) g.add(box(0.45, 0.45, 0.04, 0x111111, sx * 0.95, 0.15, 2.2)); // guardafangos
      return g;
    }
    case 'buggy': {
      // Buggy Escorpión: trompa y pontones de su color, jaula del color secundario,
      // motor cromado atrás y una cola de escorpión con aguijón encendido.
      const g = new THREE.Group();
      for (const [z, r, tw] of [[-1.15, 0.48, 0.42], [1.15, 0.55, 0.5]]) {
        for (const sx of [-1, 1]) {
          g.add(carWheel(r, tw, sx * 0.92, z, accent));
          g.add(rod([sx * 0.5, 0.62, z], [sx * 0.78, r, z], 0.08, 0x333333));
        }
      }
      g.add(box(1.3, 0.1, 2.9, 0x2a2a2a, 0, 0.5, 0.05)); // piso
      g.add(prismMesh(1.2, 0.4, 1.1, 0.7, 0.2, color, 0, 0.5, -1.4)); // trompa
      g.add(box(0.5, 0.02, 0.4, accent, 0, 0.9, -1.25)); // número
      for (const sx of [-1, 1]) {
        g.add(box(0.25, 0.35, 1.4, color, sx * 0.68, 0.55, 0.15)); // pontones
        g.add(lamp(0.22, 0.12, 0.06, 0xfff4c0, 0x8a7a40, sx * 0.38, 0.65, -1.96));
        g.add(lamp(0.14, 0.1, 0.05, 0xd01010, 0x600000, sx * 0.5, 0.55, 1.75));
        g.add(rod([sx * 0.65, 0.6, -0.65], [sx * 0.55, 1.8, -0.25], 0.09, accent));
        g.add(rod([sx * 0.65, 0.6, 0.95], [sx * 0.55, 1.85, 0.75], 0.09, accent));
        g.add(rod([sx * 0.55, 1.8, -0.25], [sx * 0.55, 1.85, 0.75], 0.09, accent));
        g.add(rod([sx * 0.55, 1.8, -0.25], [sx * 0.45, 0.88, -1.3], 0.08, accent));
        g.add(rod([sx * 0.35, 0.85, 1.65], [sx * 0.42, 1.35, 1.95], 0.1, CHROME)); // escapes
        g.add(box(0.2, 0.1, 0.6, CHROME, sx * 0.25, 1.05, 1.35));
      }
      g.add(rod([-0.55, 1.8, -0.25], [0.55, 1.8, -0.25], 0.09, accent));
      g.add(rod([-0.55, 1.85, 0.75], [0.55, 1.85, 0.75], 0.09, accent));
      g.add(rod([-0.62, 0.97, -0.67], [0.62, 0.97, -0.67], 0.08, accent));
      g.add(lamp(0.6, 0.15, 0.1, 0xfff4c0, 0x8a7a40, 0, 1.86, -0.3));
      g.add(box(0.9, 0.45, 0.7, 0x3a3a3a, 0, 0.6, 1.35)); // motor
      for (const x of [-0.15, 0.15]) g.add(cyl(0.07, 0.25, CHROME, x, 1.05, 1.35));
      // Cola de escorpión con aguijón.
      const tail: V3[] = [[0, 1.0, 1.75], [0, 1.6, 2.05], [0, 2.25, 1.85], [0, 2.55, 1.35]];
      tail.forEach((p, i) => {
        g.add(ball(0.12 - i * 0.015, accent, ...p));
        if (i > 0) g.add(rod(tail[i - 1], p, 0.18 - i * 0.03, color));
      });
      const sting = new THREE.Mesh(CONE, mat(0xffb020, 0x885500));
      sting.scale.set(0.16, 0.42, 0.16);
      sting.rotation.x = -1.95;
      sting.position.set(0, 2.47, 1.15);
      g.add(sting);
      g.add(seatedDriver(playerLook(accent), 0.62, 0.3));
      return g;
    }
    case 'muscle': {
      // Muscle car: doble franja, compresor cromado, rejilla en la luneta, llantas
      // traseras anchas, escapes laterales y cola de pato.
      const g = carBody({ w: 2.0, l: 4.4, r: 0.38, tw: 0.34, axles: [-1.35, 1.45], rim: CHROME, y0: 0.3, h: 0.62, cab: [-0.1, 1.4], cabH: 0.46, rake: [0.45, 0.6], paint: color, bumper: CHROME, doors: 1 });
      const top = 0.92;
      for (const sx of [-1, 1]) g.add(carWheel(0.42, 0.44, sx * 0.88, 1.45, CHROME));
      for (const x of [-0.28, 0.28]) {
        g.add(box(0.26, 0.02, 2.1, accent, x, top, -1.15));
        g.add(box(0.26, 0.02, 0.53, accent, x, 1.43, 0.575));
        g.add(box(0.26, 0.02, 0.8, accent, x, top, 1.8));
      }
      g.add(box(0.7, 0.24, 0.8, 0x4a4d52, 0, top, -1.2)); // compresor
      g.add(box(0.56, 0.2, 0.36, CHROME, 0, top + 0.24, -1.28));
      g.add(box(0.5, 0.03, 0.3, 0x111111, 0, top + 0.44, -1.28));
      g.add(box(0.12, 0.1, 0.3, 0x222222, 0, top + 0.05, -1.65)); // correa
      for (let i = 1; i <= 3; i++) g.add(box(1.5, 0.03, 0.06, 0x111111, 0, top + 0.46 * (i / 4) + 0.02, 1.4 - 0.6 * (i / 4) + 0.04)); // rejilla de la luneta
      for (const sx of [-1, 1]) {
        g.add(pipe(0.07, 2.0, CHROME, sx * 1.07, 0.3, 0.05));
        g.add(pipe(0.09, 0.3, CHROME, sx * 0.6, 0.25, 2.27));
      }
      const tail = box(1.9, 0.05, 0.3, color, 0, top + 0.02, 2.05); // cola de pato
      tail.rotation.x = 0.35;
      g.add(tail);
      return g;
    }
    case 'armored': {
      // Furgón blindado del banco: cabina con rejas, caja remachada con franja y
      // emblema dorado, ariete, torreta del color secundario y lingotes en el techo.
      const green = 0x3d4a3a;
      const gold = 0xf1c40f;
      const g = new THREE.Group();
      for (const z of [-1.85, 0.95, 2.05]) for (const sx of [-1, 1]) g.add(carWheel(0.52, 0.44, sx * 1.15, z, 0x555555));
      g.add(box(2.2, 0.45, 5.2, 0x1a1a1a, 0, 0.12, 0));
      g.add(box(2.5, 0.9, 1.6, green, 0, 0.55, -2.0)); // capó y cabina
      g.add(prismMesh(2.3, 0.8, 1.0, 0.65, 0.175, GLASS, 0, 1.45, -1.7));
      g.add(box(2.36, 0.08, 0.73, green, 0, 2.22, -1.525));
      for (const sx of [-1, 1]) g.add(rod([sx * 1.16, 1.45, -2.2], [sx * 1.16, 2.25, -1.85], 0.08, green, 0.12));
      for (const x of [-0.8, -0.4, 0, 0.4, 0.8]) g.add(rod([x, 1.48, -2.24], [x, 2.22, -1.9], 0.05, 0x8a8a8a));
      g.add(box(2.6, 2.0, 4.0, green, 0, 0.55, 0.8)); // caja
      g.add(box(2.62, 0.35, 3.6, color, 0, 1.0, 0.85)); // franja
      const seal = new THREE.Mesh(CYL, mat(gold)); // emblema a ambos lados
      seal.scale.set(0.9, 2.64, 0.9);
      seal.rotation.z = Math.PI / 2;
      seal.position.set(0, 1.85, 0.8);
      g.add(seal);
      g.add(box(2.66, 0.6, 0.07, green, 0, 1.55, 0.8));
      for (const y of [1.66, 1.82, 1.98]) g.add(box(2.66, 0.07, 0.34, green, 0, y, 0.8));
      for (const sx of [-1, 1]) {
        for (let z = -1.0; z <= 2.7; z += 0.46) for (const y of [0.7, 2.45]) g.add(box(0.03, 0.06, 0.06, 0x8a9a8a, sx * 1.31, y, z));
        g.add(lamp(0.35, 0.18, 0.06, 0xfff4c0, 0x8a7a40, sx * 0.85, 1.15, -2.82));
        g.add(lamp(0.3, 0.25, 0.05, 0xd01010, 0x600000, sx * 1.05, 0.9, 2.82));
        g.add(lamp(0.18, 0.15, 0.18, 0xffb020, 0x885500, sx * 1.0, 2.55, -1.0)); // balizas
      }
      g.add(box(0.03, 1.8, 0.03, 0x1a1a1a, 0, 0.65, 2.815)); // puertas traseras
      g.add(box(0.5, 0.08, 0.1, CHROME, 0, 1.4, 2.85));
      g.add(box(2.7, 0.9, 0.35, 0x8a8a8a, 0, 0.2, -2.95)); // ariete
      for (const x of [-0.9, -0.3, 0.3, 0.9]) g.add(box(0.1, 0.95, 0.06, 0x5a5a5a, x, 0.18, -3.13));
      g.add(cyl(0.55, 0.35, accent, 0, 2.55, 0.4)); // torreta
      g.add(box(0.9, 0.4, 0.08, accent, 0, 2.65, -0.15));
      g.add(pipe(0.1, 1.3, 0x222222, 0, 2.8, -0.55));
      for (const [x, z] of [[-0.3, 1.9], [0.3, 1.9], [0, 2.4], [-0.45, 2.45], [0.4, 2.4]]) g.add(prismMesh(0.3, 0.12, 0.5, 0.38, 0, gold, x, 2.55, z)); // lingotes
      g.add(prismMesh(0.3, 0.12, 0.5, 0.38, 0, gold, 0, 2.67, 2.15));
      return g;
    }
    default:
      return motorbike(color, accent);
  }
}

/**
 * Cabina con vidrios: parabrisas y luneta inclinados (`rake`), techo y pilares del
 * color de la carrocería. `front` y `back` son las z de su base, que va en `y`.
 */
function cabin(g: THREE.Group, front: number, back: number, y: number, h: number, rake: [number, number], w: number, paint: number): void {
  const tf = front + rake[0];
  const tb = back - rake[1];
  g.add(prismMesh(w, h, back - front, tb - tf, (tf + tb - front - back) / 2, GLASS, 0, y, (front + back) / 2));
  g.add(box(w + 0.06, 0.08, tb - tf + 0.08, paint, 0, y + h - 0.03, (tf + tb) / 2)); // techo
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 + 0.01);
    g.add(rod([x, y, front], [x, y + h, tf], 0.07, paint, 0.1));
    g.add(rod([x, y, back], [x, y + h, tb], 0.07, paint, 0.16));
    if (tb - tf > 1.1) g.add(box(0.07, h, 0.12, paint, x, y, (tf + tb) / 2 + 0.1));
  }
}

interface CarSpec {
  /** Ancho y largo de la carrocería. */
  w: number;
  l: number;
  /** Radio y ancho de las llantas, z de cada eje y color del rin. */
  r: number;
  tw: number;
  axles: number[];
  rim: number;
  /** Altura del bajo de la carrocería y su alto. */
  y0: number;
  h: number;
  /** Cabina: z de su base (adelante, atrás), alto e inclinación de parabrisas y luneta. */
  cab: [number, number];
  cabH: number;
  rake: [number, number];
  paint: number;
  bumper?: number;
  /** Puertas por lado (líneas y manijas). */
  doors?: 0 | 1 | 2;
}

/**
 * Auto genérico (mira hacia -Z): ruedas con rin, bajos, carrocería, parachoques,
 * parrilla, matrícula, faros y pilotos encendidos, cabina con pilares, espejos y puertas.
 */
function carBody(c: CarSpec): THREE.Group {
  const g = new THREE.Group();
  const { w, l, y0, h, paint } = c;
  const top = y0 + h;
  for (const z of c.axles) for (const sx of [-1, 1]) g.add(carWheel(c.r, c.tw, sx * (w / 2 - c.tw / 2 + 0.1), z, c.rim));
  g.add(box(w - 0.3, y0 - 0.1, l - 0.6, 0x1a1a1a, 0, 0.12, 0)); // bajos
  g.add(box(w, h, l, paint, 0, y0, 0));
  const bumper = c.bumper ?? 0x2a2a2a;
  for (const s of [-1, 1]) g.add(box(w + 0.06, 0.22, 0.16, bumper, 0, y0 - 0.04, s * (l / 2 + 0.04)));
  g.add(box(w * 0.4, h * 0.36, 0.04, 0x151515, 0, y0 + h * 0.28, -l / 2 - 0.01)); // parrilla
  g.add(box(0.4, 0.12, 0.03, 0xe8e8e8, 0, y0, l / 2 + 0.12)); // matrícula
  for (const sx of [-1, 1]) {
    g.add(lamp(w * 0.2, 0.14, 0.05, 0xfff4c0, 0x8a7a40, sx * w * 0.33, y0 + h * 0.5, -l / 2 - 0.01));
    g.add(lamp(w * 0.16, 0.13, 0.05, 0xd01010, 0x600000, sx * w * 0.36, y0 + h * 0.5, l / 2 + 0.01));
  }
  if (c.cabH > 0) {
    cabin(g, c.cab[0], c.cab[1], top, c.cabH, c.rake, w * 0.84, paint);
    for (const sx of [-1, 1]) {
      g.add(box(0.1, 0.12, 0.16, paint, sx * (w / 2 + 0.1), top + 0.04, c.cab[0] + 0.2)); // espejos
      g.add(box(0.1, 0.04, 0.05, 0x222222, sx * (w / 2 + 0.03), top + 0.08, c.cab[0] + 0.2));
    }
  }
  const doors = c.doors ?? 0;
  if (doors > 0) {
    const [f, b] = c.cab;
    const cuts = doors === 2 ? [f + 0.05, (f + b) / 2 + 0.05, b - 0.15] : [f + 0.05, f + (b - f) * 0.7];
    for (const sx of [-1, 1]) {
      for (const z of cuts) g.add(box(0.02, h * 0.8, 0.03, 0x111111, sx * (w / 2 + 0.005), y0 + h * 0.12, z));
      for (const z of cuts.slice(1)) g.add(box(0.04, 0.05, 0.16, 0x222222, sx * (w / 2 + 0.01), y0 + h * 0.72, z - 0.22));
    }
  }
  return g;
}

export const CIVILIAN_TYPES = ['sedan', 'hatchback', 'wagon', 'compact', 'pickup', 'taxi', 'minivan', 'coupe'] as const;
export type CivilianType = (typeof CIVILIAN_TYPES)[number];
export const CIVILIAN_NAMES: Record<CivilianType, string> = {
  sedan: 'Sedán',
  hatchback: 'Hatchback',
  wagon: 'Familiar',
  compact: 'Compacto',
  pickup: 'Camioneta',
  taxi: 'Taxi',
  minivan: 'Minivan',
  coupe: 'Cupé',
};

/** Auto del tráfico de cada tipo; el taxi siempre es amarillo. */
export function civilianCar(color: number, type: CivilianType = 'sedan'): THREE.Group {
  return baked(`civ:${type}`, () => civilianBody(type), type === 'taxi' ? undefined : color);
}

/** Auto del tráfico número `i`: rota colores y tipos para que no se repitan seguidos. */
export function trafficCar(i: number): THREE.Group {
  const n = CIVILIAN_COLORS.length;
  return civilianCar(CIVILIAN_COLORS[i % n], CIVILIAN_TYPES[(i * 3 + Math.floor(i / n)) % CIVILIAN_TYPES.length]);
}

function civilianBody(type: CivilianType): THREE.Group {
  const base = { w: 1.9, r: 0.34, tw: 0.26, rim: 0xb8bcc2, paint: PAINT };
  const sedan: CarSpec = { ...base, l: 4.0, axles: [-1.25, 1.3], y0: 0.3, h: 0.58, cab: [-0.6, 1.1], cabH: 0.52, rake: [0.5, 0.4], doors: 2 };
  switch (type) {
    case 'sedan':
      return carBody(sedan);
    case 'hatchback': {
      // Cola corta con portón casi vertical y alerón sobre el portón.
      const g = carBody({ ...base, l: 3.7, axles: [-1.15, 1.2], y0: 0.3, h: 0.6, cab: [-0.5, 1.72], cabH: 0.56, rake: [0.55, 0.15], doors: 2 });
      g.add(box(1.5, 0.05, 0.24, PAINT, 0, 1.49, 1.66));
      return g;
    }
    case 'wagon': {
      // Familiar: techo largo hasta atrás con barras portaequipaje.
      const g = carBody({ ...base, l: 4.1, axles: [-1.3, 1.35], y0: 0.3, h: 0.58, cab: [-0.6, 1.95], cabH: 0.54, rake: [0.5, 0.12], doors: 2 });
      for (const sx of [-1, 1]) g.add(box(0.05, 0.06, 1.7, 0x333333, sx * 0.68, 1.47, 0.86));
      return g;
    }
    case 'compact': {
      // Compacto de ciudad, alto y corto, con el techo blanco.
      const g = carBody({ ...base, w: 1.8, l: 3.5, r: 0.32, axles: [-1.1, 1.1], y0: 0.3, h: 0.6, cab: [-0.65, 1.62], cabH: 0.6, rake: [0.38, 0.08], doors: 1 });
      g.add(box(1.6, 0.04, 1.86, 0xf2f2f2, 0, 1.54, 0.62));
      return g;
    }
    case 'pickup': {
      // Camioneta de trabajo: cabina simple y platón abierto.
      const g = carBody({ ...base, l: 4.1, r: 0.38, tw: 0.3, rim: 0x555555, axles: [-1.3, 1.3], y0: 0.4, h: 0.55, cab: [-0.45, 0.55], cabH: 0.55, rake: [0.4, 0.04], doors: 1 });
      const top = 0.95;
      g.add(box(1.7, 0.02, 1.45, 0x2a2a2a, 0, top, 1.3));
      for (const sx of [-1, 1]) g.add(box(0.1, 0.4, 1.5, PAINT, sx * 0.9, top, 1.3));
      g.add(box(1.9, 0.4, 0.08, PAINT, 0, top, 2.01));
      g.add(box(1.0, 0.3, 0.5, 0x8a6a3a, -0.2, top, 1.5)); // carga
      return g;
    }
    case 'taxi': {
      // Taxi amarillo con franja de cuadros y letrero encendido en el techo.
      const g = carBody({ ...sedan, paint: 0xf4c20d });
      for (const sx of [-1, 1]) for (let i = 0; i < 10; i++) g.add(box(0.02, 0.09, 0.2, i % 2 ? 0x111111 : 0xf4f4f4, sx * 0.96, 0.5, -1.0 + i * 0.2));
      g.add(lamp(0.62, 0.18, 0.24, 0xfff6d0, 0x6a5a20, 0, 1.45, 0.32));
      return g;
    }
    case 'minivan': {
      // Minivan alta de parabrisas muy inclinado y riel de la puerta corrediza.
      const g = carBody({ ...base, l: 4.1, r: 0.35, axles: [-1.3, 1.35], y0: 0.32, h: 0.7, cab: [-1.05, 1.95], cabH: 0.72, rake: [0.8, 0.1], doors: 2 });
      for (const sx of [-1, 1]) g.add(box(0.03, 0.04, 1.3, 0x222222, sx * 0.966, 0.85, 0.75));
      for (const z of [0.2, 1.2]) g.add(box(1.5, 0.05, 0.06, 0x333333, 0, 1.79, z));
      return g;
    }
    case 'coupe': {
      // Cupé deportivo bajo con alerón y doble escape.
      const g = carBody({ ...base, l: 4.0, r: 0.35, tw: 0.3, axles: [-1.3, 1.3], y0: 0.26, h: 0.5, cab: [-0.35, 1.05], cabH: 0.44, rake: [0.6, 0.6], doors: 1 });
      const top = 0.76;
      g.add(box(1.6, 0.05, 0.3, PAINT, 0, top + 0.22, 1.8));
      for (const sx of [-1, 1]) {
        g.add(box(0.06, 0.22, 0.08, 0x222222, sx * 0.6, top, 1.8));
        g.add(pipe(0.06, 0.2, CHROME, sx * 0.4, 0.24, 2.08));
      }
      g.add(box(0.6, 0.02, 0.5, 0x151515, 0, top, -1.3)); // toma del capó
      return g;
    }
  }
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
  const g = baked(`police:${kind}`, () => policeBody(kind));
  // Las luces de la sirena quedan fuera del horneado: cambian de material al destellar.
  const [w, x, y, z] = { moto: [0.16, 0.1, 1.18, 0.95], patrol: [0.6, 0.42, 1.57, 0.32], suv: [0.7, 0.48, 2.01, 0.1], swat: [0.55, 0.45, 2.45, -1.35] }[kind];
  const red = box(w, 0.15, kind === 'moto' ? 0.13 : 0.28, 0xff0000, -x, y, z);
  const blue = box(w, 0.15, kind === 'moto' ? 0.13 : 0.28, 0x0000ff, x, y, z);
  g.add(red, blue);
  return { group: g, red, blue };
}

/** Defensa delantera de tubos (push bar) frente a `z`, de ancho `w` y alto `h`. */
function pushBar(g: THREE.Group, w: number, h: number, z: number, color = 0x111111): void {
  for (const y of [0.35, h]) g.add(box(w, 0.08, 0.08, color, 0, y, z));
  for (const sx of [-1, 1]) {
    g.add(box(0.08, h - 0.2, 0.08, color, sx * w * 0.38, 0.3, z));
    g.add(box(0.08, 0.08, 0.16, color, sx * w * 0.38, 0.5, z + 0.1));
  }
}

function policeBody(kind: 'patrol' | 'moto' | 'suv' | 'swat'): THREE.Group {
  const white = 0xf4f4f4;
  const black = 0x111111;
  const badge = 0xd4a017;
  switch (kind) {
    case 'moto': {
      const g = motorcycle('police', 0xf2f2f2, 0x1d4ed8);
      g.add(rider(LOOKS.police));
      return g;
    }
    case 'patrol': {
      // Patrulla blanca y negra con franja azul, escudo, defensa, barra de luces y antena.
      const g = carBody({ w: 2.0, l: 4.2, r: 0.37, tw: 0.3, axles: [-1.3, 1.35], rim: 0xbfc3c8, y0: 0.32, h: 0.6, cab: [-0.6, 1.15], cabH: 0.54, rake: [0.5, 0.4], paint: white, bumper: black, doors: 2 });
      g.add(box(2.02, 0.61, 1.51, black, 0, 0.32, -1.355)); // frente negro
      g.add(box(2.02, 0.61, 0.96, black, 0, 0.32, 1.63)); // cola negra
      g.add(box(2.03, 0.1, 1.9, 0x1d4ed8, 0, 0.62, 0.28)); // franja
      for (const sx of [-1, 1]) g.add(box(0.02, 0.18, 0.18, badge, sx * 1.02, 0.42, -0.25));
      pushBar(g, 1.3, 0.78, -2.32);
      g.add(box(1.5, 0.06, 0.34, 0x222222, 0, 1.51, 0.32)); // base de la barra de luces
      g.add(lamp(0.2, 0.12, 0.26, white, 0x777777, 0, 1.57, 0.32));
      g.add(rod([0.6, 0.92, 1.9], [0.62, 1.8, 2.0], 0.025, black)); // antena
      g.add(box(0.1, 0.12, 0.18, 0xd0d0d0, -1.0, 0.95, -0.45)); // faro buscador
      return g;
    }
    case 'suv': {
      // SUV negra de puertas blancas: estribos, barras de techo, defensa reforzada y llanta de repuesto.
      const g = carBody({ w: 2.3, l: 4.8, r: 0.46, tw: 0.36, axles: [-1.55, 1.55], rim: 0x8a8e93, y0: 0.48, h: 0.72, cab: [-0.95, 2.25], cabH: 0.7, rake: [0.55, 0.12], paint: 0x1a1a1a, bumper: black, doors: 2 });
      g.add(box(2.32, 0.5, 2.7, white, 0, 0.6, 0.65)); // puertas blancas
      for (const sx of [-1, 1]) {
        g.add(box(0.02, 0.16, 0.16, badge, sx * 1.17, 0.85, -0.1));
        g.add(box(0.2, 0.06, 2.4, 0x333333, sx * 1.24, 0.42, 0.1)); // estribos
        g.add(box(0.06, 0.06, 2.2, 0x333333, sx * 0.85, 1.95, 0.95)); // barras de techo
      }
      pushBar(g, 1.6, 0.95, -2.55);
      g.add(box(1.7, 0.06, 0.36, 0x222222, 0, 1.95, 0.1));
      g.add(lamp(0.22, 0.12, 0.28, white, 0x777777, 0, 2.01, 0.1));
      g.add(pipe(0.4, 0.24, 0x161616, 0, 1.15, 2.62)); // repuesto
      g.add(pipe(0.22, 0.28, 0x8a8e93, 0, 1.15, 2.62));
      return g;
    }
    case 'swat': {
      // Blindado SWAT: casco alto de flancos inclinados, ventanillas pequeñas, troneras,
      // ariete, escotilla con lanzagranadas, franja blanca y escalera trasera.
      const navy = 0x1c2b45;
      const dark = 0x0f1a2e;
      const g = new THREE.Group();
      for (const z of [-1.8, 1.8]) for (const sx of [-1, 1]) g.add(carWheel(0.55, 0.42, sx * 1.15, z, 0x3a3a3a));
      g.add(box(2.2, 0.4, 5.0, 0x151515, 0, 0.15, 0));
      g.add(box(2.6, 0.85, 5.6, navy, 0, 0.55, 0));
      g.add(prismMesh(2.4, 1.05, 4.9, 4.3, 0.15, navy, 0, 1.4, 0.35));
      for (const sx of [-1, 1]) {
        g.add(rod([sx * 0.55, 1.727, -1.993], [sx * 0.55, 2.302, -1.748], 0.85, GLASS, 0.04)); // parabrisas
        for (const z of [-0.9, 0.4]) {
          g.add(box(0.03, 0.32, 0.6, GLASS, sx * 1.205, 1.85, z));
          g.add(box(0.03, 0.12, 0.12, 0x050505, sx * 1.205, 1.6, z));
        }
        for (const z of [-1.6, -0.3, 1.0]) g.add(box(0.02, 0.75, 0.03, dark, sx * 1.31, 0.6, z));
        g.add(lamp(0.35, 0.18, 0.06, 0xfff4c0, 0x8a7a40, sx * 0.85, 1.0, -2.82));
        g.add(lamp(0.3, 0.16, 0.06, 0xd01010, 0x600000, sx * 1.05, 1.0, 2.82));
        g.add(lamp(0.2, 0.15, 0.15, 0xfff4c0, 0x8a7a40, sx * 1.0, 2.45, -1.45));
      }
      g.add(box(2.62, 0.18, 2.6, white, 0, 1.08, 0.6)); // franja "SWAT"
      g.add(box(1.2, 0.02, 0.4, dark, 0, 1.4, -2.45)); // rejilla del capó
      g.add(box(2.7, 0.5, 0.2, 0x3a3a3a, 0, 0.35, -2.9)); // ariete
      for (const x of [-0.8, 0, 0.8]) g.add(box(0.12, 0.7, 0.12, 0x555555, x, 0.25, -3.02));
      g.add(cyl(0.5, 0.12, dark, 0, 2.45, 0.6)); // escotilla
      g.add(box(0.9, 0.45, 0.08, 0x2a3a55, 0, 2.57, 0.15));
      g.add(pipe(0.2, 0.3, 0x2a2a2a, 0, 2.85, 0.55)); // tambor del lanzagranadas
      g.add(pipe(0.1, 0.8, 0x1a1a1a, 0, 2.95, 0.1, 0.25));
      g.add(box(0.03, 1.6, 0.03, dark, 0, 0.7, 2.815)); // puertas traseras
      for (let i = 0; i < 5; i++) g.add(box(0.5, 0.05, 0.05, 0x777777, 0.55, 0.75 + i * 0.35, 2.85)); // escalera
      for (const sx of [-1, 1]) g.add(box(0.05, 1.6, 0.05, 0x777777, 0.55 + sx * 0.25, 0.7, 2.85));
      return g;
    }
  }
}

export interface HeliMesh {
  group: THREE.Group;
  rotor: THREE.Group;
  /** Rotor de cola: gira sobre el eje X. */
  tailRotor: THREE.Group;
  shadow: THREE.Mesh;
  spot: THREE.Mesh;
}

/** Elipsoide con centro en (x, y, z) y diámetros sx, sy, sz (fuselajes, cuerpos de criaturas). */
function blob(sx: number, sy: number, sz: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(SPHERE, mat(color));
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Cono orientado: `rx`/`rz` giran la punta (que de base apunta hacia +Y). */
function spike(r: number, len: number, color: number, x: number, y: number, z: number, rx: number, rz = 0, emissive?: number): THREE.Mesh {
  const m = new THREE.Mesh(CONE, mat(color, emissive));
  m.scale.set(r * 2, len, r * 2);
  m.rotation.set(rx, 0, rz);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Botalón de cola: cono truncado que se afina hacia su extremo +Y. */
const BOOM = shareGeometry(new THREE.CylinderGeometry(0.2, 0.5, 1, 10));
/** Disco translúcido que simula el barrido del rotor principal. */
const ROTOR_DISC = shareGeometry(new THREE.CircleGeometry(5.7, 32).rotateX(-Math.PI / 2));
const ROTOR_BLUR = new THREE.MeshLambertMaterial({ color: 0x2a2d33, transparent: true, opacity: 0.16, depthWrite: false });

/** Fuselaje del helicóptero policial (mira hacia -Z): cabina de cristal, botalón, aletas, patines y armas. */
function heliBody(): THREE.Group {
  const navy = 0x1c2b45;
  const white = 0xeef1f5;
  const dark = 0x16181c;
  const glass = 0x4f7898;
  const metal = 0x2b2d31;
  const g = new THREE.Group();
  // Cabina redondeada con franja blanca en la cintura, morro y cúpula de cristal.
  g.add(blob(2.3, 2.0, 4.6, navy, 0, 1.0, -0.1));
  g.add(blob(2.42, 0.9, 4.1, white, 0, 0.75, 0.05));
  g.add(blob(1.7, 1.3, 2.0, navy, 0, 0.75, -2.2));
  g.add(blob(2.0, 1.45, 2.4, glass, 0, 1.25, -1.75));
  g.add(blob(2.34, 0.6, 1.2, glass, 0, 1.35, 0.1)); // ventanillas laterales
  g.add(rod([0, 1.99, -1.5], [0, 1.68, -2.8], 0.08, dark)); // marco central del parabrisas
  // Turbina sobre el techo, tomas de aire, escapes, mástil y balizas.
  g.add(prismMesh(1.3, 0.6, 2.6, 1.8, 0.2, navy, 0, 1.75, 0.6));
  g.add(box(1.32, 0.03, 0.5, white, 0, 2.35, 1.3));
  for (const sx of [-1, 1]) {
    g.add(box(0.2, 0.26, 0.45, dark, sx * 0.62, 1.95, 0.05));
    g.add(pipe(0.15, 0.55, metal, sx * 0.4, 2.08, 1.95));
  }
  g.add(cyl(0.16, 0.4, dark, 0, 2.3, 0.3));
  g.add(lamp(0.22, 0.14, 0.22, 0xd01010, 0x900000, -0.36, 2.33, -0.35));
  g.add(lamp(0.22, 0.14, 0.22, 0x1848ff, 0x0828b0, 0.36, 2.33, -0.35));
  // Botalón de cola con franja, deriva, estabilizador y luces de navegación.
  const boom = new THREE.Mesh(BOOM, mat(navy));
  boom.scale.set(1, 4.8, 0.9);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 1.35, 4.2);
  g.add(boom);
  g.add(rod([0, 1.84, 2.0], [0, 1.58, 6.3], 0.14, white, 0.04));
  g.add(prismMesh(0.12, 1.5, 1.2, 0.75, 0.45, navy, 0, 1.35, 6.25));
  g.add(prismMesh(0.1, 0.55, 0.5, 0.8, -0.2, navy, 0, 0.85, 6.35));
  g.add(box(0.14, 0.3, 0.72, white, 0, 2.55, 6.72));
  g.add(box(2.4, 0.08, 0.55, navy, 0, 1.3, 5.3));
  for (const sx of [-1, 1]) {
    g.add(box(0.08, 0.5, 0.55, white, sx * 1.2, 1.1, 5.3));
    g.add(lamp(0.1, 0.12, 0.14, sx < 0 ? 0xd01010 : 0x20d040, sx < 0 ? 0x900000 : 0x0e8a28, sx * 1.27, 1.2, 5.3));
  }
  g.add(lamp(0.12, 0.12, 0.12, 0xffffff, 0xbbbbbb, 0, 2.85, 6.95));
  // Patines con su curva al frente y los soportes.
  for (const sx of [-1, 1]) {
    g.add(pipe(0.07, 4.6, metal, sx * 1.2, -0.45, -0.1));
    g.add(rod([sx * 1.2, -0.45, -2.38], [sx * 1.2, -0.12, -2.85], 0.14, metal));
    for (const z of [-1.3, 1.2]) g.add(rod([sx * 0.72, 0.3, z], [sx * 1.2, -0.45, z], 0.12, metal));
  }
  // Alas cortas con ametralladoras a cada lado.
  g.add(box(3.4, 0.12, 0.6, navy, 0, 0.55, 0.3));
  for (const sx of [-1, 1]) {
    g.add(pipe(0.17, 1.1, dark, sx * 1.62, 0.42, 0.15));
    g.add(pipe(0.05, 0.75, 0x0d0d0d, sx * 1.62, 0.42, -0.75));
    g.add(box(0.12, 0.18, 0.5, metal, sx * 1.62, 0.55, 0.15));
  }
  // Reflector bajo el morro y antena.
  g.add(ball(0.24, dark, 0, 0.18, -2.55));
  g.add(lamp(0.3, 0.05, 0.3, 0xfff6c0, 0xfff0a0, 0, -0.05, -2.55));
  g.add(rod([0, 0.08, 0.9], [0, -0.32, 1.4], 0.04, dark));
  return g;
}

/** Rotor principal: cuatro palas con puntas amarillas sobre un buje. */
function heliRotor(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.38, 0.28, 0x16181c, 0, -0.12, 0));
  g.add(cyl(0.2, 0.15, 0x55585e, 0, 0.16, 0));
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.y = Math.PI / 4 + (i * Math.PI) / 2;
    arm.add(box(0.42, 0.05, 5.4, 0x1b1b1b, 0, 0, 2.95));
    arm.add(box(0.43, 0.055, 0.45, 0xf1c40f, 0, 0, 5.45));
    for (const sx of [-1, 1]) arm.add(box(0.06, 0.1, 0.5, 0x55585e, sx * 0.12, -0.02, 0.45));
    g.add(arm);
  }
  return g;
}

/** Rotor de cola: dos palas cruzadas en el plano YZ. */
function heliTailRotor(): THREE.Group {
  const g = new THREE.Group();
  const hub = new THREE.Mesh(CYL, mat(0x16181c));
  hub.scale.set(0.22, 0.2, 0.22);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  g.add(box(0.05, 1.6, 0.16, 0x1b1b1b, 0.06, -0.8, 0));
  g.add(box(0.05, 0.16, 1.6, 0x1b1b1b, 0.06, -0.08, 0));
  for (const y of [-0.82, 0.74]) g.add(box(0.055, 0.08, 0.17, 0xf1c40f, 0.06, y, 0));
  for (const z of [-0.78, 0.78]) g.add(box(0.055, 0.17, 0.08, 0xf1c40f, 0.06, -0.08, z));
  return g;
}

export function helicopter(): HeliMesh {
  const g = baked('heli', heliBody);
  const rotor = new THREE.Group();
  rotor.add(baked('heli:rotor', heliRotor));
  const blur = new THREE.Mesh(ROTOR_DISC, ROTOR_BLUR);
  blur.position.y = 0.03;
  rotor.add(blur);
  rotor.position.set(0, 2.62, 0.3);
  g.add(rotor);
  const tailRotor = new THREE.Group();
  tailRotor.add(baked('heli:tail', heliTailRotor));
  tailRotor.position.set(0.12, 2.25, 6.7);
  g.add(tailRotor);
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
  return { group: g, rotor, tailRotor, shadow, spot };
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
      return civilianCar(PARKED_COLORS[Math.floor(variant * PARKED_COLORS.length)], CIVILIAN_TYPES[Math.floor(variant * 56) % CIVILIAN_TYPES.length]);
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
      g.add(humanoid(variant > 0.5 ? 0x7d9a6a : 0x8a9a7a, variant > 0.5 ? 0x4a3f35 : 0x3b4a5a, 'zombie', 1));
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

/** Postura de la figura: zombi con los brazos al frente, tirador con rifle al hombro o artillero en una ametralladora montada. */
export type HumanPose = 'zombie' | 'rifle' | 'gunner';

/**
 * Figura humanoide (mira hacia -Z), con zapatos, pantalón, cinturón, camisa,
 * cuello, cara y manos. El zombi lleva ropa rota, costillas a la vista, ojos
 * verdes que brillan y la mandíbula colgando. El tirador de la banda lleva
 * pañuelo y gafas oscuras, y apunta un rifle a la altura del hombro; el
 * artillero agarra las manijas de una ametralladora montada en un poste, con
 * escudo y caja de munición, a la altura del pecho.
 */
export function humanoid(skin: number, cloth: number, pose: HumanPose, scale: number): THREE.Group {
  const g = new THREE.Group();
  const zombie = pose === 'zombie';
  const pants = zombie ? 0x3a3530 : 0x2a3a5a;
  // Piernas y zapatos (al zombi le falta uno).
  for (const sx of [-1, 1]) {
    g.add(box(0.22, 0.74, 0.25, pants, sx * 0.16, 0.08, 0));
    if (!zombie || sx < 0) g.add(box(0.24, 0.12, 0.34, 0x1e1e1e, sx * 0.16, 0, -0.04));
    else g.add(box(0.2, 0.1, 0.28, skin, sx * 0.16, 0, -0.04));
  }
  g.add(box(0.6, 0.09, 0.34, 0x3a2a1a, 0, 0.8, 0)); // cinturón
  g.add(box(0.6, 0.72, 0.34, cloth, 0, 0.86, 0)); // camisa
  if (zombie) {
    // Rasgones y costillas a la vista.
    g.add(box(0.2, 0.3, 0.02, skin, 0.14, 1.05, -0.18));
    for (let i = 0; i < 3; i++) g.add(box(0.16, 0.035, 0.02, 0xe8e2c8, 0.14, 0.98 + i * 0.09, -0.19));
    g.add(box(0.24, 0.2, 0.02, 0x5e7444, -0.16, 0.95, -0.18));
  } else {
    g.add(box(0.1, 0.3, 0.02, 0xd9d9d9, 0, 1.22, -0.18)); // cuello de la camisa
  }
  g.add(box(0.16, 0.1, 0.16, skin, 0, 1.58, 0)); // cuello
  // Cabeza con cara.
  const head = new THREE.Group();
  head.position.set(0, 1.68, 0);
  if (zombie) head.rotation.z = 0.18;
  g.add(head);
  head.add(box(0.38, 0.4, 0.36, skin, 0, 0, 0));
  if (zombie) {
    for (const x of [-0.09, 0.09]) head.add(lamp(0.08, 0.06, 0.03, 0x9dff6a, 0x39ff14, x, 0.22, -0.19));
    head.add(box(0.26, 0.1, 0.06, 0x2a1a1a, 0, 0.04, -0.19)); // boca abierta
    head.add(box(0.24, 0.08, 0.2, skin, 0, -0.06, -0.12)); // mandíbula colgando
    head.add(box(0.2, 0.06, 0.38, 0x3a3a2a, -0.08, 0.4, 0)); // mechones
    // Brazos estirados al frente.
    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(sx * 0.4, 1.48, 0);
      arm.rotation.x = -Math.PI / 2 + (sx > 0 ? 0.15 : -0.1);
      g.add(arm);
      arm.add(box(0.18, 0.62, 0.2, skin, 0, -0.62, 0));
      arm.add(box(0.15, 0.14, 0.17, skin, 0, -0.76, 0));
    }
  } else {
    head.add(box(0.4, 0.1, 0.38, 0x2a1a10, 0, 0.36, 0.02)); // pelo
    head.add(box(0.41, 0.09, 0.39, 0xb03a2e, 0, 0.3, 0)); // pañuelo
    head.add(box(0.36, 0.07, 0.04, 0x0b0b0b, 0, 0.22, -0.18)); // gafas oscuras
    head.add(box(0.14, 0.03, 0.03, 0x6b3a2a, 0, 0.08, -0.18)); // boca
    // Brazos del hombro a las manos, que sostienen el arma.
    const hands: V3[] = pose === 'rifle' ? [[0.1, 1.3, -0.62], [0.17, 1.27, -0.24]] : [[-0.13, 1.18, -0.47], [0.13, 1.18, -0.47]];
    [-1, 1].forEach((sx, i) => {
      const [hx, hy, hz] = hands[i];
      g.add(rod([sx * 0.39, 1.44, 0], [hx, hy + 0.04, hz], 0.17, cloth));
      g.add(box(0.14, 0.13, 0.15, skin, hx, hy - 0.04, hz));
    });
    const gun = 0x1a1a1a;
    if (pose === 'rifle') {
      // Rifle apoyado en el hombro derecho, apuntando al frente.
      const wood = 0x5a3a1a;
      g.add(box(0.09, 0.16, 0.3, wood, 0.15, 1.28, -0.12)); // culata
      g.add(box(0.1, 0.15, 0.42, gun, 0.15, 1.32, -0.46)); // cajón de mecanismos
      g.add(box(0.1, 0.11, 0.26, wood, 0.15, 1.33, -0.78)); // guardamanos
      g.add(pipe(0.025, 0.36, 0x111111, 0.15, 1.39, -1.08)); // cañón
      g.add(box(0.06, 0.07, 0.2, 0x111111, 0.15, 1.47, -0.42)); // mira
      const mag = box(0.07, 0.22, 0.1, gun, 0.15, 1.1, -0.5);
      mag.rotation.x = 0.3;
      g.add(mag);
    } else {
      // Ametralladora montada sobre un poste, delante del pecho.
      g.add(box(0.4, 0.05, 0.4, 0x333333, 0, 0, -0.75));
      g.add(box(0.1, 1.12, 0.1, 0x333333, 0, 0.03, -0.75)); // poste
      g.add(box(0.2, 0.2, 0.75, gun, 0, 1.12, -0.8)); // cuerpo
      g.add(pipe(0.07, 0.45, 0x2a2a2a, 0, 1.24, -1.4)); // camisa del cañón
      g.add(pipe(0.035, 0.35, 0x111111, 0, 1.24, -1.78)); // cañón
      for (const sx of [-1, 1]) g.add(box(0.05, 0.18, 0.05, 0x111111, sx * 0.13, 1.08, -0.47)); // manijas
      g.add(box(0.95, 0.55, 0.05, 0x5a5a4a, 0, 0.98, -1.08)); // escudo
      g.add(box(0.2, 0.2, 0.28, 0x3d4a2a, -0.21, 1.08, -0.82)); // caja de munición
      g.add(box(0.1, 0.03, 0.14, 0xc8a040, -0.1, 1.27, -0.82)); // cinta de balas
    }
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

/** Membrana plana (grosor 0,05) con el contorno dado en el plano XZ; se comparte entre harpías. */
function membrane(points: [number, number][]): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.025, 0);
  geo.computeVertexNormals();
  return shareGeometry(geo);
}

/** Tramo interior del ala derecha (hombro → codo) y tramo exterior entre los dedos (codo → punta). */
let wingGeos: { inner: THREE.BufferGeometry; outer: THREE.BufferGeometry } | null = null;
const WING_ELBOW = 2.5;
/** Puntas de los tres dedos del ala exterior, relativas al codo (x hacia afuera, z hacia atrás). */
const WING_FINGERS: [number, number][] = [
  [3.0, -0.35],
  [2.6, 0.9],
  [1.3, 1.55],
];

/** Harpía mutante: criatura voladora de alas membranosas que escupe ácido. */
export function harpy(): HarpyMesh {
  const hide = 0x5e4062;
  const belly = 0xa8907c;
  const skin = 0x7d3352;
  const bone = 0x2e2228;
  const claw = 0xe8e2c8;
  const acid = 0x39ff14;
  const glow = 0x2fd10f;
  wingGeos ??= {
    inner: membrane([[0, -0.3], [WING_ELBOW, -0.5], [2.4, 0.6], [1.6, 0.95], [0.9, 1.35], [0, 1.4]]),
    outer: membrane([[0, -0.05], [3.0, -0.35], [2.35, 0.35], [2.6, 0.9], [1.75, 1.0], [1.3, 1.55], [0.6, 1.15], [-0.1, 1.1]]),
  };
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  // Torso: pecho, abdomen, vientre claro, hombros musculosos y sacos de ácido que brillan.
  body.add(blob(1.1, 0.9, 1.7, hide, 0, -0.05, -0.35));
  body.add(blob(0.85, 0.75, 1.5, hide, 0, -0.1, 0.6));
  body.add(blob(0.8, 0.5, 1.9, belly, 0, -0.3, 0.05));
  for (const sx of [-1, 1]) {
    body.add(blob(0.6, 0.5, 0.8, hide, sx * 0.42, 0.08, -0.45));
    body.add(blob(0.3, 0.26, 0.4, acid, sx * 0.24, -0.46, -0.25));
    (body.children[body.children.length - 1] as THREE.Mesh).material = mat(acid, glow);
  }
  // Púas a lo largo del lomo
  for (let i = 0; i < 5; i++) body.add(spike(0.07, 0.42 - i * 0.05, bone, 0, 0.42 - i * 0.04, -0.8 + i * 0.38, 1.1));
  // Cuello y cabeza: cráneo alargado, pico ganchudo con dientes, cuatro ojos verdes y cuernos hacia atrás.
  body.add(blob(0.5, 0.45, 1.0, hide, 0, 0.02, -1.35));
  body.add(blob(0.32, 0.26, 0.5, acid, 0, -0.18, -1.3));
  (body.children[body.children.length - 1] as THREE.Mesh).material = mat(acid, glow);
  const head = new THREE.Group();
  head.position.set(0, 0.12, -1.85);
  body.add(head);
  head.add(blob(0.62, 0.5, 0.85, hide, 0, 0, -0.05));
  head.add(spike(0.19, 0.95, 0xd8c08a, 0, -0.02, -0.75, -Math.PI / 2));
  head.add(spike(0.05, 0.2, 0xd8c08a, 0, -0.12, -1.15, Math.PI));
  for (const sx of [-1, 1]) {
    for (const z of [-0.45, -0.68]) head.add(spike(0.03, 0.14, claw, sx * (0.13 + z * 0.1), -0.13, z, Math.PI));
    head.add(lamp(0.1, 0.09, 0.06, acid, glow, sx * 0.18, 0.04, -0.4));
    head.add(lamp(0.06, 0.06, 0.05, acid, glow, sx * 0.12, 0.14, -0.33));
    head.add(spike(0.06, 0.75, bone, sx * 0.3, 0.3, 0.42, 1.2, -sx * 0.4));
    head.add(spike(0.04, 0.45, bone, sx * 0.3, 0.05, 0.3, 1.4, -sx * 0.9));
  }
  for (let i = 0; i < 3; i++) head.add(spike(0.06, 0.45 - i * 0.1, bone, 0, 0.28, 0.05 + i * 0.22, 1.2));
  // Mandíbula (gira en X; negativo la abre) con baba de ácido.
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.12, -0.25);
  head.add(jaw);
  jaw.add(spike(0.15, 0.7, 0xb8a070, 0, -0.06, -0.38, -Math.PI / 2));
  jaw.add(spike(0.04, 0.3, acid, 0, -0.2, -0.5, Math.PI, 0, glow));
  // Alas de murciélago: brazo y membrana hasta el codo; después tres dedos con la membrana entre ellos.
  const wings = [-1, 1].map((s) => {
    const inner = new THREE.Group();
    inner.position.set(s * 0.5, 0.1, -0.45);
    body.add(inner);
    const innerSkin = new THREE.Mesh(wingGeos!.inner, mat(skin));
    innerSkin.scale.x = s;
    innerSkin.castShadow = true;
    inner.add(innerSkin);
    inner.add(rod([0, 0.04, -0.3], [s * WING_ELBOW, 0.04, -0.5], 0.18, bone));
    inner.add(blob(1.1, 0.3, 0.45, hide, s * 0.55, 0.04, -0.25));
    const outer = new THREE.Group();
    outer.position.set(s * WING_ELBOW, 0, -0.5);
    inner.add(outer);
    const outerSkin = new THREE.Mesh(wingGeos!.outer, mat(skin));
    outerSkin.scale.x = s;
    outerSkin.castShadow = true;
    outer.add(outerSkin);
    for (const [fx, fz] of WING_FINGERS) outer.add(rod([0, 0.04, 0], [s * fx, 0.04, fz], 0.1, bone));
    outer.add(ball(0.13, bone, 0, 0.04, 0));
    outer.add(spike(0.06, 0.38, claw, 0, 0.05, -0.25, -Math.PI / 2)); // garra del pulgar
    outer.add(spike(0.06, 0.4, claw, s * 3.15, 0.04, -0.37, 0, -s * Math.PI / 2));
    return { inner, outer };
  });
  // Patas colgantes con tres garras cada una.
  for (const sx of [-1, 1]) {
    body.add(rod([sx * 0.28, -0.35, 0.55], [sx * 0.32, -0.75, 0.95], 0.18, hide));
    body.add(rod([sx * 0.32, -0.75, 0.95], [sx * 0.3, -0.88, 1.45], 0.11, bone));
    for (const k of [-1, 0, 1]) body.add(spike(0.04, 0.3, claw, sx * 0.3 + k * 0.08, -0.98, 1.38, Math.PI * 0.75));
  }
  // Cola larga y segmentada con púas, terminada en una punta de flecha.
  const tail = new THREE.Group();
  tail.position.set(0, -0.1, 1.2);
  body.add(tail);
  tail.add(blob(0.42, 0.36, 1.1, hide, 0, 0, 0.45));
  tail.add(blob(0.3, 0.26, 1.0, hide, 0, -0.02, 1.3));
  tail.add(blob(0.2, 0.17, 0.9, hide, 0, -0.04, 2.05));
  for (let i = 0; i < 3; i++) tail.add(spike(0.05, 0.28 - i * 0.05, bone, 0, 0.2 - i * 0.05, 0.5 + i * 0.75, 1.2));
  const spade = box(0.42, 0.06, 0.42, bone, 0, -0.07, 2.65);
  spade.rotation.y = Math.PI / 4;
  tail.add(spade);
  for (const sx of [-1, 1]) tail.add(spike(0.05, 0.35, bone, sx * 0.3, -0.04, 2.45, 1.9, -sx * 1.0));

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.6, 0.6, 1);
  return { group, body, wings, tail, jaw, shadow };
}

type OutlawKind = Exclude<PursuerKind, 'patrol' | 'moto' | 'suv' | 'swat' | 'mutant' | 'flyer'>;

/** Vehículos de la banda rival y de la tierra baldía. */
export function outlawVehicle(kind: OutlawKind): THREE.Group {
  return baked(`outlaw:${kind}`, () => outlawBody(kind));
}

/** Hilera de púas mirando hacia -Z, a lo ancho de `w`. */
function spikes(g: THREE.Group, w: number, z: number, y: number): void {
  for (let x = -w / 2 + 0.3; x <= w / 2 - 0.29; x += 0.5) {
    const c = new THREE.Mesh(CONE, mat(0xb0b0b0));
    c.scale.set(0.25, 0.7, 0.25);
    c.rotation.x = -Math.PI / 2;
    c.position.set(x, y, z);
    c.castShadow = true;
    g.add(c);
  }
}

/** Púa que sale hacia afuera del centro de una rueda (lado `sx`). */
function hubSpike(g: THREE.Group, sx: number, x: number, y: number, z: number): void {
  const c = new THREE.Mesh(CONE, mat(0xb0b0b0));
  c.scale.set(0.14, 0.4, 0.14);
  c.rotation.z = -sx * Math.PI / 2;
  c.position.set(x + sx * 0.2, y, z);
  g.add(c);
}

/** Calavera de adorno mirando hacia -Z. */
function skull(g: THREE.Group, x: number, y: number, z: number, r = 0.18): void {
  g.add(ball(r, 0xe8e2c8, x, y, z));
  for (const sx of [-1, 1]) g.add(box(r * 0.45, r * 0.4, 0.04, 0x111111, x + sx * r * 0.4, y, z - r * 0.85));
  g.add(box(r * 0.8, r * 0.3, r * 0.8, 0xe8e2c8, x, y - r * 1.1, z - r * 0.1));
}

function outlawBody(kind: OutlawKind): THREE.Group {
  switch (kind) {
    case 'pyro':
      return pyroVehicle();
    case 'muscle': {
      // Muscle car rojo: franjas blancas, compresor con toma cromada, escapes laterales y alerón.
      const red = 0x8e1b1b;
      const g = carBody({ w: 2.0, l: 4.4, r: 0.38, tw: 0.34, axles: [-1.35, 1.45], rim: CHROME, y0: 0.3, h: 0.6, cab: [-0.15, 1.35], cabH: 0.48, rake: [0.5, 0.55], paint: red, bumper: CHROME, doors: 1 });
      const top = 0.9;
      for (const x of [-0.25, 0.25]) {
        g.add(box(0.25, 0.02, 2.05, 0xffffff, x, top, -1.175));
        g.add(box(0.25, 0.02, 0.85, 0xffffff, x, top, 1.775));
        g.add(box(0.25, 0.02, 0.53, 0xffffff, x, 1.43, 0.575));
      }
      g.add(box(0.62, 0.22, 0.7, 0x4a4d52, 0, top, -1.2)); // compresor
      g.add(box(0.5, 0.18, 0.34, CHROME, 0, top + 0.22, -1.28));
      g.add(box(0.44, 0.03, 0.28, 0x111111, 0, top + 0.4, -1.28));
      for (const sx of [-1, 1]) {
        g.add(pipe(0.07, 2.0, CHROME, sx * 1.07, 0.3, 0.05)); // escapes laterales
        g.add(box(0.07, 0.25, 0.1, 0x111111, sx * 0.65, top, 2.0));
        g.add(pipe(0.08, 0.25, CHROME, sx * 0.6, 0.25, 2.27));
      }
      g.add(box(1.8, 0.06, 0.34, red, 0, top + 0.25, 2.0)); // alerón
      return g;
    }
    case 'biker': {
      // Chopper negro con llamas; el motero va casi erguido, con los brazos arriba.
      const g = motorcycle('chopper', 0x161616, 0xe67e22);
      g.add(rider(LOOKS.biker, 1.32, -0.55, 0.12));
      return g;
    }
    case 'pickup': {
      // Pickup militar con defensa y cabrestante, snorkel, barra de luces, cajas de
      // munición y un artillero en el platón con una ametralladora montada.
      const olive = 0x4a5a3a;
      const dark = 0x3a4a2a;
      const g = carBody({ w: 2.1, l: 4.8, r: 0.48, tw: 0.4, axles: [-1.55, 1.6], rim: 0x2a2a2a, y0: 0.55, h: 0.62, cab: [-0.85, 0.35], cabH: 0.65, rake: [0.45, 0.04], paint: olive, doors: 1 });
      const top = 1.17;
      g.add(box(0.7, 0.02, 0.6, dark, 0.4, top, -1.7)); // manchas de camuflaje
      g.add(box(0.6, 0.02, 0.5, dark, -0.45, top, -1.1));
      g.add(box(1.9, 0.02, 1.95, 0x2a2a2a, 0, top, 1.38)); // platón
      for (const sx of [-1, 1]) g.add(box(0.1, 0.42, 2.0, dark, sx * 1.0, top, 1.38));
      g.add(box(2.1, 0.42, 0.1, dark, 0, top, 2.35));
      for (const sx of [-1, 1]) g.add(rod([sx * 0.9, top, 0.5], [sx * 0.9, top + 0.6, 0.5], 0.1, 0x222222));
      g.add(rod([-0.9, top + 0.6, 0.5], [0.9, top + 0.6, 0.5], 0.1, 0x222222));
      for (const x of [-0.65, -0.35, 0.35, 0.65]) g.add(lamp(0.24, 0.2, 0.12, 0xfff4c0, 0x8a7a40, x, top + 0.65, 0.48));
      pushBar(g, 1.7, 1.0, -2.55, 0x222222);
      g.add(box(0.5, 0.2, 0.15, 0x333333, 0, 0.6, -2.47)); // cabrestante
      g.add(rod([1.1, 0.95, -1.05], [1.1, 1.95, -0.85], 0.1, 0x111111)); // snorkel
      g.add(box(0.14, 0.12, 0.24, 0x111111, 1.1, 1.9, -0.95));
      g.add(box(0.5, 0.3, 0.4, 0x3d4a2a, -0.6, top, 2.05)); // munición
      g.add(box(0.45, 0.28, 0.4, 0x3d4a2a, 0.6, top, 2.05));
      const gunner = humanoid(0xd2a07a, 0x222222, 'gunner', 0.8);
      gunner.position.set(0, top, 1.6);
      g.add(gunner);
      return g;
    }
    case 'truck': {
      // Tráiler de la banda: tractocamión rojo con parrilla cromada, chimeneas, deflector
      // y defensa de tubos; caja grafiteada con calavera, y un artillero tras sacos de arena.
      const red = 0x7a1f1f;
      const g = new THREE.Group();
      g.add(box(1.3, 0.3, 8.6, 0x222222, 0, 0.5, -0.2)); // chasis
      for (const z of [-3.7, -1.5, -0.45, 2.9, 3.95]) for (const sx of [-1, 1]) g.add(carWheel(0.55, 0.42, sx * 1.2, z, z < -3 ? CHROME : 0x8a8e93));
      // Cabina.
      g.add(box(2.6, 1.75, 2.3, red, 0, 0.7, -3.4));
      g.add(box(2.3, 0.75, 0.05, GLASS, 0, 1.55, -4.57));
      g.add(box(0.08, 0.75, 0.06, red, 0, 1.55, -4.58));
      g.add(box(1.5, 0.62, 0.06, CHROME, 0, 0.8, -4.57)); // parrilla
      for (let i = 0; i < 4; i++) g.add(box(1.4, 0.05, 0.03, 0x222222, 0, 0.88 + i * 0.13, -4.61));
      g.add(box(2.7, 0.3, 0.3, CHROME, 0, 0.4, -4.7));
      g.add(box(2.8, 0.12, 0.12, 0x9a9a9a, 0, 1.25, -4.9)); // defensa de tubos
      for (const x of [-0.9, -0.3, 0.3, 0.9]) g.add(box(0.12, 0.95, 0.12, 0x9a9a9a, x, 0.4, -4.9));
      g.add(prismMesh(2.4, 0.55, 1.8, 1.3, 0.25, red, 0, 2.45, -3.2)); // deflector
      for (let i = 0; i < 5; i++) g.add(lamp(0.12, 0.08, 0.06, 0xffb020, 0x885500, -0.6 + i * 0.3, 2.45, -4.5));
      for (const sx of [-1, 1]) {
        g.add(lamp(0.4, 0.2, 0.06, 0xfff4c0, 0x8a7a40, sx * 0.95, 0.9, -4.57));
        g.add(box(0.04, 0.6, 0.9, GLASS, sx * 1.3, 1.65, -3.95)); // ventanillas
        g.add(pipe(0.06, 0.4, CHROME, sx * 0.5, 2.55, -4.3)); // bocinas
        g.add(rod([sx * 1.3, 1.9, -4.4], [sx * 1.55, 1.9, -4.4], 0.04, 0x222222));
        g.add(box(0.08, 0.42, 0.2, 0x222222, sx * 1.55, 1.5, -4.4)); // espejos
        g.add(cyl(0.14, 2.6, CHROME, sx * 1.15, 0.9, -2.1)); // chimeneas
        g.add(cyl(0.16, 0.12, 0x222222, sx * 1.15, 3.5, -2.1));
        g.add(box(0.25, 0.06, 0.5, 0x9a9a9a, sx * 1.36, 0.6, -2.75)); // escalones
        g.add(box(0.5, 0.5, 0.04, 0x111111, sx * 1.2, 0.2, 4.5)); // guardafangos
        g.add(lamp(0.3, 0.18, 0.05, 0xd01010, 0x600000, sx * 1.1, 1.3, 4.42));
        g.add(box(0.1, 0.8, 0.1, 0x333333, sx * 0.9, 0.35, 1.0)); // patas de apoyo
      }
      // Caja grafiteada.
      g.add(box(2.8, 2.3, 6.4, 0xd9d4c7, 0, 1.15, 1.2));
      for (let z = -1.6; z <= 4.1; z += 0.8) g.add(box(2.84, 2.3, 0.06, 0xb8b2a4, 0, 1.15, z));
      g.add(box(2.86, 0.7, 2.6, 0xe67e22, 0, 2.2, 2.1));
      g.add(box(2.86, 0.45, 1.8, 0x8e44ad, 0, 1.5, 0.2));
      g.add(box(2.86, 0.3, 1.2, 0x27ae60, 0, 2.75, -0.9));
      g.add(box(2.87, 0.55, 0.5, 0xe8e2c8, 0, 1.55, 3.4));
      g.add(box(2.88, 0.15, 0.14, 0x111111, 0, 1.8, 3.28));
      g.add(box(2.88, 0.15, 0.14, 0x111111, 0, 1.8, 3.52));
      g.add(box(0.03, 2.2, 0.03, 0x555555, 0, 1.2, 4.42)); // puertas traseras
      for (const x of [-1.0, -0.35, 0.35, 1.0]) g.add(box(0.05, 2.1, 0.05, CHROME, x, 1.2, 4.43));
      g.add(box(2.4, 0.12, 0.12, 0x333333, 0, 0.6, 4.3));
      // Sacos de arena y artillero en el techo.
      for (const [x, z, ry] of [[-0.7, 2.35, 0], [0, 2.3, 0], [0.7, 2.35, 0], [-1.05, 2.9, 1.3], [1.05, 2.9, -1.3]]) {
        const bag = box(0.62, 0.26, 0.34, 0xa08a5a, x, 3.45, z);
        bag.rotation.y = ry;
        g.add(bag);
      }
      const gunner = humanoid(0xd2a07a, 0x222222, 'gunner', 0.8);
      gunner.position.set(0, 3.45, 3.3);
      g.add(gunner);
      return g;
    }
    case 'van': {
      // Furgón blindado: placas remachadas, rejas sobre el parabrisas, troneras,
      // ariete en cuña, reflector en el techo y puertas traseras.
      const black = 0x2b2b2b;
      const plate = 0x6b6b6b;
      const g = new THREE.Group();
      for (const z of [-1.85, 1.9]) for (const sx of [-1, 1]) g.add(carWheel(0.48, 0.4, sx * 1.18, z, 0x555555));
      g.add(box(2.3, 0.4, 5.0, 0x1a1a1a, 0, 0.12, 0));
      g.add(box(2.6, 0.85, 1.0, black, 0, 0.5, -2.4)); // capó
      g.add(box(2.6, 1.85, 4.4, black, 0, 0.5, 0.7)); // carrocería
      g.add(prismMesh(2.4, 1.0, 0.45, 0.05, 0.2, GLASS, 0, 1.35, -1.725)); // parabrisas
      for (const sx of [-1, 1]) g.add(rod([sx * 1.25, 1.35, -1.95], [sx * 1.25, 2.35, -1.5], 0.1, black, 0.14));
      for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) g.add(rod([x, 1.38, -1.98], [x, 2.33, -1.53], 0.05, 0x8a8a8a));
      for (const sx of [-1, 1]) {
        g.add(box(0.08, 1.0, 4.0, plate, sx * 1.33, 0.75, 0.7)); // placas
        for (let z = -1.1; z <= 2.55; z += 0.45) for (const y of [0.83, 1.65]) g.add(box(0.03, 0.06, 0.06, 0xa0a0a0, sx * 1.38, y, z));
        g.add(box(0.04, 0.12, 0.8, 0x111111, sx * 1.31, 1.95, -0.6)); // troneras
        g.add(box(0.04, 0.12, 0.8, 0x111111, sx * 1.31, 1.95, 1.4));
        g.add(lamp(0.35, 0.16, 0.06, 0xfff4c0, 0x8a7a40, sx * 0.9, 0.95, -2.92));
        g.add(lamp(0.25, 0.3, 0.05, 0xd01010, 0x600000, sx * 1.1, 1.2, 2.92));
      }
      g.add(box(1.2, 0.5, 0.05, 0x151515, 0, 0.7, -2.92)); // parrilla
      for (let i = 0; i < 3; i++) g.add(box(0.9, 0.03, 0.12, 0x111111, 0, 1.35, -2.75 + i * 0.25)); // rejillas del capó
      const ram = box(2.7, 0.7, 0.18, 0x8a8a8a, 0, 0.25, -3.0); // ariete en cuña
      ram.rotation.x = -0.3;
      g.add(ram);
      for (const x of [-0.8, 0, 0.8]) g.add(box(0.1, 0.1, 0.4, 0x555555, x, 0.5, -2.85));
      g.add(box(0.03, 1.7, 0.03, 0x111111, 0, 0.55, 2.915)); // puertas traseras
      for (const sx of [-1, 1]) g.add(box(0.08, 0.06, 0.2, CHROME, sx * 0.15, 1.3, 2.95));
      g.add(box(0.9, 0.06, 0.6, 0x333333, 0, 2.35, -1.0)); // soporte del reflector
      g.add(lamp(0.5, 0.3, 0.4, 0xfff4c0, 0xbba860, 0, 2.41, -1.1));
      g.add(box(0.7, 0.08, 0.7, 0x3a3a3a, 0, 2.35, 1.2)); // escotilla
      return g;
    }
    case 'buggy': {
      // Buggy de dunas: jaula tubular, trompa con calavera y púas, motor descubierto
      // con escapes, ruedas con púas en el centro y conductor con su volante.
      const frame = 0x5a3a1a;
      const rust = 0x8a5a2a;
      const g = new THREE.Group();
      for (const [z, r, tw] of [[-1.2, 0.5, 0.42], [1.2, 0.52, 0.48]]) {
        for (const sx of [-1, 1]) {
          g.add(carWheel(r, tw, sx * 0.95, z, 0x7a5a3a));
          hubSpike(g, sx, sx * (0.95 + tw / 2), r, z);
          g.add(rod([sx * 0.5, 0.62, z], [sx * 0.8, r, z], 0.08, 0x333333)); // suspensión
        }
      }
      g.add(box(1.3, 0.1, 2.9, 0x4a3a2a, 0, 0.5, 0.05)); // piso
      g.add(prismMesh(1.1, 0.35, 1.0, 0.7, 0.15, rust, 0, 0.5, -1.45)); // trompa
      skull(g, 0, 1.0, -1.55, 0.15);
      spikes(g, 1.6, -2.05, 0.62);
      for (const sx of [-1, 1]) {
        g.add(lamp(0.2, 0.12, 0.06, 0xfff4c0, 0x8a7a40, sx * 0.38, 0.62, -1.96));
        // Jaula: aros delantero y trasero, largueros, barras laterales y a la trompa.
        g.add(rod([sx * 0.65, 0.6, -0.65], [sx * 0.55, 1.8, -0.25], 0.09, frame));
        g.add(rod([sx * 0.65, 0.6, 0.95], [sx * 0.55, 1.85, 0.75], 0.09, frame));
        g.add(rod([sx * 0.55, 1.8, -0.25], [sx * 0.55, 1.85, 0.75], 0.09, frame));
        g.add(rod([sx * 0.62, 1.0, -0.52], [sx * 0.63, 1.0, 0.9], 0.08, frame));
        g.add(rod([sx * 0.55, 1.8, -0.25], [sx * 0.42, 0.82, -1.35], 0.08, frame));
        g.add(rod([sx * 0.4, 0.82, 1.6], [sx * 0.45, 1.42, 1.95], 0.1, 0x6b4a2a)); // escapes
        g.add(box(0.2, 0.1, 0.6, CHROME, sx * 0.25, 1.1, 1.4)); // tapas de válvulas
        g.add(lamp(0.14, 0.1, 0.05, 0xd01010, 0x600000, sx * 0.5, 0.55, 1.6));
      }
      g.add(rod([-0.55, 1.8, -0.25], [0.55, 1.8, -0.25], 0.09, frame));
      g.add(rod([-0.55, 1.85, 0.75], [0.55, 1.85, 0.75], 0.09, frame));
      g.add(rod([-0.55, 1.85, 0.75], [0.6, 0.62, 0.95], 0.08, frame));
      g.add(rod([-0.62, 0.97, -0.62], [0.62, 0.97, -0.62], 0.08, frame)); // travesaño del tablero
      g.add(lamp(0.6, 0.15, 0.1, 0xfff4c0, 0x8a7a40, 0, 1.86, -0.3)); // barra de luces
      g.add(box(0.9, 0.5, 0.7, 0x4a4d52, 0, 0.6, 1.4)); // motor
      g.add(cyl(0.16, 0.14, 0x222222, 0, 1.1, 1.4));
      g.add(box(0.3, 0.4, 0.25, 0x3a5a2a, -0.4, 0.6, 0.88)); // bidón
      g.add(seatedDriver(LOOKS.driver, 0.62, 0.35));
      return g;
    }
    case 'raider': {
      // Moto de cross oxidada; el saqueador lleva cresta, gafas de soldador, máscara y hombreras con púas.
      const g = motorcycle('dirt', 0x8a5a2a, 0x5a3a1a);
      g.add(rider(LOOKS.raider));
      return g;
    }
    case 'rig': {
      // Camión de guerra: cabina oxidada con placas y mirilla, compresor sobre el capó,
      // pala con púas, cisterna con zunchos, pasarela, banderas y seis ruedas.
      const rust = 0x5a4632;
      const g = new THREE.Group();
      g.add(box(1.4, 0.35, 6.4, 0x222222, 0, 0.5, -0.1)); // chasis
      for (const z of [-2.5, 0.9, 2.3]) {
        for (const sx of [-1, 1]) {
          g.add(carWheel(0.6, 0.48, sx * 1.25, z, 0x6b5a3a));
          hubSpike(g, sx, sx * 1.49, 0.6, z);
        }
      }
      g.add(box(2.2, 0.9, 1.1, rust, 0, 0.75, -2.95)); // capó
      g.add(box(0.7, 0.3, 0.6, 0x4a4d52, 0, 1.65, -2.95)); // compresor
      g.add(box(0.6, 0.2, 0.3, CHROME, 0, 1.95, -3.0));
      g.add(box(1.6, 0.6, 0.05, 0x222222, 0, 0.85, -3.52)); // parrilla
      skull(g, 0, 1.25, -3.6, 0.22);
      g.add(box(2.6, 1.5, 1.3, rust, 0, 0.75, -1.8)); // cabina
      g.add(box(2.0, 0.28, 0.04, GLASS, 0, 1.8, -2.47)); // mirilla
      for (const [x, y, rz] of [[-0.6, 1.15, 0.08], [0.55, 1.2, -0.06], [0.9, 2.0, 0.1]]) {
        const p = box(0.85, 0.45, 0.06, 0x6b6b6b, x, y, -2.48);
        p.rotation.z = rz;
        g.add(p);
      }
      for (const x of [-0.9, -0.3, 0.3, 0.9]) {
        const c = new THREE.Mesh(CONE, mat(0xb0b0b0));
        c.scale.set(0.22, 0.45, 0.22);
        c.position.set(x, 2.47, -1.8);
        g.add(c);
      }
      const plow = box(3.4, 1.2, 0.5, 0x8a8a8a, 0, 0.1, -3.6);
      plow.rotation.x = -0.35;
      g.add(plow);
      spikes(g, 3.2, -3.9, 0.6);
      // Cisterna sobre su cuna, con zunchos, escotilla y pasarela.
      g.add(box(2.4, 0.3, 4.2, 0x3a2e22, 0, 0.65, 1.1));
      g.add(pipe(1.2, 4.0, 0x6b5a3a, 0, 2.0, 1.1));
      for (const z of [-0.4, 0.6, 1.6, 2.6]) g.add(pipe(1.24, 0.18, 0x2a2a2a, 0, 2.0, z));
      g.add(box(0.8, 0.06, 3.6, 0x4a4a4a, 0, 3.18, 1.1));
      g.add(cyl(0.35, 0.15, 0x3a3a3a, 0, 3.15, 0.2));
      for (const sx of [-1, 1]) {
        g.add(cyl(0.15, 1.8, 0x333333, sx * 1.42, 1.3, -2.2)); // escapes
        g.add(lamp(0.3, 0.22, 0.15, 0xfff4c0, 0x8a7a40, sx * 0.6, 2.25, -2.35));
        g.add(lamp(0.25, 0.15, 0.05, 0xd01010, 0x600000, sx * 0.9, 0.55, 3.22));
        g.add(rod([sx * 1.1, 2.0, 3.1], [sx * 1.1, 3.9, 3.1], 0.06, 0x3a2a1a)); // astas
        g.add(box(0.04, 0.5, 0.7, sx > 0 ? 0x8a2a1a : 0x2a2a2a, sx * 1.1, 3.3, 3.45)); // banderas
      }
      for (let i = 0; i < 5; i++) g.add(box(0.5, 0.05, 0.05, 0x777777, 0.5, 0.9 + i * 0.4, 3.12)); // escalera
      return g;
    }
  }
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
 * Incinerador: oruga blindada con ruedas de rodaje y tacos, glacis inclinado,
 * conductor con traje ignífugo y máscara de gas sentado tras un escudo con
 * mirilla, dos tanques de combustible a la espalda con mangueras hasta la
 * boquilla del lanzallamas, que lleva aletas de enfriamiento y piloto encendido.
 */
function pyroVehicle(): THREE.Group {
  const g = new THREE.Group();
  const hull = 0x5a4a3a;
  const armor = 0x4a3f33;
  for (const sx of [-1, 1]) {
    const x = sx * 0.95;
    g.add(box(0.5, 0.8, 4.3, 0x1a1a1a, x, 0.02, 0)); // oruga
    for (let i = 0; i < 5; i++) g.add(carWheel(0.28, 0.54, x, -1.5 + i * 0.75, 0x3a3a3a));
    for (const z of [-1.85, 1.85]) g.add(carWheel(0.36, 0.56, x, z, 0x5a5a5a));
    for (let z = -2.0; z <= 2.01; z += 0.36) g.add(box(0.52, 0.05, 0.12, 0x2a2a2a, x, 0.82, z)); // tacos
  }
  g.add(box(1.4, 0.75, 4.2, hull, 0, 0.35, 0)); // casco
  g.add(rod([0, 0.45, -2.35], [0, 1.1, -1.7], 1.4, armor, 0.12)); // glacis
  // Puesto del conductor: escudo con mirilla, laterales y el conductor sentado.
  g.add(box(1.5, 1.0, 0.12, armor, 0, 1.1, -1.15));
  g.add(box(0.8, 0.08, 0.03, 0x111111, 0, 1.78, -1.225));
  for (const sx of [-1, 1]) {
    g.add(box(0.08, 0.45, 1.3, armor, sx * 0.72, 1.1, -0.1));
    for (const y of [1.25, 1.95]) g.add(box(0.06, 0.06, 0.03, 0x8a8a8a, sx * 0.62, y, -1.22));
  }
  g.add(seatedDriver(LOOKS.pyro, 1.1, 0.05));
  // Tanques con franjas y válvulas, unidos a la boquilla por mangueras.
  for (const sx of [-1, 1]) {
    const x = sx * 0.42;
    g.add(cyl(0.4, 1.7, 0xb03a2e, x, 1.1, 1.4));
    for (const y of [1.45, 2.35]) g.add(cyl(0.42, 0.14, 0xf1c40f, x, y, 1.4));
    g.add(cyl(0.08, 0.15, CHROME, x, 2.8, 1.4));
    g.add(box(0.22, 0.04, 0.04, 0xb03a2e, x, 2.95, 1.4));
    const hose: V3[] = [[x, 1.3, 1.0], [sx * 0.62, 1.15, 0.6], [sx * 0.62, 1.15, -1.3], [sx * 0.12, 1.3, -1.75]];
    for (let i = 0; i < hose.length - 1; i++) g.add(rod(hose[i], hose[i + 1], 0.08, 0x222222));
    g.add(lamp(0.25, 0.16, 0.08, 0xfff4c0, 0x8a7a40, sx * 0.5, 1.12, -1.78));
  }
  g.add(box(1.0, 0.08, 0.9, 0x2a2a2a, 0, 1.75, 1.4)); // abrazadera de los tanques
  g.add(cyl(0.1, 0.9, 0x333333, 0.55, 1.1, 2.0)); // escape
  // Lanzallamas: torreta, boquilla con aletas, bocina abierta y piloto.
  g.add(cyl(0.3, 0.2, 0x333333, 0, 1.1, -1.75));
  g.add(pipe(0.12, 1.5, 0x333333, 0, 1.4, -2.5));
  for (const z of [-2.1, -2.4, -2.7]) g.add(pipe(0.18, 0.08, 0x777777, 0, 1.4, z));
  const tip = new THREE.Mesh(CONE, mat(0x2a2a2a));
  tip.scale.set(0.36, 0.3, 0.36);
  tip.rotation.x = Math.PI / 2;
  tip.position.set(0, 1.4, -3.35);
  g.add(tip);
  g.add(rod([0, 1.52, -3.1], [0, 1.6, -3.3], 0.04, 0x333333));
  const pilot = ball(0.1, 0x9dff6a, 0, 1.64, -3.35);
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
