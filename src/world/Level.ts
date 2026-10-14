import * as THREE from 'three';
import { PerformanceTracker } from '../ai/PerformanceTracker';
import { buildProfile, type SkillClassifier, type SkillProfile } from '../ai/SkillClassifier';
import type { Biome, LevelConfig } from '../config/types';
import type { Audio } from '../core/Audio';
import type { DriveInput } from '../core/Input';
import { clamp, clamp01, damp } from '../core/math';
import { Rng } from '../core/Rng';
import { Civilian } from '../entities/Civilian';
import { Helicopter } from '../entities/Helicopter';
import { BIKE_SPEC, Player, TURBO_MUL } from '../entities/Player';
import { PoliceUnit, type FireRequest } from '../entities/Police';
import { Projectiles } from '../entities/Projectiles';
import { Sandstorm } from '../entities/Sandstorm';
import { mat } from '../fx/Meshes';
import { Effects } from '../fx/Particles';
import { ChunkManager, type CivilianSpawn, type ObstacleRecord } from './ChunkManager';
import { Physics, type Tag } from './Physics';
import { CHUNK, Track } from './Track';

export interface LevelHooks {
  message(text: string, color?: string, seconds?: number): void;
}

export type LevelState = 'countdown' | 'running' | 'ending' | 'done';

const MOODS = {
  day: { bg: 0xd9c49c, sky: 0xfff6e5, ground: 0xb89468, hemi: 1.7, sun: 0xffffff, sunI: 2.6 },
  afternoon: { bg: 0xcdb89a, sky: 0xffeacc, ground: 0x8a7a66, hemi: 1.6, sun: 0xffe2b8, sunI: 2.4 },
  sunset: { bg: 0x7a5468, sky: 0xffc7a0, ground: 0x6a4a5a, hemi: 1.4, sun: 0xff9d5c, sunI: 2.2 },
  dusk: { bg: 0x1d2438, sky: 0x8fa2d6, ground: 0x2a2a3a, hemi: 1.0, sun: 0x9db4ff, sunI: 1.2 },
};

const OBSTACLE_HARDNESS: Record<string, number> = {
  rock: 1.6,
  cactus: 1.0,
  barrier: 1.6,
  wreck: 1.5,
  dumpster: 1.2,
  parkedCar: 1.2,
  barrel: 0.7,
  crate: 0.5,
  cone: 0.25,
  tumbleweed: 0.15,
};

/**
 * Una partida de un nivel: escena, física, mapa procedural, jugadores,
 * policía, tráfico y reglas de victoria/derrota.
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
  readonly police: PoliceUnit[] = [];
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
  /** Nivel 0: progreso del análisis y estimación en vivo de la habilidad. */
  aiProgress = 0;
  liveProfile: SkillProfile | null = null;

  private sun: THREE.DirectionalLight;
  private camX = 0;
  private camZ = 0;
  private camH = 50;
  private shake = 0;
  private spawnTimer = 2.5;
  private liveTimer = 0;
  private endTimer = 0;
  private respawnTimers = new Map<Player, number>();
  private origMaterials = new Map<Player, THREE.Material[]>();
  private phase: 'desert' | 'outskirts' | 'city' | 'bank' = 'desert';
  private phaseChunks = 0;
  private bankSmoke = 0;
  private analysisAnnounced = new Set<number>();
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
    this.phase = config.index === 0 ? 'desert' : 'city';

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

    const startD = config.index === 0 ? 6 : 5;
    for (let i = 0; i < playerCount; i++) {
      const off = playerCount === 1 ? 0 : i === 0 ? -2.2 : 2.2;
      const p = new Player(this.physics, i, this.track.centerX(startD) + off, -startD, 0);
      this.scene.add(p.mesh);
      this.players.push(p);
    }
    if (config.index === 0) this.storm = new Sandstorm(this.scene, config.duration);

    this.camX = this.track.centerX(startD);
    this.camZ = -startD - 8;
  }

  // ------------------------------------------------------------ mapa

  private biomeFor(i: number): Biome {
    const cfg = this.config;
    if (cfg.index === 0) {
      if (i < 1) return 'desert';
      const t = this.elapsed / cfg.duration;
      if (this.phase === 'desert' && t >= 0.5) this.enterPhase('outskirts');
      else if (this.phase === 'outskirts' && this.phaseChunks >= 2) this.enterPhase('city');
      else if (this.phase === 'city' && this.phaseChunks >= 2 && this.elapsed >= cfg.duration - 6) this.enterPhase('bank');
      this.phaseChunks++;
      return this.phase === 'bank' ? 'bankEnd' : this.phase;
    }
    if (i < 0) return 'bankBack';
    if (i === 0) return 'plaza';
    // Nivel 3: el último tramo de la huida regresa al desierto.
    if (cfg.index === 3) {
      if (this.phase === 'city' && this.elapsed >= cfg.duration * 0.68) this.enterPhase('outskirts');
      else if (this.phase === 'outskirts' && this.phaseChunks >= 2) this.enterPhase('desert');
    }
    this.phaseChunks++;
    return this.phase === 'bank' ? 'city' : this.phase;
  }

  private enterPhase(p: Level['phase']): void {
    this.phase = p;
    this.phaseChunks = 0;
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

  get remaining(): number {
    return Math.max(0, this.config.duration - this.elapsed);
  }

  get activePolice(): number {
    return this.police.filter((p) => !p.wrecked).length;
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

    // ---- policía, tráfico, helicóptero
    if (this.config.police && running) this.updatePolice(dt);
    for (const c of this.civilians) c.update(dt, this.track, this.physics);
    if (this.heli && this.config.police) {
      const shot = this.heli.update(dt, this.players, this.config.police, this.rng);
      if (shot) this.fire(shot, true);
    }

    // ---- física
    this.physics.world.timestep = dt;
    this.physics.step((a, b) => this.onContact(a, b));
    for (const p of this.players) p.vehicle.sync();
    for (const u of this.police) u.vehicle.sync();
    for (const c of this.civilians) c.vehicle.sync();

    // ---- balas
    this.bullets.update(dt, this.players, this.physics, {
      onHit: (p, dmg, x, z) => {
        if (p.invuln > 0) return;
        this.tracker.bullet(true);
        this.fx.sparks(x, z, 8);
        this.fx.dust(x, z, 0x3fae5a, 3, 0.6);
        this.cashLost += 2500;
        this.damagePlayer(p, dmg, 'disparo');
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
    if (this.config.index > 0 && this.elapsed < 14 && this.chunks.bankFront) {
      this.bankSmoke -= dt;
      if (this.bankSmoke <= 0) {
        this.bankSmoke = 0.08;
        this.fx.smokeTrail(this.chunks.bankFront.x + this.rng.range(-3, 3), -this.chunks.bankFront.d);
      }
    }
    for (const u of this.police) {
      if (!u.wrecked) continue;
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
    for (const u of this.police) {
      if (u.wrecked) continue;
      for (const p of alive) nearest = Math.min(nearest, Math.hypot(u.vehicle.px - p.vehicle.px, u.vehicle.pz - p.vehicle.pz));
    }
    this.audio.siren(clamp01(1 - nearest / 70), dt);

    this.updateAnalysis(dt);
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

  private start(): void {
    this.state = 'running';
    this.audio.blip(1040);
    if (this.config.index === 0) {
      this.hooks.message('¡Acelera! La tormenta se acerca', '#ffd27a');
    } else {
      const f = this.chunks.bankFront;
      if (f) {
        this.fx.explosion(f.x, -f.d + 1, 2.4);
        this.fx.explosion(f.x - 6, -f.d - 1, 1.2);
        this.fx.explosion(f.x + 6, -f.d - 1, 1.2);
      }
      this.audio.explosion();
      this.shake = 1.6;
      this.hooks.message('¡BOOM! ¡Salgan de ahí!', '#ff7a45');
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
    if (!input) {
      v.halt(dt, 14);
      return;
    }

    const offroad = this.track.isOffroad(v.px, v.d);
    p.offroad = offroad;
    const biome = this.track.biomeAt(v.d);
    let speedMul = 1;
    let gripMul = 1;
    let accelMul = 1;
    if (offroad && (biome === 'desert' || biome === 'outskirts')) {
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
      } else if (h.kind === 'spikes' && p.spikeTimer <= 0) {
        p.spikeTimer = 3;
        this.fx.sparks(v.px, v.pz, 12);
        this.damagePlayer(p, 10, 'púas');
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
    // Nivel 0 (calibración): la moto se repara lentamente si no recibe golpes.
    p.sinceHit += dt;
    if (this.config.index === 0 && p.sinceHit > 4) p.hp = Math.min(p.maxHp, p.hp + dt * 2.5);

    const wantsTurbo = input.turbo && input.throttle > 0 && p.turbo > 0.02;
    p.turboActive = wantsTurbo;
    if (wantsTurbo) {
      p.turbo = Math.max(0, p.turbo - dt * 0.36);
      speedMul *= TURBO_MUL;
      accelMul = 1.7;
      this.fx.turbo(v.px - Math.sin(v.heading) * -1.2, v.pz - Math.cos(v.heading) * -1.2, v.heading + Math.PI);
    } else {
      p.turbo = Math.min(1, p.turbo + dt * 0.11);
    }

    p.steer = input.steer;
    v.drive(dt, input.throttle, input.brake, input.steer, { speedMul, accelMul, gripMul });
    this.tracker.samplePlayer(p.index, dt, Math.max(0, v.speed), BIKE_SPEC.maxSpeed, input.steer, offroad);

    // Peligro cercano (para la métrica "sangre fría").
    let danger = false;
    if (this.storm && this.storm.depth(v.d) > -15) danger = true;
    for (const u of this.police) if (!u.wrecked && Math.hypot(u.vehicle.px - v.px, u.vehicle.pz - v.pz) < 8) danger = true;
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
        this.damagePlayer(p, 10, 'rezagado');
        this.hooks.message(`J${p.index + 1}: ¡Rezagado!`, p.color, 1.2);
      }
    }
  }

  private damagePlayer(p: Player, amount: number, _cause: string): void {
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

  // ------------------------------------------------------------ policía

  private updatePolice(dt: number): void {
    const cfg = this.config.police!;
    const alive = this.alivePlayers;
    if (alive.length === 0) return;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.activePolice < cfg.maxActive) {
      const first = this.police.length === 0;
      this.spawnPolice(first);
      if (first) this.spawnPolice(true);
      this.spawnTimer = cfg.spawnInterval * this.rng.range(0.8, 1.2);
    }

    if (cfg && this.config.helicopter && !this.heli && this.elapsed > 8) {
      const p = alive[0].vehicle;
      this.heli = new Helicopter(this.scene, p.px + 30, p.pz - 60);
      this.hooks.message('¡Helicóptero policial en el aire!', '#7dd3fc', 2);
    }

    for (const u of this.police) {
      const shot = u.update({ dt, players: this.players, track: this.track, physics: this.physics, config: cfg, rng: this.rng });
      if (shot) this.fire(shot, false);
    }

    // Reciclar unidades que quedaron muy atrás.
    const minD = Math.min(...alive.map((p) => p.vehicle.d));
    for (let i = this.police.length - 1; i >= 0; i--) {
      const u = this.police[i];
      const tooFar = u.vehicle.d < minD - (u.wrecked ? 60 : 95) || u.vehicle.d > this.maxD + 200;
      if (tooFar) {
        this.removeVehicle(u.vehicle.body, u.vehicle.mesh);
        this.police.splice(i, 1);
        if (!u.wrecked) this.spawnTimer = Math.min(this.spawnTimer, 1);
      }
    }
  }

  private spawnPolice(fromSide: boolean): void {
    const cfg = this.config.police!;
    const kind = this.rng.weighted(cfg.kinds);
    const alive = this.alivePlayers;
    const minD = Math.min(...alive.map((p) => p.vehicle.d));
    let x: number;
    let d: number;
    let heading = 0;

    const sides = this.chunks.sideSpawns;
    if ((fromSide || minD < 40) && sides.length) {
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
    if (d < 8 && !sides.length) d = 8;
    if (!this.chunks.isClear(x, d, 3)) x = this.track.centerX(d);
    for (const u of this.police) if (Math.hypot(u.vehicle.px - x, u.vehicle.pz + d) < 5) x += 5;

    const unit = new PoliceUnit(this.physics, kind, x, -d, heading, this.rng);
    unit.vehicle.vx = -Math.sin(heading) * 20;
    unit.vehicle.vz = -Math.cos(heading) * 20;
    this.scene.add(unit.vehicle.mesh);
    this.police.push(unit);
  }

  private fire(shot: FireRequest, aerial: boolean): void {
    this.bullets.fire(shot.x, shot.z, shot.angle, shot.damage, aerial);
    this.fx.muzzle(shot.x - Math.sin(shot.angle) * 2.4, shot.z - Math.cos(shot.angle) * 2.4, shot.angle);
    this.audio.shot();
  }

  // ------------------------------------------------------------ colisiones

  private onContact(a: Tag, b: Tag): void {
    if (b.kind === 'player' && a.kind !== 'player') [a, b] = [b, a];
    if (a.kind === 'player') {
      const p = a.ref as Player;
      if (!p.alive) return;
      const impact = p.vehicle.impact();
      let dmg = 0;
      let key: unknown = b.ref ?? b;
      switch (b.kind) {
        case 'police': {
          const u = b.ref as PoliceUnit;
          if (u.wrecked) {
            dmg = Math.max(0, impact - 5) * 0.6;
            break;
          }
          dmg = impact * 0.35 + u.stats.ram * (u.isRamming ? 0.8 : 0.25) * (0.5 + this.config.police!.aggression * 0.5);
          this.damagePolice(u, impact * 0.6);
          this.shake = Math.max(this.shake, 0.8);
          break;
        }
        case 'civilian':
          dmg = Math.max(0, impact - 4) * 0.8;
          (b.ref as Civilian).panic = 2;
          break;
        case 'obstacle': {
          const o = b.ref as ObstacleRecord;
          o.hitMask |= 1 << p.index;
          const hard = OBSTACLE_HARDNESS[o.kind] ?? 1;
          dmg = Math.max(0, impact - 5) * hard * 0.55;
          break;
        }
        case 'wall':
          dmg = Math.max(0, impact - 5) * 0.65;
          key = 'wall';
          break;
        case 'player':
          dmg = impact * 0.15;
          this.damagePlayer(b.ref as Player, impact * 0.15, 'compañero');
          break;
        default:
          break;
      }
      if (impact > 3) {
        this.fx.sparks(p.vehicle.px, p.vehicle.pz, Math.round(clamp(impact, 4, 18)));
        this.audio.crash(clamp(impact / 20, 0.2, 1.2));
        this.shake = Math.max(this.shake, clamp(impact / 25, 0.1, 0.9));
      }
      if (dmg > 0.8 && p.canTakeHit(key, this.elapsed, b.kind === 'police' ? 0.9 : 0.45)) {
        this.tracker.collision(0);
        this.damagePlayer(p, dmg, b.kind);
      }
      return;
    }

    // Policía contra el entorno (o entre sí): se dañan con impactos fuertes.
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      if (x.kind !== 'police') continue;
      const u = x.ref as PoliceUnit;
      const impact = u.vehicle.impact();
      if (impact > 12) this.damagePolice(u, (impact - 12) * (y.kind === 'wall' || y.kind === 'obstacle' ? 2.6 : 2));
    }
    if (a.kind === 'civilian' || b.kind === 'civilian') {
      const c = (a.kind === 'civilian' ? a.ref : b.ref) as Civilian;
      if (c.vehicle.impact() > 5) c.panic = 2.5;
    }
  }

  private damagePolice(u: PoliceUnit, amount: number): void {
    if (u.damage(amount)) {
      this.fx.explosion(u.vehicle.px, u.vehicle.pz, 1.1);
      this.audio.explosion();
      this.shake = Math.max(this.shake, 0.7);
      this.tracker.copWrecked();
      this.score += 1500;
      this.hooks.message(`¡${u.stats.label} fuera de combate! +1.500`, '#7dd3fc', 1.5);
    }
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
        const near = Math.abs(p.vehicle.px - o.x) < 3.2;
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
      const depth = storm.depth(p.vehicle.d);
      if (depth > 0) {
        this.damagePlayer(p, dt * (8 + depth * 0.6), 'tormenta');
        if (this.rng.chance(dt * 1.5)) this.hooks.message(`J${p.index + 1}: ¡La tormenta te alcanza!`, '#e0b070', 1);
      }
    }
  }

  /** Estimación en vivo del nivel 0 ("El Analista"). */
  private updateAnalysis(dt: number): void {
    if (this.config.index !== 0) return;
    this.aiProgress = clamp01(this.elapsed / this.config.duration);
    this.liveTimer -= dt;
    if (this.liveTimer <= 0) {
      this.liveTimer = 0.5;
      this.liveProfile = buildProfile(this.classifier, this.tracker.m);
    }
    const marks: [number, string][] = [
      [0.25, 'El Analista: registrando tu estilo de manejo...'],
      [0.5, 'El Analista: ¡se ve la ciudad! Sigo midiendo...'],
      [0.85, 'El Analista: ya casi te tengo calado'],
      [1, 'Análisis completo. ¡Entra al Banco Central!'],
    ];
    for (const [at, text] of marks) {
      if (this.aiProgress >= at && !this.analysisAnnounced.has(at)) {
        this.analysisAnnounced.add(at);
        this.hooks.message(text, '#9be7a1', 2.5);
      }
    }
  }

  private checkEnd(dt: number): void {
    if (this.alivePlayers.length === 0) {
      this.finish('failed', 2.5);
      return;
    }
    this.score += dt * 40 * this.alivePlayers.length;
    if (this.config.index === 0) {
      const door = this.chunks.bankDoor;
      if (door && this.aiProgress >= 1) {
        for (const p of this.alivePlayers) {
          const v = p.vehicle;
          if (Math.abs(v.d - door.d) < door.hd && Math.abs(v.px - door.x) < door.hw) {
            this.hooks.message('Entrando al Banco Central...', '#f4d03f', 2);
            this.finish('complete', 1.8);
            return;
          }
        }
      }
    } else if (this.elapsed >= this.config.duration) {
      this.score += 3000 * this.config.index + this.alivePlayers.reduce((s, p) => s + p.hp * 20, 0);
      this.hooks.message('¡Los perdiste! Escapaste de la persecución', '#9be7a1', 2.5);
      this.finish('complete', 2.2);
    }
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
    const minForWidth = 26 / (tanHalf * camera.aspect);
    const h = clamp(Math.max(42 + speed * 0.35 + spread * 0.8, minForWidth), 30, 120);

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

  get chunkCount(): number {
    return Math.round(this.chunks.generatedUntil / CHUNK);
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
