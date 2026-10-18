export interface DriveInput {
  throttle: number;
  brake: number;
  /** -1 izquierda .. +1 derecha */
  steer: number;
  turbo: boolean;
  /** Disparar: con tecla apunta solo al objetivo más cercano; con el ratón, hacia la mira. */
  shoot: boolean;
  /** Punto del mundo bajo la mira del ratón (solo jugador 1), o null para apuntado automático. */
  aim: { x: number; z: number } | null;
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

const P1: Scheme = { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], turbo: ['Space', 'ShiftLeft'], shoot: ['KeyF'] };
const P2: Scheme = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  turbo: ['ShiftRight', 'Enter', 'NumpadEnter', 'Numpad0'],
  shoot: ['ControlRight', 'Period', 'NumpadDecimal'],
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

  /**
   * Controles de un jugador. Con un solo jugador se aceptan ambos esquemas
   * (WASD y flechas); con dos, P1 usa WASD y P2 las flechas.
   */
  drive(player: number, playerCount: number): DriveInput {
    const schemes = playerCount === 1 ? [P1, P2] : [player === 0 ? P1 : P2];
    const any = (keys: (s: Scheme) => string[]) => schemes.some((s) => keys(s).some((k) => this.down.has(k)));
    return {
      throttle: any((s) => s.up) ? 1 : 0,
      brake: any((s) => s.down) ? 1 : 0,
      steer: (any((s) => s.right) ? 1 : 0) - (any((s) => s.left) ? 1 : 0),
      turbo: any((s) => s.turbo),
      shoot: any((s) => s.shoot),
      aim: null,
    };
  }
}
