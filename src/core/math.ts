export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Suavizado exponencial independiente del framerate. */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

export const wrapAngle = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Cuaternión de rotación alrededor del eje Y (formato Rapier). */
export const quatY = (angle: number) => ({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) });

/**
 * Convención de orientación del juego: ángulo 0 mira hacia -Z (arriba en pantalla).
 * El vector "adelante" para un ángulo a es (-sin a, -cos a) en el plano XZ.
 */
export const forwardX = (a: number): number => -Math.sin(a);
export const forwardZ = (a: number): number => -Math.cos(a);

export const formatTime = (seconds: number): string => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const formatMoney = (n: number): string => '$' + Math.round(n).toLocaleString('es-CO');
