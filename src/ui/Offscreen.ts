import * as THREE from 'three';
import { PLAYER_COLORS } from '../entities/Player';
import { vehicleThumbnails } from './Thumbnails';

/** Un compañero que puede quedar fuera de la pantalla. */
export interface Mate {
  index: number;
  x: number;
  z: number;
  vehicle: string;
  alive: boolean;
}

/** Separación del borde de la pantalla (px). */
const MARGIN = 46;

/**
 * Indicadores de compañeros fuera de cámara: un círculo con la foto de su
 * vehículo pegado al borde de la pantalla, una flecha que apunta hacia él y la
 * distancia. Cada jugador ve su propia cámara, así que el otro puede alejarse.
 */
export class OffscreenMarkers {
  private root: HTMLElement;
  private marks = new Map<number, { el: HTMLElement; img: HTMLImageElement; arrow: HTMLElement; dist: HTMLElement; vehicle: string }>();
  private v = new THREE.Vector3();

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'offscreen';
    document.querySelector('#app')!.appendChild(this.root);
  }

  /** `me`: posición del jugador de este dispositivo (para la distancia). */
  update(camera: THREE.PerspectiveCamera, mates: Mate[], me: { x: number; z: number } | null): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const seen = new Set<number>();
    for (const m of mates) {
      if (!m.alive) continue;
      // ¿Dónde cae en la pantalla?
      this.v.set(m.x, 1, m.z).project(camera);
      const sx = ((this.v.x + 1) / 2) * w;
      const sy = ((1 - this.v.y) / 2) * h;
      if (sx > 8 && sx < w - 8 && sy > 8 && sy < h - 8) continue;
      seen.add(m.index);
      const mark = this.mark(m);
      // Se lleva al borde siguiendo la línea desde el centro de la pantalla.
      const dx = sx - w / 2;
      const dy = sy - h / 2;
      const t = Math.min((w / 2 - MARGIN) / Math.max(1e-3, Math.abs(dx)), (h / 2 - MARGIN) / Math.max(1e-3, Math.abs(dy)));
      mark.el.style.transform = `translate(${w / 2 + dx * t}px, ${h / 2 + dy * t}px)`;
      mark.arrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      mark.dist.textContent = me ? `${Math.round(Math.hypot(m.x - me.x, m.z - me.z))} m` : '';
      mark.el.classList.remove('hidden');
    }
    for (const [index, mark] of this.marks) if (!seen.has(index)) mark.el.classList.add('hidden');
  }

  private mark(m: Mate) {
    let mark = this.marks.get(m.index);
    if (!mark) {
      const el = document.createElement('div');
      el.className = 'offscreen-mark hidden';
      el.style.setProperty('--pc', PLAYER_COLORS[m.index]?.css ?? '#ffffff');
      el.innerHTML = `<div class="offscreen-arrow"><i></i></div><div class="offscreen-circle"><img alt="" draggable="false" /></div><b class="offscreen-dist"></b>`;
      this.root.appendChild(el);
      mark = {
        el,
        img: el.querySelector('img')!,
        arrow: el.querySelector('.offscreen-arrow') as HTMLElement,
        dist: el.querySelector('.offscreen-dist') as HTMLElement,
        vehicle: '',
      };
      this.marks.set(m.index, mark);
    }
    if (mark.vehicle !== m.vehicle) {
      // Foto del vehículo con los colores de ese jugador (se dibuja una vez y queda guardada).
      mark.vehicle = m.vehicle;
      mark.img.src = vehicleThumbnails([m.vehicle], Math.min(m.index, PLAYER_COLORS.length - 1))[m.vehicle] || '';
    }
    return mark;
  }

  hide(): void {
    for (const mark of this.marks.values()) mark.el.classList.add('hidden');
  }
}
