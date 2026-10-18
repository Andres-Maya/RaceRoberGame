import type { DriveInput } from '../core/Input';

/** Verdadero en celulares y tabletas (pantalla táctil como puntero principal). */
export const IS_TOUCH =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

/**
 * Controles en pantalla para celular: un joystick a la izquierda y botones de
 * turbo y disparo a la derecha. El joystick marca la dirección en la pantalla
 * hacia donde debe ir el vehículo (arriba = hacia arriba de la pantalla); sin
 * tocarlo, el vehículo no acelera.
 */
export class TouchControls {
  private root: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private stickId: number | null = null;
  private cx = 0;
  private cy = 0;
  private sx = 0;
  private sy = 0;
  private turbo = false;
  private shoot = false;
  private pauseHit = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="touch-stick-zone"><div class="touch-stick"><div class="touch-knob"></div></div></div>
      <div class="touch-buttons">
        <button type="button" class="touch-btn touch-turbo" data-touch="turbo">TURBO</button>
        <button type="button" class="touch-btn touch-shoot" data-touch="shoot">DISPARO</button>
      </div>
      <button type="button" class="touch-pause" data-touch="pause" aria-label="Pausa">II</button>`;
    document.querySelector('#app')!.appendChild(this.root);
    this.base = this.root.querySelector('.touch-stick') as HTMLElement;
    this.knob = this.root.querySelector('.touch-knob') as HTMLElement;

    const zone = this.root.querySelector('.touch-stick-zone') as HTMLElement;
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      // El joystick aparece donde se apoya el pulgar.
      const r = zone.getBoundingClientRect();
      this.cx = e.clientX;
      this.cy = e.clientY;
      this.base.style.left = `${e.clientX - r.left}px`;
      this.base.style.top = `${e.clientY - r.top}px`;
      this.base.classList.add('active');
      this.move(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.move(e.clientX, e.clientY);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.sx = 0;
      this.sy = 0;
      this.knob.style.transform = '';
      this.base.classList.remove('active');
      this.base.style.left = '';
      this.base.style.top = '';
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);

    for (const btn of this.root.querySelectorAll<HTMLElement>('[data-touch]')) {
      const kind = btn.dataset.touch!;
      const set = (on: boolean) => {
        btn.classList.toggle('on', on);
        if (kind === 'turbo') this.turbo = on;
        else if (kind === 'shoot') this.shoot = on;
      };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        if (kind === 'pause') this.pauseHit = true;
        else set(true);
      });
      btn.addEventListener('pointerup', () => set(false));
      btn.addEventListener('pointercancel', () => set(false));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  private move(x: number, y: number): void {
    const max = 46;
    let dx = x - this.cx;
    let dy = y - this.cy;
    const len = Math.hypot(dx, dy);
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    this.sx = dx / max;
    this.sy = dy / max;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    if (!on) {
      this.turbo = false;
      this.shoot = false;
      this.root.querySelectorAll('.on').forEach((b) => b.classList.remove('on'));
    }
  }

  /** Se tocó el botón de pausa desde la última consulta. */
  consumePause(): boolean {
    const hit = this.pauseHit;
    this.pauseHit = false;
    return hit;
  }

  /** Mezcla el control táctil con el del teclado. */
  apply(input: DriveInput): DriveInput {
    if (this.root.classList.contains('hidden')) return input;
    // La cámara mira hacia abajo con el norte (-Z) arriba: derecha de la pantalla = +X, abajo = +Z.
    // Sin tocar el joystick el vehículo no acelera (se detiene poco a poco).
    const active = Math.hypot(this.sx, this.sy) > 0.3;
    return {
      ...input,
      dir: active ? Math.atan2(-this.sx, -this.sy) : null,
      turbo: input.turbo || this.turbo,
      shoot: input.shoot || this.shoot,
    };
  }
}

/** Pantalla completa y orientación horizontal (solo funcionan tras un toque del jugador). */
export function enterFullscreen(): void {
  if (!IS_TOUCH || document.fullscreenElement) return;
  const el = document.documentElement;
  el.requestFullscreen?.({ navigationUI: 'hide' })
    .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => {});
}
