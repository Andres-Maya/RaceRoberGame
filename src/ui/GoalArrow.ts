import * as THREE from 'three';

/** Separación de los bordes (px); arriba es mayor para no tapar el contador de la meta. */
const MARGIN = { side: 54, top: 118, bottom: 70 };

/** Bandera a cuadros de meta (asta y paño de 5×4 cuadros) para dibujar dentro del círculo. */
function flagSvg(): string {
  const cells: string[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) if ((r + c) % 2 === 0) cells.push(`<rect x="${17 + c * 7}" y="${12 + r * 6}" width="7" height="6" />`);
  return `<svg class="goal-flag" viewBox="0 0 64 64" aria-hidden="true">
    <rect x="13" y="10" width="4" height="44" rx="2" class="goal-pole" />
    <path d="M17 12h35v24H17z" class="goal-cloth" />
    <g class="goal-checks">${cells.join('')}</g>
  </svg>`;
}

/**
 * Indicador de la meta con el mismo estilo que el del compañero fuera de la
 * pantalla: un círculo con una bandera a cuadros, una flecha que apunta hacia
 * la meta y la distancia. Fuera de la pantalla se pega al borde (mientras está
 * lejos señala la carretera rumbo a la meta); a la vista, rebota encima de ella.
 */
export class GoalArrow {
  private el: HTMLElement;
  private arrow: HTMLElement;
  private label: HTMLElement;
  private v = new THREE.Vector3();
  private text = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'goal-arrow';
    this.el.className = 'offscreen-mark hidden';
    this.el.style.setProperty('--pc', '#4cd37b');
    this.el.innerHTML = `<div class="offscreen-arrow"><i></i></div><div class="offscreen-circle">${flagSvg()}</div><b class="offscreen-dist"></b>`;
    document.querySelector('#app')!.appendChild(this.el);
    this.arrow = this.el.querySelector('.offscreen-arrow') as HTMLElement;
    this.label = this.el.querySelector('.offscreen-dist') as HTMLElement;
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
      // A la vista: encima de la meta, con la flecha hacia abajo.
      x = sx;
      y = sy - 58;
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
    this.arrow.style.transform = `rotate(${angle.toFixed(3)}rad)`;
    const text = onScreen ? 'META' : `META · ${remaining >= 1000 ? `${(remaining / 1000).toFixed(1)} km` : `${Math.round(remaining)} m`}`;
    if (text !== this.text) {
      this.text = text;
      this.label.textContent = text;
    }
  }

  hide(): void {
    this.el.classList.add('hidden');
  }
}
