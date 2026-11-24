import type { DriveInput, Input } from '../core/Input';

/** Tecla que se muestra en el tutorial y los códigos que la encienden al presionarla. */
interface Key {
  label: string;
  codes: string[];
}

interface Step {
  title: string;
  text: string;
  /** Grupos de teclas equivalentes (se muestran separados por "o"). */
  keys: Key[][];
  /** Cuánto debe mantener la acción (s) o, con `presses`, cuántas veces pulsarla. */
  goal: number;
  presses?: boolean;
  active: (d: DriveInput) => boolean;
}

const k = (label: string, ...codes: string[]): Key => ({ label, codes });

const STEPS: Step[] = [
  {
    title: 'Acelera',
    text: 'Mantén presionado para arrancar',
    keys: [[k('W', 'KeyW')], [k('↑', 'ArrowUp')]],
    goal: 1.2,
    active: (d) => d.throttle > 0,
  },
  {
    title: 'Gira',
    text: 'Esquiva el tráfico y toma las curvas',
    keys: [
      [k('A', 'KeyA'), k('D', 'KeyD')],
      [k('←', 'ArrowLeft'), k('→', 'ArrowRight')],
    ],
    goal: 1,
    active: (d) => d.steer !== 0,
  },
  {
    title: 'Frena y reversa',
    text: 'Mantén presionado para frenar; detenido, retrocedes',
    keys: [[k('S', 'KeyS')], [k('↓', 'ArrowDown')]],
    goal: 0.8,
    active: (d) => d.brake > 0,
  },
  {
    title: 'Dispara',
    text: 'El arma apunta sola al enemigo más cercano · 2 disparos',
    keys: [[k('Espacio', 'Space')], [k('F', 'KeyF')]],
    goal: 2,
    presses: true,
    active: (d) => d.shoot,
  },
  {
    title: 'Turbo',
    text: 'Gasta la barra azul para escapar más rápido',
    keys: [[k('Shift', 'ShiftLeft', 'ShiftRight')], [k('Enter', 'Enter', 'NumpadEnter')]],
    goal: 0.8,
    active: (d) => d.turbo,
  },
];

/** Segundos que queda el mensaje final antes de desaparecer. */
const DONE_TIME = 1.6;

/**
 * Tutorial en vivo al empezar la partida: muestra una acción a la vez, ilumina
 * las teclas mientras se presionan y avanza cuando el jugador la practica, sin
 * detener el juego. `T` lo salta.
 */
export class Tutorial {
  private el: HTMLElement;
  private step = 0;
  private progress = 0;
  private wasActive = false;
  private doneLeft = 0;
  private running = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'tutorial';
    this.el.className = 'hidden';
    document.querySelector('#hud')!.appendChild(this.el);
  }

  /** Está en pantalla (enseñando o con el mensaje final). */
  get active(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
    this.step = 0;
    this.progress = 0;
    this.wasActive = true;
    this.doneLeft = 0;
    this.el.className = '';
    this.render();
  }

  stop(): void {
    this.running = false;
    this.el.className = 'hidden';
    this.el.innerHTML = '';
  }

  /**
   * Avanza con los controles de este cuadro. Devuelve true el cuadro en que el
   * jugador completa la última acción.
   */
  update(dt: number, input: Input, drive: DriveInput): boolean {
    if (!this.running) return false;
    if (this.doneLeft > 0) {
      this.doneLeft -= dt;
      if (this.doneLeft <= 0) this.stop();
      return false;
    }
    const s = STEPS[this.step];
    const on = s.active(drive);
    // Las pulsaciones cuentan al bajar la tecla: mantenerla presionada al cambiar de paso no suma.
    if (s.presses) {
      if (on && !this.wasActive) this.progress += 1;
    } else if (on) {
      this.progress += dt;
    }
    this.wasActive = on;
    this.lightKeys(input);
    const fill = this.el.querySelector<HTMLElement>('.tut-fill');
    if (fill) fill.style.width = `${Math.min(1, this.progress / s.goal) * 100}%`;
    if (this.progress < s.goal) return false;

    this.step++;
    this.progress = 0;
    this.wasActive = true;
    if (this.step >= STEPS.length) {
      this.doneLeft = DONE_TIME;
      this.el.className = 'done';
      this.el.innerHTML = `<div class="tut-card"><div class="tut-title">¡Listo! A escapar</div><div class="tut-text">Repasa los controles cuando quieras en el menú › Controles</div></div>`;
      return true;
    }
    this.render();
    return false;
  }

  /** Enciende cada tecla del paso actual mientras está presionada. */
  private lightKeys(input: Input): void {
    this.el.querySelectorAll<HTMLElement>('kbd[data-codes]').forEach((kbd) => {
      kbd.classList.toggle('on', kbd.dataset.codes!.split(' ').some((c) => input.isDown(c)));
    });
  }

  private render(): void {
    const s = STEPS[this.step];
    const keys = s.keys
      .map((group) => `<span class="tut-group">${group.map((key) => `<kbd data-codes="${key.codes.join(' ')}">${key.label}</kbd>`).join('')}</span>`)
      .join('<span class="tut-or">o</span>');
    const dots = STEPS.map((_, i) => `<i class="${i < this.step ? 'ok' : i === this.step ? 'now' : ''}"></i>`).join('');
    this.el.innerHTML = `<div class="tut-card">
      <div class="tut-head"><span>TUTORIAL · ${this.step + 1}/${STEPS.length}</span><span class="tut-dots">${dots}</span><span class="tut-skip"><kbd>T</kbd> saltar</span></div>
      <div class="tut-title">${s.title}</div>
      <div class="tut-keys">${keys}</div>
      <div class="tut-text">${s.text}</div>
      <div class="bar small"><div class="fill tut-fill"></div></div>
    </div>`;
    // Reinicia la animación de entrada de la tarjeta en cada paso.
    this.el.classList.remove('step');
    void this.el.offsetWidth;
    this.el.classList.add('step');
  }
}
