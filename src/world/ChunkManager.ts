import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Biome, FinishScene, HazardKind, LevelConfig, ObstacleKind } from '../config/types';
import { quatY } from '../core/math';
import type { Rng } from '../core/Rng';
import {
  bankBuilding,
  box,
  building,
  cliff,
  container,
  coolingTower,
  deadTree,
  mat,
  nuclearPlant,
  OBSTACLE_SPECS,
  obstacleMesh,
  outlawVehicle,
  palm,
  pickupMesh,
  policeVehicle,
  rampMesh,
  rubble,
  ruin,
  setSiren,
  shareGeometry,
  textPlane,
  tree,
  tunnelMountain,
  disposeUnique,
  type PursuerMesh,
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
  /** Zombis atropellados: quedan tendidos y sin colisión. */
  dead?: boolean;
}

/** Zona que termina el nivel (puerta del banco, boca del túnel, planta, línea de meta). */
export interface FinishZone {
  kind: FinishScene;
  x: number;
  d: number;
  hw: number;
  hd: number;
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
  sirens: PursuerMesh[];
  pickups: Pickup[];
  placed: { x: number; d: number; r: number }[];
  /** Contenido diferido (obstáculos, tráfico, zombis): se crea al acercarse la moto. */
  pending: { d: number; run: () => void }[];
}

/**
 * Distancia por delante de la moto a la que se activa el contenido diferido:
 * justo fuera de la pantalla, para que nada se desordene antes de llegar.
 */
const ACTIVATE_AHEAD = 85;

const DESERT_WEIGHTS: Partial<Record<ObstacleKind, number>> = { rock: 2.2, barrel: 1.8, tumbleweed: 1.6, wreck: 0.6, crate: 1, cactus: 0.4, fuelBarrel: 0.6 };

const GROUND: Record<Biome, number> = {
  desert: 0xdcb982,
  outskirts: 0xcfae7c,
  city: 0x55585e,
  plaza: 0x6a6d72,
  bankBack: 0x6a6d72,
  bankEnd: 0x6a6d72,
  bridge: 0x2b6f95,
  tunnelEnd: 0x7a6a55,
  tunnelExit: 0x55534d,
  industrial: 0x55534d,
  plantEnd: 0x55534d,
  plantBack: 0x5a5446,
  wasteland: 0x6a5d45,
  safeZone: 0x6a5d45,
};

/** Biomas con tráfico, obstáculos normales, retenes y recompensas. */
const ROAD_BIOMES = new Set<Biome>(['desert', 'outskirts', 'city', 'bridge', 'industrial', 'wasteland']);

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
  private leadSpeed = 30;
  private lastCross = -10;
  /** Se generó la estructura final cerrada (banco, túnel, planta): no hay más tramos. */
  finished = false;
  finishZone: FinishZone | null = null;
  /** Fachada de la estructura de salida (banco, túnel o planta) al inicio del nivel. */
  startFront: { x: number; d: number } | null = null;
  /** Puntos donde estalla la planta nuclear al final del nivel 2. */
  blastPoints: { x: number; z: number }[] = [];
  private finishDoor: THREE.Mesh | null = null;
  /** Puntos de aparición de patrullas en calles laterales de la plaza. */
  sideSpawns: { x: number; d: number; heading: number }[] = [];

  constructor(
    private ctx: ChunkContext,
    startIndex: number,
  ) {
    this.nextIndex = startIndex;
    this.nextRoadblock = Infinity;
  }

  get generatedUntil(): number {
    return this.nextIndex * CHUNK;
  }

  update(frontD: number, behindD: number, dt: number, leadSpeed = 30): void {
    this.leadSpeed = leadSpeed;
    while (!this.finished && this.nextIndex * CHUNK < frontD + 260) this.generate(this.nextIndex++);
    for (const c of this.chunks.values()) if (c.d1 < behindD) this.disposeChunk(c);

    // Activar el contenido diferido que ya quedó a la distancia de aparición.
    for (const c of this.chunks.values()) {
      if (!c.pending.length || c.d0 > frontD + ACTIVATE_AHEAD) continue;
      const ready = c.pending.filter((p) => p.d <= frontD + ACTIVATE_AHEAD);
      if (!ready.length) continue;
      c.pending = c.pending.filter((p) => p.d > frontD + ACTIVATE_AHEAD);
      for (const p of ready) p.run();
    }

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
        if (o.kind === 'zombie' && !o.dead) {
          const inner = o.mesh.children[0];
          const phase = this.spin * 3 + o.d;
          inner.rotation.z = Math.sin(phase) * 0.15;
          inner.position.y = Math.abs(Math.sin(phase)) * 0.1;
          // Al salir de la vía dan media vuelta y vuelven a cruzar.
          const lat = t.x - this.track.centerX(o.d);
          // Sobre el puente se dan la vuelta en la baranda, no a 5 m (sería el río).
          const turnAt = this.track.waterEdge(o.d) !== null ? this.track.halfWidth(o.d) + 0.6 : this.track.halfWidth(o.d) + 5;
          if (o.drift && Math.abs(lat) > turnAt && Math.sign(lat) === Math.sign(o.drift.x)) {
            o.drift.x *= -1;
            o.body.setRotation(quatY(o.drift.x > 0 ? -Math.PI / 2 : Math.PI / 2), true);
          }
        }
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

  /**
   * Obstáculo más cercano por delante de un vehículo que avanza en dirección
   * `dir` (+1 hacia la meta, -1 en sentido contrario). Devuelve su x o null.
   */
  obstacleAhead(x: number, d: number, dir: number, range = 16, width = 2.4): { x: number; dist: number } | null {
    let best: { x: number; dist: number } | null = null;
    const i0 = Math.floor(Math.min(d, d + dir * range) / CHUNK);
    const i1 = Math.floor(Math.max(d, d + dir * range) / CHUNK);
    for (let i = i0; i <= i1; i++) {
      const c = this.chunks.get(i);
      if (!c) continue;
      for (const o of c.obstacles) {
        if (o.dead || !o.onRoad) continue;
        const t = o.body.translation();
        const dist = (-t.z - d) * dir;
        if (dist < 1.5 || dist > range || Math.abs(t.x - x) > width) continue;
        if (!best || dist < best.dist) best = { x: t.x, dist };
      }
    }
    return best;
  }

  /** ¿Hay un obstáculo cerca de (x, d)? Útil para aparecer vehículos sin solaparse. */
  isClear(x: number, d: number, radius: number): boolean {
    const c = this.chunks.get(Math.floor(d / CHUNK));
    if (!c) return true;
    return c.placed.every((p) => Math.hypot(p.x - x, p.d - d) > p.r + radius);
  }

  /** Abre la puerta final (banco o planta): queda un hueco oscuro por donde entra la moto. */
  openFinishDoor(): void {
    if (this.finishDoor) this.finishDoor.material = mat(0x0a0a0a);
  }

  /** Obstáculo que explotó: desaparece y deja una mancha quemada. */
  destroyObstacle(o: ObstacleRecord): void {
    if (o.dead) return;
    o.dead = true;
    o.drift = null;
    o.mesh.visible = false;
    o.body.collider(0).setSensor(true);
    const c = [...this.chunks.values()].find((ch) => ch.obstacles.includes(o));
    if (!c) return;
    const t = o.body.translation();
    const scorch = new THREE.Mesh(sandGeo, mat(0x1a1612));
    scorch.scale.set(5.5, 1, 5.5);
    scorch.position.set(t.x, 0.045, t.z);
    this.ctx.scene.add(scorch);
    c.objects.push(scorch);
  }

  /** Zombi atropellado: cae al suelo y deja de colisionar. */
  killZombie(o: ObstacleRecord): void {
    if (o.dead) return;
    o.dead = true;
    o.drift = null;
    const inner = o.mesh.children[0];
    inner.rotation.set(-Math.PI / 2, 0, 0);
    inner.position.y = 0.3;
    o.body.collider(0).setSensor(true);
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
      pending: [],
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
      case 'city': {
        // Cruces a intervalos irregulares (nunca dos tramos seguidos).
        const cross = index - this.lastCross >= 2 && this.ctx.rng.chance(0.3);
        if (cross) this.lastCross = index;
        const start = c.d0 + this.ctx.rng.range(8, 16);
        this.genCity(c, cross ? [start, start + this.ctx.rng.range(14, 18)] : null);
        break;
      }
      case 'plaza':
        this.genCity(c, [c.d0 + 2, c.d0 + 22], true);
        break;
      case 'bankBack':
        this.genBankBack(c);
        break;
      case 'bankEnd':
        this.genBankEnd(c);
        break;
      case 'bridge':
        this.genBridge(c);
        break;
      case 'tunnelEnd':
        this.genTunnelEnd(c);
        break;
      case 'tunnelExit':
        this.genTunnelExit(c);
        break;
      case 'industrial':
        this.genIndustrial(c);
        break;
      case 'plantEnd':
        this.genPlantEnd(c);
        break;
      case 'plantBack':
        this.genPlantBack(c);
        break;
      case 'wasteland':
        this.genWasteland(c);
        break;
      case 'safeZone':
        this.genSafeZone(c);
        break;
    }
    if (ROAD_BIOMES.has(biome) && index >= 3) {
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

    // Mesetas rocosas y algún oasis fuera de la vía.
    if (rng.chance(0.3)) {
      const s = rng.sign();
      const w = rng.range(6, 10);
      const len = rng.range(8, 14);
      const d = rng.range(c.d0 + len / 2, c.d1 - len / 2);
      const off = s * rng.range(half + 6 + w / 2, 28 - w / 2);
      this.add(c, cliff(w, rng.range(6, 14), len, rng.next()), d, off, rng.range(-0.3, 0.3));
      this.solid(c, d, off, w / 2, len / 2);
    } else if (rng.chance(0.1)) {
      const s = rng.sign();
      const d = (c.d0 + c.d1) / 2;
      const off = s * rng.range(half + 9, 20);
      const water = new THREE.Mesh(sandGeo, mat(0x3f8fbf));
      water.scale.set(9, 1, 7);
      water.position.y = 0.03;
      this.add(c, water, d, off);
      for (let i = 0; i < 3; i++) this.add(c, palm(), d + rng.range(-4, 4), off + rng.range(-5, 5));
    }
    // Decoración fuera de la vía (también sólida): cactus y rocas.
    const decor = rng.int(2, 8);
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
      if (!plaza && this.ctx.rng.chance(0.6 * Math.min(1.5, this.ctx.config.trafficDensity / 3))) {
        const s = this.ctx.rng.sign();
        const lane = s > 0 ? -3.5 : 3.5;
        // Se programa al acercarse la moto para que el auto se atraviese justo delante.
        this.defer(c, mid, () => {
          const rng = this.ctx.rng;
          const eta = Math.max(1.2, ACTIVATE_AHEAD / Math.max(10, this.leadSpeed));
          let speed = rng.range(11, 16);
          let offset = speed * eta * rng.range(0.8, 1.05);
          if (offset > 42) {
            offset = 42;
            speed = Math.max(7, (42 / eta) * rng.range(0.85, 1.05));
          }
          this.ctx.spawnCivilian({
            x: this.track.centerX(mid) - s * offset,
            d: mid + lane,
            heading: s > 0 ? -Math.PI / 2 : Math.PI / 2,
            speed,
            mode: 'cross',
            lane: 0,
          });
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
          if (len >= 9 && rng.chance(0.14)) {
            this.cityLot(c, d + len / 2, len, s, half);
          } else {
            const h = rng.range(6, 26);
            this.add(c, building(deep, h, len - 0.4, rng.next()), d + len / 2, off);
            this.solid(c, d + len / 2, off, deep / 2, len / 2);
          }
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

  /** Parque o estacionamiento en lugar de un edificio: un respiro visual por el que se puede pasar. */
  private cityLot(c: Chunk, d: number, len: number, s: number, half: number): void {
    const rng = this.ctx.rng;
    const deep = 14;
    const off = s * (half + SIDEWALK + deep / 2 + 0.3);
    if (rng.chance(0.5)) {
      this.flat(c, deep, len - 0.4, 0x5d8a3c, d, off, 0.02);
      for (let i = 0; i < rng.int(2, 4); i++) {
        const td = d + rng.range(-len / 2 + 1.5, len / 2 - 1.5);
        const toff = off + rng.range(-deep / 2 + 2, deep / 2 - 2);
        this.add(c, tree(), td, toff);
        c.bodies.push(this.ctx.physics.fixedBall(this.track.centerX(td) + toff, -td, 0.35, { kind: 'wall' }));
      }
    } else {
      this.flat(c, deep, len - 0.4, 0x3a3b3f, d, off, 0.02);
      for (let z = -len / 2 + 2; z < len / 2 - 1; z += 3) this.flat(c, deep * 0.6, 0.15, 0xdddddd, d + z, off + s * deep * 0.15, 0.03);
      for (let z = -len / 2 + 3.5; z < len / 2 - 2; z += 3) {
        if (!rng.chance(0.55)) continue;
        const pos = off + s * deep * 0.15;
        const car = obstacleMesh('parkedCar', rng.next());
        this.add(c, car, d + z, pos, Math.PI / 2);
        c.bodies.push(this.ctx.physics.fixedBox(this.track.centerX(d + z) + pos, -(d + z), 2, 0.95, this.track.angle(d + z), { kind: 'wall' }));
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
    this.startFront = { x: this.track.centerX(c.d1), d: c.d1 - 2 };
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
    this.finishDoor = bank.getObjectByName('bankDoor') as THREE.Mesh;
    this.solid(c, facade + depth / 2, 0, 35, depth / 2);
    this.bounds(c, BOUND);
    this.finishZone = { kind: 'bank', x: this.track.centerX(facade), d: facade - 4, hw: 6, hd: 4 };
    this.finished = true;
  }

  // ------------------------------------------------------------ puente y túnel (nivel 1 → 2)

  private bridgeDeck(c: Chunk, half: number, d0 = c.d0, d1 = c.d1): void {
    this.strip(c, -half - 1.6, half + 1.6, 0x7d7d78, 0.008, d0, d1);
    this.road(c, half, 0x34353a, d0, d1);
    this.strip(c, -half, -half + 0.25, 0xffffff, 0.03, d0, d1);
    this.strip(c, half - 0.25, half, 0xffffff, 0.03, d0, d1);
    this.strip(c, -0.35, -0.15, 0xf1c40f, 0.03, d0, d1);
    this.strip(c, 0.15, 0.35, 0xf1c40f, 0.03, d0, d1);
    this.dashes(c, -half / 2, 0xffffff, 3, 8, 0.2, d0, d1);
    this.dashes(c, half / 2, 0xffffff, 3, 8, 0.2, d0, d1);
    for (const s of [-1, 1]) {
      for (let d = d0; d < d1; d += 4) this.add(c, box(0.4, 1.1, 4.05, 0xb8b8b8), d + 2, s * (half + 1.3));
      this.solid(c, (d0 + d1) / 2, s * (half + 1.7), 0.4, (d1 - d0) / 2 + 1.5);
    }
  }

  /** Cierra el río a los costados del puente en d (nadie puede rodear la baranda). */
  private riverCaps(c: Chunk, d: number, half: number): void {
    const inner = half + 2.1;
    const outer = BOUND + 1;
    for (const s of [-1, 1]) this.solid(c, d, s * (inner + outer) / 2, (outer - inner) / 2, 0.5);
  }

  private genBridge(c: Chunk): void {
    const rng = this.ctx.rng;
    const half = HALF_WIDTH.bridge;
    this.riverCaps(c, c.d0 + 0.5, half);
    this.riverCaps(c, c.d1 - 0.5, half);
    // Oleaje del río
    for (let i = 0; i < 10; i++) this.flat(c, rng.range(4, 14), 0.5, 0x4a93bd, rng.range(c.d0, c.d1), rng.sign() * rng.range(half + 4, 70), 0.0, rng.range(-0.2, 0.2));
    if (this.prevBiome !== 'bridge') {
      // Estribo de concreto a la entrada del puente
      this.flat(c, 80, 6, 0x8a8a85, c.d0 + 3, 0, 0.004);
      this.gantry(c, c.d0 + 10, half, 'PUENTE DEL RÍO');
    }
    this.bridgeDeck(c, half);
    if (c.index % 2 === 0) {
      // Torres de un puente colgante
      const mid = (c.d0 + c.d1) / 2;
      for (const s of [-1, 1]) this.add(c, box(2.2, 26, 2.2, 0xa03a2a), mid, s * (half + 3.4));
      this.add(c, box(half * 2 + 9, 1.4, 1.6, 0xa03a2a, 0, 24, 0), mid, 0);
      for (const s of [-1, 1]) this.add(c, box(0.2, 0.2, CHUNK, 0x555555, 0, 22, 0), mid, s * (half + 3.4));
    }
    this.bounds(c, BOUND);
    this.roadObstacles(c, this.ctx.config.obstacleWeights, half, 0.6);
    this.roadHazards(c, half, { oil: 1 });
    this.traffic(c, [-3, -7], [3, 7], 0.8);
  }

  /** Final del nivel 1: el puente desemboca en el túnel de la montaña. */
  private genTunnelEnd(c: Chunk): void {
    const half = HALF_WIDTH.tunnelEnd;
    const face = c.d0 + 22;
    const depth = 30;
    this.bridgeDeck(c, half, c.d0, c.d0 + 10);
    this.riverCaps(c, c.d0 + 0.5, half);
    this.riverCaps(c, c.d0 + 10, half);
    this.strip(c, -half - 1.6, half + 1.6, 0x6a5a48, 0.006, c.d0 + 10, face);
    this.road(c, half, 0x34353a, c.d0 + 10, face);
    const mountain = tunnelMountain(96, depth, half * 2);
    this.add(c, mountain, face + depth / 2, 0, Math.PI);
    this.solid(c, face + depth / 2, 0, 48, depth / 2);
    this.bounds(c, BOUND);
    this.finishZone = { kind: 'tunnel', x: this.track.centerX(face), d: face - 4, hw: half - 1, hd: 4 };
    this.finished = true;
  }

  /** Inicio del nivel 2: las motos salen de la boca del túnel. */
  private genTunnelExit(c: Chunk): void {
    const half = HALF_WIDTH.tunnelExit;
    const depth = 30;
    const face = c.d1 - 2;
    this.road(c, half, 0x343434, face - 2, c.d1);
    const mountain = tunnelMountain(96, depth, half * 2);
    this.add(c, mountain, face - depth / 2, 0);
    this.solid(c, face - depth / 2, 0, 48, depth / 2);
    this.bounds(c, BOUND);
    this.startFront = { x: this.track.centerX(face), d: face };
  }

  // ------------------------------------------------------------ zona industrial (nivel 2)

  private industrialStreet(c: Chunk, half: number, d0 = c.d0, d1 = c.d1): void {
    this.strip(c, -half - 2.5, half + 2.5, 0x6b675e, 0.005, d0, d1);
    this.road(c, half, 0x343434, d0, d1);
    this.strip(c, -half, -half + 0.25, 0xcfcfcf, 0.03, d0, d1);
    this.strip(c, half - 0.25, half, 0xcfcfcf, 0.03, d0, d1);
    this.dashes(c, 0, 0xd4a017, 3, 7, 0.22, d0, d1);
    this.dashes(c, -half / 2, 0xcfcfcf, 2.5, 9, 0.2, d0, d1);
    this.dashes(c, half / 2, 0xcfcfcf, 2.5, 9, 0.2, d0, d1);
  }

  private genIndustrial(c: Chunk): void {
    const rng = this.ctx.rng;
    const half = HALF_WIDTH.industrial;
    this.industrialStreet(c, half);
    for (const s of [-1, 1]) {
      let d = c.d0;
      while (c.d1 - d > 4) {
        const r = rng.next();
        if (r < 0.45) {
          // Bodega
          const len = Math.min(rng.range(12, 20), c.d1 - d);
          const deep = rng.range(12, 17);
          const off = s * (half + 3 + deep / 2);
          this.add(c, building(deep, rng.range(6, 10), len - 0.6, rng.next()), d + len / 2, off);
          this.solid(c, d + len / 2, off, deep / 2, len / 2);
          d += len;
        } else if (r < 0.8) {
          // Pila de contenedores
          const len = 6.6;
          if (c.d1 - d < len) break;
          const cols = rng.int(1, 3);
          for (let j = 0; j < cols; j++) {
            const off = s * (half + 3 + 1.3 + j * 2.7);
            const levels = rng.int(1, 2);
            for (let k = 0; k < levels; k++) {
              const ct = container([0xb03a2e, 0x2e86c1, 0x1e8449, 0xd68910][rng.int(0, 3)]);
              ct.position.y = k * 2.6;
              this.add(c, ct, d + len / 2, off);
            }
          }
          this.solid(c, d + len / 2, s * (half + 3 + cols * 1.35), cols * 1.35, len / 2);
          d += len + rng.range(1, 4);
        } else {
          // Chimenea industrial
          const off = s * (half + rng.range(8, 14));
          const h = rng.range(18, 28);
          this.add(c, box(2.4, h, 2.4, 0x8a8580), d + 3, off);
          this.add(c, box(2.5, 1.2, 2.5, 0xc0392b, 0, h - 3, 0), d + 3, off);
          this.add(c, box(2.5, 1.2, 2.5, 0xffffff, 0, h - 1.5, 0), d + 3, off);
          this.solid(c, d + 3, off, 1.2, 1.2);
          d += 8;
        }
      }
    }
    this.bounds(c, BOUND);
    const weights = { ...this.ctx.config.obstacleWeights };
    this.roadObstacles(c, weights, half);
    this.roadHazards(c, half, this.ctx.config.hazardWeights);
    this.traffic(c, [-3, -8], [3, 8], 1);
  }

  /** Final del nivel 2: la carretera termina en la compuerta de la planta nuclear. */
  private genPlantEnd(c: Chunk): void {
    const half = HALF_WIDTH.plantEnd;
    const facade = c.d0 + 30;
    const depth = 26;
    this.industrialStreet(c, half, c.d0, facade);
    this.flat(c, 70, 14, 0x8f8a80, facade - 7, 0, 0.012);
    const plant = nuclearPlant(70, depth, false, true);
    this.add(c, plant, facade + depth / 2, 0, Math.PI);
    this.finishDoor = plant.getObjectByName('plantDoor') as THREE.Mesh;
    this.solid(c, facade + depth / 2, 0, 35, depth / 2);
    const towerD = facade + depth + 8;
    for (const s of [-1, 1]) this.add(c, coolingTower(10, 26, false), towerD, s * 24);
    this.bounds(c, BOUND);
    const cx = this.track.centerX(facade + depth / 2);
    this.blastPoints = [
      { x: cx, z: -(facade + depth / 2) },
      { x: this.track.centerX(towerD) - 24, z: -towerD },
      { x: this.track.centerX(towerD) + 24, z: -towerD },
    ];
    this.finishZone = { kind: 'plant', x: this.track.centerX(facade), d: facade - 4, hw: 6, hd: 4 };
    this.finished = true;
  }

  // ------------------------------------------------------------ tierra baldía (nivel 3)

  /** Inicio del nivel 3: la planta destruida queda detrás, brillando en verde. */
  private genPlantBack(c: Chunk): void {
    const half = HALF_WIDTH.plantBack;
    const depth = 26;
    const center = c.d1 - 3 - depth / 2;
    this.road(c, half, 0x3d3a36, c.d1 - 6, c.d1);
    const plant = nuclearPlant(70, depth, true);
    this.add(c, plant, center, 0);
    this.solid(c, center, 0, 35, depth / 2);
    for (const s of [-1, 1]) this.add(c, coolingTower(10, 13, true), center - 2, s * 26);
    this.solid(c, c.d0 + 0.5, 0, BOUND + 1, 0.5);
    this.bounds(c, BOUND);
    this.startFront = { x: this.track.centerX(c.d1), d: c.d1 - 2 };
  }

  private wastelandRoad(c: Chunk, half: number): void {
    const rng = this.ctx.rng;
    this.strip(c, -half - 2, half + 2, 0x5e5240, 0.005);
    this.road(c, half, 0x3d3a36);
    this.dashes(c, 0, 0x8a7a3a, 3, 9);
    // Grietas en el asfalto
    for (let i = 0; i < 6; i++) this.flat(c, 0.18, rng.range(2, 6), 0x1f1d1b, rng.range(c.d0, c.d1), rng.range(-half + 1, half - 1), 0.03, rng.range(-1, 1));
    for (const s of [-1, 1]) {
      for (let d = c.d0; d < c.d1; d += 10) {
        const w = rng.range(5, 8);
        const off = s * (30 + w / 2);
        this.add(c, rubble(w, rng.range(3, 8), 10.4, rng.next()), d + 5, off);
        this.solid(c, d + 5, off, w / 2, 5.2);
      }
    }
    this.bounds(c, BOUND);
  }

  private genWasteland(c: Chunk): void {
    const rng = this.ctx.rng;
    const half = HALF_WIDTH.wasteland;
    this.wastelandRoad(c, half);
    for (const s of [-1, 1]) {
      let d = c.d0 + rng.range(0, 6);
      while (d < c.d1 - 6) {
        const len = rng.range(7, 13);
        const deep = rng.range(7, 12);
        const off = s * (half + rng.range(4, 8) + deep / 2);
        if (Math.abs(off) + deep / 2 < 29.5) {
          this.add(c, ruin(deep, rng.range(5, 13), len, rng.next()), d + len / 2, off);
          this.solid(c, d + len / 2, off, deep / 2, len / 2);
          c.placed.push({ x: this.track.centerX(d + len / 2) + off, d: d + len / 2, r: Math.max(deep, len) / 2 });
        }
        d += len + rng.range(4, 12);
      }
      for (let i = 0; i < 2; i++) {
        const td = rng.range(c.d0, c.d1);
        const off = s * rng.range(half + 2, half + 4);
        this.add(c, deadTree(), td, off);
      }
      if (rng.chance(0.5)) this.addObstacle(c, 'wreck', rng.range(c.d0, c.d1), s * rng.range(half + 3, 26), rng.range(0, 6), false);
      if (rng.chance(0.4)) this.addObstacle(c, 'toxicBarrel', rng.range(c.d0, c.d1), s * rng.range(half + 3, 26), 0, false);
    }
    this.roadObstacles(c, this.ctx.config.obstacleWeights, half + 1);
    // Hordas de zombis cruzando la carretera
    if (c.index >= 2 && rng.chance(Math.min(0.8, 0.35 * (this.ctx.config.obstacleDensity / 8)))) {
      const d = rng.range(c.d0 + 6, c.d1 - 6);
      const n = rng.int(2, 5);
      for (let i = 0; i < n; i++) {
        const zd = d + rng.range(-4, 4);
        const off = rng.range(-half, half);
        if (this.isClear(this.track.centerX(zd) + off, zd, 1)) this.planObstacle(c, 'zombie', zd, off, 0);
      }
    }
    this.roadHazards(c, half, this.ctx.config.hazardWeights);
  }

  /** Final del nivel 3: el cartel de la zona segura marca la meta. */
  private genSafeZone(c: Chunk): void {
    const half = HALF_WIDTH.safeZone;
    this.wastelandRoad(c, half);
    const d = c.d0 + 20;
    this.gantry(c, d, half, 'ZONA SEGURA');
    for (let x = -half, i = 0; x < half; x += 1, i++) {
      this.flat(c, 1, 1, i % 2 === 0 ? 0xffffff : 0x111111, d - 0.5, x + 0.5, 0.04);
      this.flat(c, 1, 1, i % 2 === 0 ? 0x111111 : 0xffffff, d + 0.5, x + 0.5, 0.04);
    }
    this.finishZone = { kind: 'safeZone', x: this.track.centerX(d), d, hw: 40, hd: 1.5 };
  }

  // ------------------------------------------------------------ contenido

  private defer(c: Chunk, d: number, run: () => void): void {
    c.pending.push({ d, run });
  }

  /**
   * Reserva el lugar de un obstáculo en la vía ahora, pero lo crea al acercarse
   * la moto: así nadie lo choca ni lo empuja antes de que el jugador llegue.
   */
  private planObstacle(c: Chunk, kind: ObstacleKind, d: number, off: number, rotOffset: number, mesh?: THREE.Object3D): void {
    const spec = OBSTACLE_SPECS[kind];
    c.placed.push({ x: this.track.centerX(d) + off, d, r: Math.max(spec.hx, spec.hz) });
    this.defer(c, d, () => this.addObstacle(c, kind, d, off, rotOffset, true, mesh, false));
  }

  private addObstacle(
    c: Chunk,
    kind: ObstacleKind,
    d: number,
    off: number,
    rotOffset: number,
    onRoad: boolean,
    mesh?: THREE.Object3D,
    register = true,
  ): ObstacleRecord {
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
          rotates: kind !== 'zombie',
        })
      : this.ctx.physics.fixedBox(x, -d, spec.hx, spec.hz, rot, tag);
    if (kind === 'tumbleweed') {
      const dir = this.ctx.rng.sign();
      rec.drift = { x: dir * this.ctx.rng.range(3, 6), z: this.ctx.rng.range(-1, 1) };
    }
    if (kind === 'zombie') {
      // Caminan lentamente de un lado a otro de la vía.
      const dir = this.ctx.rng.sign();
      rec.drift = { x: dir * this.ctx.rng.range(1.2, 2.4), z: this.ctx.rng.range(-0.4, 0.4) };
      const facing = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      rec.body.setRotation(quatY(facing), true);
      m.rotation.y = facing;
    }
    c.bodies.push(rec.body);
    c.obstacles.push(rec);
    if (register) c.placed.push({ x, d, r: Math.max(spec.hx, spec.hz) });
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

  private roadObstacles(c: Chunk, weights: Partial<Record<ObstacleKind, number>>, half: number, factor = 1): void {
    const rng = this.ctx.rng;
    // Los primeros tramos quedan despejados para arrancar con calma.
    if (c.index < 2) return;
    const base = (this.ctx.config.obstacleDensity * factor * CHUNK) / 100;
    const roll = rng.next();
    let scale = 1;
    if (roll < 0.15) {
      // Tramo de respiro: casi vacío.
      scale = 0.25;
    } else if (roll < 0.15 + Math.min(0.6, 0.3 + base / 8)) {
      // Una formación (slalom, muro con hueco, chicane...) y menos obstáculos sueltos.
      this.formation(c, weights, half);
      scale = 0.45;
    }
    const count = rng.poisson(base * scale);
    for (let i = 0; i < count; i++) {
      const kind = rng.weighted(weights);
      const spec = OBSTACLE_SPECS[kind];
      if (kind === 'parkedCar' || kind === 'container') {
        // Estacionados junto al borde, alineados con la vía.
        const s = rng.sign();
        const d = rng.range(c.d0 + 3.5, c.d1 - 3.5);
        const off = s * (half - spec.hx - 0.3);
        if (this.isClear(this.track.centerX(d) + off, d, spec.hz + 1)) this.planObstacle(c, kind, d, off, rng.chance(0.5) ? 0 : Math.PI);
        continue;
      }
      const spot = this.freeSpot(c, half, Math.max(spec.hx, spec.hz));
      if (!spot) continue;
      this.planObstacle(c, kind, spot.d, spot.off, this.randomRotation(kind));
    }
  }

  private randomRotation(kind: ObstacleKind): number {
    const rng = this.ctx.rng;
    if (kind === 'barrier') return rng.range(-0.15, 0.15);
    if (kind === 'wreck') return rng.range(-0.8, 0.8);
    return rng.range(0, Math.PI * 2);
  }

  /** Marca un espacio libre (hueco de un muro, paso de un retén) que nadie debe ocupar. */
  private reserve(c: Chunk, d: number, off: number, r: number): void {
    c.placed.push({ x: this.track.centerX(d) + off, d, r });
  }

  /** Coloca un obstáculo si el lugar está libre y dentro del tramo. */
  private placeOnRoad(c: Chunk, kind: ObstacleKind, d: number, off: number, rot = this.randomRotation(kind)): void {
    if (d < c.d0 + 1 || d > c.d1 - 1) return;
    const spec = OBSTACLE_SPECS[kind];
    if (this.isClear(this.track.centerX(d) + off, d, Math.max(spec.hx, spec.hz) + 0.3)) this.planObstacle(c, kind, d, off, rot);
  }

  /** Formaciones de obstáculos: dan ritmo y variedad frente al reparto uniforme. */
  private formation(c: Chunk, weights: Partial<Record<ObstacleKind, number>>, half: number): void {
    const rng = this.ctx.rng;
    const has = (k: ObstacleKind) => (weights[k] ?? 0) > 0;
    const soft = (['cone', 'barrel', 'crate', 'toxicBarrel', 'tumbleweed'] as ObstacleKind[]).filter(has);
    const hard = (['barrier', 'wreck', 'rock', 'dumpster'] as ObstacleKind[]).filter(has);
    const options: string[] = [];
    if (soft.length) options.push('slalom', 'spill', 'wall');
    if (hard.length) options.push('chicane', 'wall');
    if (has('parkedCar') || has('container')) options.push('parkedLine');
    if (has('zombie')) options.push('horde', 'horde');
    if (has('fuelBarrel')) options.push('depot');
    // Rampa de salto (nunca sobre el puente: el salto podría caer al río).
    if ((soft.length || hard.length) && c.biome !== 'bridge') options.push('jump');
    if (!options.length) return;
    const start = c.d0 + rng.range(3, 10);

    switch (rng.pick(options)) {
      case 'slalom': {
        // Zigzag: obstáculos alternando de lado.
        const k = rng.pick(soft);
        let side = rng.sign();
        const gap = rng.range(5, 7.5);
        for (let i = 0, n = rng.int(4, 6); i < n; i++, side = -side) this.placeOnRoad(c, k, start + i * gap, side * rng.range(half * 0.2, half * 0.55));
        break;
      }
      case 'wall': {
        // Fila de lado a lado con un único hueco.
        const k = soft.length && (rng.chance(0.6) || !hard.length) ? rng.pick(soft) : rng.pick(hard);
        const spec = OBSTACLE_SPECS[k];
        const d = rng.range(c.d0 + 8, c.d1 - 8);
        const hole = rng.range(-half + 3.5, half - 3.5);
        // Barreras y chatarra van alineadas; el resto gira libre, así que su ancho real es mayor.
        const aligned = k === 'barrier' || k === 'wreck';
        const foot = aligned ? spec.hx : Math.hypot(spec.hx, spec.hz);
        for (let off = -half + foot; off <= half - foot; off += foot * 2 + 0.4) {
          // Hueco de al menos ~5,8 m entre los bordes de las piezas vecinas.
          if (Math.abs(off - hole) > 2.9 + foot) this.placeOnRoad(c, k, d + rng.range(-0.3, 0.3), off, aligned ? rng.range(-0.08, 0.08) : undefined);
        }
        // El hueco queda reservado: ningún otro obstáculo puede taparlo.
        this.reserve(c, d, hole, 2.9);
        break;
      }
      case 'chicane': {
        // Barreras que cierran media vía, alternando lados.
        const k = rng.pick(hard);
        const spec = OBSTACLE_SPECS[k];
        const foot = k === 'barrier' || k === 'wreck' ? spec.hx : Math.hypot(spec.hx, spec.hz);
        let side = rng.sign();
        for (let i = 0, n = rng.int(2, 3); i < n; i++, side = -side) {
          const d = start + i * rng.range(11, 15);
          // Cada fila cierra su mitad sin pasar del centro: obliga a zigzaguear, no a frenar.
          for (let off = half - foot; off >= foot; off -= foot * 2 + 0.3) this.placeOnRoad(c, k, d, side * off, k === 'barrier' || k === 'wreck' ? 0 : undefined);
          this.reserve(c, d, -side * half * 0.5, 3.4);
        }
        break;
      }
      case 'depot': {
        // Barriles de combustible juntos junto al borde: una trampa para los perseguidores.
        const d = rng.range(c.d0 + 6, c.d1 - 6);
        const s = rng.sign();
        for (let i = 0, n = rng.int(3, 5); i < n; i++) this.placeOnRoad(c, 'fuelBarrel', d + rng.range(-2.5, 2.5), s * (half - rng.range(1, 3.5)));
        break;
      }
      case 'jump': {
        // Rampa y, poco después, un muro con hueco: se puede saltar por encima o rodearlo.
        const off = rng.range(-half * 0.4, half * 0.4);
        const d = Math.min(start, c.d1 - 26);
        if (d < c.d0 + 2 || !this.isClear(this.track.centerX(d) + off, d, 3)) break;
        this.hazard(c, 'ramp', d, off, 2.2, 1.6);
        this.reserve(c, d, off, 3);
        // El tramo de aterrizaje queda despejado.
        for (const ahead of [14, 20, 25]) this.reserve(c, d + ahead, off, 2.6);
        const pool = hard.length ? hard : soft;
        const k = rng.pick(pool);
        const spec = OBSTACLE_SPECS[k];
        const wd = d + 8;
        const hole = rng.range(-half + 3.5, half - 3.5);
        const aligned = k === 'barrier' || k === 'wreck';
        const foot = aligned ? spec.hx : Math.hypot(spec.hx, spec.hz);
        for (let o = -half + foot; o <= half - foot; o += foot * 2 + 0.4) {
          if (Math.abs(o - hole) > 2.9 + foot) this.placeOnRoad(c, k, wd, o, aligned ? 0 : undefined);
        }
        this.reserve(c, wd, hole, 2.9);
        break;
      }
      case 'spill': {
        // Carga derramada: un montón de cajas o barriles juntos.
        const k = rng.pick(soft);
        const d = rng.range(c.d0 + 6, c.d1 - 6);
        const off = rng.range(-half * 0.6, half * 0.6);
        for (let i = 0, n = rng.int(4, 8); i < n; i++) this.placeOnRoad(c, k, d + rng.range(-3, 3), off + rng.range(-3, 3));
        break;
      }
      case 'parkedLine': {
        // Varios vehículos estacionados seguidos junto al borde.
        const k: ObstacleKind = has('container') && (!has('parkedCar') || rng.chance(0.5)) ? 'container' : 'parkedCar';
        const spec = OBSTACLE_SPECS[k];
        const s = rng.sign();
        let d = start;
        for (let i = 0, n = rng.int(2, 4); i < n; i++) {
          this.placeOnRoad(c, k, d + spec.hz, s * (half - spec.hx - 0.3), rng.chance(0.5) ? 0 : Math.PI);
          d += spec.hz * 2 + rng.range(0.8, 3);
        }
        break;
      }
      case 'horde': {
        // Hilera de zombis cruzando de lado a lado.
        const d = rng.range(c.d0 + 6, c.d1 - 6);
        for (let i = 0, n = rng.int(3, 6); i < n; i++) this.placeOnRoad(c, 'zombie', d + rng.range(-5, 5), rng.range(-half, half), 0);
        break;
      }
    }
  }

  private roadHazards(c: Chunk, half: number, weights: Partial<Record<HazardKind, number>>): void {
    const rng = this.ctx.rng;
    if (c.index < 2 || Object.values(weights).every((w) => !w)) return;
    const count = rng.poisson((this.ctx.config.hazardDensity * CHUNK) / 100);
    for (let i = 0; i < count; i++) {
      const kind = rng.weighted(weights);
      const size = { sand: [3.5, 3], oil: [1.8, 1.6], spikes: [3.2, 0.4], acid: [2.2, 2], ramp: [2.2, 1.6] }[kind];
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
    } else if (kind === 'ramp') {
      this.add(c, rampMesh(), d, off);
    } else if (kind === 'acid') {
      const m = new THREE.Mesh(sandGeo, mat(0x4cff2a, 0x1fae0a));
      m.scale.set(hw * 2, 1, hd * 2);
      m.position.y = 0.05;
      this.add(c, m, d, off);
      const rim = new THREE.Mesh(sandGeo, mat(0x2a5a1a));
      rim.scale.set(hw * 2.3, 1, hd * 2.3);
      rim.position.y = 0.04;
      this.add(c, rim, d, off);
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
      const spawn = {
        x,
        d,
        heading: this.track.angle(d) + (isForward ? 0 : Math.PI),
        speed: isForward ? rng.range(10, 16) : rng.range(12, 18),
        mode: 'lane' as const,
        lane,
      };
      this.defer(c, d, () => this.ctx.spawnCivilian(spawn));
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
    const every = this.ctx.config.roadblockEvery;
    if (every <= 0) return;
    // La IA puede activar los retenes a mitad de nivel: el primero llega con algo de margen.
    if (this.nextRoadblock === Infinity) this.nextRoadblock = c.d0 + every * 0.4;
    if (c.d0 < this.nextRoadblock) return;
    const rng = this.ctx.rng;
    this.nextRoadblock = c.d0 + this.ctx.config.roadblockEvery * rng.range(0.8, 1.2);
    const half = this.ctx.track.halfWidth(c.d0 + 20);
    const d = c.d0 + 20;
    const slots: number[] = [];
    for (let off = -half + 2.2; off <= half - 2.2; off += 4.5) slots.push(off);
    const gap = rng.int(0, slots.length - 1);
    // Si algo ya ocupa el paso del retén, se deja para el siguiente tramo.
    if (!this.isClear(this.track.centerX(d) + slots[gap], d, 2.6)) {
      this.nextRoadblock = c.d1;
      return;
    }
    this.reserve(c, d, slots[gap], 2.6);
    const faction = this.ctx.config.faction;
    slots.forEach((off, i) => {
      if (i === gap) return;
      const dd = d + rng.range(-0.6, 0.6);
      const rot = Math.PI / 2 + rng.range(-0.25, 0.25);
      if (faction === 'police') {
        // Retén policial con sirenas encendidas
        const pm = policeVehicle('patrol');
        setSiren(pm, i % 2 === 0);
        c.sirens.push(pm);
        this.planObstacle(c, 'parkedCar', dd, off, rot, pm.group);
      } else if (faction === 'gang') {
        // Barricada de la banda rival
        this.planObstacle(c, 'parkedCar', dd, off, rot, outlawVehicle('muscle'));
      } else {
        // Muro de chatarra quemada
        this.planObstacle(c, 'wreck', dd, off, rot);
      }
    });
    // Púas delante de un vehículo de la barricada y conos o barriles en los bordes.
    const spikeSlot = slots[(gap + 1) % slots.length];
    if (faction !== 'gang' && Math.abs(spikeSlot - slots[gap]) > 1) this.hazard(c, 'spikes', d - 4, spikeSlot, 2.2, 0.4);
    const edge: ObstacleKind = faction === 'police' ? 'cone' : faction === 'gang' ? 'barrel' : 'toxicBarrel';
    for (const s of [-1, 1]) this.planObstacle(c, edge, d - 2, s * (half - 0.6), 0);
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
