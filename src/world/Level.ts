import * as THREE from 'three';
import { AdaptiveDifficulty, kindLabel } from '../ai/AdaptiveDifficulty';
import { PerformanceTracker } from '../ai/PerformanceTracker';
import { buildProfile, type SkillClassifier, type SkillProfile } from '../ai/SkillClassifier';
import { BASE_LEVELS } from '../config/levels';
import { VEHICLES, type VehicleDef } from '../config/vehicles';
import type { Biome, Faction, FinishScene, LevelConfig, Mood, PursuerConfig, PursuerKind } from '../config/types';
import type { Audio } from '../core/Audio';
import { steerToward, type DriveInput } from '../core/Input';
import { clamp, clamp01, wrapAngle } from '../core/math';
import { Rng } from '../core/Rng';
import { Civilian } from '../entities/Civilian';
import { Flyer } from '../entities/Flyer';
import { Helicopter } from '../entities/Helicopter';
import { Player } from '../entities/Player';
import { Lobs, type Lob } from '../entities/Lobs';
import { Projectiles, segmentDistance } from '../entities/Projectiles';
import { FLAME_ANGLE, FLAME_RANGE, Pursuer, PURSUER_STATS, type FireRequest } from '../entities/Pursuer';
import { Sandstorm } from '../entities/Sandstorm';
import { mat } from '../fx/Meshes';
import { Effects } from '../fx/Particles';
import { CameraRig, cameraFocus } from './CameraRig';
import { ChunkManager, type CivilianSpawn, type ObstacleRecord } from './ChunkManager';
import { Physics, type Tag } from './Physics';
import { CHUNK, ROUGH_BIOMES, Track } from './Track';

export interface LevelHooks {
  message(text: string, color?: string, seconds?: number): void;
  /** Destello de pantalla completa (explosiones grandes). */
  flash(color: string): void;
}

export type LevelState = 'countdown' | 'running' | 'ending' | 'done';

const MOODS = {
  day: { bg: 0xd9c49c, sky: 0xfff6e5, ground: 0xb89468, hemi: 1.7, sun: 0xffffff, sunI: 2.6 },
  afternoon: { bg: 0xcdb89a, sky: 0xffeacc, ground: 0x8a7a66, hemi: 1.6, sun: 0xffe2b8, sunI: 2.4 },
  sunset: { bg: 0x7a5468, sky: 0xffc7a0, ground: 0x6a4a5a, hemi: 1.4, sun: 0xff9d5c, sunI: 2.2 },
  toxic: { bg: 0x3a3d2c, sky: 0xe4ecc8, ground: 0x4a4030, hemi: 1.5, sun: 0xf2ffd6, sunI: 2.1 },
  night: { bg: 0x10131d, sky: 0x6a7aaa, ground: 0x1a1a24, hemi: 0.9, sun: 0x9fb4ff, sunI: 1.0 },
};

// ---- Nivel infinito: zonas que cambian bioma, bando, iluminación y música.
type EndlessBiome = 'desert' | 'city' | 'industrial' | 'wasteland';

interface Zone {
  index: number;
  d0: number;
  d1: number;
  biome: EndlessBiome;
  faction: Faction;
  mood: Mood;
  /** Tramo de unión con la zona siguiente. */
  connector: 'bridge' | 'outskirts';
}

const ZONE_NAMES: Record<EndlessBiome, string> = {
  desert: 'Desierto abierto',
  city: 'Ciudad',
  industrial: 'Zona industrial',
  wasteland: 'Tierra baldía',
};
const ZONE_MOODS: Record<EndlessBiome, Mood[]> = {
  desert: ['day', 'afternoon', 'sunset', 'night'],
  city: ['afternoon', 'sunset', 'night', 'day'],
  industrial: ['sunset', 'night', 'afternoon'],
  wasteland: ['toxic', 'night', 'sunset'],
};
const ZONE_GEN: Record<EndlessBiome, Pick<LevelConfig, 'obstacleWeights' | 'hazardWeights' | 'trafficDensity'>> = {
  desert: { obstacleWeights: { barrel: 2, crate: 1.5, wreck: 1, rock: 1.5, tumbleweed: 1.5, fuelBarrel: 1.6 }, hazardWeights: { sand: 1, oil: 0.3, spikes: 0.3 }, trafficDensity: 1.8 },
  city: { obstacleWeights: BASE_LEVELS[1].obstacleWeights, hazardWeights: BASE_LEVELS[1].hazardWeights, trafficDensity: 3 },
  industrial: { obstacleWeights: BASE_LEVELS[2].obstacleWeights, hazardWeights: BASE_LEVELS[2].hazardWeights, trafficDensity: 1.8 },
  wasteland: { obstacleWeights: BASE_LEVELS[3].obstacleWeights, hazardWeights: BASE_LEVELS[3].hazardWeights, trafficDensity: 0 },
};
const ROSTERS: Record<Faction, PursuerKind[]> = {
  police: BASE_LEVELS[1].roster,
  gang: BASE_LEVELS[2].roster,
  wasteland: BASE_LEVELS[3].roster,
};
const ALL_KINDS: PursuerKind[] = [...ROSTERS.police, ...ROSTERS.gang, ...ROSTERS.wasteland];
const FACTION_LABEL: Record<Faction, string> = { police: 'la policía', gang: 'Los Cuervos', wasteland: 'los saqueadores' };
const TARGET_RING = new THREE.RingGeometry(1.8, 2.2, 32).rotateX(-Math.PI / 2);
/** Alcance del auto-apuntado del arma de la moto (m). */
const AIM_RANGE = 45;
const PLAYER_BULLET_DAMAGE = 20;

const ACID_POOL_GEO = new THREE.CircleGeometry(0.5, 18).rotateX(-Math.PI / 2);
const ACID_POOL_MAT = new THREE.MeshBasicMaterial({ color: 0x5cff2a, transparent: true, opacity: 0.75, depthWrite: false });

/** Biomas donde las explosiones y el fuego son verdes (estética tóxica). */
const TOXIC_BIOMES = new Set<Biome>(['wasteland', 'plantBack', 'safeZone']);

interface BlastSpec {
  radius: number;
  pursuerDmg: number;
  playerDmg: number;
  scale: number;
}
const BLASTS = {
  barrel: { radius: 8, pursuerDmg: 170, playerDmg: 16, scale: 1.5 },
  vehicle: { radius: 6, pursuerDmg: 80, playerDmg: 9, scale: 1.1 },
  grenade: { radius: 5.5, pursuerDmg: 60, playerDmg: 14, scale: 1.15 },
  bomb: { radius: 4.5, pursuerDmg: 60, playerDmg: 11, scale: 1 },
} satisfies Record<string, BlastSpec>;

const MUSIC_BY_BIOME: Record<EndlessBiome, number> = { desert: 0, city: 1, industrial: 2, wasteland: 3 };

/** Duración del salto al salir de una estructura (s). */
const JUMP_TIME = 0.8;

const OBSTACLE_HARDNESS: Record<string, number> = {
  rock: 1.6,
  cactus: 1.0,
  barrier: 1.6,
  wreck: 1.5,
  container: 1.6,
  dumpster: 1.2,
  parkedCar: 1.2,
  barrel: 0.7,
  toxicBarrel: 0.7,
  fuelBarrel: 0.6,
  crate: 0.5,
  cone: 0.25,
  tumbleweed: 0.15,
  zombie: 0.12,
};

/** Cómo anuncia El Analista los refuerzos de cada facción. */
const REINFORCEMENTS = { police: 'La policía envía', gang: 'Los Cuervos mandan', wasteland: 'De las ruinas salen' };

/** Distancia (m) por detrás del compañero a la que un jugador es capturado. */
const CAPTURE_GAP = 60;
/** Segundos que tarda en reaparecer un jugador caído o capturado. */
const RESPAWN_TIME = 10;

/**
 * Una partida de un nivel: escena, física, mapa procedural, jugadores,
 * perseguidores, tráfico, calibración de la IA y reglas de victoria/derrota.
 * Los niveles terminan por distancia al llegar a su estructura final.
 */
export class Level {
  /** Resolución del mapa de sombras (en celulares se reduce). */
  static shadowSize = 2048;

  readonly scene = new THREE.Scene();
  readonly physics = new Physics();
  readonly rng = new Rng(Math.floor(Math.random() * 1e9));
  readonly track: Track;
  readonly chunks: ChunkManager;
  readonly fx: Effects;
  readonly bullets: Projectiles;
  readonly tracker: PerformanceTracker;
  readonly players: Player[] = [];
  readonly pursuers: Pursuer[] = [];
  readonly civilians: Civilian[] = [];
  heli: Helicopter | null = null;
  readonly flyers: Flyer[] = [];
  storm: Sandstorm | null = null;

  state: LevelState = 'countdown';
  outcome: 'complete' | 'failed' | null = null;
  countdown = 3;
  elapsed = 0;
  score = 0;
  cashLost = 0;
  maxD = 0;
  /** Progreso de la calibración (0..1) y estimación en vivo de la habilidad. */
  aiProgress = 0;
  liveProfile: SkillProfile | null = null;
  /** Perfil medido al terminar la calibración (o el nivel 0 completo). */
  calibratedProfile: SkillProfile | null = null;

  private difficulty = new AdaptiveDifficulty();
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private moodTarget: (typeof MOODS)[Mood] | null = null;
  private zones: Zone[] = [];
  private currentZone = -1;
  /** Habilidad medida en la calibración del nivel infinito (rige su rampa de dificultad). */
  private endlessSkill = 0.5;
  /** Explosiones pendientes (las reacciones en cadena se escalonan unas décimas). */
  private blasts: { x: number; z: number; delay: number; spec: BlastSpec }[] = [];
  /** Granadas, bombas y gotas de ácido en el aire. */
  private lobs: Lobs;
  /** Charcos de ácido temporales que deja la lluvia de las harpías. */
  private acidPools: { x: number; z: number; r: number; life: number; mesh: THREE.Mesh }[] = [];
  private flameWarn = 0;
  /** Anillo bajo el objetivo al que apunta cada moto con la tecla de disparo. */
  private targetMarkers: THREE.Mesh[] = [];
  private ammoWarn = 0;
  /** Tiempo bala restante (segundos reales). */
  private slowmo = 0;
  private combo = 0;
  private lastKill = -10;
  private recentKills: number[] = [];
  private cam = new CameraRig();
  /** Temblor de cámara (0..~1.2). */
  shake = 0;
  private spawnTimer = 2.5;
  private firstWave = true;
  private liveTimer = 0;
  private endTimer = 0;
  private blastTimer = -1;
  private blastCount = 0;
  private respawnTimers = new Map<Player, number>();
  private origMaterials = new Map<Player, THREE.Material[]>();
  private startSmoke = 0;
  private announced = new Set<number>();
  private civColor = 0;

  constructor(
    readonly config: LevelConfig,
    readonly playerCount: number,
    private audio: Audio,
    private hooks: LevelHooks,
    private classifier: SkillClassifier,
    /** Vehículo de cada jugador (por defecto, la moto). */
    vehicles: VehicleDef[] = [],
  ) {
    const mood = MOODS[config.mood];
    this.scene.background = new THREE.Color(mood.bg);
    this.hemi = new THREE.HemisphereLight(mood.sky, mood.ground, mood.hemi);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(mood.sun, mood.sunI);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(Level.shadowSize, Level.shadowSize);
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 1;
    sc.far = 260;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);

    this.track = new Track(this.rng);
    this.fx = new Effects(this.scene);
    this.bullets = new Projectiles(this.scene);
    this.lobs = new Lobs(this.scene);
    this.tracker = new PerformanceTracker(playerCount);

    this.chunks = new ChunkManager(
      {
        scene: this.scene,
        physics: this.physics,
        track: this.track,
        rng: this.rng,
        config,
        biomeFor: (i) => this.biomeFor(i),
        spawnCivilian: (s) => this.spawnCivilian(s),
      },
      -1,
    );
    this.chunks.update(0, -Infinity, 0);

    // En los niveles 1-3 las motos esperan dentro de la estructura inicial y salen por su puerta.
    const inside = config.start !== 'road';
    const startD = inside ? -9 : 6;
    const defs = Array.from({ length: playerCount }, (_, i) => vehicles[i] ?? VEHICLES[0]);
    // Separación según el ancho de los vehículos elegidos (dos autos no caben tan juntos como dos motos).
    const halfWidths = defs.reduce((s, d) => s + d.spec.hx, 0) / 2;
    const spacing = Math.max(inside ? 1.3 : 2.2, halfWidths + 0.35);
    for (let i = 0; i < playerCount; i++) {
      const off = playerCount === 1 ? 0 : i === 0 ? -spacing : spacing;
      const p = new Player(this.physics, i, this.track.centerX(startD) + off, -startD, 0, defs[i]);
      if (inside) {
        p.setGhost(true);
        p.cutscene = 'exit';
        p.mesh.visible = false;
      }
      this.scene.add(p.mesh);
      this.players.push(p);
    }
    if (config.index === 0) this.storm = new Sandstorm(this.scene, 60, Math.min(1, ...defs.map((d) => d.spec.maxSpeed / VEHICLES[0].spec.maxSpeed)));
    for (const p of this.players) {
      const marker = new THREE.Mesh(TARGET_RING, new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.85, depthWrite: false }));
      marker.visible = false;
      this.scene.add(marker);
      this.targetMarkers.push(marker);
    }
    if (config.index === 4) {
      // La calibración arranca con el perseguidor más básico del bando de la primera zona.
      const zone = this.zoneAt(0);
      config.faction = zone.faction;
      config.pursuers = { ...config.pursuers!, kinds: { [ROSTERS[zone.faction][0]]: 1 } };
    }

    this.cam.place(this.track.centerX(startD), -startD - 8);
  }

  // ------------------------------------------------------------ mapa

  /** Bioma de cada tramo según su distancia a la meta. */
  private biomeFor(i: number): Biome {
    const cfg = this.config;
    const d0 = i * CHUNK;
    const end = cfg.distance;
    switch (cfg.index) {
      case 0:
        if (d0 >= end - CHUNK) return 'bankEnd';
        if (d0 < end * 0.5) return 'desert';
        return d0 < end * 0.5 + 2 * CHUNK ? 'outskirts' : 'city';
      case 1:
        if (i < 0) return 'bankBack';
        if (i === 0) return 'plaza';
        if (d0 >= end - CHUNK) return 'tunnelEnd';
        return d0 >= end - 4 * CHUNK ? 'bridge' : 'city';
      case 2:
        if (i < 0) return 'tunnelExit';
        return d0 >= end - CHUNK ? 'plantEnd' : 'industrial';
      case 4: {
        if (i < 1) return 'desert';
        const zone = this.zoneAt(d0);
        this.applyZoneGeneration(zone);
        // Los dos últimos tramos de cada zona la unen con la siguiente.
        if (d0 >= zone.d1 - 2 * CHUNK) return zone.connector;
        return zone.biome;
      }
      case 3:
      default:
        if (i < 0) return 'plantBack';
        if (d0 >= end) return 'desert';
        return d0 >= end - CHUNK ? 'safeZone' : 'wasteland';
    }
  }

  /** Zona del nivel infinito que contiene la distancia d (se generan bajo demanda). */
  private zoneAt(d: number): Zone {
    while (!this.zones.length || this.zones[this.zones.length - 1].d1 <= d) {
      const prev = this.zones[this.zones.length - 1];
      const index = this.zones.length;
      const d0 = prev ? prev.d1 : 0;
      const biomes = (['desert', 'city', 'industrial', 'wasteland'] as EndlessBiome[]).filter((b) => b !== prev?.biome);
      const biome: EndlessBiome = index === 0 ? 'desert' : this.rng.pick(biomes);
      const len = (index === 0 ? 9 : this.rng.int(13, 22)) * CHUNK;
      const faction: Faction =
        biome === 'city' ? 'police' : biome === 'industrial' ? 'gang' : biome === 'wasteland' ? 'wasteland' : this.rng.pick(['police', 'gang', 'wasteland'] as Faction[]);
      this.zones.push({
        index,
        d0,
        d1: d0 + len,
        biome,
        faction,
        mood: index === 0 ? 'day' : this.rng.pick(ZONE_MOODS[biome]),
        connector: this.rng.chance(0.5) ? 'bridge' : 'outskirts',
      });
    }
    return this.zones.find((z) => d < z.d1) ?? this.zones[0];
  }

  /** Ajusta la generación de los tramos de una zona: obstáculos, peligros, tráfico y retenes. */
  private applyZoneGeneration(zone: Zone): void {
    const cfg = this.config;
    Object.assign(cfg, ZONE_GEN[zone.biome]);
    cfg.faction = zone.faction;
    cfg.obstacleDensity = Math.min(16, (5.5 + zone.index * 0.8) * (0.7 + 0.6 * this.endlessSkill));
    cfg.hazardDensity = Math.min(3.5, 1 + zone.index * 0.2);
    cfg.roadblockEvery = zone.index >= 2 ? Math.max(350, 900 - zone.index * 60) : 0;
  }

  /** Perseguidores de una zona: su bando primero y, zona tras zona, cualquier enemigo. */
  private endlessPursuers(zone: Zone): PursuerConfig {
    const s = this.endlessSkill;
    const own = ROSTERS[zone.faction];
    const others = ALL_KINDS.filter((k) => !own.includes(k));
    for (let i = others.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [others[i], others[j]] = [others[j], others[i]];
    }
    const count = clamp(2 + zone.index + Math.round(s * 2), 2, ALL_KINDS.length);
    const kinds: Partial<Record<PursuerKind, number>> = {};
    for (const k of [...own, ...others].slice(0, count)) kinds[k] = own.includes(k) ? 1 : 0.55;
    return {
      maxActive: Math.min(10, 3 + Math.floor(zone.index * 0.7) + Math.round(s * 2) + (this.playerCount - 1)),
      spawnInterval: Math.max(1.6, 5.2 - zone.index * 0.35 - s),
      kinds,
      aggression: Math.min(0.95, 0.45 + 0.05 * zone.index + 0.2 * (s - 0.5)),
      accuracy: Math.min(0.85, 0.28 + 0.04 * zone.index + 0.15 * (s - 0.5)),
      fireRate: Math.min(1, 0.35 + 0.04 * zone.index),
    };
  }

  /** Al entrar en una zona: nueva iluminación, nuevos enemigos y aviso. */
  private enterZone(zone: Zone): void {
    this.currentZone = zone.index;
    this.moodTarget = MOODS[zone.mood];
    if (!this.calibrating) {
      this.config.pursuers = this.endlessPursuers(zone);
      this.config.helicopter = zone.faction === 'police' && zone.index >= 2;
      if (!this.config.helicopter && this.heli) {
        this.heli.dispose();
        this.heli = null;
      }
      this.spawnTimer = Math.min(this.spawnTimer, 1.5);
    }
    this.hooks.message(`ZONA ${zone.index + 1}: ${ZONE_NAMES[zone.biome]} · te persigue ${FACTION_LABEL[zone.faction]}`, '#f4d03f', 3);
  }

  /** Zona actual del nivel infinito (para el HUD). */
  get zoneInfo(): { index: number; name: string; progress: number } | null {
    if (this.config.index !== 4 || this.currentZone < 0) return null;
    const z = this.zones[this.currentZone];
    return { index: z.index + 1, name: ZONE_NAMES[z.biome], progress: clamp01((this.maxD - z.d0) / (z.d1 - z.d0)) };
  }

  /** Estilo musical: en el nivel infinito depende del bioma de la zona. */
  get musicStyle(): number {
    if (this.config.index !== 4) return this.config.index;
    const z = this.zones[Math.max(0, this.currentZone)];
    return z ? MUSIC_BY_BIOME[z.biome] : 0;
  }

  private spawnCivilian(s: CivilianSpawn): void {
    if (this.civilians.length > 40) return;
    const c = new Civilian(this.physics, s, this.civColor++);
    this.scene.add(c.vehicle.mesh);
    this.civilians.push(c);
  }

  // ------------------------------------------------------------ bucle

  get alivePlayers(): Player[] {
    return this.players.filter((p) => p.alive);
  }

  /** Distancia hasta la meta (estructura final). */
  get finishD(): number {
    return this.chunks.finishZone?.d ?? this.config.distance;
  }

  get remainingDistance(): number {
    return Math.max(0, this.finishD - this.maxD);
  }

  get progress(): number {
    return clamp01(this.maxD / Math.max(1, this.finishD));
  }

  get calibrating(): boolean {
    return this.calibratedProfile === null;
  }

  get activePursuers(): number {
    return this.pursuers.filter((p) => !p.wrecked).length + this.flyers.filter((f) => f.alive).length;
  }

  /** 0..1: qué tan brutal debe sonar la música (perseguidores, tormenta, meta cerca). */
  get musicIntensity(): number {
    if (this.state !== 'running') return 0.4;
    if (this.config.index === 0) {
      const gap = this.stormGap ?? 70;
      return clamp01(0.3 + this.progress * 0.3 + (gap < 30 ? 0.4 : 0));
    }
    if (this.calibrating) return 0.35;
    const max = this.config.pursuers?.maxActive ?? 1;
    return clamp01(0.25 + (0.6 * this.activePursuers) / max + (this.heli ? 0.15 : 0) + (this.progress > 0.85 ? 0.2 : 0));
  }

  update(dt: number, inputs: DriveInput[]): void {
    if (this.state === 'done') return;
    if (this.state === 'countdown') {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      if (Math.ceil(this.countdown) !== before && this.countdown > 0) this.audio.blip(660);
      if (this.countdown <= 0) this.start();
      this.fx.update(dt);
      return;
    }

    // Tiempo bala: tras derribar varios perseguidores casi a la vez, todo va más lento un instante.
    if (this.slowmo > 0) {
      this.slowmo -= dt;
      dt *= 0.35;
    }
    this.elapsed += dt;
    this.tracker.tick(dt);
    const running = this.state === 'running';

    // ---- jugadores
    for (const p of this.players) this.updatePlayer(p, running ? inputs[p.index] : null, dt);

    // ---- perseguidores, tráfico, helicóptero
    if (this.config.pursuers && running) this.updatePursuers(dt);
    this.processBlasts(dt);
    this.lobs.update(dt, (l) => this.lobLanded(l));
    this.updateAcidPools(dt);
    const probe = (x: number, d: number, dir: number) => this.chunks.obstacleAhead(x, d, dir);
    for (const c of this.civilians) c.update(dt, this.track, this.physics, probe);
    if (this.heli && this.config.pursuers) {
      const shot = this.heli.update(dt, this.players, this.config.pursuers, this.rng);
      if (shot) this.fire(shot, true);
    }

    // ---- física
    this.physics.world.timestep = dt;
    this.physics.step((a, b) => this.onContact(a, b));
    for (const p of this.players) p.vehicle.sync();
    for (const u of this.pursuers) u.vehicle.sync();
    for (const c of this.civilians) c.vehicle.sync();

    // ---- balas
    this.bullets.update(dt, this.players, this.physics, {
      onHit: (p, dmg, x, z) => {
        if (p.invuln > 0 || p.ghost) return;
        this.tracker.bullet(true);
        this.fx.sparks(x, z, 8);
        this.fx.dust(x, z, 0x3fae5a, 3, 0.6);
        this.cashLost += 2500;
        this.damagePlayer(p, dmg, true);
      },
      onWall: (x, z) => this.fx.sparks(x, z, 5),
      onSegment: (x0, z0, x1, z1) => this.bulletHitsBarrel(x0, z0, x1, z1),
      onPlayerBullet: (x0, z0, x1, z1) => this.playerBulletHit(x0, z0, x1, z1),
      onExpire: (near) => {
        this.tracker.bullet(false);
        if (near) this.tracker.m.nearMisses++;
      },
    });

    // ---- mapa y entorno
    const alive = this.alivePlayers;
    const ref = alive.length ? alive : this.players;
    const minD = Math.min(...ref.map((p) => p.vehicle.d));
    this.maxD = Math.max(this.maxD, ...ref.map((p) => p.vehicle.d));
    this.tracker.setDistance(this.maxD);
    const leadSpeed = Math.max(0, ...ref.map((p) => p.vehicle.speed));
    this.chunks.update(this.maxD, this.maxD - 150, dt, leadSpeed);
    this.checkObstaclesPassed();
    this.cullTraffic(minD);
    if (this.storm) this.updateStorm(dt, minD);
    this.updateStartSmoke(dt);
    for (const u of this.pursuers) {
      if (!u.wrecked || u.stats.onFoot || u.sinking) continue;
      u.smokeTimer -= dt;
      if (u.smokeTimer <= 0) {
        u.smokeTimer = 0.12;
        this.fx.smokeTrail(u.vehicle.px, u.vehicle.pz, this.toxicAt(u.vehicle.pz));
      }
    }

    // ---- audio
    const sp = ref.reduce((s, p) => s + Math.abs(p.vehicle.speed) / p.def.spec.maxSpeed, 0) / ref.length;
    this.audio.engine(clamp01(sp), alive.length > 0, ref.reduce((s, p) => s + p.def.engineTone, 0) / ref.length);
    let nearest = Infinity;
    {
      for (const u of this.pursuers) {
        if (u.wrecked || u.stats.faction !== 'police') continue;
        for (const p of alive) nearest = Math.min(nearest, Math.hypot(u.vehicle.px - p.vehicle.px, u.vehicle.pz - p.vehicle.pz));
      }
    }
    this.audio.siren(clamp01(1 - nearest / 70), dt);

    this.updateAnalysis(dt);
    this.updateBlast(dt);
    if (this.config.index === 4) {
      const zone = this.zoneAt(this.maxD);
      if (zone.index !== this.currentZone) this.enterZone(zone);
    }
    this.updateMood(dt);
    if (running) this.checkEnd(dt);
    else if (this.state === 'ending') {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.state = 'done';
        this.audio.stopLoops();
      }
    }
    this.fx.update(dt);
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }

  /** Transición suave de la iluminación hacia la de la zona actual. */
  private updateMood(dt: number): void {
    const m = this.moodTarget;
    if (!m) return;
    const k = 1 - Math.exp(-0.8 * dt);
    const bg = this.scene.background as THREE.Color;
    bg.lerp(new THREE.Color(m.bg), k);
    this.hemi.color.lerp(new THREE.Color(m.sky), k);
    this.hemi.groundColor.lerp(new THREE.Color(m.ground), k);
    this.hemi.intensity += (m.hemi - this.hemi.intensity) * k;
    this.sun.color.lerp(new THREE.Color(m.sun), k);
    this.sun.intensity += (m.sunI - this.sun.intensity) * k;
  }

  /** Escena inicial al terminar la cuenta regresiva. */
  private start(): void {
    this.state = 'running';
    this.audio.blip(1040);
    const f = this.chunks.startFront;
    const launch = () => {
      for (const p of this.players) {
        p.vehicle.vx = 0;
        p.vehicle.vz = -28;
        p.invuln = Math.max(p.invuln, 2.5);
      }
    };
    switch (this.config.start) {
      case 'road':
        this.hooks.message(this.config.index === 4 ? 'Carretera sin fin: ¿hasta dónde llegas?' : '¡Acelera! La tormenta se acerca', '#ffd27a');
        break;
      case 'bank':
        if (f) {
          this.fx.explosion(f.x, -f.d + 1, 2.4);
          this.fx.explosion(f.x - 6, -f.d - 1, 1.2);
          this.fx.explosion(f.x + 6, -f.d - 1, 1.2);
        }
        this.audio.explosion();
        this.shake = 1.6;
        this.hooks.message('¡BOOM! ¡Salgan de ahí!', '#ff7a45');
        launch();
        break;
      case 'tunnel':
        this.hooks.message('Fin del túnel... ¡Los Cuervos los esperan!', '#ff9a3c');
        launch();
        break;
      case 'plant':
        if (f) {
          this.fx.explosion(f.x, -f.d + 1, 3, true);
          this.fx.explosion(f.x - 8, -f.d - 2, 1.6, true);
          this.fx.explosion(f.x + 8, -f.d - 2, 1.6, true);
        }
        this.audio.explosion();
        this.shake = 2;
        this.hooks.flash('#39ff14');
        this.hooks.message('¡El reactor estalla! ¡Fuera de la planta!', '#9dff6a');
        launch();
        break;
    }
  }

  private updateStartSmoke(dt: number): void {
    const f = this.chunks.startFront;
    if (!f || this.elapsed > 14 || this.config.start === 'tunnel' || this.config.start === 'road') return;
    this.startSmoke -= dt;
    if (this.startSmoke <= 0) {
      this.startSmoke = 0.08;
      this.fx.smokeTrail(f.x + this.rng.range(-3, 3), -f.d, this.config.start === 'plant');
    }
  }

  // ------------------------------------------------------------ jugadores

  private updatePlayer(p: Player, input: DriveInput | null, dt: number): void {
    p.invuln = Math.max(0, p.invuln - dt);
    p.flash = Math.max(0, p.flash - dt);
    p.oilTimer = Math.max(0, p.oilTimer - dt);
    p.spikeTimer = Math.max(0, p.spikeTimer - dt);
    const v = p.vehicle;

    if (!p.alive) {
      const marker = this.targetMarkers[p.index];
      if (marker) marker.visible = false;
      v.halt(dt);
      const t = this.respawnTimers.get(p);
      if (t !== undefined) {
        const left = t - dt;
        if (left <= 0) this.respawn(p);
        else this.respawnTimers.set(p, left);
      }
      return;
    }
    if (p.cutscene) {
      this.updateCutscene(p, dt);
      return;
    }
    if (p.air > 0) {
      if (input) this.handleShooting(p, input, dt);
      this.updateAir(p, dt);
      return;
    }
    if (!input) {
      v.halt(dt, 14);
      return;
    }
    // Joystick del celular: girar hacia donde apunta la bolita (o retroceder si apunta atrás).
    input = steerToward(input, v.heading, v.speed);
    // Red de seguridad: la moto nunca circula sobre el río.
    if (this.track.isWater(v.px, v.d)) {
      this.fallInRiver(p);
      return;
    }

    const offroad = this.track.isOffroad(v.px, v.d);
    p.offroad = offroad;
    let speedMul = 1;
    let gripMul = 1;
    let accelMul = 1;
    if (offroad && ROUGH_BIOMES.has(this.track.biomeAt(v.d))) {
      // Cada vehículo sufre distinto fuera del asfalto (el buggy, nada).
      speedMul *= p.def.offroad;
      if (p.def.offroad < 1) gripMul *= 0.8;
      if (Math.abs(v.speed) > 6 && this.rng.chance(0.5)) this.fx.dust(v.px, v.pz);
    }

    for (const h of this.chunks.hazards()) {
      if (h.kind === 'ramp') {
        this.tryRamp(p, h, dt);
        continue;
      }
      if (Math.abs(v.d - h.d) > h.hd || Math.abs(v.px - h.x) > h.hw) continue;
      this.tracker.hazard(dt);
      if (h.kind === 'sand') {
        if (!p.def.sandProof) speedMul *= 0.5;
        if (this.rng.chance(0.6)) this.fx.dust(v.px, v.pz, 0xe2c48e, 1, 1.6);
      } else if (h.kind === 'oil') {
        if (p.oilTimer <= 0) this.hooks.message(`${this.who(p)}¡Aceite!`, '#cccccc', 0.8);
        p.oilTimer = 1.1;
      } else if (h.kind === 'acid') {
        // El ácido corroe la moto mientras se está encima.
        this.damagePlayer(p, dt * 16, true);
        speedMul *= 0.8;
        if (this.rng.chance(0.4)) this.fx.splatter(v.px, v.pz, 2);
        if (this.rng.chance(dt * 2)) this.hooks.message(`${this.who(p)}¡Ácido!`, '#9dff6a', 0.8);
      } else if (h.kind === 'spikes' && p.spikeTimer <= 0) {
        p.spikeTimer = 3;
        this.fx.sparks(v.px, v.pz, 12);
        this.damagePlayer(p, 10);
        this.hooks.message(`${this.who(p)}¡Llanta ponchada!`, '#ff9f43', 1.2);
      }
    }
    if (p.oilTimer > 0) gripMul *= 0.15;
    if (p.spikeTimer > 0) speedMul *= 0.62;

    for (const pk of this.chunks.pickups()) {
      if (Math.abs(pk.d - v.d) > 2.4 || Math.abs(pk.x - v.px) > 2.4) continue;
      this.chunks.take(pk);
      this.score += 100;
      this.audio.blip(pk.kind === 'repair' ? 760 : 1200);
      if (pk.kind === 'repair') {
        // La llave repara un 30 % de la vida máxima.
        const repair = Math.round(p.maxHp * 0.3);
        p.hp = Math.min(p.maxHp, p.hp + repair);
        this.hooks.message(`${this.who(p)}¡Reparación! +${repair}`, '#4cd37b', 1);
      } else if (pk.kind === 'ammo') {
        const before = p.ammo;
        p.ammo = Math.min(p.maxAmmo, p.ammo + 20);
        this.hooks.message(`${this.who(p)}¡Munición! +${p.ammo - before}`, '#f4d03f', 1);
      } else {
        p.turbo = 1;
        this.hooks.message(`${this.who(p)}¡Nitro lleno!`, '#7dd3fc', 1);
      }
    }
    // Nivel 0 (prólogo): la moto se repara lentamente si no recibe golpes.
    p.sinceHit += dt;
    if (this.config.index === 0 && p.sinceHit > 4) p.hp = Math.min(p.maxHp, p.hp + dt * p.maxHp * 0.025);

    const wantsTurbo = input.turbo && input.throttle > 0 && p.turbo > 0.02;
    p.turboActive = wantsTurbo;
    if (wantsTurbo) {
      p.turbo = Math.max(0, p.turbo - dt * p.def.turboDrain);
      speedMul *= p.def.turboMul;
      accelMul = 1.7;
      this.fx.turbo(v.px + Math.sin(v.heading) * (v.spec.hz + 0.1), v.pz + Math.cos(v.heading) * (v.spec.hz + 0.1), v.heading + Math.PI);
    } else {
      p.turbo = Math.min(1, p.turbo + dt * p.def.turboRegen);
    }

    p.steer = input.steer;
    v.drive(dt, input.throttle, input.brake, input.steer, { speedMul, accelMul, gripMul });
    this.handleShooting(p, input, dt);
    this.tracker.samplePlayer(p.index, dt, Math.max(0, v.speed), v.spec.maxSpeed, input.steer, offroad);

    // Peligro cercano (para la métrica "sangre fría").
    let danger = false;
    if (this.storm && this.storm.depth(v.d) > -15) danger = true;
    for (const u of this.pursuers) if (!u.wrecked && Math.hypot(u.vehicle.px - v.px, u.vehicle.pz - v.pz) < 8) danger = true;
    if (danger) this.tracker.danger(dt);

    // No permitir retroceder hacia tramos ya liberados.
    const minAllowed = this.maxD - 115;
    if (v.d < minAllowed) v.teleport(this.track.centerX(minAllowed + 2), -(minAllowed + 2), 0);

    // Cooperativo: quien se queda muy atrás es capturado y reaparece junto a su compañero.
    if (this.playerCount > 1) {
      const leader = this.alivePlayers.reduce((a, b) => (a.vehicle.d > b.vehicle.d ? a : b));
      if (leader !== p && leader.vehicle.d - v.d > CAPTURE_GAP) this.capturePlayer(p);
    }
  }

  /** El rezagado queda fuera de la carrera hasta la cuenta regresiva (como si hubiera caído). */
  private capturePlayer(p: Player): void {
    const v = p.vehicle;
    p.alive = false;
    p.captured = true;
    p.setGhost(true);
    p.mesh.visible = false;
    this.targetMarkers[p.index].visible = false;
    this.fx.dust(v.px, v.pz, 0x8a8a8a, 10, 2.4);
    this.audio.crash(0.5);
    this.respawnTimers.set(p, RESPAWN_TIME);
    this.hooks.message(`¡J${p.index + 1} se quedó atrás y lo capturaron! Vuelve en ${RESPAWN_TIME} s`, p.color, 2.5);
  }

  /** Segundos para que reaparezca un jugador caído o capturado (null si no espera reaparecer). */
  respawnLeft(p: Player): number | null {
    return this.respawnTimers.get(p) ?? null;
  }

  /** Escenas automáticas: salir de la estructura inicial y entrar en la final. */
  private updateCutscene(p: Player, dt: number): void {
    const v = p.vehicle;
    if (p.cutscene === 'exit') {
      const front = this.chunks.startFront?.d ?? -3;
      const jumps = this.config.start !== 'tunnel';
      if (v.d > front - 3) p.mesh.visible = true;
      if (p.airTime <= 0 && v.d < front - 1.5) {
        v.drive(dt, 1, 0, 0, { speedMul: 1, accelMul: 3, gripMul: 1 });
        return;
      }
      if (!jumps) {
        // Del túnel se sale rodando: el control vuelve al pasar la boca.
        this.endCutscene(p, false);
        return;
      }
      if (p.airTime <= 0) {
        p.airTime = JUMP_TIME;
        this.fx.dust(v.px, v.pz, 0x9a9a9a, 6, 2);
        this.audio.blip(420);
      }
      p.airTime -= dt;
      const t = clamp01(1 - p.airTime / JUMP_TIME);
      const h = Math.sin(t * Math.PI);
      p.mesh.position.y = h * 3.4;
      p.mesh.scale.setScalar(1 + h * 0.4);
      p.mesh.rotation.x = (0.5 - t) * 0.9;
      v.drive(dt, 1, 0, 0);
      if (p.airTime <= 0) this.endCutscene(p, true);
      return;
    }

    // Entrada a la estructura final: rumbo a la puerta, sin colisiones, hasta perderse adentro.
    const zone = this.chunks.finishZone;
    if (!zone) return;
    const aimD = zone.d + 14;
    const desired = Math.atan2(-(zone.x - v.px), -(-aimD - v.pz));
    const steer = clamp(-wrapAngle(desired - v.heading) * 3, -1, 1);
    if (v.d > zone.d + 18) v.halt(dt, 30);
    else v.drive(dt, 1, 0, steer, { speedMul: 0.6, accelMul: 1, gripMul: 2 });
    if (v.d > zone.d + 4.5) p.mesh.visible = false;
  }

  // ------------------------------------------------------------ arma de la moto

  /** Enemigo o bidón explosivo más cercano a la vista, dentro del alcance del arma. */
  private nearestTarget(p: Player): { x: number; z: number; vx: number; vz: number } | null {
    const v = p.vehicle;
    let best: { x: number; z: number; vx: number; vz: number } | null = null;
    let bestD = AIM_RANGE;
    const consider = (x: number, z: number, vx: number, vz: number, needsSight: boolean) => {
      const dist = Math.hypot(x - v.px, z - v.pz);
      if (dist >= bestD || dist < 1.5) return;
      if (needsSight && this.physics.rayFixed(v.px, v.pz, (x - v.px) / dist, (z - v.pz) / dist, dist - 1) !== null) return;
      bestD = dist;
      best = { x, z, vx, vz };
    };
    for (const u of this.pursuers) if (!u.wrecked) consider(u.vehicle.px, u.vehicle.pz, u.vehicle.vx, u.vehicle.vz, true);
    for (const f of this.flyers) if (f.alive) consider(f.x, f.z, 0, 0, false);
    for (const o of this.chunks.obstacles()) {
      if (o.kind !== 'fuelBarrel' || o.dead || Math.abs(o.d - v.d) > AIM_RANGE) continue;
      const t = o.body.translation();
      consider(t.x, t.z, 0, 0, true);
    }
    return best;
  }

  /**
   * Arma de la moto: con la tecla dispara solo al objetivo más cercano (marcado
   * con un anillo); con el ratón, hacia la mira. Usa munición limitada.
   */
  private handleShooting(p: Player, input: DriveInput, dt: number): void {
    const v = p.vehicle;
    p.fireCooldown -= dt;
    this.ammoWarn -= dt;
    const target = input.aim ? null : this.nearestTarget(p);
    const marker = this.targetMarkers[p.index];
    if (marker) {
      marker.visible = !!target && p.ammo > 0;
      if (target) {
        marker.position.set(target.x, 0.1, target.z);
        marker.rotation.y += dt * 3;
      }
    }
    if (!input.shoot || p.fireCooldown > 0 || this.state !== 'running') return;
    if (p.ammo <= 0) {
      p.fireCooldown = 0.35;
      this.audio.emptyClick();
      if (this.ammoWarn <= 0) {
        this.ammoWarn = 2.5;
        this.hooks.message(`${this.who(p)}¡Sin munición! Busca cajas amarillas`, '#f4d03f', 1.4);
      }
      return;
    }
    let angle = v.heading;
    if (input.aim) {
      angle = Math.atan2(-(input.aim.x - v.px), -(input.aim.z - v.pz));
    } else if (target) {
      // Se adelanta un poco al movimiento del objetivo.
      const t = Math.hypot(target.x - v.px, target.z - v.pz) / 62;
      angle = Math.atan2(-(target.x + target.vx * t - v.px), -(target.z + target.vz * t - v.pz));
    }
    p.ammo--;
    p.fireCooldown = 0.16;
    this.bullets.fire(v.px, v.pz, angle, PLAYER_BULLET_DAMAGE, false, 'player', true);
    this.fx.muzzle(v.px - Math.sin(angle) * (v.spec.hz + 0.2), v.pz - Math.cos(angle) * (v.spec.hz + 0.2), angle);
    this.audio.playerShot();
  }

  /** Impacto de una bala de la moto: enemigos, harpías, bidones, zombis o civiles. */
  private playerBulletHit(x0: number, z0: number, x1: number, z1: number): boolean {
    for (const u of this.pursuers) {
      if (u.wrecked) continue;
      const r = (u.stats.spec.hx + u.stats.spec.hz) / 2 + 0.2;
      if (segmentDistance(x0, z0, x1, z1, u.vehicle.px, u.vehicle.pz) > r) continue;
      this.fx.sparks(u.vehicle.px, u.vehicle.pz, 6);
      if (u.stats.onFoot) this.fx.splatter(u.vehicle.px, u.vehicle.pz, 6);
      this.damagePursuer(u, PLAYER_BULLET_DAMAGE);
      return true;
    }
    for (const f of this.flyers) {
      if (!f.alive || segmentDistance(x0, z0, x1, z1, f.x, f.z) > 2.2) continue;
      this.fx.splatter(f.x, f.z, 8);
      f.hp -= PLAYER_BULLET_DAMAGE;
      if (f.hp <= 0) {
        f.shootDown();
        this.registerKill(1200, 'Harpía');
      }
      return true;
    }
    const dMin = Math.min(-z0, -z1) - 2;
    const dMax = Math.max(-z0, -z1) + 2;
    for (const o of this.chunks.obstacles()) {
      if (o.dead || o.d < dMin || o.d > dMax || (o.kind !== 'fuelBarrel' && o.kind !== 'zombie')) continue;
      const t = o.body.translation();
      if (segmentDistance(x0, z0, x1, z1, t.x, t.z) > (o.kind === 'fuelBarrel' ? 0.8 : 0.6)) continue;
      if (o.kind === 'fuelBarrel') this.explodeBarrel(o, 0);
      else this.splatZombie(o);
      return true;
    }
    for (const c of this.civilians) {
      if (segmentDistance(x0, z0, x1, z1, c.vehicle.px, c.vehicle.pz) > 1.4) continue;
      this.fx.sparks(c.vehicle.px, c.vehicle.pz, 4);
      c.panic = 2;
      return true;
    }
    return false;
  }

  /**
   * ¿Toma la rampa? Basta con entrar de frente, con buena parte del vehículo
   * sobre ella y algo de velocidad: despega justo antes de tocarla. Si no (de
   * lado, desde atrás, casi detenido), la rampa es sólida y choca.
   */
  private tryRamp(p: Player, h: { x: number; d: number; hw: number; hd: number }, dt: number): boolean {
    const v = p.vehicle;
    const s = v.spec;
    const speed = v.speed;
    if (p.air > 0 || speed < 4) return false;
    // Entre un poco antes del borde de entrada (lo que avanzará este cuadro) y el final de la rampa.
    const front = v.d + s.hz;
    if (front + speed * dt * 2 + 0.4 < h.d - h.hd || v.d - s.hz > h.d + h.hd) return false;
    // De frente: rumbo parecido al de la carretera.
    if (Math.abs(wrapAngle(v.heading - this.track.angle(v.d))) > 0.75) return false;
    // Al menos el 40 % del ancho del vehículo sobre la rampa (o toda la rampa bajo él).
    const lat = v.px - h.x;
    const overlap = Math.min(lat + s.hx, h.hw) - Math.max(lat - s.hx, -h.hw);
    if (overlap < Math.min(2 * s.hx, 2 * h.hw) * 0.4) return false;
    this.launch(p, h.d + h.hd - v.d + s.hz + 1);
    return true;
  }

  /** Despegue desde una rampa: en el aire no hay colisiones ni se puede girar. */
  private launch(p: Player, clearance = 0): void {
    const v = p.vehicle;
    // Vuela al menos lo necesario para pasar la rampa completa (aunque se tome despacio).
    const minAir = clearance > 0 ? clearance / Math.max(4, v.speed * 1.05) : 0;
    p.airDur = clamp(Math.max((0.45 + (v.speed / v.spec.maxSpeed) * 0.5) * p.def.jump, minAir), 0.45, 1.6);
    p.air = p.airDur;
    p.setGhost(true);
    v.vx *= 1.05;
    v.vz *= 1.05;
    this.fx.dust(v.px, v.pz, 0x9a9a9a, 6, 1.6);
    this.audio.blip(520);
  }

  private updateAir(p: Player, dt: number): void {
    const v = p.vehicle;
    p.air -= dt;
    const t = clamp01(1 - p.air / p.airDur);
    const h = Math.sin(t * Math.PI);
    p.mesh.position.y = h * 3.2 * (p.airDur / 0.9);
    p.mesh.scale.setScalar(1 + h * 0.35);
    p.mesh.rotation.x = (0.5 - t) * 0.8;
    // En el aire no hay roce con el suelo: conserva la velocidad del despegue.
    v.apply();
    // Nunca aterrizar dentro de un edificio ni sobre el río.
    const lat = this.track.lateral(v.px, v.d);
    const edge = this.track.waterEdge(v.d);
    const maxLat = Math.min(edge !== null ? edge - 1 : Infinity, this.track.halfWidth(v.d) + 1.5);
    if (Math.abs(lat) > maxLat) {
      const x = this.track.centerX(v.d) + Math.sign(lat) * maxLat;
      v.body.setTranslation({ x, y: 1, z: v.pz }, true);
      v.px = x;
      v.vx *= 0.3;
    }
    if (p.air <= 0) {
      p.air = 0;
      p.mesh.position.y = 0;
      p.mesh.scale.setScalar(1);
      p.mesh.rotation.x = 0;
      p.setGhost(false);
      this.fx.dust(v.px, v.pz, 0x8a8a8a, 10, 2.2);
      this.fx.sparks(v.px, v.pz, 6);
      this.audio.crash(0.35);
      this.shake = Math.max(this.shake, 0.45);
      this.score += 300;
      p.turbo = Math.min(1, p.turbo + 0.15);
      this.hooks.message(`${this.who(p)}¡Salto! +300`, '#ffd27a', 1);
    }
  }

  /** Si la moto toca el agua, cae al río y vuelve al centro del puente. */
  private fallInRiver(p: Player): void {
    const v = p.vehicle;
    this.fx.splash(v.px, v.pz, 30);
    this.audio.crash(0.6);
    this.damagePlayer(p, 30);
    if (!p.alive) return;
    v.teleport(this.track.centerX(v.d), v.pz, this.track.angle(v.d));
    p.invuln = Math.max(p.invuln, 1.5);
    this.hooks.message(`${this.who(p)}¡Al río! Vuelves al puente (−30)`, '#7fc8ff', 1.5);
  }

  // ------------------------------------------------------------ explosiones

  /** Programa una explosión (con retraso para escalonar las reacciones en cadena). */
  private queueBlast(x: number, z: number, delay: number, spec: BlastSpec): void {
    this.blasts.push({ x, z, delay, spec });
  }

  /** En la tierra baldía todo explota y arde en verde. */
  private toxicAt(z: number): boolean {
    return TOXIC_BIOMES.has(this.track.biomeAt(-z)) || this.config.index === 3;
  }

  /** Barril de combustible que estalla. */
  private explodeBarrel(o: ObstacleRecord, delay: number): void {
    if (o.dead) return;
    const t = o.body.translation();
    this.chunks.destroyObstacle(o);
    this.queueBlast(t.x, t.z, delay, BLASTS.barrel);
  }

  /** Una bala que roza un barril de combustible lo hace estallar. */
  private bulletHitsBarrel(x0: number, z0: number, x1: number, z1: number): boolean {
    const dMin = Math.min(-z0, -z1) - 2;
    const dMax = Math.max(-z0, -z1) + 2;
    for (const o of this.chunks.obstacles()) {
      if (o.kind !== 'fuelBarrel' || o.dead || o.d < dMin || o.d > dMax) continue;
      const t = o.body.translation();
      if (segmentDistance(x0, z0, x1, z1, t.x, t.z) < 0.75) {
        this.explodeBarrel(o, 0);
        return true;
      }
    }
    return false;
  }

  /** Cae una granada, bomba o gota de ácido. */
  private lobLanded(l: Lob): void {
    if (l.kind === 'acid') {
      this.fx.splatter(l.x1, l.z1, 10);
      for (const p of this.alivePlayers) {
        if (p.ghost || Math.hypot(p.vehicle.px - l.x1, p.vehicle.pz - l.z1) > 1.6) continue;
        if (p.canTakeHit('acidDrop', this.elapsed, 0.3)) this.damagePlayer(p, l.damage, true);
      }
      if (this.rng.chance(0.45)) this.addAcidPool(l.x1, l.z1);
      return;
    }
    this.detonate(l.x1, l.z1, l.kind === 'grenade' ? { ...BLASTS.grenade, playerDmg: l.damage } : { ...BLASTS.bomb, playerDmg: l.damage });
  }

  private addAcidPool(x: number, z: number): void {
    if (this.acidPools.length > 14) return;
    const mesh = new THREE.Mesh(ACID_POOL_GEO, ACID_POOL_MAT);
    const r = this.rng.range(1.3, 2);
    mesh.scale.set(r * 2, 1, r * 2);
    mesh.position.set(x, 0.06, z);
    this.scene.add(mesh);
    this.acidPools.push({ x, z, r, life: 4.5, mesh });
  }

  /** Los charcos de ácido queman mientras la moto está encima y se secan solos. */
  private updateAcidPools(dt: number): void {
    for (let i = this.acidPools.length - 1; i >= 0; i--) {
      const pool = this.acidPools[i];
      pool.life -= dt;
      const k = Math.min(1, pool.life / 0.6);
      pool.mesh.scale.set(pool.r * 2 * k, 1, pool.r * 2 * k);
      for (const p of this.alivePlayers) {
        if (p.ghost || p.air > 0 || Math.hypot(p.vehicle.px - pool.x, p.vehicle.pz - pool.z) > pool.r) continue;
        this.damagePlayer(p, dt * 12, true);
        this.tracker.hazard(dt);
        if (this.rng.chance(dt * 6)) this.fx.splatter(p.vehicle.px, p.vehicle.pz, 2);
      }
      if (pool.life <= 0) {
        this.scene.remove(pool.mesh);
        this.acidPools.splice(i, 1);
      }
    }
  }

  /** Lanzallamas: daño continuo en el cono de fuego; incendia barriles y zombis. */
  private updateFlames(dt: number): void {
    this.flameWarn -= dt;
    for (const u of this.pursuers) {
      if (!u.flaming) continue;
      const v = u.vehicle;
      const fx = -Math.sin(v.heading);
      const fz = -Math.cos(v.heading);
      const nx = v.px + fx * 3.2;
      const nz = v.pz + fz * 3.2;
      const toxic = this.toxicAt(v.pz);
      this.fx.flame(nx, nz, v.heading, FLAME_RANGE, toxic);
      const inCone = (x: number, z: number) => {
        const dx = x - nx;
        const dz = z - nz;
        const dist = Math.hypot(dx, dz);
        return dist < FLAME_RANGE && Math.abs(wrapAngle(Math.atan2(-dx, -dz) - v.heading)) < FLAME_ANGLE + 0.6 / Math.max(1, dist);
      };
      for (const p of this.alivePlayers) {
        if (p.ghost || p.air > 0 || !inCone(p.vehicle.px, p.vehicle.pz)) continue;
        this.damagePlayer(p, dt * 15, true);
        if (this.flameWarn <= 0) {
          this.flameWarn = 2;
          this.hooks.message(`${this.who(p)}¡Te queman!`, toxic ? '#9dff6a' : '#ff7a45', 1);
        }
      }
      for (const o of this.chunks.obstacles()) {
        if (o.dead || (o.kind !== 'fuelBarrel' && o.kind !== 'zombie')) continue;
        const t = o.body.translation();
        if (!inCone(t.x, t.z)) continue;
        if (o.kind === 'fuelBarrel') this.explodeBarrel(o, 0.2);
        else this.splatZombie(o);
      }
    }
  }

  private processBlasts(dt: number): void {
    if (!this.blasts.length) return;
    const due = this.blasts.filter((b) => (b.delay -= dt) <= 0);
    if (!due.length) return;
    this.blasts = this.blasts.filter((b) => b.delay > 0);
    for (const b of due) this.detonate(b.x, b.z, b.spec);
  }

  /**
   * Onda expansiva: daña y empuja a perseguidores (mucho), a las motos (poco),
   * hace estallar barriles cercanos y revienta zombis y harpías en picada.
   */
  private detonate(x: number, z: number, spec: BlastSpec): void {
    const R = spec.radius;
    this.fx.blast(x, z, spec.scale, this.toxicAt(z));
    this.audio.explosion();
    const alive = this.alivePlayers;
    const nearest = Math.min(60, ...alive.map((p) => Math.hypot(p.vehicle.px - x, p.vehicle.pz - z)));
    this.shake = Math.max(this.shake, clamp(1.7 - nearest / 25, 0.3, 1.7));

    const push = (v: { vx: number; vz: number; px: number; pz: number; body: { setLinvel(v: { x: number; y: number; z: number }, w: boolean): void } }, strength: number) => {
      const dx = v.px - x;
      const dz = v.pz - z;
      const dist = Math.max(0.5, Math.hypot(dx, dz));
      v.vx += (dx / dist) * strength;
      v.vz += (dz / dist) * strength;
      v.body.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
    };

    for (const u of this.pursuers) {
      if (u.wrecked) continue;
      const dist = Math.hypot(u.vehicle.px - x, u.vehicle.pz - z);
      if (dist > R) continue;
      const f = 1 - dist / R;
      push(u.vehicle, 22 * f);
      u.vehicle.heading += (this.rng.next() - 0.5) * 1.2 * f;
      this.damagePursuer(u, spec.pursuerDmg * f);
    }
    for (const p of alive) {
      if (p.ghost) continue;
      const dist = Math.hypot(p.vehicle.px - x, p.vehicle.pz - z);
      const r = R * 0.75;
      if (dist > r) continue;
      const f = 1 - dist / r;
      push(p.vehicle, 10 * f);
      if (p.canTakeHit('blast', this.elapsed, 0.5)) this.damagePlayer(p, spec.playerDmg * f, true);
    }
    for (const c of this.civilians) {
      if (Math.hypot(c.vehicle.px - x, c.vehicle.pz - z) > R) continue;
      push(c.vehicle, 12);
      c.panic = 2.5;
    }
    for (const o of this.chunks.obstacles()) {
      if (o.dead) continue;
      const t = o.body.translation();
      const dist = Math.hypot(t.x - x, t.z - z);
      if (o.kind === 'fuelBarrel' && dist < 7) this.explodeBarrel(o, this.rng.range(0.12, 0.3));
      else if (o.kind === 'zombie' && dist < R) this.splatZombie(o);
    }
    for (const f of this.flyers) {
      if (f.alive && f.y < 5 && Math.hypot(f.x - x, f.z - z) < R) {
        f.shootDown();
        this.registerKill(1200, 'Harpía');
      }
    }
  }

  /**
   * Derribos seguidos suman combo: puntos extra, turbo y un poco de vida
   * (la adrenalina compensa la dificultad). Varios casi a la vez: tiempo bala.
   */
  private registerKill(points: number, label: string): void {
    this.score += points;
    this.tracker.copWrecked();
    this.combo = this.elapsed - this.lastKill < 3.5 ? this.combo + 1 : 1;
    this.lastKill = this.elapsed;
    this.recentKills = this.recentKills.filter((t) => this.elapsed - t < 1.2);
    this.recentKills.push(this.elapsed);
    for (const p of this.alivePlayers) {
      p.turbo = Math.min(1, p.turbo + 0.2);
      if (this.combo >= 2) p.hp = Math.min(p.maxHp, p.hp + 4);
    }
    if (this.combo >= 2) {
      const bonus = 400 * (this.combo - 1);
      this.score += bonus;
      const word = ['', '', '¡DOBLE!', '¡TRIPLE!', '¡CUÁDRUPLE!'][this.combo] ?? '¡MASACRE!';
      this.hooks.message(`${word} Combo x${this.combo} +${bonus.toLocaleString('es-CO')}`, '#ff9f43', 1.8);
    } else {
      this.hooks.message(`¡${label} fuera de combate! +${points.toLocaleString('es-CO')}`, '#7dd3fc', 1.5);
    }
    if (this.recentKills.length >= 2 && this.slowmo <= 0) {
      this.slowmo = 0.9;
      if (this.recentKills.length >= 3) this.hooks.flash('#ffe0a0');
    }
  }

  private endCutscene(p: Player, landed: boolean): void {
    const v = p.vehicle;
    p.mesh.position.y = 0;
    p.mesh.scale.setScalar(1);
    p.mesh.rotation.x = 0;
    p.setGhost(false);
    p.cutscene = null;
    if (landed) {
      this.fx.dust(v.px, v.pz, 0x8a8a8a, 10, 2.4);
      this.fx.sparks(v.px, v.pz, 8);
      this.audio.crash(0.4);
      this.shake = Math.max(this.shake, 0.5);
    }
  }

  /** `weapon`: balas, explosiones, ácido y fuego, que el blindaje del vehículo reduce. */
  /** Prefijo de los avisos: solo hace falta decir quién cuando hay varios jugadores. */
  private who(p: Player): string {
    return this.playerCount > 1 ? `J${p.index + 1}: ` : '';
  }

  private damagePlayer(p: Player, amount: number, weapon = false): void {
    if (weapon) amount *= p.def.armor;
    if (amount <= 0 || !p.alive) return;
    if (p.invuln <= 0) this.tracker.damage(amount);
    const destroyed = p.damage(amount);
    if (destroyed) this.wreckPlayer(p);
  }

  private wreckPlayer(p: Player): void {
    const v = p.vehicle;
    this.fx.blast(v.px, v.pz, 1.1, this.toxicAt(v.pz));
    this.audio.explosion();
    this.shake = 1.2;
    const mats: THREE.Material[] = [];
    const burnt = mat(0x222222);
    p.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        mats.push(m.material as THREE.Material);
        m.material = burnt;
      }
    });
    this.origMaterials.set(p, mats);
    if (this.alivePlayers.length > 0 && !p.dropped) {
      this.respawnTimers.set(p, RESPAWN_TIME);
      this.hooks.message(`¡J${p.index + 1} cayó! Vuelve en ${RESPAWN_TIME} s`, p.color, 2.5);
    }
  }

  /** Un jugador en línea se desconectó: sale de la carrera sin reaparecer. */
  dropPlayer(index: number): void {
    const p = this.players[index];
    if (!p || p.dropped) return;
    p.dropped = true;
    p.alive = false;
    p.setGhost(true);
    p.mesh.visible = false;
    this.respawnTimers.delete(p);
  }

  private respawn(p: Player): void {
    this.respawnTimers.delete(p);
    if (p.dropped) return;
    const partner = this.alivePlayers[0];
    if (!partner) return;
    const mats = this.origMaterials.get(p) ?? [];
    this.origMaterials.delete(p);
    let i = 0;
    p.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && mats[i]) m.material = mats[i++];
    });
    if (p.captured) {
      p.captured = false;
      p.setGhost(false);
      p.mesh.visible = true;
    }
    const d = partner.vehicle.d - 5;
    p.vehicle.teleport(this.track.centerX(d) + (partner.vehicle.px > this.track.centerX(d) ? -2.5 : 2.5), -d, 0);
    p.alive = true;
    p.hp = Math.round(p.maxHp * 0.45);
    p.invuln = 2.5;
    this.cashLost += 20000;
    this.hooks.message(`J${p.index + 1} vuelve a la carrera (−$20.000)`, p.color, 2);
  }

  // ------------------------------------------------------------ perseguidores

  private updatePursuers(dt: number): void {
    const cfg = this.config.pursuers!;
    const alive = this.alivePlayers;
    if (alive.length === 0) return;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.activePursuers < cfg.maxActive) {
      // La primera oleada del nivel 1 sale de las calles laterales de la plaza del banco.
      const fromSide = this.firstWave && this.config.start === 'bank';
      this.spawnPursuer(fromSide);
      if (this.firstWave) this.spawnPursuer(fromSide);
      this.firstWave = false;
      this.spawnTimer = cfg.spawnInterval * this.rng.range(0.8, 1.2);
    }

    if (this.config.helicopter && !this.heli && !this.calibrating) {
      const p = alive[0].vehicle;
      this.heli = new Helicopter(this.scene, p.px + 30, p.pz - 60);
      this.hooks.message('¡Helicóptero policial en el aire!', '#7dd3fc', 2);
    }

    for (const u of this.pursuers) {
      const shot = u.update({ dt, players: this.players, track: this.track, physics: this.physics, config: cfg, rng: this.rng });
      if (shot) this.fire(shot, false);
    }
    this.updateFlames(dt);
    this.updateFlyers(dt, cfg);

    // Los enemigos terrestres que pisan el río se hunden.
    for (const u of this.pursuers) {
      if (u.wrecked || !this.track.isWater(u.vehicle.px, u.vehicle.d)) continue;
      u.sink();
      this.fx.splash(u.vehicle.px, u.vehicle.pz);
      this.audio.crash(0.6);
      this.tracker.copWrecked();
      this.score += 500;
      this.hooks.message(`¡${u.stats.label} se hundió en el río! +500`, '#7fc8ff', 1.5);
    }

    // Reciclar unidades que quedaron muy atrás o ya se consumieron.
    const minD = Math.min(...alive.map((p) => p.vehicle.d));
    for (let i = this.pursuers.length - 1; i >= 0; i--) {
      const u = this.pursuers[i];
      const tooFar = u.vehicle.d < minD - (u.wrecked ? 60 : 95) || u.vehicle.d > this.maxD + 200;
      const burnedOut = u.wrecked && u.wreckTime > (u.sinking ? 2.2 : u.stats.onFoot ? 2.5 : 7);
      if (burnedOut && !u.stats.onFoot && !u.sinking) this.fx.blast(u.vehicle.px, u.vehicle.pz, 0.6, this.toxicAt(u.vehicle.pz));
      if (tooFar || burnedOut) {
        this.removeVehicle(u.vehicle.body, u.vehicle.mesh);
        this.pursuers.splice(i, 1);
        if (!u.wrecked) this.spawnTimer = Math.min(this.spawnTimer, 1);
      }
    }
  }

  /** Harpías: acechan, escupen ácido y se lanzan en picada. */
  private updateFlyers(dt: number, cfg: PursuerConfig): void {
    const minD = Math.min(...this.alivePlayers.map((p) => p.vehicle.d));
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      const { rain, attack } = f.update(dt, this.players, cfg, this.rng);
      if (rain) {
        // Lluvia de ácido verde: gotas que caen alrededor de la moto.
        for (let k = 0, n = this.rng.int(5, 8); k < n; k++) {
          const a = this.rng.range(0, Math.PI * 2);
          const r = this.rng.range(0, 4.5);
          this.lobs.launch('acid', f.x + this.rng.range(-1, 1), f.z + this.rng.range(-1, 1), rain.x + Math.cos(a) * r, rain.z + Math.sin(a) * r, this.rng.range(0.55, 0.95), 6, true);
        }
      }
      if (attack) {
        const p = attack.player;
        if (p.turboActive && attack.playerSpeed > p.def.spec.maxSpeed * 0.88) {
          // A toda velocidad con turbo, la moto embiste a la harpía en picada.
          f.shootDown();
          this.fx.splatter(f.x, f.z, 24);
          this.damagePlayer(p, 4);
          this.registerKill(1200, 'Harpía');
        } else {
          this.fx.splatter(p.vehicle.px, p.vehicle.pz, 14);
          this.audio.crash(0.8);
          this.shake = Math.max(this.shake, 0.9);
          this.damagePlayer(p, 10 + cfg.aggression * 8, true);
          this.hooks.message(`${this.who(p)}¡Ataque de harpía!`, '#c08aff', 1);
        }
      }
      if (f.gone || -f.z < minD - 90) {
        f.dispose();
        this.flyers.splice(i, 1);
      }
    }
  }

  private spawnPursuer(fromSide: boolean): void {
    const cfg = this.config.pursuers!;
    const kind = this.rng.weighted(cfg.kinds) as PursuerKind;
    if (PURSUER_STATS[kind].flying) {
      // Las harpías llegan volando desde adelante, a un costado de la vía.
      const d = this.maxD + this.rng.range(50, 80);
      this.flyers.push(new Flyer(this.scene, this.track.centerX(d) + this.rng.sign() * this.rng.range(10, 25), -d, this.rng));
      return;
    }
    const alive = this.alivePlayers;
    const minD = Math.min(...alive.map((p) => p.vehicle.d));
    let x: number;
    let d: number;
    let heading = 0;

    const sides = this.chunks.sideSpawns;
    if (PURSUER_STATS[kind].onFoot) {
      // Los mutantes salen corriendo de las ruinas, por delante y a los lados.
      d = this.maxD + this.rng.range(25, 55);
      const s = this.rng.sign();
      x = this.track.centerX(d) + s * (this.track.halfWidth(d) + this.rng.range(3, 7));
      // Sobre el puente los costados son río: aparecen al borde de la calzada.
      if (this.track.isWater(x, d)) x = this.track.centerX(d) + s * (this.track.halfWidth(d) - 1);
      heading = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else if (fromSide && sides.length && minD < 80) {
      const s = this.rng.pick(sides);
      x = s.x;
      d = s.d + this.rng.range(-3, 3);
      heading = s.heading;
    } else if (this.config.index >= 2 && this.rng.chance(0.22)) {
      // Unidad que viene de frente.
      d = this.maxD + 75;
      x = this.track.centerX(d) + this.rng.range(-4, 4);
      heading = this.track.angle(d) + Math.PI;
    } else {
      d = minD - this.rng.range(38, 52);
      const half = this.track.halfWidth(d);
      x = this.track.centerX(d) + this.rng.range(-half + 2.5, half - 2.5);
      heading = this.track.angle(d);
    }
    if (d < 8) {
      // Detrás está la estructura inicial: aparecer por delante en sentido contrario.
      d = this.maxD + 70;
      x = this.track.centerX(d);
      heading = this.track.angle(d) + Math.PI;
    }
    if (!this.chunks.isClear(x, d, 3)) x = this.track.centerX(d);
    for (const u of this.pursuers) if (Math.hypot(u.vehicle.px - x, u.vehicle.pz + d) < 5) x += 5;

    const unit = new Pursuer(this.physics, kind, x, -d, heading, this.rng);
    const v0 = unit.stats.onFoot ? 6 : 20;
    unit.vehicle.vx = -Math.sin(heading) * v0;
    unit.vehicle.vz = -Math.cos(heading) * v0;
    this.scene.add(unit.vehicle.mesh);
    this.pursuers.push(unit);
  }

  private fire(shot: FireRequest, aerial: boolean): void {
    if (shot.lob) {
      const { x, z, dur, kind } = shot.lob;
      this.lobs.launch(kind, shot.x, shot.z, x, z, dur, shot.damage, this.toxicAt(z));
      this.fx.muzzle(shot.x - Math.sin(shot.angle) * 2.4, shot.z - Math.cos(shot.angle) * 2.4, shot.angle);
      this.audio.crash(0.15);
      return;
    }
    this.bullets.fire(shot.x, shot.z, shot.angle, shot.damage, aerial, shot.faction);
    this.fx.muzzle(shot.x - Math.sin(shot.angle) * 2.4, shot.z - Math.cos(shot.angle) * 2.4, shot.angle);
    this.audio.shot();
  }

  // ------------------------------------------------------------ colisiones

  private onContact(a: Tag, b: Tag): void {
    if (b.kind === 'player' && a.kind !== 'player') [a, b] = [b, a];
    if (a.kind === 'player') {
      const p = a.ref as Player;
      if (!p.alive || p.ghost) return;
      if (b.kind === 'player' && (b.ref as Player).ghost) return;
      const impact = p.vehicle.impact();
      let dmg = 0;
      let key: unknown = b.ref ?? b;
      switch (b.kind) {
        case 'pursuer': {
          const u = b.ref as Pursuer;
          if (u.wrecked) {
            dmg = Math.max(0, impact - 5) * 0.6;
            break;
          }
          if (u.stats.onFoot && impact > 4) {
            // Atropellar a un mutante lo derriba, aunque alcanza a golpear.
            dmg = u.stats.ram * 0.4;
            this.damagePursuer(u, 999);
            break;
          }
          dmg = impact * 0.35 + u.stats.ram * (u.isRamming ? 0.8 : 0.25) * (0.5 + this.config.pursuers!.aggression * 0.5);
          this.damagePursuer(u, impact * 0.6 * p.def.ram);
          this.shake = Math.max(this.shake, 0.8);
          break;
        }
        case 'civilian':
          dmg = Math.max(0, impact - 4) * 0.8;
          (b.ref as Civilian).panic = 2;
          break;
        case 'obstacle': {
          const o = b.ref as ObstacleRecord;
          if (o.dead) return;
          o.hitMask |= 1 << p.index;
          if (o.kind === 'fuelBarrel' && impact > 4) {
            // El daño lo hace la explosión (y a la moto le llega reducido).
            this.explodeBarrel(o, 0.04);
            break;
          }
          const hard = OBSTACLE_HARDNESS[o.kind] ?? 1;
          dmg = Math.max(0, impact - 5) * hard * 0.55;
          if (o.kind === 'zombie') {
            dmg += 2;
            this.splatZombie(o);
          }
          break;
        }
        case 'wall':
          dmg = Math.max(0, impact - 5) * 0.65;
          key = 'wall';
          break;
        case 'player':
          dmg = impact * 0.15;
          this.damagePlayer(b.ref as Player, impact * 0.15);
          break;
        default:
          break;
      }
      if (impact > 3) {
        this.fx.sparks(p.vehicle.px, p.vehicle.pz, Math.round(clamp(impact, 4, 18)));
        this.audio.crash(clamp(impact / 20, 0.2, 1.2));
        this.shake = Math.max(this.shake, clamp(impact / 25, 0.1, 0.9));
      }
      if (dmg > 0.8 && p.canTakeHit(key, this.elapsed, b.kind === 'pursuer' ? 0.9 : 0.45)) {
        this.tracker.collision(0);
        this.damagePlayer(p, dmg);
      }
      return;
    }

    // Zombis arrollados y barriles embestidos por perseguidores o civiles.
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      if (x.kind !== 'obstacle' || (y.kind !== 'pursuer' && y.kind !== 'civilian')) continue;
      const o = x.ref as ObstacleRecord;
      if (o.kind === 'zombie') this.splatZombie(o);
      if (o.kind === 'fuelBarrel') {
        const other = (y.ref as Pursuer | Civilian).vehicle;
        if (other.impact() > 5 || Math.hypot(other.vx, other.vz) > 12) this.explodeBarrel(o, 0.04);
      }
    }

    // Perseguidores contra el entorno (o entre sí): se dañan con impactos fuertes.
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      if (x.kind !== 'pursuer') continue;
      const u = x.ref as Pursuer;
      const impact = u.vehicle.impact();
      if (impact > 12) this.damagePursuer(u, (impact - 12) * (y.kind === 'wall' || y.kind === 'obstacle' ? 2.6 : 2));
    }
    if (a.kind === 'civilian' || b.kind === 'civilian') {
      const c = (a.kind === 'civilian' ? a.ref : b.ref) as Civilian;
      if (c.vehicle.impact() > 5) c.panic = 2.5;
    }
  }

  private splatZombie(o: ObstacleRecord): void {
    if (o.dead) return;
    const t = o.body.translation();
    this.fx.splatter(t.x, t.z, 16);
    this.chunks.killZombie(o);
  }

  private damagePursuer(u: Pursuer, amount: number): void {
    if (!u.damage(amount)) return;
    if (u.stats.onFoot) {
      this.fx.splatter(u.vehicle.px, u.vehicle.pz, 20);
      this.registerKill(500, u.stats.label);
      return;
    }
    // El vehículo estalla y su onda puede arrastrar a los que estén cerca.
    this.queueBlast(u.vehicle.px, u.vehicle.pz, 0.05, BLASTS.vehicle);
    this.registerKill(1500, u.stats.label);
  }

  // ------------------------------------------------------------ métricas

  private checkObstaclesPassed(): void {
    const alive = this.alivePlayers;
    for (const o of this.chunks.obstacles()) {
      if (!o.onRoad) continue;
      for (const p of alive) {
        const bit = 1 << p.index;
        if (o.passMask & bit || p.vehicle.d < o.d + 2.5) continue;
        o.passMask |= bit;
        const hit = (o.hitMask & bit) !== 0;
        const lateral = Math.abs(p.vehicle.px - o.body.translation().x);
        // Solo cuentan los obstáculos que realmente estaban en la trayectoria.
        if (!hit && lateral > 6) continue;
        const near = lateral < 2.6 && p.vehicle.speed > 22;
        this.tracker.obstacle(hit, near);
        if (!hit && near) this.score += 150;
      }
    }
  }

  private cullTraffic(minD: number): void {
    for (let i = this.civilians.length - 1; i >= 0; i--) {
      const c = this.civilians[i];
      const v = c.vehicle;
      const sank = this.track.isWater(v.px, v.d);
      if (sank) this.fx.splash(v.px, v.pz);
      if (sank || v.d < minD - 70 || v.d > this.maxD + 340 || Math.abs(this.track.lateral(v.px, v.d)) > 70) {
        this.removeVehicle(v.body, v.mesh);
        this.civilians.splice(i, 1);
      }
    }
  }

  private removeVehicle(body: Parameters<Physics['remove']>[0], mesh: THREE.Object3D): void {
    this.physics.remove(body);
    this.scene.remove(mesh);
  }

  private updateStorm(dt: number, minD: number): void {
    const storm = this.storm!;
    storm.update(dt, minD, this.track, this.fx);
    for (const p of this.alivePlayers) {
      if (p.ghost) continue;
      const depth = storm.depth(p.vehicle.d);
      if (depth > 0) {
        this.damagePlayer(p, dt * (8 + depth * 0.6));
        if (this.rng.chance(dt * 1.5)) this.hooks.message(`${this.who(p)}¡La tormenta te alcanza!`, '#e0b070', 1);
      }
    }
  }

  /**
   * Calibración ("El Analista"). En el nivel 0 dura todo el recorrido; en los
   * niveles 1-3 son los primeros metros: al terminar, la IA ajusta este mismo
   * nivel (tipos y cantidad de perseguidores, obstáculos y distancia).
   */
  private updateAnalysis(dt: number): void {
    if (!this.calibrating) return;
    const target = this.config.index === 0 ? this.finishD : this.config.calibration;
    this.aiProgress = Math.max(this.aiProgress, clamp01(this.maxD / target));
    this.liveTimer -= dt;
    if (this.liveTimer <= 0) {
      this.liveTimer = 0.5;
      this.liveProfile = buildProfile(this.classifier, this.tracker.m);
    }
    const marks: [number, string][] =
      this.config.index === 0
        ? [
            [0.25, 'El Analista: registrando tu estilo de manejo...'],
            [0.5, 'El Analista: ¡se ve la ciudad! Sigo midiendo...'],
            [0.85, 'El Analista: ya casi te tengo calado'],
          ]
        : [
            [0.05, 'El Analista: calibrando... muéstrame cómo manejas'],
            [0.6, 'El Analista: un poco más y decido los refuerzos'],
          ];
    for (const [at, text] of marks) {
      if (this.state === 'running' && this.aiProgress >= at && !this.announced.has(at)) {
        this.announced.add(at);
        this.hooks.message(text, '#9be7a1', 2.5);
      }
    }
    if (this.config.index > 0 && this.aiProgress >= 1 && this.state === 'running') this.applyCalibration();
  }

  private applyCalibration(): void {
    const profile = buildProfile(this.classifier, this.tracker.m);
    this.calibratedProfile = profile;
    this.liveProfile = profile;
    if (this.config.index === 4) {
      // Nivel infinito: la habilidad medida fija el punto de partida de la rampa.
      this.endlessSkill = profile.skill;
      const zone = this.zoneAt(this.maxD);
      this.config.pursuers = this.endlessPursuers(zone);
      this.config.adaptiveNotes = [
        `Habilidad medida: ${Math.round(profile.skill * 100)}% (${profile.tier})`,
        'Cada zona suma tipos de enemigos de cualquier bando, más perseguidores y más obstáculos',
      ];
      this.hooks.message(`El Analista: perfil ${profile.tier}. Que empiece la cacería sin fin`, '#9be7a1', 4);
      this.spawnTimer = Math.min(this.spawnTimer, 0.8);
      return;
    }
    const adj = this.difficulty.adjust(this.config.index as 1 | 2 | 3, profile, this.playerCount);
    Object.assign(this.config, adj);
    const kinds = Object.keys(adj.pursuers!.kinds) as PursuerKind[];
    const who = REINFORCEMENTS[this.config.faction!];
    this.hooks.message(`El Analista: perfil ${profile.tier}. ${who} ${kinds.map(kindLabel).join(', ')}`, '#9be7a1', 4);
    // Refuerzos inmediatos acordes al nuevo nivel de amenaza.
    this.spawnTimer = Math.min(this.spawnTimer, 0.8);
  }

  private checkEnd(dt: number): void {
    if (this.alivePlayers.length === 0) {
      this.finish('failed', 2.5);
      return;
    }
    this.score += dt * 40 * this.alivePlayers.length;
    const zone = this.chunks.finishZone;
    if (!zone) return;
    for (const p of this.alivePlayers) {
      const v = p.vehicle;
      const crossed = zone.kind === 'safeZone' ? v.d >= zone.d : Math.abs(v.d - zone.d) < zone.hd && Math.abs(v.px - zone.x) < zone.hw;
      if (crossed) {
        this.reachFinish(zone.kind);
        return;
      }
    }
  }

  private reachFinish(kind: FinishScene): void {
    const zone = this.chunks.finishZone!;
    if (this.config.index === 0) {
      this.aiProgress = 1;
      this.calibratedProfile = buildProfile(this.classifier, this.tracker.m);
    } else {
      // Bonificación por la vida que queda (proporcional, no depende del máximo).
      this.score += 3000 * this.config.index + this.alivePlayers.reduce((s, p) => s + (p.hp / p.maxHp) * 2000, 0);
    }
    if (kind !== 'safeZone') {
      if (kind !== 'tunnel') this.chunks.openFinishDoor();
      for (const p of this.alivePlayers) {
        // Solo entran las motos cercanas; las lejanas simplemente frenan.
        if (Math.hypot(p.vehicle.px - zone.x, p.vehicle.d - zone.d) > 30) continue;
        p.setGhost(true);
        p.cutscene = 'enter';
      }
    }
    const texts: Record<FinishScene, [string, string]> = {
      bank: ['Entrando al Banco Central...', '#f4d03f'],
      tunnel: ['¡Al túnel! La policía se queda atrás', '#9be7a1'],
      plant: ['Adentro de la planta nuclear... ¡algo anda mal!', '#ff9a3c'],
      safeZone: ['¡Zona segura! Escaparon de la tierra baldía', '#9be7a1'],
      none: ['', '#ffffff'],
    };
    this.hooks.message(...texts[kind], 2.5);
    if (kind === 'plant') {
      this.blastTimer = 1.1;
      this.finish('complete', 3.6);
    } else {
      this.finish('complete', 2.2);
    }
  }

  /** Final del nivel 2: la planta nuclear estalla en una serie de explosiones verdes. */
  private updateBlast(dt: number): void {
    if (this.blastTimer < 0) return;
    this.blastTimer -= dt;
    if (this.blastTimer > 0) return;
    const points = this.chunks.blastPoints;
    const pt = points[this.blastCount % points.length];
    if (pt) {
      this.fx.explosion(pt.x + this.rng.range(-4, 4), pt.z + this.rng.range(-4, 4), 4, true);
      this.fx.explosion(pt.x, pt.z, 2.5, true);
    }
    this.audio.explosion();
    this.shake = 2.2;
    if (this.blastCount === 0) {
      this.hooks.flash('#39ff14');
      this.hooks.message('¡LA PLANTA NUCLEAR EXPLOTA!', '#39ff14', 2.5);
    }
    this.blastCount++;
    this.blastTimer = this.blastCount < 5 ? 0.3 : -1;
  }

  private finish(outcome: 'complete' | 'failed', delay: number): void {
    this.outcome = outcome;
    this.state = 'ending';
    this.endTimer = delay;
    this.bullets.clear();
    this.lobs.clear();
    if (outcome === 'complete') for (const p of this.players) p.invuln = 99;
  }

  // ------------------------------------------------------------ cámara

  /** Cámara del jugador `me` (la del anfitrión sigue a su propio vehículo). */
  updateCamera(camera: THREE.PerspectiveCamera, dt: number, me = 0): void {
    const focus = cameraFocus(this.camPlayers, me);
    this.cam.update(camera, dt, focus, this.shake, this.cameraZoom);
    this.sun.position.set(this.cam.x + 35, 110, this.cam.z + 25);
    this.sun.target.position.set(this.cam.x, 0, this.cam.z);
  }

  /** Vehículos de todos los jugadores, en orden, para las cámaras. */
  get camPlayers(): { px: number; pz: number; vx: number; vz: number; alive: boolean }[] {
    return this.players.map((p) => ({ px: p.vehicle.px, pz: p.vehicle.pz, vx: p.vehicle.vx, vz: p.vehicle.vz, alive: p.alive && !p.dropped }));
  }

  /** Durante la explosión de la planta la cámara se aleja para verla completa. */
  get cameraZoom(): number {
    return this.blastCount > 0 ? 30 : 0;
  }

  /** Distancia a la tormenta (nivel 0) del jugador más atrasado. */
  get stormGap(): number | null {
    if (!this.storm) return null;
    const ref = this.alivePlayers;
    if (!ref.length) return null;
    return Math.min(...ref.map((p) => p.vehicle.d)) - this.storm.front;
  }

  dispose(): void {
    this.audio.stopLoops();
    this.chunks.dispose();
    this.bullets.clear();
    this.lobs.clear();
    this.heli?.dispose();
    for (const f of this.flyers) f.dispose();
    this.storm?.dispose();
    this.fx.dispose();
    this.physics.dispose();
    this.scene.clear();
  }
}
