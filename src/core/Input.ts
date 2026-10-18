export interface DriveInput {
  throttle: number;
  brake: number;
  /** -1 izquierda .. +1 derecha */
  steer: number;
  turbo: boolean;
  /** Disparar: el arma apunta sola al objetivo más cercano. */
  shoot: boolean;
  /**
   * Joystick del celular: rumbo del mundo hacia el que apunta la bolita
   * (null = sin dirección). El nivel lo convierte en giro, aceleración o reversa.
   */
  dir?: number | null;
}

/**
 * Convierte la dirección del joystick en controles: el vehículo gira hacia
 * donde apunta la bolita; si apunta hacia atrás, retrocede en esa dirección.
 * `speed` es la velocidad longitudinal actual (negativa en reversa).
 */
export function steerToward(input: DriveInput, heading: number, speed: number): DriveInput {
  if (input.dir === null || input.dir === undefined) return input;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const diff = wrap(input.dir - heading);
  // Con histéresis: ya en reversa, sigue en reversa mientras la dirección quede bastante atrás.
  const reversing = speed < -0.5 ? Math.abs(diff) > 1.5 : Math.abs(diff) > 2.1;
  if (reversing) {
    // La cola apunta hacia la bolita; en reversa el giro se invierte.
    const back = wrap(input.dir + Math.PI - heading);
    return { ...input, throttle: 0, brake: 1, turbo: false, steer: Math.max(-1, Math.min(1, back * 3)) };
  }
  return { ...input, throttle: 1, brake: 0, steer: Math.max(-1, Math.min(1, -diff * 3)) };
}

interface Scheme {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  turbo: string[];
  shoot: string[];
}

/** WASD y flechas valen igual: un solo jugador por dispositivo. */
const KEYS: Scheme = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  turbo: ['Space', 'ShiftLeft', 'ShiftRight', 'Enter', 'NumpadEnter', 'Numpad0'],
  shoot: ['KeyF', 'ControlRight', 'Period', 'NumpadDecimal'],
};

const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  constructor() {
    window.addEventListener('keydown', (e) => {
      // Escribir en un campo de texto (código de sala, IP) no maneja el vehículo ni activa atajos.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && e.code !== 'Escape') return;
      if (BLOCKED.has(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Verdadero solo en el frame en que la tecla se presionó. */
  wasPressed(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  endFrame(): void {
    this.pressed.clear();
  }

  /** Controles del jugador de este dispositivo (en línea, el otro juega en el suyo). */
  drive(): DriveInput {
    const any = (keys: string[]) => keys.some((k) => this.down.has(k));
    return {
      throttle: any(KEYS.up) ? 1 : 0,
      brake: any(KEYS.down) ? 1 : 0,
      steer: (any(KEYS.right) ? 1 : 0) - (any(KEYS.left) ? 1 : 0),
      turbo: any(KEYS.turbo),
      shoot: any(KEYS.shoot),
    };
  }
}
