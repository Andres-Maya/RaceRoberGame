import { formatMoney, formatTime } from '../core/math';
import { BIKE_SPEC, PLAYER_COLORS, TURBO_MUL } from '../entities/Player';
import type { Level } from '../world/Level';

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
  private cache = new Map<HTMLElement, string>();

  show(level: Level, baseCash: number): void {
    this.root.classList.remove('hidden');
    this.levelName.textContent = level.config.name;
    this.objective.textContent = level.config.subtitle;
    this.ai.classList.toggle('hidden', level.config.index !== 0);
    this.storm.classList.toggle('hidden', level.config.index !== 0);
    this.cash.classList.toggle('hidden', level.config.index === 0);
    this.wanted.classList.toggle('hidden', level.config.index === 0);
    this.players.innerHTML = level.players
      .map(
        (p) => `
      <div class="pcard" style="--pc:${PLAYER_COLORS[p.index].css}">
        <div class="pcard-title">J${p.index + 1} · Moto ${PLAYER_COLORS[p.index].name}</div>
        <div class="bar"><div class="fill hp" data-hp="${p.index}"></div></div>
        <div class="bar small"><div class="fill turbo" data-turbo="${p.index}"></div></div>
        <div class="pcard-speed"><span data-speed="${p.index}">0</span> km/h</div>
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
    this.stormOverlay.style.opacity = '0';
    this.damageOverlay.style.opacity = '0';
  }

  private set(el: HTMLElement, text: string): void {
    if (this.cache.get(el) === text) return;
    this.cache.set(el, text);
    el.textContent = text;
  }

  update(level: Level): void {
    const cfg = level.config;
    if (cfg.index === 0) {
      if (level.aiProgress >= 1) {
        this.set(this.timerLabel, 'OBJETIVO');
        this.set(this.timer, 'BANCO');
      } else {
        this.set(this.timerLabel, 'ANÁLISIS IA');
        this.set(this.timer, formatTime(level.remaining));
      }
      this.aiBar.style.width = `${Math.round(level.aiProgress * 100)}%`;
      const prof = level.liveProfile;
      this.set(this.aiSkill, prof ? `${Math.round(prof.skill * 100)}%` : '—');
      this.set(this.aiTier, prof ? (level.aiProgress < 0.35 ? 'Calibrando…' : prof.tier) : 'Calibrando…');
      const gap = level.stormGap;
      if (gap !== null) {
        this.set(this.storm, gap > 0 ? `Tormenta a ${Math.round(gap)} m` : '¡DENTRO DE LA TORMENTA!');
        this.storm.classList.toggle('danger', gap < 20);
        this.stormOverlay.style.opacity = String(Math.max(0, Math.min(0.75, (12 - gap) / 25)));
      }
    } else {
      this.set(this.timerLabel, 'RESISTE');
      this.set(this.timer, formatTime(level.remaining));
      this.timer.classList.toggle('urgent', level.remaining < 10);
      this.set(this.cash, formatMoney(this.baseCash - level.cashLost));
      const stars = Math.min(5, Math.ceil(level.activePolice / 1.5) + (level.heli ? 1 : 0));
      this.set(this.wanted, '★'.repeat(stars) + '☆'.repeat(5 - stars));
    }
    this.set(this.score, `${Math.round(level.score).toLocaleString('es-CO')} pts`);

    let flash = 0;
    for (const p of level.players) {
      const hp = this.players.querySelector<HTMLElement>(`[data-hp="${p.index}"]`);
      const tb = this.players.querySelector<HTMLElement>(`[data-turbo="${p.index}"]`);
      const sp = this.players.querySelector<HTMLElement>(`[data-speed="${p.index}"]`);
      if (hp) {
        hp.style.width = `${(p.hp / p.maxHp) * 100}%`;
        hp.classList.toggle('low', p.hp < 30);
      }
      if (tb) {
        tb.style.width = `${p.turbo * 100}%`;
        tb.classList.toggle('active', p.turboActive);
      }
      // Escala visual: velocidad máxima con turbo ≈ 220 km/h.
      if (sp) this.set(sp, p.alive ? String(Math.round((Math.abs(p.vehicle.speed) / (BIKE_SPEC.maxSpeed * TURBO_MUL)) * 220)) : 'KO');
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
