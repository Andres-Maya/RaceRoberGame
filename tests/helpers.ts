// Entorno mínimo para correr la lógica real del juego en Node, sin navegador:
// lienzos de texto falsos, audio y avisos mudos, y azar con semilla para que
// cada prueba genere siempre el mismo mapa.
import RAPIER from '@dimforge/rapier3d-compat';

const ctx2d = new Proxy({}, { get: () => () => ({ width: 0 }) });
const g = globalThis as Record<string, unknown>;
g.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {}, toDataURL: () => 'data:,' }),
};
g.window ??= globalThis;

let physicsReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  physicsReady ??= RAPIER.init();
  return physicsReady;
}

/** Reemplaza Math.random por un generador con semilla (mulberry32). */
export function seedRandom(seed: number): void {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Objeto que acepta cualquier llamada y no hace nada (audio y avisos). */
export const silent = new Proxy({}, { get: () => () => {} }) as never;
export const hooks = { message: () => {}, flash: () => {} };

export const DT = 1 / 60;
