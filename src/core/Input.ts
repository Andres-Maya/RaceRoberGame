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
  /** Posición del ratón en pantalla y si el botón izquierdo está presionado. */
  readonly mouse = { x: 0, y: 0, down: false };

  constructor() {
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.down = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
    window.addEventListener('keydown', (e) => {
      if (BLOCKED.has(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouse.down = false;
    });
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
