import { formatMoney } from '../core/math';
import { PLAYER_COLORS } from '../entities/Player';
import { esc } from './html';
import type { FinishScene } from '../config/types';
import type { Level } from '../world/Level';

/** Datos de un jugador que muestra el HUD. */
export interface HudPlayer {
  index: number;
  name: string;
  /** Identificador del vehículo (para su foto en el indicador fuera de pantalla). */
  vehicle: string;
  hp: number;
  maxHp: number;
  turbo: number;
  turboActive: boolean;
  alive: boolean;
  ammo: number;
  maxAmmo: number;
  /** Velocidad en m/s. */
  speed: number;
  flash: number;
  /** Fuera de la carrera esperando reaparecer: destruido o capturado. */
  down: 'dead' | 'captured' | null;
  /** Segundos para reaparecer (null si no está esperando). */
  respawn: number | null;
}

/**
 * Todo lo que el HUD necesita de una partida. En la partida local sale del
 * nivel; en línea, el invitado lo recibe del anfitrión en cada cuadro.
 */
export interface HudState {
  levelIndex: number;
  levelName: string;
  subtitle: string;
  finish: FinishScene | 'none';
  zone: { index: number; name: string; progress: number } | null;
  maxD: number;
  remainingDistance: number;
  progress: number;
  aiProgress: number;
  skill: number | null;
  tier: string | null;
  calibrating: boolean;
  stormGap: number | null;
  state: string;
  cashLost: number;
  activePursuers: number;
  heli: boolean;
  score: number;
  countdown: number;
  elapsed: number;
  players: HudPlayer[];
  /** Punto al que apunta la flecha de la meta (null si no hay meta o ya se llegó). */
  goal: { x: number; z: number; near: boolean } | null;
}

/** Estado del HUD a partir del nivel en curso. */
export function hudState(level: Level): HudState {
  const cfg = level.config;
  const prof = level.liveProfile;
  return {
    levelIndex: cfg.index,
    levelName: cfg.name,
    subtitle: cfg.subtitle,
    finish: cfg.finish,
    zone: level.zoneInfo,
    maxD: level.maxD,
    remainingDistance: level.remainingDistance,
    progress: level.progress,
    aiProgress: level.aiProgress,
    skill: prof ? prof.skill : null,
    tier: prof ? prof.tier : null,
    calibrating: level.calibrating,
    stormGap: level.stormGap,
    state: level.state,
    cashLost: level.cashLost,
    activePursuers: level.activePursuers,
    heli: !!level.heli?.chasing,
    score: level.score,
    countdown: level.countdown,
    elapsed: level.elapsed,
    goal: level.goalPoint,
    players: level.players.map((p) => ({
      index: p.index,
      name: p.def.name,
      vehicle: p.def.id,
      hp: p.hp,
      maxHp: p.maxHp,
      turbo: p.turbo,
      turboActive: p.turboActive,
      alive: p.alive,
      ammo: p.ammo,
      maxAmmo: p.maxAmmo,
      speed: p.vehicle.speed,
      flash: p.flash,
      down: level.respawnLeft(p) !== null ? (p.captured ? 'captured' : 'dead') : null,
      respawn: level.respawnLeft(p),
    })),
  };
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

/** Interfaz durante el juego: cronómetro, vida, turbo, policía y panel de la IA. */
export class Hud {
  private root = $('#hud');
  private levelName = $('#hud-level-name');
  private objective = $('#hud-objective');
  private timerLabel = $('#hud-timer-label');
  private timer = $('#hud-timer');
  private cash = $('#hud-cash');
  private score = $('#hud-score');
  private wanted = $('#hud-wanted');
  private ai = $('#hud-ai');
  private aiBar = $('#hud-ai-bar');
  private aiSkill = $('#hud-ai-skill');
  private aiTier = $('#hud-ai-tier');
  private storm = $('#hud-storm');
  private players = $('#hud-players');
  private toasts = $('#hud-toasts');
  private countdown = $('#hud-countdown');
  private stormOverlay = $('#storm-overlay');
  private damageOverlay = $('#damage-overlay');
  private flashOverlay = $('#flash-overlay');
  private progressBar = $('#hud-progress-bar');
  private spectateTitle = $('#hud-spectate .spec-title');
  private spectateCount = $('#hud-spectate .spec-count');
  private spectateDist = $('#hud-spectate .spec-dist');
  /** Jugador de este dispositivo. */
  private me = 0;
  private cache = new Map<HTMLElement, string>();

  /** `me`: índice del jugador de este dispositivo (en línea, su tarjeta se marca como "TÚ"). */
  show(level: HudState, baseCash: number, me = 0): void {
    this.root.classList.remove('hidden');
    this.root.classList.remove('spectating');
    this.me = me;
    this.levelName.textContent = level.levelName;
    this.objective.textContent = level.subtitle;
    this.ai.classList.remove('hidden');
    this.storm.classList.toggle('hidden', level.levelIndex !== 0);
    this.cash.classList.toggle('hidden', level.levelIndex === 0);
    this.wanted.classList.toggle('hidden', level.levelIndex === 0);
    const many = level.players.length > 1;
    this.players.innerHTML = level.players
      .map(
        (p) => `
      <div class="pcard" style="--pc:${PLAYER_COLORS[p.index].css}">
        <div class="pcard-title">${many ? `${p.index === me ? 'TÚ' : `J${p.index + 1}`} · ` : ''}${esc(p.name)}</div>
        <div class="bar"><div class="fill hp" data-hp="${p.index}"></div></div>
        <div class="bar small"><div class="fill turbo" data-turbo="${p.index}"></div></div>
        <div class="pcard-speed"><span data-speed="${p.index}">0</span> km/h <span class="pcard-ammo" data-ammo-box="${p.index}">BALAS <b data-ammo="${p.index}">0</b></span></div>
      </div>`,
      )
      .join('');
    this.toasts.innerHTML = '';
    this.baseCash = baseCash;
    this.cache.clear();
  }

  private baseCash = 0;

  hide(): void {
    this.root.classList.add('hidden');
    this.root.classList.remove('spectating');
    this.stormOverlay.style.opacity = '0';
    this.damageOverlay.style.opacity = '0';
  }

  private set(el: HTMLElement, text: string): void {
    if (this.cache.get(el) === text) return;
    this.cache.set(el, text);
    el.textContent = text;
  }

  /** Este jugador está fuera de la carrera esperando reaparecer (en pantalla queda solo la cuenta regresiva). */
  spectating(level: HudState): boolean {
    return level.players[this.me]?.respawn != null;
  }

  update(level: HudState): void {
    // Caído o capturado: se oculta todo menos la distancia recorrida y la cuenta regresiva.
    const own = level.players[this.me];
    const waiting = own?.respawn != null;
    this.root.classList.toggle('spectating', waiting);
    if (waiting && own) {
      this.set(this.spectateTitle, own.down === 'captured' ? 'TE CAPTURARON' : 'VEHÍCULO DESTRUIDO');
      this.set(this.spectateCount, String(Math.max(1, Math.ceil(own.respawn ?? 0))));
      this.set(this.spectateDist, `Recorrido: ${level.maxD >= 1000 ? `${(level.maxD / 1000).toFixed(2)} km` : `${Math.round(level.maxD)} m`}`);
      this.damageOverlay.style.opacity = '0';
      return;
    }
    const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
    const zone = level.zone;
    if (level.finish === 'none') {
      // Nivel infinito: distancia recorrida y avance dentro de la zona.
      this.set(this.timerLabel, zone ? `ZONA ${zone.index} · ${zone.name.toUpperCase()}` : 'RECORRIDO');
      this.set(this.timer, km(level.maxD));
      this.progressBar.style.width = `${Math.round((zone?.progress ?? 0) * 100)}%`;
    } else {
      // Meta por distancia
      const goal = { bank: 'BANCO', tunnel: 'TÚNEL', plant: 'PLANTA', safeZone: 'ZONA SEGURA' }[level.finish];
      this.set(this.timerLabel, `${goal} EN`);
      const left = level.remainingDistance;
      this.set(this.timer, km(left));
      this.timer.classList.toggle('urgent', left < 150);
      this.progressBar.style.width = `${Math.round(level.progress * 100)}%`;
    }

    // El Analista: calibración y veredicto
    this.aiBar.style.width = `${Math.round(level.aiProgress * 100)}%`;
    const skill = level.skill;
    this.set(this.aiSkill, skill !== null ? `${Math.round(skill * 100)}%` : '—');
    const calibrating = level.calibrating;
    this.set(this.aiTier, skill === null || (calibrating && level.aiProgress < 0.35) ? 'Calibrando…' : calibrating ? `${level.tier}?` : `${level.tier} · ajuste aplicado`);

    if (level.levelIndex === 0) {
      const gap = level.stormGap;
      if (gap !== null) {
        this.set(this.storm, gap > 0 ? `Tormenta a ${Math.round(gap)} m` : '¡DENTRO DE LA TORMENTA!');
        this.storm.classList.toggle('danger', gap < 20);
        const stormAlpha = level.state === 'running' ? Math.max(0, Math.min(0.75, (12 - gap) / 25)) : 0;
        this.stormOverlay.style.opacity = String(stormAlpha);
      }
    } else {
      this.set(this.cash, formatMoney(this.baseCash - level.cashLost));
      const stars = Math.min(5, Math.ceil(level.activePursuers / 1.5) + (level.heli ? 1 : 0));
      this.set(this.wanted, '★'.repeat(stars) + '☆'.repeat(5 - stars));
    }
    this.set(this.score, `${Math.round(level.score).toLocaleString('es-CO')} pts`);

    let flash = 0;
    for (const p of level.players) {
      const hp = this.players.querySelector<HTMLElement>(`[data-hp="${p.index}"]`);
      const tb = this.players.querySelector<HTMLElement>(`[data-turbo="${p.index}"]`);
      const sp = this.players.querySelector<HTMLElement>(`[data-speed="${p.index}"]`);
      const am = this.players.querySelector<HTMLElement>(`[data-ammo="${p.index}"]`);
      if (am) {
        this.set(am, `${p.ammo}/${p.maxAmmo}`);
        am.parentElement?.classList.toggle('low', p.ammo < 6);
      }
      if (hp) {
        hp.style.width = `${(p.hp / p.maxHp) * 100}%`;
        hp.classList.toggle('low', p.hp < p.maxHp * 0.3);
      }
      if (tb) {
        tb.style.width = `${p.turbo * 100}%`;
        tb.classList.toggle('active', p.turboActive);
      }
      // Escala visual: la moto con turbo ≈ 220 km/h; el deportivo pasa de 270.
      if (sp) this.set(sp, p.alive ? String(Math.round(Math.abs(p.speed) * 4.6)) : 'KO');
      flash = Math.max(flash, p.flash * 2);
    }
    this.damageOverlay.style.opacity = String(Math.min(0.6, flash));

    if (level.state === 'countdown') {
      this.countdown.classList.remove('hidden');
      this.set(this.countdown, String(Math.max(1, Math.ceil(level.countdown))));
    } else if (level.elapsed < 0.8) {
      this.set(this.countdown, '¡YA!');
    } else {
      this.countdown.classList.add('hidden');
    }
  }

  /** Destello de pantalla completa que se desvanece. */
  flash(color: string): void {
    const el = this.flashOverlay;
    el.style.transition = 'none';
    el.style.background = color;
    el.style.opacity = '0.85';
    void el.offsetWidth;
    el.style.transition = 'opacity 1.4s ease-out';
    el.style.opacity = '0';
  }

  toast(text: string, color = '#ffffff', seconds = 1.8): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.color = color;
    el.textContent = text;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    setTimeout(() => el.classList.add('out'), seconds * 1000);
    setTimeout(() => el.remove(), seconds * 1000 + 500);
  }
}
