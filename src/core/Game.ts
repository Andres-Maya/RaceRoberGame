import * as THREE from 'three';
import { AdaptiveDifficulty } from '../ai/AdaptiveDifficulty';
import { buildProfile, RuleBasedClassifier, type SkillProfile } from '../ai/SkillClassifier';
import { ENDLESS_LEVEL, LEVEL_0, VICTORY_TEXT } from '../config/levels';
import type { LevelConfig } from '../config/types';
import { Hud } from '../ui/Hud';
import { Screens } from '../ui/Screens';
import { Level } from '../world/Level';
import { Audio, type SoundChannel } from './Audio';
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
    this.audio.musicOn = this.storage.data.musicOn;
    this.audio.setVolumes(this.storage.data.volumes);
    this.screens.onVolume = (ch, v) => this.setVolume(ch, v, false);
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
      if (!document.hidden) this.audio.resyncMusic();
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

  private raycaster = new THREE.Raycaster();
  private aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1);
  private aimPoint = new THREE.Vector3();

  /** Punto del suelo bajo el cursor (para apuntar con el ratón). */
  private mouseWorld(): { x: number; z: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.input.mouse.x - rect.left) / rect.width) * 2 - 1, -((this.input.mouse.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.aimPlane, this.aimPoint);
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  private tick(dt: number, render = true): void {
    // Durante la partida el cursor es una mira.
    document.body.classList.toggle('aiming', this.state === 'playing');
    if (this.input.wasPressed('KeyM') && this.state !== 'menu') this.toggleMute();
    if (this.input.wasPressed('KeyN') && this.state !== 'menu') this.toggleMusic();
    if (this.input.wasPressed('Minus', 'NumpadSubtract')) this.setVolume('music', this.storage.data.volumes.music - 0.1, true);
    if (this.input.wasPressed('Equal', 'NumpadAdd')) this.setVolume('music', this.storage.data.volumes.music + 0.1, true);

    if (this.state === 'playing' && this.level) {
      if (this.input.wasPressed('Escape', 'KeyP')) {
        this.pause();
      } else {
        const inputs = [0, 1].map((i) => this.input.drive(i, this.campaign.players));
        // Clic izquierdo: el jugador 1 dispara hacia la mira.
        if (this.input.mouse.down) {
          inputs[0].shoot = true;
          inputs[0].aim = this.mouseWorld();
        }
        this.level.update(dt, inputs);
        this.audio.musicIntensity(this.level.musicIntensity);
        // Cuando caen todas las motos, el metal se corta y entra el réquiem.
        if (this.level.outcome === 'failed') this.audio.playMusic('death');
        // En el nivel infinito la música cambia de estilo con cada zona.
        else this.audio.playMusic('level', this.level.musicStyle);
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
    this.audio.duckMusic(false);
    this.audio.playMusic('calm');
    this.screens.menu(this.storage.data, {
      one: () => this.newCampaign(1),
      two: () => this.newCampaign(2),
      select: () => this.screens.levelSelect(this.storage.data, (l, p) => this.startFrom(l, p), () => this.showMenu()),
      controls: () => this.screens.controls(() => this.showMenu()),
      stats: () => this.showStats(),
      sound: () => this.showSound(),
      mute: () => {
        this.toggleMute();
        this.showMenu();
      },
      music: () => {
        this.toggleMusic();
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

  /** Volumen de un canal (0..1): desde los controles deslizantes o con las teclas - y + (música). */
  private setVolume(channel: SoundChannel, v: number, fromKeys: boolean): void {
    const vol = Math.round(Math.max(0, Math.min(1, v)) * 20) / 20;
    this.storage.data.volumes[channel] = vol;
    this.storage.save();
    this.audio.unlock();
    this.audio.setVolume(channel, vol);
    if (fromKeys) {
      this.screens.showVolume(channel, vol);
      if (this.state === 'playing') this.hud.toast(`Música: ${Math.round(vol * 100)}%`, '#cccccc', 0.8);
    } else {
      this.audio.preview(channel);
    }
  }

  /** Apartado de sonido del menú principal. */
  private showSound(): void {
    this.screens.sound(this.storage.data, {
      back: () => this.showMenu(),
      music: () => {
        this.toggleMusic();
        this.showSound();
      },
      mute: () => {
        this.toggleMute();
        this.showSound();
      },
    });
  }

  private toggleMusic(): void {
    this.storage.data.musicOn = !this.storage.data.musicOn;
    this.storage.save();
    this.audio.setMusicOn(this.storage.data.musicOn);
  }

  private newCampaign(players: number): void {
    this.campaign = { players, level: 0, profile: null, cash: 0, score: 0, config: null };
    this.showIntro();
  }

  private startFrom(level: number, players: number): void {
    this.campaign = { players, level, profile: this.storage.data.profile, cash: level > 0 ? LOOT : 0, score: 0, config: null };
    this.showIntro();
  }

  /**
   * Configuración nueva para cada intento: los niveles 1-3 arrancan en modo
   * calibración y la IA los ajusta en caliente durante la partida.
   */
  private configFor(level: number): LevelConfig {
    if (level === 0) return structuredClone(LEVEL_0);
    if (level === 4) return structuredClone(ENDLESS_LEVEL);
    return this.difficulty.calibrationConfig(level as 1 | 2 | 3, this.campaign.players);
  }

  private showIntro(): void {
    this.state = 'intro';
    this.disposeLevel();
    this.hud.hide();
    const cfg = this.configFor(this.campaign.level);
    this.campaign.config = cfg;
    this.audio.playMusic('epic');
    this.screens.intro(cfg, this.campaign.players, () => this.beginLevel(), () => this.showMenu());
  }

  private beginLevel(): void {
    const cfg = this.configFor(this.campaign.level);
    this.campaign.config = cfg;
    this.disposeLevel();
    this.screens.hide();
    this.audio.unlock();
    const hooks = { message: (t: string, c?: string, s?: number) => this.hud.toast(t, c, s), flash: (c: string) => this.hud.flash(c) };
    this.level = new Level(cfg, this.campaign.players, this.audio, hooks, this.classifier);
    this.hud.show(this.level, this.campaign.cash);
    this.audio.duckMusic(false);
    this.audio.playMusic('level', this.level.musicStyle);
    this.state = 'playing';
    this.last = performance.now();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.audio.stopLoops();
    this.audio.duckMusic(true);
    this.screens.pause(
      this.storage.data.volumes,
      () => {
        this.screens.hide();
        this.audio.duckMusic(false);
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
    // El perfil del nivel es el medido en su calibración (o el recorrido completo si no llegó a terminarla).
    const measured = level.calibratedProfile ?? buildProfile(this.classifier, m);
    this.storage.record({ date: new Date().toISOString(), players: this.campaign.players, level: cfg.index, skill: measured.skill, features: measured.features });

    if (level.outcome === 'failed') {
      this.state = 'gameover';
      this.hud.hide();
      this.audio.playMusic('death');
      this.saveBest(this.campaign.score + level.score, 0);
      let endless: { zone: number; best: number; record: boolean } | undefined;
      if (cfg.index === 4) {
        const record = level.maxD > data.bestEndless;
        if (record) data.bestEndless = Math.round(level.maxD);
        this.storage.save();
        endless = { zone: level.zoneInfo?.index ?? 1, best: data.bestEndless, record };
      }
      this.screens.gameOver(cfg, m, level.score, () => this.showIntro(), () => this.showMenu(), endless);
      return;
    }

    this.campaign.score += level.score;
    this.campaign.profile = measured;
    this.campaign.cash = cfg.index === 0 ? LOOT : Math.max(0, this.campaign.cash - level.cashLost);
    data.profile = this.campaign.profile;
    data.unlocked = Math.max(data.unlocked, Math.min(3, cfg.index + 1));
    this.storage.save();
    this.hud.hide();
    this.audio.playMusic('victory');

    if (cfg.index === 3) {
      this.state = 'victory';
      data.victories++;
      this.saveBest(this.campaign.score, this.campaign.cash);
      this.screens.victory(
        VICTORY_TEXT,
        this.campaign.cash,
        this.campaign.score,
        this.campaign.profile,
        () => this.showMenu(),
        () => {
          this.campaign.level = 4;
          this.showIntro();
        },
      );
      return;
    }

    this.state = 'results';
    this.screens.results(
      cfg,
      m,
      level.score,
      cfg.index === 0 ? null : this.campaign.cash,
      measured,
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
