import { formatMoney } from '../core/math';
import { PLAYER_COLORS } from '../entities/Player';
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
  private flashOverlay = $('#flash-overlay');
  private progressBar = $('#hud-progress-bar');
  private cache = new Map<HTMLElement, string>();

  show(level: Level, baseCash: number): void {
    this.root.classList.remove('hidden');
    this.levelName.textContent = level.config.name;
    this.objective.textContent = level.config.subtitle;
    this.ai.classList.remove('hidden');
    this.storm.classList.toggle('hidden', level.config.index !== 0);
    this.cash.classList.toggle('hidden', level.config.index === 0);
    this.wanted.classList.toggle('hidden', level.config.index === 0);
    this.players.innerHTML = level.players
      .map(
        (p) => `
      <div class="pcard" style="--pc:${PLAYER_COLORS[p.index].css}">
        <div class="pcard-title">J${p.index + 1} · ${p.def.name} ${PLAYER_COLORS[p.index].name}</div>
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
    const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
    const zone = level.zoneInfo;
    if (cfg.finish === 'none') {
      // Nivel infinito: distancia recorrida y avance dentro de la zona.
      this.set(this.timerLabel, zone ? `ZONA ${zone.index} · ${zone.name.toUpperCase()}` : 'RECORRIDO');
      this.set(this.timer, km(level.maxD));
      this.progressBar.style.width = `${Math.round((zone?.progress ?? 0) * 100)}%`;
    } else {
      // Meta por distancia
      const goal = { bank: 'BANCO', tunnel: 'TÚNEL', plant: 'PLANTA', safeZone: 'ZONA SEGURA' }[cfg.finish];
      this.set(this.timerLabel, `${goal} EN`);
      const left = level.remainingDistance;
      this.set(this.timer, km(left));
      this.timer.classList.toggle('urgent', left < 150);
      this.progressBar.style.width = `${Math.round(level.progress * 100)}%`;
    }

    // El Analista: calibración y veredicto
    this.aiBar.style.width = `${Math.round(level.aiProgress * 100)}%`;
    const prof = level.liveProfile;
    this.set(this.aiSkill, prof ? `${Math.round(prof.skill * 100)}%` : '—');
    const calibrating = level.calibrating;
    this.set(this.aiTier, !prof || (calibrating && level.aiProgress < 0.35) ? 'Calibrando…' : calibrating ? `${prof.tier}?` : `${prof.tier} · ajuste aplicado`);

    if (cfg.index === 0) {
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
      if (sp) this.set(sp, p.alive ? String(Math.round(Math.abs(p.vehicle.speed) * 4.6)) : 'KO');
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
