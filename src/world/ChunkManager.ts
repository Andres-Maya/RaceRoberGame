import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Biome, HazardKind, LevelConfig, ObstacleKind } from '../config/types';
import type { Rng } from '../core/Rng';
import {
  bankBuilding,
  box,
  building,
  cliff,
  mat,
  OBSTACLE_SPECS,
  obstacleMesh,
  palm,
  pickupMesh,
  policeVehicle,
  setSiren,
  shareGeometry,
  textPlane,
  tree,
  disposeUnique,
  type PoliceMesh,
} from '../fx/Meshes';
import type { Physics } from './Physics';
import { BOUND, CHUNK, HALF_WIDTH, SIDEWALK, Track, WIDE_BOUND } from './Track';

export interface ObstacleRecord {
  kind: ObstacleKind;
  d: number;
  x: number;
  /** Solo los obstáculos sobre la vía cuentan para las métricas de la IA. */
  onRoad: boolean;
  hitMask: number;
  passMask: number;
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  dynamic: boolean;
  drift: { x: number; z: number } | null;
}

export interface Hazard {
  kind: HazardKind;
  x: number;
  d: number;
  hw: number;
  hd: number;
}

export interface Pickup {
  kind: 'repair' | 'nitro';
  x: number;
  d: number;
  mesh: THREE.Object3D;
  taken: boolean;
}

export interface CivilianSpawn {
  x: number;
  d: number;
  heading: number;
  speed: number;
  mode: 'lane' | 'cross';
  lane: number;
}

export interface ChunkContext {
  scene: THREE.Scene;
  physics: Physics;
  track: Track;
  rng: Rng;
  config: LevelConfig;
  biomeFor(index: number): Biome;
  spawnCivilian(spawn: CivilianSpawn): void;
}

interface Chunk {
  index: number;
  biome: Biome;
  d0: number;
  d1: number;
  bodies: RAPIER.RigidBody[];
  objects: THREE.Object3D[];
  obstacles: ObstacleRecord[];
  hazards: Hazard[];
  sirens: PoliceMesh[];
  pickups: Pickup[];
  placed: { x: number; d: number; r: number }[];
}

const DESERT_WEIGHTS: Partial<Record<ObstacleKind, number>> = { rock: 2.2, barrel: 1.8, tumbleweed: 1.6, wreck: 0.6, crate: 1, cactus: 0.4 };

const GROUND: Record<Biome, number> = {
  desert: 0xdcb982,
  outskirts: 0xcfae7c,
  city: 0x55585e,
  plaza: 0x6a6d72,
  bankBack: 0x6a6d72,
  bankEnd: 0x6a6d72,
};

/**
 * Genera el mapa por tramos de 40 m delante de los jugadores y libera los que
 * quedan atrás. Cada bioma tiene su propio generador; la densidad y la mezcla
 * de obstáculos provienen de la configuración (ajustada por la IA).
 */
export class ChunkManager {
  private chunks = new Map<number, Chunk>();
  private nextIndex: number;
  private nextRoadblock: number;
  private prevBiome: Biome | null = null;
  private sirenTimer = 0;
  private sirenPhase = false;
  private spin = 0;
  /** Se generó el banco final (nivel 0): no hay más tramos. */
  finished = false;
  bankDoor: { x: number; d: number; hw: number; hd: number } | null = null;
  bankFront: { x: number; d: number } | null = null;
  /** Puntos de aparición de patrullas en calles laterales de la plaza. */
  sideSpawns: { x: number; d: number; heading: number }[] = [];

  constructor(
    private ctx: ChunkContext,
    startIndex: number,
  ) {
    this.nextIndex = startIndex;
    const every = ctx.config.roadblockEvery;
    this.nextRoadblock = every > 0 ? 260 + every * 0.4 : Infinity;
  }

  get generatedUntil(): number {
    return this.nextIndex * CHUNK;
  }

  update(frontD: number, behindD: number, dt: number): void {
    while (!this.finished && this.nextIndex * CHUNK < frontD + 260) this.generate(this.nextIndex++);
    for (const c of this.chunks.values()) if (c.d1 < behindD) this.disposeChunk(c);

    // Props dinámicos: sincronizar malla con su cuerpo físico.
    for (const c of this.chunks.values()) {
      for (const o of c.obstacles) {
        if (!o.dynamic) continue;
        if (o.drift && o.hitMask === 0) o.body.setLinvel({ x: o.drift.x, y: 0, z: o.drift.z }, true);
        const t = o.body.translation();
        const r = o.body.rotation();
        o.mesh.position.set(t.x, 0, t.z);
        o.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        if (o.kind === 'tumbleweed') o.mesh.children[0].rotation.z -= (o.drift?.x ?? 0) * dt * 0.8;
      }
    }

    this.spin += dt;
    for (const c of this.chunks.values()) {
      for (const p of c.pickups) {
        const inner = p.mesh.children[0];
        inner.rotation.y = this.spin * 2;
        inner.position.y = 0.4 + Math.sin(this.spin * 4 + p.d) * 0.25;
      }
    }

    this.sirenTimer += dt;
    if (this.sirenTimer > 0.25) {
      this.sirenTimer = 0;
      this.sirenPhase = !this.sirenPhase;
      for (const c of this.chunks.values()) for (const s of c.sirens) setSiren(s, this.sirenPhase);
    }
  }

  *obstacles(): Generator<ObstacleRecord> {
    for (const c of this.chunks.values()) yield* c.obstacles;
  }

  *hazards(): Generator<Hazard> {
    for (const c of this.chunks.values()) yield* c.hazards;
  }

  *pickups(): Generator<Pickup> {
    for (const c of this.chunks.values()) for (const p of c.pickups) if (!p.taken) yield p;
  }

  take(p: Pickup): void {
    p.taken = true;
    p.mesh.visible = false;
  }

  /** ¿Hay un obstáculo cerca de (x, d)? Útil para aparecer vehículos sin solaparse. */
  isClear(x: number, d: number, radius: number): boolean {
    const c = this.chunks.get(Math.floor(d / CHUNK));
    if (!c) return true;
    return c.placed.every((p) => Math.hypot(p.x - x, p.d - d) > p.r + radius);
  }

  dispose(): void {
    for (const c of [...this.chunks.values()]) this.disposeChunk(c);
  }

  // ------------------------------------------------------------ generación

  private generate(index: number): void {
    const biome = this.ctx.biomeFor(index);
    this.ctx.track.setBiome(index, biome);
    const c: Chunk = {
      index,
      biome,
      d0: index * CHUNK,
      d1: (index + 1) * CHUNK,
      bodies: [],
      objects: [],
      obstacles: [],
      hazards: [],
      sirens: [],
      pickups: [],
      placed: [],
    };
    this.chunks.set(index, c);
    this.ground(c);
    switch (biome) {
      case 'desert':
        this.genDesert(c);
        break;
      case 'outskirts':
        this.genOutskirts(c);
        break;
      case 'city':
        this.genCity(c, index % 4 === 2 ? [c.d0 + 12, c.d0 + 28] : null);
        break;
      case 'plaza':
        this.genCity(c, [c.d0 + 2, c.d0 + 22], true);
        break;
      case 'bankBack':
        this.genBankBack(c);
        break;
      case 'bankEnd':
        this.genBankEnd(c);
        break;
    }
    if (biome !== 'bankBack' && biome !== 'plaza' && biome !== 'bankEnd' && index >= 3) {
      this.maybeRoadblock(c);
      this.maybePickup(c);
    }
    this.prevBiome = biome;
  }

  private get track(): Track {
    return this.ctx.track;
  }

  private add(c: Chunk, obj: THREE.Object3D, d: number, off: number, rotOffset = 0): THREE.Object3D {
    obj.position.set(this.track.centerX(d) + off, obj.position.y, -d);
    obj.rotation.y = this.track.angle(d) + rotOffset;
    this.ctx.scene.add(obj);
    c.objects.push(obj);
    return obj;
  }

  private solid(c: Chunk, d: number, off: number, hx: number, hz: number, rotOffset = 0): void {
    const x = this.track.centerX(d) + off;
    c.bodies.push(this.ctx.physics.fixedBox(x, -d, hx, hz, this.track.angle(d) + rotOffset, { kind: 'wall' }));
  }

  private flat(c: Chunk, w: number, len: number, color: number, d: number, off: number, y = 0.02, rotOffset = 0): void {
    const m = box(w, 0.02, len, color);
    m.castShadow = false;
    m.position.y = y;
    this.add(c, m, d, off, rotOffset);
  }

  /** Banda que sigue la curva de la vía entre dos desplazamientos laterales. */
  private strip(c: Chunk, offL: number, offR: number, color: number, y: number, d0 = c.d0, d1 = c.d1): void {
    const n = Math.max(1, Math.ceil((d1 - d0) / 2));
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const d = d0 + ((d1 - d0) * i) / n;
      const cx = this.track.centerX(d);
      pos.push(cx + offL, 0, -d, cx + offR, 0, -d);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat(color));
    mesh.position.y = y;
    mesh.receiveShadow = true;
    this.ctx.scene.add(mesh);
    c.objects.push(mesh);
  }

  private dashes(c: Chunk, off: number, color: number, len: number, period: number, width = 0.22, d0 = c.d0, d1 = c.d1): void {
    for (let d = Math.ceil(d0 / period) * period; d + len <= d1; d += period) this.flat(c, width, len, color, d + len / 2, off, 0.04);
  }

  private ground(c: Chunk): void {
    const g = box(520, 0.02, CHUNK + 0.4, GROUND[c.biome]);
    g.castShadow = false;
    g.position.y = -0.02;
    this.add(c, g, (c.d0 + c.d1) / 2, 0, -this.track.angle((c.d0 + c.d1) / 2));
  }

  /** Paredes invisibles laterales y, si el tramo es ancho, tapas en sus extremos. */
  private bounds(c: Chunk, bound: number): void {
    const mid = (c.d0 + c.d1) / 2;
    for (const s of [-1, 1]) {
      this.solid(c, mid, s * (bound + 0.5), 0.5, CHUNK / 2 + 1.5);
      if (bound > BOUND) {
        const w = (bound - BOUND) / 2;
        for (const d of [c.d0 + 0.5, c.d1 - 0.5]) this.solid(c, d, s * (BOUND + w), w + 0.5, 0.5);
      }
    }
  }

  private road(c: Chunk, half: number, color: number, d0 = c.d0, d1 = c.d1): void {
    this.strip(c, -half, half, color, 0.01, d0, d1);
  }

  // ------------------------------------------------------------ desierto

  private genDesert(c: Chunk): void {
    const rng = this.ctx.rng;
    const half = HALF_WIDTH.desert;
    this.strip(c, -half - 1.6, half + 1.6, 0xc9a56f, 0.005);
    this.road(c, half, 0x6f655a);
    this.strip(c, -half, -half + 0.25, 0xe8e0d0, 0.03);
    this.strip(c, half - 0.25, half, 0xe8e0d0, 0.03);
    this.dashes(c, 0, 0xe6b422, 3, 7);

    // Acantilados a ambos lados (cara interna en ±30).
    for (const s of [-1, 1]) {
      for (let d = c.d0; d < c.d1; d += 10) {
        const h = rng.range(3, 9);
        const w = rng.range(5, 8);
        const off = s * (30 + w / 2);
        this.add(c, cliff(w, h, 10.4, rng.next()), d + 5, off);
        this.solid(c, d + 5, off, w / 2, 5.2);
      }
    }
    this.bounds(c, BOUND);

    // Decoración fuera de la vía (también sólida): cactus y rocas.
    const decor = rng.int(3, 6);
    for (let i = 0; i < decor; i++) {
      const s = rng.sign();
      const off = s * rng.range(half + 3, 27);
      const d = rng.range(c.d0, c.d1);
      this.addObstacle(c, rng.chance(0.6) ? 'cactus' : 'rock', d, off, rng.range(0, 6), false);
    }
    // Manchas de arena oscura (solo visuales).
    for (let i = 0; i < 3; i++) this.flat(c, rng.range(3, 8), rng.range(3, 8), 0xc8a26a, rng.range(c.d0, c.d1), rng.sign() * rng.range(half + 2, 26), 0.01, rng.range(0, 3));

    this.roadObstacles(c, DESERT_WEIGHTS, half + 1);
    this.roadHazards(c, half, { sand: 1, oil: 0.15, spikes: this.ctx.config.hazardWeights.spikes ?? 0 });
    this.traffic(c, [-4], [4], 0.6);
  }

  // ------------------------------------------------------------ afueras

  private genOutskirts(c: Chunk): void {
    const rng = this.ctx.rng;
    const half = HALF_WIDTH.outskirts;
    this.strip(c, -half - 1.6, half + 1.6, 0x9c9283, 0.005);
    this.road(c, half, 0x4c4b4d);
    this.strip(c, -half, -half + 0.25, 0xffffff, 0.03);
    this.strip(c, half - 0.25, half, 0xffffff, 0.03);
    this.dashes(c, 0, 0xe6b422, 3, 6);

    for (const s of [-1, 1]) {
      // Cerca metálica
      for (let d = c.d0; d < c.d1; d += 4) this.add(c, box(0.2, 2.2, 0.2, 0x8a8f94), d, s * 30);
      this.add(c, box(0.12, 0.15, CHUNK, 0xa0a5aa, 0, 1.9, 0), (c.d0 + c.d1) / 2, s * 30);
      // Bodegas y gasolineras bajas
      let d = c.d0 + rng.range(0, 6);
      while (d < c.d1 - 8) {
        const len = rng.range(8, 14);
        const deep = rng.range(7, 12);
        const off = s * (half + rng.range(5, 8) + deep / 2);
        if (Math.abs(off) + deep / 2 < 29.5) {
          this.add(c, building(deep, rng.range(3.5, 7), len, rng.next()), d + len / 2, off);
          this.solid(c, d + len / 2, off, deep / 2, len / 2);
          c.placed.push({ x: this.track.centerX(d + len / 2) + off, d: d + len / 2, r: Math.max(deep, len) / 2 });
        }
        d += len + rng.range(4, 10);
      }
      for (let i = 0; i < 2; i++) this.add(c, palm(), rng.range(c.d0, c.d1), s * (half + 2.5));
    }
    this.bounds(c, BOUND);

    if (this.prevBiome !== 'outskirts') {
      const text = this.prevBiome === 'desert' ? 'CIUDAD COBALTO' : 'SALIDA · DESIERTO';
      this.gantry(c, c.d0 + 20, half, text);
    }

    const mix = { ...DESERT_WEIGHTS, ...this.ctx.config.obstacleWeights };
    this.roadObstacles(c, mix, half);
    this.roadHazards(c, half, this.ctx.config.hazardWeights);
    this.traffic(c, [-4.5], [4.5], 0.8);
  }

  private gantry(c: Chunk, d: number, half: number, text: string): void {
    for (const s of [-1, 1]) {
      this.add(c, box(0.5, 8, 0.5, 0x6d7378), d, s * (half + 2));
      const x = this.track.centerX(d) + s * (half + 2);
      c.bodies.push(this.ctx.physics.fixedBall(x, -d, 0.35, { kind: 'wall' }));
    }
    this.add(c, box(half * 2 + 4.5, 0.5, 0.6, 0x6d7378, 0, 7.6, 0), d, 0);
    const sign = textPlane(text, half * 2 + 2, 3.2, '#1e7b3a', '#ffffff');
    sign.position.y = 8.1;
    this.add(c, sign, d, 0, 0);
    sign.rotation.set(-Math.PI / 2, 0, this.track.angle(d));
  }

  // ------------------------------------------------------------ ciudad

  private genCity(c: Chunk, cross: [number, number] | null, plaza = false): void {
    const half = HALF_WIDTH.city;
    this.cityStreet(c, half, cross);
    this.cityBlocks(c, half, cross ? [[c.d0, cross[0]], [cross[1], c.d1]] : [[c.d0, c.d1]]);
    this.bounds(c, cross ? WIDE_BOUND : BOUND);

    if (cross) {
      const mid = (cross[0] + cross[1]) / 2;
      const len = cross[1] - cross[0];
      for (const s of [-1, 1]) {
        // La calle transversal termina en un edificio que bloquea el paso.
        const deep = 14;
        const off = s * (half + SIDEWALK + 30 + deep / 2);
        this.add(c, building(deep, this.ctx.rng.range(8, 18), len + 2, this.ctx.rng.next()), mid, off);
        this.solid(c, mid, off, deep / 2, len / 2 + 1);
        if (plaza) this.sideSpawns.push({ x: this.track.centerX(mid) + s * (half + 22), d: mid, heading: s > 0 ? Math.PI / 2 : -Math.PI / 2 });
      }
      if (!plaza && this.ctx.rng.chance(0.55 * Math.min(1.5, this.ctx.config.trafficDensity / 3))) {
        const s = this.ctx.rng.sign();
        this.ctx.spawnCivilian({
          x: this.track.centerX(mid) + s * 40,
          d: mid + (s > 0 ? -3.5 : 3.5),
          heading: s > 0 ? Math.PI / 2 : -Math.PI / 2,
          speed: this.ctx.rng.range(11, 16),
          mode: 'cross',
          lane: 0,
        });
      }
    }

    if (!plaza) {
      this.roadObstacles(c, this.ctx.config.obstacleWeights, half);
      const hw = { ...this.ctx.config.hazardWeights };
      if (hw.sand) {
        hw.oil = (hw.oil ?? 0) + hw.sand;
        delete hw.sand;
      }
      this.roadHazards(c, half, hw);
      this.traffic(c, [-3, -9], [3, 9], 1);
    }
  }

  private cityStreet(c: Chunk, half: number, cross: [number, number] | null): void {
    this.road(c, half, 0x2c2d31);
    const segments: [number, number][] = cross ? [[c.d0, cross[0]], [cross[1], c.d1]] : [[c.d0, c.d1]];
    for (const [a, b] of segments) {
      if (b - a < 0.5) continue;
      for (const s of [-1, 1]) {
        this.strip(c, s > 0 ? half : -half - SIDEWALK, s > 0 ? half + SIDEWALK : -half, 0x9d9d9d, 0.12, a, b);
        this.strip(c, s > 0 ? half : -half - 0.3, s > 0 ? half + 0.3 : -half, 0xc7c7c7, 0.14, a, b);
      }
      this.strip(c, -0.35, -0.15, 0xf1c40f, 0.03, a, b);
      this.strip(c, 0.15, 0.35, 0xf1c40f, 0.03, a, b);
      this.dashes(c, -half / 2, 0xffffff, 3, 8, 0.2, a, b);
      this.dashes(c, half / 2, 0xffffff, 3, 8, 0.2, a, b);
    }
    if (cross) {
      const mid = (cross[0] + cross[1]) / 2;
      const len = cross[1] - cross[0];
      this.flat(c, WIDE_BOUND * 2, len, 0x2c2d31, mid, 0, 0.011);
      // Pasos de cebra
      for (const d of [cross[0] - 1.5, cross[1] + 1.5]) {
        for (let x = -half + 1; x < half; x += 1.6) this.flat(c, 0.8, 2.4, 0xf2f2f2, d, x, 0.035);
      }
      // Semáforos en las esquinas
      for (const s of [-1, 1]) {
        this.add(c, box(0.3, 5, 0.3, 0x2b2b2b), cross[0] - 1, s * (half + 1));
        this.add(c, box(0.6, 1.2, 0.5, 0x111111, 0, 4.4, 0), cross[0] - 1, s * (half + 1));
      }
    }
  }

  private cityBlocks(c: Chunk, half: number, ranges: [number, number][]): void {
    const rng = this.ctx.rng;
    for (const s of [-1, 1]) {
      for (const [a, b] of ranges) {
        let d = a;
        while (b - d >= 3) {
          let len = rng.range(9, 16);
          if (b - d - len < 5) len = b - d;
          const deep = rng.range(11, 16);
          const off = s * (half + SIDEWALK + deep / 2 + 0.3);
          const h = rng.range(6, 26);
          this.add(c, building(deep, h, len - 0.4, rng.next()), d + len / 2, off);
          this.solid(c, d + len / 2, off, deep / 2, len / 2);
          d += len;
        }
        // Árboles en la acera
        for (let td = a + 4; td < b - 2; td += rng.range(10, 18)) {
          const t = tree();
          this.add(c, t, td, s * (half + SIDEWALK - 1));
          const x = this.track.centerX(td) + s * (half + SIDEWALK - 1);
          c.bodies.push(this.ctx.physics.fixedBall(x, -td, 0.3, { kind: 'wall' }));
        }
      }
    }
  }

  // ------------------------------------------------------------ banco

  /** Inicio de los niveles 1-3: el banco recién asaltado queda detrás. */
  private genBankBack(c: Chunk): void {
    const half = HALF_WIDTH.city;
    this.road(c, half, 0x2c2d31, c.d1 - 6, c.d1);
    const depth = 24;
    const center = c.d1 - 3 - depth / 2;
    const bank = bankBuilding(70, depth, true);
    this.add(c, bank, center, 0);
    this.solid(c, center, 0, 35, depth / 2);
    for (const s of [-1, 1]) {
      this.add(c, building(26, 14, CHUNK, 0.3), (c.d0 + c.d1) / 2, s * 48);
      this.solid(c, (c.d0 + c.d1) / 2, s * 48, 13, CHUNK / 2);
    }
    this.solid(c, c.d0 + 0.5, 0, WIDE_BOUND + 1, 0.5);
    this.bounds(c, WIDE_BOUND);
    this.bankFront = { x: this.track.centerX(c.d1), d: c.d1 - 2 };
  }

  /** Final del nivel 0: la vía desemboca en la fachada del Banco Central. */
  private genBankEnd(c: Chunk): void {
    const half = HALF_WIDTH.city;
    const facade = c.d0 + 30;
    this.cityStreet(c, half, null);
    this.cityBlocks(c, half, [[c.d0, c.d0 + 14]]);
    this.flat(c, 70, 16, 0x8f8a80, c.d0 + 22, 0, 0.13);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) this.add(c, palm(), c.d0 + 16 + i * 5, s * (half + 1.5));
    const depth = 24;
    const bank = bankBuilding(70, depth, false, true);
    this.add(c, bank, facade + depth / 2, 0, Math.PI);
    this.solid(c, facade + depth / 2, 0, 35, depth / 2);
    this.bounds(c, BOUND);
    this.bankDoor = { x: this.track.centerX(facade), d: facade - 4, hw: 6, hd: 4 };
    this.finished = true;
  }

  // ------------------------------------------------------------ contenido

  private addObstacle(c: Chunk, kind: ObstacleKind, d: number, off: number, rotOffset: number, onRoad: boolean, mesh?: THREE.Object3D): ObstacleRecord {
    const spec = OBSTACLE_SPECS[kind];
    const x = this.track.centerX(d) + off;
    const rot = this.track.angle(d) + rotOffset;
    const m = mesh ?? obstacleMesh(kind, this.ctx.rng.next());
    m.position.set(x, 0, -d);
    m.rotation.y = rot;
    this.ctx.scene.add(m);
    c.objects.push(m);
    const rec: ObstacleRecord = { kind, d, x, onRoad, hitMask: 0, passMask: 0, body: null!, mesh: m, dynamic: spec.dynamic, drift: null };
    const tag = { kind: 'obstacle' as const, ref: rec };
    rec.body = spec.dynamic
      ? this.ctx.physics.dynamicBox(x, -d, spec.hx, spec.hz, rot, tag, {
          density: spec.density,
          linearDamping: kind === 'tumbleweed' ? 0.2 : 1.6,
          angularDamping: 3,
          rotates: true,
        })
      : this.ctx.physics.fixedBox(x, -d, spec.hx, spec.hz, rot, tag);
    if (kind === 'tumbleweed') {
      const dir = this.ctx.rng.sign();
      rec.drift = { x: dir * this.ctx.rng.range(3, 6), z: this.ctx.rng.range(-1, 1) };
    }
    c.bodies.push(rec.body);
    c.obstacles.push(rec);
    c.placed.push({ x, d, r: Math.max(spec.hx, spec.hz) });
    return rec;
  }

  private freeSpot(c: Chunk, half: number, r: number): { d: number; off: number } | null {
    const rng = this.ctx.rng;
    for (let tries = 0; tries < 8; tries++) {
      const d = rng.range(c.d0 + 1, c.d1 - 1);
      const off = rng.range(-half + r, half - r);
      if (this.isClear(this.track.centerX(d) + off, d, r + 1.6)) return { d, off };
    }
    return null;
  }

  private roadObstacles(c: Chunk, weights: Partial<Record<ObstacleKind, number>>, half: number): void {
    const rng = this.ctx.rng;
    // Los primeros tramos quedan despejados para arrancar con calma.
    if (c.index < 2) return;
    const count = rng.poisson((this.ctx.config.obstacleDensity * CHUNK) / 100);
    for (let i = 0; i < count; i++) {
      const kind = rng.weighted(weights);
      const spec = OBSTACLE_SPECS[kind];
      if (kind === 'parkedCar') {
        const s = rng.sign();
        const d = rng.range(c.d0 + 2, c.d1 - 2);
        const off = s * (half - 1.3);
        if (this.isClear(this.track.centerX(d) + off, d, 3)) this.addObstacle(c, kind, d, off, rng.chance(0.5) ? 0 : Math.PI, true);
        continue;
      }
      const spot = this.freeSpot(c, half, Math.max(spec.hx, spec.hz));
      if (!spot) continue;
      const rot = kind === 'barrier' ? rng.range(-0.15, 0.15) : kind === 'wreck' ? rng.range(-0.8, 0.8) : rng.range(0, Math.PI * 2);
      this.addObstacle(c, kind, spot.d, spot.off, rot, true);
    }
  }

  private roadHazards(c: Chunk, half: number, weights: Partial<Record<HazardKind, number>>): void {
    const rng = this.ctx.rng;
    if (c.index < 2 || Object.values(weights).every((w) => !w)) return;
    const count = rng.poisson((this.ctx.config.hazardDensity * CHUNK) / 100);
    for (let i = 0; i < count; i++) {
      const kind = rng.weighted(weights);
      const size = { sand: [3.5, 3], oil: [1.8, 1.6], spikes: [3.2, 0.4] }[kind];
      const d = rng.range(c.d0 + 3, c.d1 - 3);
      const off = rng.range(-half + size[0], half - size[0]);
      this.hazard(c, kind, d, off, size[0], size[1]);
    }
  }

  private hazard(c: Chunk, kind: HazardKind, d: number, off: number, hw: number, hd: number): void {
    if (kind === 'sand') {
      const m = new THREE.Mesh(sandGeo, mat(0xe2c48e));
      m.scale.set(hw * 2, 1, hd * 2);
      m.position.y = 0.05;
      m.receiveShadow = true;
      this.add(c, m, d, off);
    } else if (kind === 'oil') {
      const m = new THREE.Mesh(sandGeo, mat(0x0d0d10));
      m.scale.set(hw * 2, 1, hd * 2);
      m.position.y = 0.05;
      this.add(c, m, d, off);
    } else {
      this.flat(c, hw * 2, hd * 2, 0x3a3a3a, d, off, 0.06);
      for (let x = -hw + 0.3; x < hw; x += 0.5) {
        const spike = box(0.18, 0.25, 0.18, 0xcfd3d6, x, 0, 0);
        spike.castShadow = false;
        this.add(c, spike, d, off + x);
      }
    }
    c.hazards.push({ kind, x: this.track.centerX(d) + off, d, hw, hd });
  }

  private traffic(c: Chunk, oncoming: number[], forward: number[], factor: number): void {
    const rng = this.ctx.rng;
    if (c.index < 2) return;
    const count = rng.poisson((this.ctx.config.trafficDensity * factor * CHUNK) / 100);
    for (let i = 0; i < count; i++) {
      const isForward = rng.chance(0.55);
      const lane = rng.pick(isForward ? forward : oncoming);
      const d = rng.range(c.d0 + 2, c.d1 - 2);
      const x = this.track.centerX(d) + lane;
      if (!this.isClear(x, d, 3)) continue;
      this.ctx.spawnCivilian({
        x,
        d,
        heading: this.track.angle(d) + (isForward ? 0 : Math.PI),
        speed: isForward ? rng.range(10, 16) : rng.range(12, 18),
        mode: 'lane',
        lane,
      });
      c.placed.push({ x, d, r: 2.5 });
    }
  }

  /** Llaves de reparación y latas de nitro sobre la vía. */
  private maybePickup(c: Chunk): void {
    const rng = this.ctx.rng;
    if (!rng.chance(0.24)) return;
    const half = this.ctx.track.halfWidth(c.d0 + 20);
    const spot = this.freeSpot(c, half, 1.5);
    if (!spot) return;
    const kind = rng.chance(0.55) ? 'repair' : 'nitro';
    const mesh = pickupMesh(kind);
    this.add(c, mesh, spot.d, spot.off, 0);
    c.pickups.push({ kind, x: this.track.centerX(spot.d) + spot.off, d: spot.d, mesh, taken: false });
    c.placed.push({ x: this.track.centerX(spot.d) + spot.off, d: spot.d, r: 1.5 });
  }

  private maybeRoadblock(c: Chunk): void {
    if (c.d0 < this.nextRoadblock) return;
    const rng = this.ctx.rng;
    this.nextRoadblock = c.d0 + this.ctx.config.roadblockEvery * rng.range(0.8, 1.2);
    const half = this.ctx.track.halfWidth(c.d0 + 20);
    const d = c.d0 + 20;
    const slots: number[] = [];
    for (let off = -half + 2.2; off <= half - 2.2; off += 4.5) slots.push(off);
    const gap = rng.int(0, slots.length - 1);
    slots.forEach((off, i) => {
      if (i === gap) return;
      const pm = policeVehicle('patrol');
      setSiren(pm, i % 2 === 0);
      c.sirens.push(pm);
      this.addObstacle(c, 'parkedCar', d + rng.range(-0.6, 0.6), off, Math.PI / 2 + rng.range(-0.25, 0.25), true, pm.group);
    });
    // Púas delante de un carro del retén y conos en los bordes.
    const spikeSlot = slots[(gap + 1) % slots.length];
    if (Math.abs(spikeSlot - slots[gap]) > 1) this.hazard(c, 'spikes', d - 4, spikeSlot, 2.2, 0.4);
    for (const s of [-1, 1]) this.addObstacle(c, 'cone', d - 2, s * (half - 0.6), 0, true);
  }

  // ------------------------------------------------------------ limpieza

  private disposeChunk(c: Chunk): void {
    for (const b of c.bodies) this.ctx.physics.remove(b);
    for (const o of c.objects) {
      this.ctx.scene.remove(o);
      disposeUnique(o);
    }
    this.chunks.delete(c.index);
  }
}

const sandGeo = shareGeometry(new THREE.CircleGeometry(0.5, 14).rotateX(-Math.PI / 2));
