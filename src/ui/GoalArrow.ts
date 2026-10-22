import * as THREE from 'three';

/** Separación de los bordes (px); arriba es mayor para no tapar el contador de la meta. */
const MARGIN = { side: 54, top: 118, bottom: 70 };

/**
 * Flecha hacia la meta. Fuera de la pantalla se pega al borde y apunta hacia
 * ella (mientras está lejos, hacia donde sigue la carretera rumbo a la meta);
 * cuando la meta está a la vista, rebota encima de ella.
 */
export class GoalArrow {
  private el: HTMLElement;
  private icon: HTMLElement;
  private label: HTMLElement;
  private v = new THREE.Vector3();
  private text = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'goal-arrow';
    this.el.className = 'hidden';
    this.el.innerHTML = `<div class="goal-icon"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 14h18V5l15 15-15 15v-9H4z" /></svg></div><b class="goal-label"></b>`;
    document.querySelector('#app')!.appendChild(this.el);
    this.icon = this.el.querySelector('.goal-icon') as HTMLElement;
    this.label = this.el.querySelector('.goal-label') as HTMLElement;
  }

  /** `goal`: punto del mundo al que apuntar; `remaining`: metros hasta la meta. */
  update(camera: THREE.PerspectiveCamera, goal: { x: number; z: number; near: boolean } | null, remaining: number): void {
    if (!goal) {
      this.hide();
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.v.set(goal.x, 1, goal.z).project(camera);
    const sx = ((this.v.x + 1) / 2) * w;
    const sy = ((1 - this.v.y) / 2) * h;
    const onScreen = goal.near && sx > MARGIN.side && sx < w - MARGIN.side && sy > MARGIN.top && sy < h - MARGIN.bottom;
    let x: number;
    let y: number;
    let angle: number;
    if (onScreen) {
      // A la vista: encima de la meta, apuntando hacia abajo.
      x = sx;
      y = sy - 46;
      angle = Math.PI / 2;
    } else {
      // Fuera de la pantalla: en el borde, sobre la línea que va del centro a la meta.
      const cx = w / 2;
      const cy = h / 2;
      const dx = sx - cx;
      const dy = sy - cy;
      const tx = dx > 0 ? (w - MARGIN.side - cx) / dx : dx < 0 ? (MARGIN.side - cx) / dx : Infinity;
      const ty = dy > 0 ? (h - MARGIN.bottom - cy) / dy : dy < 0 ? (MARGIN.top - cy) / dy : Infinity;
      const t = Math.min(tx, ty);
      x = cx + dx * t;
      y = cy + dy * t;
      angle = Math.atan2(dy, dx);
    }
    this.el.classList.remove('hidden');
    this.el.classList.toggle('near', onScreen);
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    this.icon.style.transform = `rotate(${angle.toFixed(3)}rad)`;
    const text = `META · ${remaining >= 1000 ? `${(remaining / 1000).toFixed(1)} km` : `${Math.round(remaining)} m`}`;
    if (text !== this.text) {
      this.text = text;
      this.label.textContent = text;
    }
  }

  hide(): void {
    this.el.classList.add('hidden');
  }
}
