import * as THREE from 'three';
import { AdaptiveDifficulty } from '../ai/AdaptiveDifficulty';
import { blendProfile, buildProfile, RuleBasedClassifier, type SkillProfile } from '../ai/SkillClassifier';
import { LEVEL_0, VICTORY_TEXT } from '../config/levels';
import type { LevelConfig } from '../config/types';
import { Hud } from '../ui/Hud';
import { Screens } from '../ui/Screens';
import { Level } from '../world/Level';
import { Audio } from './Audio';
import { Input } from './Input';
import { Storage } from './Storage';

type State = 'menu' | 'intro' | 'playing' | 'paused' | 'results' | 'gameover' | 'victory';

/** Botín obtenido del Banco Central al terminar el nivel 0. */
const LOOT = 500_000;

interface Campaign {
  players: number;
  level: number;
  profile: SkillProfile | null;
  cash: number;
  score: number;
  config: LevelConfig | null;
}

/**
 * Orquesta el juego: renderizador, bucle principal, máquina de estados de
 * pantallas y la campaña (nivel 0 → IA → niveles 1-3 adaptados).
 */
export class Game {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.PerspectiveCamera(50, 1, 1, 600);
  private input = new Input();
  private audio = new Audio();
  private storage = new Storage();
  private hud = new Hud();
  private screens = new Screens();
  private classifier = new RuleBasedClassifier();
  private difficulty = new AdaptiveDifficulty();
  private level: Level | null = null;
  private state: State = 'menu';
  private last = performance.now();
  private campaign: Campaign = { players: 1, level: 0, profile: null, cash: 0, score: 0, config: null };

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x14161c);
    container.prepend(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
    this.resize();

    // Un perfil calculado con otra versión del clasificador no es comparable: se descarta.
    if (this.storage.data.profile && this.storage.data.profile.classifier !== this.classifier.name) {
      this.storage.data.profile = null;
      this.storage.save();
    }
    this.audio.muted = this.storage.data.muted;
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });

    this.showMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ bucle

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.tick(dt);
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Solo desarrollo: avanza la simulación sin depender de requestAnimationFrame. */
  debugAdvance(seconds: number, step = 1 / 60): void {
    for (let t = 0; t < seconds; t += step) this.tick(step, t + step >= seconds);
  }

  private tick(dt: number, render = true): void {
    if (this.input.wasPressed('KeyM') && this.state !== 'menu') this.toggleMute();

    if (this.state === 'playing' && this.level) {
      if (this.input.wasPressed('Escape', 'KeyP')) {
        this.pause();
      } else {
        const inputs = [0, 1].map((i) => this.input.drive(i, this.campaign.players));
        this.level.update(dt, inputs);
        this.hud.update(this.level);
        if (this.level.state === 'done') this.onLevelDone();
      }
    } else {
      this.screens.handleKeys(this.input);
    }

    if (this.level) {
      this.level.updateCamera(this.camera, this.state === 'playing' ? dt : 0);
      if (render) this.renderer.render(this.level.scene, this.camera);
    } else if (render) {
      this.renderer.clear();
    }
    this.input.endFrame();
  }

  // ------------------------------------------------------------ pantallas

  private showMenu(): void {
    this.state = 'menu';
    this.disposeLevel();
    this.hud.hide();
    this.screens.menu(this.storage.data, {
      one: () => this.newCampaign(1),
      two: () => this.newCampaign(2),
      select: () => this.screens.levelSelect(this.storage.data, (l, p) => this.startFrom(l, p), () => this.showMenu()),
      controls: () => this.screens.controls(() => this.showMenu()),
      stats: () => this.showStats(),
      mute: () => {
        this.toggleMute();
        this.showMenu();
      },
    });
  }

  private showStats(): void {
    this.screens.stats(
      this.storage.data,
      () => this.showMenu(),
      () => {
        if (confirm('¿Borrar todo el progreso y el perfil de la IA?')) {
          this.storage.reset();
          this.showStats();
        }
      },
    );
  }

  private toggleMute(): void {
    this.storage.data.muted = !this.storage.data.muted;
    this.storage.save();
    this.audio.setMuted(this.storage.data.muted);
  }

  private newCampaign(players: number): void {
    this.campaign = { players, level: 0, profile: null, cash: 0, score: 0, config: null };
    this.showIntro();
  }

  private startFrom(level: number, players: number): void {
    const profile = level > 0 ? this.storage.data.profile : null;
    this.campaign = { players, level, profile, cash: level > 0 ? LOOT : 0, score: 0, config: null };
    this.showIntro();
  }

  private configFor(level: number): LevelConfig {
    if (level === 0) return LEVEL_0;
    return this.difficulty.configFor(level as 1 | 2 | 3, this.campaign.profile, this.campaign.players);
  }

  private showIntro(): void {
    this.state = 'intro';
    this.disposeLevel();
    this.hud.hide();
    const cfg = this.configFor(this.campaign.level);
    this.campaign.config = cfg;
    this.screens.intro(cfg, this.campaign.players, () => this.beginLevel(), () => this.showMenu());
  }

  private beginLevel(): void {
    const cfg = this.campaign.config ?? this.configFor(this.campaign.level);
    this.disposeLevel();
    this.screens.hide();
    this.audio.unlock();
    this.level = new Level(cfg, this.campaign.players, this.audio, { message: (t, c, s) => this.hud.toast(t, c, s) }, this.classifier);
    this.hud.show(this.level, this.campaign.cash);
    this.state = 'playing';
    this.last = performance.now();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.audio.stopLoops();
    this.screens.pause(
      () => {
        this.screens.hide();
        this.state = 'playing';
        this.last = performance.now();
      },
      () => this.beginLevel(),
      () => this.showMenu(),
    );
  }

  private onLevelDone(): void {
    const level = this.level!;
    const cfg = level.config;
    const m = level.tracker.m;
    const data = this.storage.data;
    data.runs++;
    const recent = buildProfile(this.classifier, m);
    this.storage.record({ date: new Date().toISOString(), players: this.campaign.players, level: cfg.index, skill: recent.skill, features: recent.features });

    if (level.outcome === 'failed') {
      // La IA también aprende de las derrotas: el reintento será más accesible.
      if (cfg.index > 0 && this.campaign.profile) this.campaign.profile = blendProfile(this.campaign.profile, recent, 0.25);
      this.state = 'gameover';
      this.hud.hide();
      this.saveBest(this.campaign.score + level.score, 0);
      this.screens.gameOver(cfg, m, level.score, () => this.showIntro(), () => this.showMenu());
      return;
    }

    this.campaign.score += level.score;
    if (cfg.index === 0) {
      this.campaign.profile = recent;
      this.campaign.cash = LOOT;
    } else {
      this.campaign.profile = this.campaign.profile ? blendProfile(this.campaign.profile, recent, 0.3) : recent;
      this.campaign.cash = Math.max(0, this.campaign.cash - level.cashLost);
    }
    data.profile = this.campaign.profile;
    data.unlocked = Math.max(data.unlocked, Math.min(3, cfg.index + 1));
    this.storage.save();
    this.hud.hide();

    if (cfg.index === 3) {
      this.state = 'victory';
      data.victories++;
      this.saveBest(this.campaign.score, this.campaign.cash);
      this.screens.victory(VICTORY_TEXT, this.campaign.cash, this.campaign.score, this.campaign.profile, () => this.showMenu());
      return;
    }

    this.state = 'results';
    const preview = cfg.index === 0 ? ([1, 2, 3] as const).map((l) => this.difficulty.configFor(l, this.campaign.profile, this.campaign.players)) : [];
    this.screens.results(
      cfg,
      m,
      level.score,
      cfg.index === 0 ? null : this.campaign.cash,
      this.campaign.profile,
      preview,
      () => {
        this.campaign.level = cfg.index + 1;
        this.showIntro();
      },
      () => this.showMenu(),
    );
  }

  private saveBest(score: number, cash: number): void {
    const d = this.storage.data;
    d.bestScore = Math.max(d.bestScore, Math.round(score));
    d.bestCash = Math.max(d.bestCash, Math.round(cash));
    this.storage.save();
  }

  private disposeLevel(): void {
    if (!this.level) return;
    this.level.dispose();
    this.level = null;
  }
}
