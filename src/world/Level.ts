import * as THREE from 'three';
import { AdaptiveDifficulty, kindLabel } from '../ai/AdaptiveDifficulty';
import { PerformanceTracker } from '../ai/PerformanceTracker';
import { buildProfile, type SkillClassifier, type SkillProfile } from '../ai/SkillClassifier';
import type { Biome, FinishScene, LevelConfig, PursuerKind } from '../config/types';
import type { Audio } from '../core/Audio';
import type { DriveInput } from '../core/Input';
import { clamp, clamp01, damp, wrapAngle } from '../core/math';
import { Rng } from '../core/Rng';
import { Civilian } from '../entities/Civilian';
import { Helicopter } from '../entities/Helicopter';
import { BIKE_SPEC, Player, TURBO_MUL } from '../entities/Player';
import { Projectiles } from '../entities/Projectiles';
import { Pursuer, PURSUER_STATS, type FireRequest } from '../entities/Pursuer';
import { Sandstorm } from '../entities/Sandstorm';
import { mat } from '../fx/Meshes';
import { Effects } from '../fx/Particles';
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
};

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
  crate: 0.5,
  cone: 0.25,
  tumbleweed: 0.15,
  zombie: 0.12,
};

/** Cómo anuncia El Analista los refuerzos de cada facción. */
const REINFORCEMENTS = { police: 'La policía envía', gang: 'Los Cuervos mandan', wasteland: 'De las ruinas salen' };

/**
 * Una partida de un nivel: escena, física, mapa procedural, jugadores,
 * perseguidores, tráfico, calibración de la IA y reglas de victoria/derrota.
 * Los niveles terminan por distancia al llegar a su estructura final.
 */
export class Level {
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
  private camX = 0;
  private camZ = 0;
  private camH = 50;
  private shake = 0;
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
  ) {
    const mood = MOODS[config.mood];
    this.scene.background = new THREE.Color(mood.bg);
    this.scene.add(new THREE.HemisphereLight(mood.sky, mood.ground, mood.hemi));
    this.sun = new THREE.DirectionalLight(mood.sun, mood.sunI);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
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
    const spacing = inside ? 1.3 : 2.2;
    for (let i = 0; i < playerCount; i++) {
      const off = playerCount === 1 ? 0 : i === 0 ? -spacing : spacing;
      const p = new Player(this.physics, i, this.track.centerX(startD) + off, -startD, 0);
      if (inside) {
        p.setGhost(true);
        p.cutscene = 'exit';
        p.mesh.visible = false;
      }
      this.scene.add(p.mesh);
      this.players.push(p);
    }
    if (config.start === 'road') this.storm = new Sandstorm(this.scene, 60);

    this.camX = this.track.centerX(startD);
    this.camZ = -startD - 8;
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
      case 3:
      default:
        if (i < 0) return 'plantBack';
        if (d0 >= end) return 'desert';
        return d0 >= end - CHUNK ? 'safeZone' : 'wasteland';
    }
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
    return this.pursuers.filter((p) => !p.wrecked).length;
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

    this.elapsed += dt;
    this.tracker.tick(dt);
    const running = this.state === 'running';

    // ---- jugadores
    for (const p of this.players) this.updatePlayer(p, running ? inputs[p.index] : null, dt);

    // ---- perseguidores, tráfico, helicóptero
    if (this.config.pursuers && running) this.updatePursuers(dt);
    for (const c of this.civilians) c.update(dt, this.track, this.physics);
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
        this.damagePlayer(p, dmg);
      },
      onWall: (x, z) => this.fx.sparks(x, z, 5),
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
    this.chunks.update(this.maxD, this.maxD - 150, dt);
    this.checkObstaclesPassed();
    this.cullTraffic(minD);
    if (this.storm) this.updateStorm(dt, minD);
    this.updateStartSmoke(dt);
    for (const u of this.pursuers) {
      if (!u.wrecked || u.stats.onFoot) continue;
      u.smokeTimer -= dt;
      if (u.smokeTimer <= 0) {
        u.smokeTimer = 0.12;
        this.fx.smokeTrail(u.vehicle.px, u.vehicle.pz);
      }
    }

    // ---- audio
    const sp = ref.reduce((s, p) => s + Math.abs(p.vehicle.speed), 0) / ref.length / BIKE_SPEC.maxSpeed;
    this.audio.engine(clamp01(sp), alive.length > 0);
    let nearest = Infinity;
    if (this.config.faction === 'police') {
      for (const u of this.pursuers) {
        if (u.wrecked) continue;
        for (const p of alive) nearest = Math.min(nearest, Math.hypot(u.vehicle.px - p.vehicle.px, u.vehicle.pz - p.vehicle.pz));
      }
    }
    this.audio.siren(clamp01(1 - nearest / 70), dt);

    this.updateAnalysis(dt);
    this.updateBlast(dt);
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
        this.hooks.message('¡Acelera! La tormenta se acerca', '#ffd27a');
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
    if (!input) {
      v.halt(dt, 14);
      return;
    }

    const offroad = this.track.isOffroad(v.px, v.d);
    p.offroad = offroad;
    let speedMul = 1;
    let gripMul = 1;
    let accelMul = 1;
    if (offroad && ROUGH_BIOMES.has(this.track.biomeAt(v.d))) {
      speedMul *= 0.68;
      gripMul *= 0.8;
      if (Math.abs(v.speed) > 6 && this.rng.chance(0.5)) this.fx.dust(v.px, v.pz);
    }

    for (const h of this.chunks.hazards()) {
      if (Math.abs(v.d - h.d) > h.hd || Math.abs(v.px - h.x) > h.hw) continue;
      this.tracker.hazard(dt);
      if (h.kind === 'sand') {
        speedMul *= 0.5;
        if (this.rng.chance(0.6)) this.fx.dust(v.px, v.pz, 0xe2c48e, 1, 1.6);
      } else if (h.kind === 'oil') {
        if (p.oilTimer <= 0) this.hooks.message(`J${p.index + 1}: ¡Aceite!`, '#cccccc', 0.8);
        p.oilTimer = 1.1;
      } else if (h.kind === 'acid') {
        // El ácido corroe la moto mientras se está encima.
        this.damagePlayer(p, dt * 16);
        speedMul *= 0.8;
        if (this.rng.chance(0.4)) this.fx.splatter(v.px, v.pz, 2);
        if (this.rng.chance(dt * 2)) this.hooks.message(`J${p.index + 1}: ¡Ácido!`, '#9dff6a', 0.8);
      } else if (h.kind === 'spikes' && p.spikeTimer <= 0) {
        p.spikeTimer = 3;
        this.fx.sparks(v.px, v.pz, 12);
        this.damagePlayer(p, 10);
        this.hooks.message(`J${p.index + 1}: ¡Llanta ponchada!`, '#ff9f43', 1.2);
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
        p.hp = Math.min(p.maxHp, p.hp + 30);
        this.hooks.message(`J${p.index + 1}: ¡Reparación! +30`, '#4cd37b', 1);
      } else {
        p.turbo = 1;
        this.hooks.message(`J${p.index + 1}: ¡Nitro lleno!`, '#7dd3fc', 1);
      }
    }
    // Nivel 0 (prólogo): la moto se repara lentamente si no recibe golpes.
    p.sinceHit += dt;
    if (this.config.index === 0 && p.sinceHit > 4) p.hp = Math.min(p.maxHp, p.hp + dt * 2.5);

    const wantsTurbo = input.turbo && input.throttle > 0 && p.turbo > 0.02;
    p.turboActive = wantsTurbo;
    if (wantsTurbo) {
      p.turbo = Math.max(0, p.turbo - dt * 0.36);
      speedMul *= TURBO_MUL;
      accelMul = 1.7;
      this.fx.turbo(v.px + Math.sin(v.heading) * 1.2, v.pz + Math.cos(v.heading) * 1.2, v.heading + Math.PI);
    } else {
      p.turbo = Math.min(1, p.turbo + dt * 0.11);
    }

    p.steer = input.steer;
    v.drive(dt, input.throttle, input.brake, input.steer, { speedMul, accelMul, gripMul });
    this.tracker.samplePlayer(p.index, dt, Math.max(0, v.speed), BIKE_SPEC.maxSpeed, input.steer, offroad);

    // Peligro cercano (para la métrica "sangre fría").
    let danger = false;
    if (this.storm && this.storm.depth(v.d) > -15) danger = true;
    for (const u of this.pursuers) if (!u.wrecked && Math.hypot(u.vehicle.px - v.px, u.vehicle.pz - v.pz) < 8) danger = true;
    if (danger) this.tracker.danger(dt);

    // No permitir retroceder hacia tramos ya liberados.
    const minAllowed = this.maxD - 115;
    if (v.d < minAllowed) v.teleport(this.track.centerX(minAllowed + 2), -(minAllowed + 2), 0);

    // Cooperativo: el rezagado es arrastrado junto a su compañero.
    if (this.playerCount > 1) {
      const leader = this.alivePlayers.reduce((a, b) => (a.vehicle.d > b.vehicle.d ? a : b));
      if (leader !== p && leader.vehicle.d - v.d > 60) {
        const d = leader.vehicle.d - 6;
        v.teleport(this.track.centerX(d) + (leader.vehicle.px > this.track.centerX(d) ? -2.5 : 2.5), -d, 0);
        this.damagePlayer(p, 10);
        this.hooks.message(`J${p.index + 1}: ¡Rezagado!`, p.color, 1.2);
      }
    }
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

  private damagePlayer(p: Player, amount: number): void {
    if (amount <= 0 || !p.alive) return;
    if (p.invuln <= 0) this.tracker.damage(amount);
    const destroyed = p.damage(amount);
    if (destroyed) this.wreckPlayer(p);
  }

  private wreckPlayer(p: Player): void {
    const v = p.vehicle;
    this.fx.explosion(v.px, v.pz, 1.3);
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
    if (this.alivePlayers.length > 0) {
      this.respawnTimers.set(p, 6);
      this.hooks.message(`¡J${p.index + 1} cayó! Tu compañero vuelve por ti en 6 s`, p.color, 2.5);
    }
  }

  private respawn(p: Player): void {
    this.respawnTimers.delete(p);
    const partner = this.alivePlayers[0];
    if (!partner) return;
    const mats = this.origMaterials.get(p) ?? [];
    let i = 0;
    p.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && mats[i]) m.material = mats[i++];
    });
    const d = partner.vehicle.d - 5;
    p.vehicle.teleport(this.track.centerX(d) + (partner.vehicle.px > this.track.centerX(d) ? -2.5 : 2.5), -d, 0);
    p.alive = true;
    p.hp = 45;
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

    // Reciclar unidades que quedaron muy atrás o ya se consumieron.
    const minD = Math.min(...alive.map((p) => p.vehicle.d));
    for (let i = this.pursuers.length - 1; i >= 0; i--) {
      const u = this.pursuers[i];
      const tooFar = u.vehicle.d < minD - (u.wrecked ? 60 : 95) || u.vehicle.d > this.maxD + 200;
      const burnedOut = u.wrecked && u.wreckTime > (u.stats.onFoot ? 2.5 : 7);
      if (burnedOut && !u.stats.onFoot) this.fx.explosion(u.vehicle.px, u.vehicle.pz, 0.5);
      if (tooFar || burnedOut) {
        this.removeVehicle(u.vehicle.body, u.vehicle.mesh);
        this.pursuers.splice(i, 1);
        if (!u.wrecked) this.spawnTimer = Math.min(this.spawnTimer, 1);
      }
    }
  }

  private spawnPursuer(fromSide: boolean): void {
    const cfg = this.config.pursuers!;
    const kind = this.rng.weighted(cfg.kinds) as PursuerKind;
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
    this.bullets.fire(shot.x, shot.z, shot.angle, shot.damage, aerial, this.config.faction ?? 'police');
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
          this.damagePursuer(u, impact * 0.6);
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

    // Zombis arrollados por perseguidores o civiles.
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      if (x.kind === 'obstacle' && (x.ref as ObstacleRecord).kind === 'zombie' && (y.kind === 'pursuer' || y.kind === 'civilian')) {
        this.splatZombie(x.ref as ObstacleRecord);
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
      this.score += 500;
      this.tracker.copWrecked();
      return;
    }
    this.fx.explosion(u.vehicle.px, u.vehicle.pz, 1.1);
    this.audio.explosion();
    this.shake = Math.max(this.shake, 0.7);
    this.tracker.copWrecked();
    this.score += 1500;
    this.hooks.message(`¡${u.stats.label} fuera de combate! +1.500`, '#7dd3fc', 1.5);
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
      if (v.d < minD - 70 || v.d > this.maxD + 340 || Math.abs(this.track.lateral(v.px, v.d)) > 70) {
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
        if (this.rng.chance(dt * 1.5)) this.hooks.message(`J${p.index + 1}: ¡La tormenta te alcanza!`, '#e0b070', 1);
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
      this.score += 3000 * this.config.index + this.alivePlayers.reduce((s, p) => s + p.hp * 20, 0);
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
    if (outcome === 'complete') for (const p of this.players) p.invuln = 99;
  }

  // ------------------------------------------------------------ cámara

  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const alive = this.alivePlayers;
    const ref = alive.length ? alive : this.players;
    let cx = 0;
    let cz = 0;
    let vx = 0;
    let vz = 0;
    for (const p of ref) {
      cx += p.vehicle.px;
      cz += p.vehicle.pz;
      vx += p.vehicle.vx;
      vz += p.vehicle.vz;
    }
    cx /= ref.length;
    cz /= ref.length;
    vx /= ref.length;
    vz /= ref.length;
    let spread = 0;
    if (ref.length > 1) spread = Math.hypot(ref[0].vehicle.px - ref[1].vehicle.px, ref[0].vehicle.pz - ref[1].vehicle.pz);

    // Mirar hacia donde se va: más carretera visible por delante.
    const look = Math.min(1, 14 / Math.max(1, Math.hypot(vx, vz)));
    const tx = cx + vx * 0.4 * look;
    const tz = cz + vz * 0.4 * look - 6;
    const speed = Math.hypot(vx, vz);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const minForWidth = 19 / (tanHalf * camera.aspect);
    // Durante la explosión de la planta la cámara se aleja para verla completa.
    const blastZoom = this.blastCount > 0 ? 30 : 0;
    const h = clamp(Math.max(36 + speed * 0.35 + spread * 0.8, minForWidth) + blastZoom, 28, 120);

    this.camX = damp(this.camX, tx, 5, dt);
    this.camZ = damp(this.camZ, tz, 5, dt);
    this.camH = damp(this.camH, h, 2, dt);
    const s = this.shake * this.shake * 1.4;
    const sx = (Math.random() - 0.5) * s;
    const sz = (Math.random() - 0.5) * s;
    camera.up.set(0, 0, -1);
    camera.position.set(this.camX + sx, this.camH, this.camZ + sz + 0.01);
    camera.lookAt(this.camX + sx, 0, this.camZ + sz);

    this.sun.position.set(this.camX + 35, 110, this.camZ + 25);
    this.sun.target.position.set(this.camX, 0, this.camZ);
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
    this.heli?.dispose();
    this.storm?.dispose();
    this.fx.dispose();
    this.physics.dispose();
    this.scene.clear();
  }
}
