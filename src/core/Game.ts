import * as THREE from 'three';
import { AdaptiveDifficulty } from '../ai/AdaptiveDifficulty';
import { buildProfile, RuleBasedClassifier, type SkillProfile } from '../ai/SkillClassifier';
import { ENDLESS_LEVEL, LEVEL_0, VICTORY_TEXT } from '../config/levels';
import type { LevelConfig } from '../config/types';
import { isUnlocked, VEHICLES, vehicleById, type VehicleDef, type VehicleId } from '../config/vehicles';
import { GuestView } from '../net/GuestView';
import { HostSync, packInput, unpackInput } from '../net/HostSync';
import { lanAddress, lanInfo, PeerLink, WsLink, type LanInfo, type Link } from '../net/Link';
import { PROTOCOL, type NetMessage, type PackedInput } from '../net/protocol';
import { QrLink, qrImage, qrKind } from '../net/QrLink';
import { Hud, hudState } from '../ui/Hud';
import type { Loader } from '../ui/Loader';
import { OffscreenMarkers, type Mate } from '../ui/Offscreen';
import { QrScanner } from '../ui/QrScanner';
import { Screens } from '../ui/Screens';
import { enterFullscreen, IS_TOUCH, TouchControls } from '../ui/Touch';
import { Level, type LevelHooks } from '../world/Level';
import { Audio, type SoundChannel } from './Audio';
import { Input, type DriveInput } from './Input';
import type { MusicMode } from './Music';
import { Storage } from './Storage';

type State = 'menu' | 'intro' | 'loading' | 'playing' | 'paused' | 'results' | 'gameover' | 'victory' | 'online' | 'guest';

/** Botín obtenido del Banco Central al terminar el nivel 0. */
const LOOT = 500_000;

/** Tiempo mínimo de la pantalla de carga entre niveles (que la llanta alcance a rodar). */
const MIN_LOADING_MS = 700;

/** Pantallas del anfitrión que el invitado ve en espejo. */
const MIRRORED: State[] = ['intro', 'paused', 'results', 'gameover', 'victory'];
const MUSIC_MODES = new Set<MusicMode>(['off', 'calm', 'epic', 'level', 'victory', 'death']);

interface Campaign {
  players: number;
  level: number;
  profile: SkillProfile | null;
  cash: number;
  score: number;
  config: LevelConfig | null;
}

/** Partida en línea en curso (como anfitrión o como invitado). */
interface Net {
  role: 'host' | 'guest';
  link: Link;
  /** Anfitrión: vehículo del invitado (null mientras no haya nadie conectado). */
  peer: VehicleId | null;
  /** Anfitrión: últimos controles recibidos del invitado. */
  remote: DriveInput;
  sync: HostSync | null;
  /** Anfitrión por IP: direcciones para compartir. */
  addresses: string[];
  /** Anfitrión: la sala está en pantalla (se redibuja cuando cambia el invitado). */
  inRoom: boolean;
  /** Invitado: escena replicada y si está jugando. */
  view: GuestView | null;
  playing: boolean;
  inGarage: boolean;
  waitText: string;
  lastInput: string;
  inputTimer: number;
}

const idleInput = (): DriveInput => ({ throttle: 0, brake: 0, steer: 0, turbo: false, shoot: false, aim: null });

/** Color de un aviso recibido por red (evita valores que no sean colores simples). */
const safeColor = (c: unknown): string | undefined => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(c) ? c : undefined);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'No se pudo conectar.');

/**
 * Orquesta el juego: renderizador, bucle principal, máquina de estados de
 * pantallas, la campaña (nivel 0 → IA → niveles 1-3 adaptados) y las
 * partidas en línea (el anfitrión simula; el invitado ve una réplica).
 */
export class Game {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.PerspectiveCamera(50, 1, 1, 600);
  private input = new Input();
  private audio = new Audio();
  private storage = new Storage();
  private hud = new Hud();
  private screens = new Screens();
  private touch = new TouchControls();
  private offscreen = new OffscreenMarkers();
  private classifier = new RuleBasedClassifier();
  private difficulty = new AdaptiveDifficulty();
  private level: Level | null = null;
  private state: State = 'menu';
  private last = performance.now();
  private campaign: Campaign = { players: 1, level: 0, profile: null, cash: 0, score: 0, config: null };
  /** Cambia con cada carga para descartar una que quedó obsoleta. */
  private loadToken = 0;
  private lan: LanInfo | null = null;
  private net: Net | null = null;
  /** Aviso del navegador para instalar el juego como app (Chrome/Android). */
  private installPrompt: (Event & { prompt: () => Promise<void> }) | null = null;
  /** Cámara abierta para escanear un código QR de conexión. */
  private scanner: QrScanner | null = null;

  constructor(
    container: HTMLElement,
    private loader: Loader,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // En celulares se dibuja a menor resolución y con sombras más livianas.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
    if (IS_TOUCH) {
      Level.shadowSize = 1024;
      document.body.classList.add('touch');
    }
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
    this.screens.onShow = (html, variant) => this.mirrorScreen(html, variant);
    this.audio.onMusic = (mode, level) => {
      if (this.net?.role === 'host') this.net.link.send({ t: 'music', mode, level });
    };
    // El audio solo puede arrancar dentro de un gesto válido; en táctil, al soltar el dedo.
    const unlock = () => this.audio.unlock();
    for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(ev, unlock, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
      if (!document.hidden) this.audio.resyncMusic();
    });

    // Instalar como app: el juego queda guardado y abre sin internet.
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as Event & { prompt: () => Promise<void> };
      if (this.state === 'menu' && !this.net) this.showMenu();
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      if (this.state === 'menu' && !this.net) this.showMenu();
    });

    this.showMenu();
    // ¿Se abrió desde el servidor de red local? Entonces se ofrece la conexión por IP.
    void lanInfo().then((info) => {
      this.lan = info;
      if (info && new URLSearchParams(location.search).has('join')) {
        history.replaceState(null, '', location.pathname);
        void this.joinGame('ip', location.host);
      }
    });
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

  /** Controles del jugador de este dispositivo: teclado o controles táctiles. */
  private localInput(players: number): DriveInput {
    return this.touch.apply(this.input.drive(0, players));
  }

  private tick(dt: number, render = true): void {
    const playing = this.state === 'playing' && !!this.level;
    const guest = this.state === 'guest' && !!this.net?.view && this.net.playing && !this.screens.visible;
    // Durante la partida se oculta el cursor; en celular aparecen los controles táctiles.
    document.body.classList.toggle('in-game', playing || guest);
    // Caído o capturado esperando reaparecer: sin controles, solo se mira al compañero.
    const waiting = playing && this.level ? this.level.respawnLeft(this.level.players[0]) !== null : guest ? this.net!.view!.hud.players[1]?.respawn != null : false;
    this.touch.show(IS_TOUCH && (playing || guest) && !waiting);
    const typing = this.state === 'online' || (this.state === 'menu' && this.screens.visible);
    if (this.input.wasPressed('KeyM') && !typing) this.toggleMute();
    if (this.input.wasPressed('KeyN') && !typing) this.toggleMusic();
    if (this.input.wasPressed('Minus', 'NumpadSubtract')) this.setVolume('music', this.storage.data.volumes.music - 0.1, true);
    if (this.input.wasPressed('Equal', 'NumpadAdd')) this.setVolume('music', this.storage.data.volumes.music + 0.1, true);

    if (playing && this.level) {
      if (this.input.wasPressed('Escape', 'KeyP') || this.touch.consumePause()) {
        this.pause();
      } else {
        const online = this.net?.role === 'host';
        const inputs = online
          ? [this.localInput(1), this.net!.remote]
          : [this.localInput(this.campaign.players), this.input.drive(1, this.campaign.players)];
        this.level.update(dt, inputs);
        this.audio.musicIntensity(this.level.musicIntensity);
        // Cuando caen todos los vehículos, el metal se corta y entra el réquiem.
        if (this.level.outcome === 'failed') this.audio.playMusic('death');
        // En el nivel infinito la música cambia de estilo con cada zona.
        else this.audio.playMusic('level', this.level.musicStyle);
        this.net?.sync?.tick(dt, this.level, this.level.musicIntensity);
        this.hud.update(hudState(this.level));
        if (this.level.state === 'done') this.onLevelDone();
      }
    } else if (guest) {
      this.updateGuest(dt);
    } else {
      this.touch.consumePause();
      this.screens.handleKeys(this.input);
    }

    const view = this.net?.view;
    if (this.level) {
      this.level.updateCamera(this.camera, this.state === 'playing' ? dt : 0);
      if (render) this.renderer.render(this.level.scene, this.camera);
    } else if (view) {
      view.update(dt, this.camera, 1);
      if (render) this.renderer.render(view.scene, this.camera);
    } else if (render) {
      this.renderer.clear();
    }
    this.updateMates(playing, guest, waiting);
    this.input.endFrame();
  }

  /** Indicadores en el borde de la pantalla para el compañero que quedó fuera de cámara. */
  private updateMates(playing: boolean, guest: boolean, waiting: boolean): void {
    const me = playing ? 0 : 1;
    if (waiting) {
      this.offscreen.hide();
      return;
    }
    let mates: Mate[] = [];
    let mine: { x: number; z: number } | null = null;
    if (playing && this.level && this.level.players.length > 1) {
      mates = this.level.players.map((p) => ({ index: p.index, x: p.vehicle.px, z: p.vehicle.pz, vehicle: p.def.id, alive: p.alive && !p.dropped }));
      const own = this.level.players[me];
      mine = { x: own.vehicle.px, z: own.vehicle.pz };
    } else if (guest && this.net?.view) {
      const view = this.net.view;
      mates = view.players.map((p, i) => ({ index: i, x: p.px, z: p.pz, vehicle: view.hud.players[i]?.vehicle ?? 'moto', alive: p.alive }));
      const own = view.players[me];
      mine = own ? { x: own.px, z: own.pz } : null;
    }
    mates = mates.filter((m) => m.index !== me);
    if (mates.length) this.offscreen.update(this.camera, mates, mine);
    else this.offscreen.hide();
  }

  // ------------------------------------------------------------ pantallas

  private showMenu(): void {
    // En una partida en línea, "volver al menú" es volver a la sala.
    if (this.net) {
      if (this.net.role === 'host') this.showRoom();
      else this.guestWait(this.net.waitText || 'Esperando al anfitrión…');
      return;
    }
    this.state = 'menu';
    this.loadToken++;
    this.disposeLevel();
    this.hud.hide();
    this.audio.duckMusic(false);
    this.audio.playMusic('calm');
    this.screens.menu(this.storage.data, {
      play: () => this.newCampaign(),
      select: () => this.screens.levelSelect(this.storage.data, (l) => this.startFrom(l), () => this.showMenu()),
      online: () => this.showOnline(),
      garage: () => this.showGarage(() => this.showMenu()),
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
      install: this.installPrompt
        ? () => {
            const prompt = this.installPrompt;
            this.installPrompt = null;
            void prompt?.prompt().finally(() => this.showMenu());
          }
        : undefined,
    });
  }

  /** Garaje: el vehículo elegido se guarda (y en línea se avisa al anfitrión). */
  private showGarage(back: () => void): void {
    if (this.net) {
      this.net.inRoom = false;
      this.net.inGarage = true;
    }
    this.screens.garage(
      this.storage.data,
      (id) => {
        this.storage.data.vehicles[0] = id;
        this.storage.save();
        this.audio.unlock();
        this.audio.blip(760);
        if (this.net?.role === 'guest') this.net.link.send({ t: 'vehicle', vehicle: id });
      },
      () => {
        if (this.net) this.net.inGarage = false;
        back();
      },
    );
  }

  /** Vehículos elegidos (si uno quedó bloqueado, por ejemplo al borrar el progreso, se usa la moto). */
  private chosenVehicles(): VehicleDef[] {
    return this.storage.data.vehicles.map((id) => {
      const def = vehicleById(id);
      return isUnlocked(def, this.storage.data) ? def : VEHICLES[0];
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
      if (this.state === 'playing' || this.state === 'guest') this.hud.toast(`Música: ${Math.round(vol * 100)}%`, '#cccccc', 0.8);
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

  /** Jugadores de la próxima partida: 2 si hay un invitado conectado. */
  private get playerCount(): number {
    return this.net?.role === 'host' && this.net.peer && this.net.link.connected ? 2 : 1;
  }

  private newCampaign(): void {
    enterFullscreen();
    this.campaign = { players: this.playerCount, level: 0, profile: null, cash: 0, score: 0, config: null };
    this.showIntro();
  }

  private startFrom(level: number): void {
    enterFullscreen();
    this.campaign = { players: this.playerCount, level, profile: this.storage.data.profile, cash: level > 0 ? LOOT : 0, score: 0, config: null };
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
    this.campaign.players = this.playerCount;
    if (this.net) this.net.inRoom = false;
    this.state = 'intro';
    this.disposeLevel();
    this.hud.hide();
    const cfg = this.configFor(this.campaign.level);
    this.campaign.config = cfg;
    this.audio.playMusic('epic');
    this.screens.intro(
      cfg,
      this.chosenVehicles()[0].id,
      () => this.beginLevel(),
      () => this.showMenu(),
    );
  }

  /**
   * Arranca el nivel tras la pantalla de carga: se muestra la llanta, se
   * construye el mundo y se compilan los shaders antes de soltar el control.
   * En línea, el anfitrión además graba el nivel para enviárselo al invitado.
   */
  private beginLevel(): void {
    this.campaign.players = this.playerCount;
    const cfg = this.configFor(this.campaign.level);
    this.campaign.config = cfg;
    this.disposeLevel();
    this.screens.hide();
    this.hud.hide();
    this.audio.unlock();
    this.audio.stopLoops();
    this.state = 'loading';
    const token = ++this.loadToken;
    const started = performance.now();
    const label = cfg.index === 0 ? 'Prólogo' : cfg.index === 4 ? 'Nivel infinito' : `Nivel ${cfg.index}`;
    this.loader.show(`Preparando ${label}`);
    const net = this.net?.role === 'host' ? this.net : null;
    const online = this.campaign.players > 1 && !!net;
    if (net) {
      net.inRoom = false;
      net.sync = online ? new HostSync(net.link) : null;
      if (online) net.link.send({ t: 'begin', label });
    }
    // Dos cuadros de espera para que la llanta aparezca antes del trabajo pesado.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (token !== this.loadToken) return;
        const sync = net?.sync ?? null;
        let hooks: LevelHooks = { message: (t, c, s) => this.hud.toast(t, c, s), flash: (c) => this.hud.flash(c) };
        if (sync) hooks = sync.wrapHooks(hooks);
        const vehicles = online ? [this.chosenVehicles()[0], vehicleById(net!.peer ?? 'moto')] : this.chosenVehicles();
        const level = new Level(cfg, this.campaign.players, sync ? sync.wrapAudio(this.audio) : this.audio, hooks, this.classifier, vehicles);
        sync?.attach(level);
        this.level = level;
        level.updateCamera(this.camera, 0);
        this.renderer.compile(level.scene, this.camera);
        window.setTimeout(
          () => {
            if (token !== this.loadToken || this.level !== level) return;
            if (online && !net!.peer) level.dropPlayer(1);
            sync?.init(level, this.campaign.cash);
            this.loader.hide();
            this.hud.show(hudState(level), this.campaign.cash);
            this.audio.duckMusic(false);
            this.audio.playMusic('level', level.musicStyle);
            this.state = 'playing';
            this.last = performance.now();
          },
          Math.max(0, MIN_LOADING_MS - (performance.now() - started)),
        );
      }),
    );
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
    if (this.net?.role === 'host') {
      this.net.link.send({ t: 'end' });
      this.net.sync = null;
    }
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

  // ------------------------------------------------------------ en línea

  private newNet(role: 'host' | 'guest', link: Link): Net {
    return {
      role,
      link,
      peer: null,
      remote: idleInput(),
      sync: null,
      addresses: [],
      inRoom: false,
      view: null,
      playing: false,
      inGarage: false,
      waitText: '',
      lastInput: '',
      inputTimer: 0,
    };
  }

  private showOnline(): void {
    this.state = 'online';
    this.screens.online(
      { lan: this.lan, secure: location.protocol === 'https:', camera: QrScanner.available },
      {
        hostCode: () => void this.hostGame('code'),
        hostIp: () => void this.hostGame('ip'),
        hostQr: () => void this.hostQr(),
        joinCode: (code) => void this.joinGame('code', code),
        joinIp: (address) => void this.joinGame('ip', address),
        joinQr: () => this.joinQr(),
        back: () => this.showMenu(),
      },
    );
  }

  /** Sale de la partida en línea y vuelve al menú principal. */
  private leaveOnline(): void {
    this.stopScanner();
    const net = this.net;
    this.net = null;
    if (net) {
      if (net.role === 'host') net.link.send({ t: 'bye', text: 'El anfitrión cerró la partida.' });
      net.link.close();
      net.view?.dispose();
    }
    this.loadToken++;
    this.loader.hide();
    this.audio.stopLoops();
    this.showMenu();
  }

  // ------------------------------------------------------------ hotspot sin internet (QR)

  private stopScanner(): void {
    this.scanner?.stop();
    this.scanner = null;
  }

  /** Abre la cámara en la pantalla actual y entrega el primer código del tipo pedido. */
  private scanQr(kind: 'O' | 'A', onText: (text: string) => void, stream?: MediaStream | null): void {
    const video = this.screens.qrVideo();
    if (!video || !QrScanner.available) return;
    this.stopScanner();
    const scanner = new QrScanner();
    this.scanner = scanner;
    scanner.start(video, (t) => qrKind(t) === kind, onText, stream).catch(() => {
      // Sin permiso o sin cámara: queda la opción de pegar el código como texto.
      if (this.scanner === scanner) this.screens.openQrManual();
    });
  }

  /**
   * Anfitrión por hotspot: muestra su QR, escanea el del invitado y queda
   * conectado directo por la red local, sin internet ni servidores.
   */
  private async hostQr(): Promise<void> {
    enterFullscreen();
    this.audio.unlock();
    const link = new QrLink();
    const net = this.newNet('host', link);
    this.net = net;
    this.state = 'online';
    link.onMessage = (m) => this.hostMessage(m);
    link.onPeerLeft = () => this.guestLeft();
    const title = 'Hotspot · crear partida';
    const first = 'Activa el hotspot de este teléfono (no hace falta tener datos) y conecta el otro teléfono a él. También sirve un mismo Wi-Fi.';
    this.screens.qrStep({ title, steps: [first], status: 'Preparando el código… (permite el uso de la cámara)' }, { paste: () => {}, leave: () => this.leaveOnline() });
    let offer: string;
    let image: string;
    // Con permiso de cámara el navegador usa las direcciones reales de la red local.
    const warm = await QrScanner.warmup();
    try {
      offer = await link.offer();
      image = await qrImage(offer);
    } catch (e) {
      warm?.getTracks().forEach((t) => t.stop());
      if (this.net !== net) return;
      this.net = null;
      link.close();
      this.screens.netError(errorText(e), () => this.showOnline());
      return;
    }
    warm?.getTracks().forEach((t) => t.stop());
    if (this.net !== net) return;

    const accept = async (answer: string) => {
      if (this.net !== net) return;
      this.stopScanner();
      this.screens.netStatus(title, 'Conectando con el otro teléfono…', { leave: () => this.leaveOnline() });
      try {
        await link.accept(answer);
      } catch (e) {
        if (this.net !== net) return;
        this.net = null;
        link.close();
        this.screens.netError(errorText(e), () => this.showOnline());
        return;
      }
      if (this.net === net) this.showRoom();
    };
    const showCode = () =>
      this.screens.qrStep(
        { title, steps: [first, 'En el otro teléfono: EN LÍNEA › UNIRSE CON QR y escanea este código.', 'Después toca ESCANEAR LA RESPUESTA y escanea el código que aparece en su pantalla.'], qr: image, text: offer },
        { scan: () => showScanner(), paste: (t) => void accept(t), leave: () => this.leaveOnline() },
      );
    const showScanner = () => {
      this.screens.qrStep(
        { title, steps: ['Apunta la cámara al código QR que muestra el otro teléfono.'], video: true, text: offer },
        { paste: (t) => void accept(t), leave: () => this.leaveOnline() },
      );
      this.scanQr('A', (t) => void accept(t));
    };
    showCode();
  }

  /** Invitado por hotspot: escanea el QR del anfitrión y le muestra el suyo. */
  private joinQr(): void {
    enterFullscreen();
    this.audio.unlock();
    const link = new QrLink();
    const net = this.newNet('guest', link);
    this.net = net;
    this.state = 'guest';
    link.onMessage = (m) => this.guestMessage(m);
    const title = 'Hotspot · unirse';
    let busy = false;
    const useOffer = async (offer: string) => {
      if (this.net !== net || busy) return;
      busy = true;
      this.stopScanner();
      this.screens.netStatus(title, 'Preparando tu código…', { leave: () => this.leaveOnline() });
      let answer: string;
      let image: string;
      // La cámara se mantiene un momento abierta para que la conexión use las direcciones reales de la red.
      const warm = await QrScanner.warmup();
      try {
        answer = await link.answer(offer);
        image = await qrImage(answer);
      } catch (e) {
        warm?.getTracks().forEach((t) => t.stop());
        if (this.net !== net) return;
        this.net = null;
        link.close();
        this.screens.netError(errorText(e), () => this.showOnline());
        return;
      }
      warm?.getTracks().forEach((t) => t.stop());
      if (this.net !== net) return;
      this.screens.qrStep(
        { title, steps: ['Muéstrale este código al anfitrión: debe tocar ESCANEAR LA RESPUESTA y apuntar su cámara aquí.'], qr: image, text: answer, status: 'Esperando la conexión…' },
        { paste: () => {}, leave: () => this.leaveOnline() },
      );
      try {
        await link.waitOpen();
      } catch (e) {
        if (this.net !== net) return;
        this.net = null;
        link.close();
        this.screens.netError(errorText(e), () => this.showOnline());
        return;
      }
      if (this.net !== net) return;
      link.onPeerLeft = (reason) => this.hostLost(reason);
      link.onError = (text) => this.hostLost(text);
      link.send({ t: 'hello', v: PROTOCOL, vehicle: this.chosenVehicles()[0].id });
      this.guestWait('Conectado por hotspot. Esperando a que el anfitrión elija el nivel…');
    };
    this.screens.qrStep(
      { title, steps: ['Conecta este teléfono al hotspot (o al Wi-Fi) del anfitrión.', 'En el teléfono del anfitrión: EN LÍNEA › CREAR CON QR.', 'Apunta la cámara a su código QR.'], video: QrScanner.available },
      { paste: (t) => void useOffer(t), leave: () => this.leaveOnline() },
    );
    this.scanQr('O', (t) => void useOffer(t));
  }

  /** Crea una partida: por código (WebRTC) o por IP (servidor de red local). */
  private async hostGame(kind: 'code' | 'ip'): Promise<void> {
    enterFullscreen();
    this.audio.unlock();
    const link = kind === 'code' ? new PeerLink() : new WsLink(location.host, 'host');
    const net = this.newNet('host', link);
    this.net = net;
    this.state = 'online';
    this.screens.netStatus('Creando la partida', 'Preparando la sala…', { leave: () => this.leaveOnline() });
    try {
      if (link instanceof PeerLink) await link.host();
      else await (link as WsLink).open();
    } catch (e) {
      if (this.net !== net) return;
      this.net = null;
      link.close();
      this.screens.netError(errorText(e), () => this.showOnline());
      return;
    }
    if (this.net !== net) {
      link.close();
      return;
    }
    if (kind === 'ip' && this.lan) net.addresses = this.lan.ips.map((ip) => `http://${ip}:${this.lan!.port}`);
    link.onMessage = (m) => this.hostMessage(m);
    link.onPeerLeft = () => this.guestLeft();
    link.onError = (text) => {
      if (this.state === 'playing') this.hud.toast(text, '#ff7a45', 3);
    };
    this.showRoom();
  }

  /** Sala del anfitrión. */
  private showRoom(): void {
    const net = this.net!;
    this.state = 'online';
    this.loadToken++;
    this.disposeLevel();
    this.hud.hide();
    this.audio.duckMusic(false);
    this.audio.playMusic('calm');
    net.inRoom = true;
    net.inGarage = false;
    this.screens.room(
      {
        kind: net.link.kind,
        code: net.link instanceof PeerLink ? net.link.code : '',
        addresses: net.addresses,
        guest: net.peer && net.link.connected ? vehicleById(net.peer).name : null,
        vehicle: this.chosenVehicles()[0].name,
      },
      {
        play: () => {
          net.inRoom = false;
          this.screens.levelSelect(this.storage.data, (l) => this.startFrom(l), () => this.showRoom());
        },
        garage: () => this.showGarage(() => this.showRoom()),
        leave: () => this.leaveOnline(),
      },
    );
    net.link.send({ t: 'lobby', text: 'El anfitrión está eligiendo el nivel…' });
  }

  private hostMessage(m: NetMessage): void {
    const net = this.net;
    if (!net || net.role !== 'host') return;
    switch (m.t) {
      case 'hello':
        if (m.v !== PROTOCOL) {
          net.link.send({ t: 'bye', text: 'El anfitrión tiene otra versión del juego: actualicen ambos.' });
          return;
        }
        net.peer = vehicleById(String(m.vehicle)).id;
        net.link.send({ t: 'welcome', v: PROTOCOL });
        if (net.inRoom || this.state === 'online') {
          this.screens.roomGuest(vehicleById(net.peer).name);
          net.link.send({ t: 'lobby', text: 'El anfitrión está eligiendo el nivel…' });
        } else {
          net.link.send({ t: 'lobby', text: 'La partida ya empezó: entrarás en el próximo nivel.' });
          if (this.state === 'playing') this.hud.toast('El jugador 2 se conectó: entra en el próximo nivel', '#4cd37b', 3);
        }
        break;
      case 'vehicle':
        net.peer = vehicleById(String(m.vehicle)).id;
        if (net.inRoom) this.screens.roomGuest(vehicleById(net.peer).name);
        break;
      case 'input':
        if (Array.isArray(m.i) && m.i.length === 8) net.remote = this.cleanInput(m.i);
        break;
      case 'pause':
        if (this.state === 'playing' && this.level && this.level.players.length > 1) this.pause();
        break;
    }
  }

  /** Controles recibidos del invitado, acotados a valores válidos. */
  private cleanInput(i: PackedInput): DriveInput {
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
    const d = unpackInput(i);
    return {
      throttle: num(d.throttle, 0, 1),
      brake: num(d.brake, 0, 1),
      steer: num(d.steer, -1, 1),
      turbo: d.turbo === true,
      shoot: d.shoot === true,
      aim: d.aim && Number.isFinite(d.aim.x) && Number.isFinite(d.aim.z) ? { x: d.aim.x, z: d.aim.z } : null,
      dir: typeof d.dir === 'number' && Number.isFinite(d.dir) ? d.dir : null,
    };
  }

  private guestLeft(): void {
    const net = this.net;
    if (!net || net.role !== 'host') return;
    net.peer = null;
    net.remote = idleInput();
    if (this.level && this.level.players.length > 1) {
      this.level.dropPlayer(1);
      this.hud.toast('El jugador 2 se desconectó', '#ff7a45', 3);
    }
    if (net.inRoom) this.screens.roomGuest(null);
  }

  /** Reenvía al invitado las pantallas de historia, pausa y resultados. */
  private mirrorScreen(html: string, variant: string): void {
    const net = this.net;
    if (net?.role !== 'host' || !net.link.connected || !MIRRORED.includes(this.state)) return;
    net.link.send({ t: 'screen', html, variant });
  }

  /** Se une a una partida por código o por IP. */
  private async joinGame(kind: 'code' | 'ip', value: string): Promise<void> {
    enterFullscreen();
    this.audio.unlock();
    let target = value.trim();
    if (kind === 'ip') {
      target = lanAddress(target, this.lan?.port ?? 8080);
      if (!target) {
        this.screens.netError('Escribe la IP del anfitrión, por ejemplo 192.168.43.1:8080.', () => this.showOnline());
        return;
      }
      // Desde una página segura (https) el navegador no permite conectar por IP: se abre el juego del anfitrión.
      if (location.protocol === 'https:') {
        location.href = `http://${target}/?join=1`;
        return;
      }
    } else if (!target) {
      this.screens.netError('Escribe el código de la sala.', () => this.showOnline());
      return;
    }
    const link = kind === 'code' ? new PeerLink() : new WsLink(target, 'guest');
    const net = this.newNet('guest', link);
    this.net = net;
    this.state = 'guest';
    link.onMessage = (m) => this.guestMessage(m);
    this.screens.netStatus('Uniéndose', kind === 'code' ? `Buscando la sala ${target.toUpperCase()}…` : `Conectando con ${target}…`, { leave: () => this.leaveOnline() });
    try {
      if (link instanceof PeerLink) await link.join(target);
      else await (link as WsLink).open();
    } catch (e) {
      if (this.net !== net) return;
      this.net = null;
      link.close();
      this.screens.netError(errorText(e), () => this.showOnline());
      return;
    }
    if (this.net !== net) {
      link.close();
      return;
    }
    link.onPeerLeft = (reason) => this.hostLost(reason);
    link.onError = (text) => this.hostLost(text);
    link.send({ t: 'hello', v: PROTOCOL, vehicle: this.chosenVehicles()[0].id });
    this.guestWait('Conectado. Esperando a que el anfitrión elija el nivel…');
  }

  /** Invitado: pantalla de espera entre niveles. */
  private guestWait(text: string): void {
    const net = this.net!;
    net.waitText = text;
    net.playing = false;
    net.inGarage = false;
    this.state = 'guest';
    this.hud.hide();
    this.audio.stopLoops();
    this.screens.netStatus('Partida en línea', text, {
      leave: () => this.leaveOnline(),
      garage: () => this.showGarage(() => this.guestWait(net.waitText)),
    });
  }

  /** Invitado: se perdió la conexión con el anfitrión. */
  private hostLost(text: string): void {
    const net = this.net;
    if (!net || net.role !== 'guest') return;
    this.stopScanner();
    this.net = null;
    net.link.close();
    net.view?.dispose();
    this.loader.hide();
    this.hud.hide();
    this.audio.stopLoops();
    this.state = 'menu';
    this.screens.netError(text, () => this.showMenu());
  }

  private guestMessage(m: NetMessage): void {
    const net = this.net;
    if (!net || net.role !== 'guest') return;
    switch (m.t) {
      case 'welcome':
        if (m.v !== PROTOCOL) this.hostLost('El anfitrión tiene otra versión del juego: actualicen ambos.');
        break;
      case 'lobby':
        // El anfitrión volvió a la sala (también al salir desde la pausa): termina el nivel en curso.
        net.waitText = String(m.text);
        if (!net.inGarage) {
          net.view?.dispose();
          net.view = null;
          this.guestWait(net.waitText);
        }
        break;
      case 'screen':
        net.inGarage = false;
        this.state = 'guest';
        if (m.variant !== 'pause') {
          net.playing = false;
          this.hud.hide();
          this.audio.stopLoops();
        }
        this.screens.mirror(String(m.html), String(m.variant), () => this.leaveOnline());
        break;
      case 'music':
        if (MUSIC_MODES.has(m.mode)) this.audio.playMusic(m.mode, Number(m.level) || 0);
        break;
      case 'begin':
        net.view?.dispose();
        net.view = null;
        net.playing = false;
        net.inGarage = false;
        this.state = 'guest';
        this.screens.hide();
        this.hud.hide();
        this.loader.show(`Preparando ${String(m.label).slice(0, 40)}`);
        break;
      case 'init':
        net.view?.dispose();
        try {
          net.view = new GuestView(m.scene, m.hud, this.audio, Level.shadowSize);
        } catch {
          this.hostLost('No se pudo recibir la partida del anfitrión.');
          return;
        }
        this.hud.show(net.view.hud, Number(m.baseCash) || 0, 1);
        this.loader.hide();
        this.screens.hide();
        this.audio.duckMusic(false);
        net.playing = true;
        net.inputTimer = 0;
        this.state = 'guest';
        break;
      case 'frame':
        if (!net.view) return;
        try {
          net.view.apply(m);
        } catch (err) {
          console.warn('Cuadro inválido del anfitrión', err);
          return;
        }
        for (const [text, color, seconds] of m.msg ?? []) this.hud.toast(String(text), safeColor(color), Number(seconds) || 1.8);
        for (const c of m.flash ?? []) {
          const color = safeColor(c);
          if (color) this.hud.flash(color);
        }
        // Al reanudar tras una pausa vuelven a llegar cuadros: se quita la pantalla.
        if (net.playing && this.screens.visible && !net.inGarage) this.screens.hide();
        break;
      case 'end':
        net.playing = false;
        this.hud.hide();
        this.audio.stopLoops();
        break;
      case 'bye':
        this.hostLost(String(m.text));
        break;
    }
  }

  /** Invitado jugando: envía sus controles y muestra lo que llega del anfitrión. */
  private updateGuest(dt: number): void {
    const net = this.net!;
    const view = net.view!;
    if (this.input.wasPressed('Escape', 'KeyP') || this.touch.consumePause()) net.link.send({ t: 'pause' });
    const packed = packInput(this.localInput(1));
    const key = packed.join(',');
    net.inputTimer -= dt;
    // Se envía al cambiar y, además, 10 veces por segundo por si se perdió alguno.
    if (key !== net.lastInput || net.inputTimer <= 0) {
      net.link.send({ t: 'input', i: packed });
      net.lastInput = key;
      net.inputTimer = 0.1;
    }
    this.audio.engine(view.engine[0], view.engine[1], view.engine[2]);
    this.audio.siren(view.siren, dt);
    this.audio.musicIntensity(view.intensity);
    this.hud.update(view.hud);
  }
}
