import type { VehicleSpec } from '../entities/Vehicle';

export type VehicleId = 'cacharro' | 'moto' | 'sport' | 'truck' | 'buggy' | 'muscle' | 'armored';

/** Progreso del jugador que decide qué vehículos están desbloqueados. */
export interface UnlockState {
  /** Nivel más alto desbloqueado (1 = superó el prólogo). */
  unlocked: number;
  victories: number;
  /** Mejor distancia (m) en el nivel infinito. */
  bestEndless: number;
  /** Totales de todas las partidas. */
  totals: { wrecks: number; jumps: number };
}

/** Cómo se consigue un vehículo: se desbloquea cuando `current` alcanza `target`. */
export interface Unlock {
  text: string;
  current: (s: UnlockState) => number;
  target: number;
  /** Progreso legible ("12/40"); sin él no se muestra (metas de sí o no). */
  progress?: (s: UnlockState) => string;
}

/**
 * Vehículo jugable: física, vida, munición, turbo y habilidades propias.
 * Todos usan el mismo controlador arcade; lo que cambia son sus números.
 */
export interface VehicleDef {
  id: VehicleId;
  name: string;
  /** Etiqueta corta del estilo de juego. */
  role: string;
  description: string;
  spec: VehicleSpec;
  hp: number;
  ammoStart: number;
  ammoMax: number;
  /** Multiplicador de velocidad máxima con turbo. */
  turboMul: number;
  /** Gasto y recarga del turbo por segundo. */
  turboDrain: number;
  turboRegen: number;
  /** Velocidad fuera del asfalto (1 = sin penalización). */
  offroad: number;
  /** La arena no lo frena. */
  sandProof: boolean;
  /** Multiplicador del daño que hace al embestir perseguidores. */
  ram: number;
  /** Multiplicador del daño recibido de balas, explosiones, ácido y fuego. */
  armor: number;
  /** Multiplicador de la duración de los saltos en rampa. */
  jump: number;
  /** Tono del motor (1 = moto; menor = más grave). */
  engineTone: number;
  /** Una sola línea de ruedas (moto): salta aunque tome la rampa por la esquina. */
  twoWheeler: boolean;
  /** Habilidades que se muestran en la tarjeta del garaje. */
  perks: string[];
  /** Cómo se desbloquea (null = el vehículo inicial). */
  unlock: Unlock | null;
}

const spec = (maxSpeed: number, accel: number, steerRate: number, grip: number, hx: number, hz: number, density: number, brake = 42): VehicleSpec => ({
  maxSpeed,
  accel,
  brake,
  reverse: 9,
  steerRate,
  grip,
  hx,
  hz,
  density,
});

export const VEHICLES: VehicleDef[] = [
  {
    id: 'cacharro',
    name: 'Cacharro',
    role: 'Inicial',
    description: 'Un hatchback oxidado con el escape amarrado con alambre. No es bonito, pero arranca y aguanta.',
    spec: spec(33, 22, 2.4, 8, 0.95, 2.0, 2.6),
    hp: 170,
    ammoStart: 30,
    ammoMax: 60,
    turboMul: 1.4,
    turboDrain: 0.32,
    turboRegen: 0.12,
    offroad: 0.65,
    sandProof: false,
    ram: 1.3,
    armor: 1,
    jump: 1,
    engineTone: 0.9,
    twoWheeler: false,
    perks: ['Fácil de manejar y resistente', 'Cuatro ruedas: salta bien si toma la rampa de frente'],
    unlock: null,
  },
  {
    id: 'moto',
    name: 'Furia',
    role: 'Equilibrada',
    description: 'La moto clásica de la banda: pequeña, ágil y fácil de controlar.',
    spec: spec(34, 24, 2.7, 8, 0.45, 1.1, 2),
    hp: 150,
    ammoStart: 30,
    ammoMax: 60,
    turboMul: 1.4,
    turboDrain: 0.36,
    turboRegen: 0.14,
    offroad: 0.68,
    sandProof: false,
    ram: 1,
    armor: 1,
    jump: 1,
    engineTone: 1,
    twoWheeler: true,
    perks: ['Silueta pequeña: cabe por cualquier hueco', 'El turbo se recarga más rápido'],
    unlock: { text: 'Supera el prólogo (nivel 0)', current: (s) => Math.min(s.unlocked, 1), target: 1 },
  },
  {
    id: 'sport',
    name: 'Relámpago',
    role: 'Velocista',
    description: 'Deportivo de carreras robado a un coleccionista. Nadie lo alcanza... si no choca.',
    spec: spec(41, 31, 2.4, 9.5, 0.95, 2.0, 2.5, 46),
    hp: 110,
    ammoStart: 25,
    ammoMax: 50,
    turboMul: 1.45,
    turboDrain: 0.38,
    turboRegen: 0.11,
    offroad: 0.55,
    sandProof: false,
    ram: 1.2,
    armor: 1,
    jump: 1.1,
    engineTone: 1.3,
    twoWheeler: false,
    perks: ['Velocidad punta y aceleración máximas', 'Frágil y torpe fuera del asfalto'],
    unlock: { text: 'Supera el nivel 1', current: (s) => Math.min(s.unlocked, 2), target: 2 },
  },
  {
    id: 'truck',
    name: 'Toro',
    role: 'Tanque',
    description: 'Camioneta 4x4 con defensa de tubos. Lenta, pero arrasa con lo que embiste.',
    spec: spec(29, 16, 1.9, 7, 1.1, 2.4, 5, 36),
    hp: 260,
    ammoStart: 40,
    ammoMax: 80,
    turboMul: 1.35,
    turboDrain: 0.34,
    turboRegen: 0.1,
    offroad: 0.9,
    sandProof: false,
    ram: 2.2,
    armor: 0.9,
    jump: 0.85,
    engineTone: 0.72,
    twoWheeler: false,
    perks: ['Embestida ×2,2: destroza patrullas', 'Cajón de munición grande (80)'],
    unlock: { text: 'Derriba 40 perseguidores en total', current: (s) => s.totals.wrecks, target: 40, progress: (s) => `${Math.min(40, s.totals.wrecks)}/40` },
  },
  {
    id: 'buggy',
    name: 'Escorpión',
    role: 'Todoterreno',
    description: 'Buggy de dunas con suspensión alta. El desierto y las ruinas son su casa.',
    spec: spec(35, 27, 2.9, 7.5, 0.9, 1.7, 2.5),
    hp: 140,
    ammoStart: 30,
    ammoMax: 60,
    turboMul: 1.5,
    turboDrain: 0.36,
    turboRegen: 0.12,
    offroad: 1,
    sandProof: true,
    ram: 1.3,
    armor: 1,
    jump: 1.3,
    engineTone: 1.12,
    twoWheeler: false,
    perks: ['Sin penalización fuera del asfalto ni en la arena', 'Salta más lejos en las rampas'],
    unlock: { text: 'Completa 15 saltos en rampas', current: (s) => s.totals.jumps, target: 15, progress: (s) => `${Math.min(15, s.totals.jumps)}/15` },
  },
  {
    id: 'muscle',
    name: 'Bestia',
    role: 'Clásico',
    description: 'Muscle car de los setenta con motor sobrealimentado. Derrapa, pero no se rinde.',
    spec: spec(37, 23, 2.1, 6, 1.0, 2.2, 3.5),
    hp: 180,
    ammoStart: 30,
    ammoMax: 60,
    turboMul: 1.55,
    turboDrain: 0.24,
    turboRegen: 0.11,
    offroad: 0.62,
    sandProof: false,
    ram: 1.6,
    armor: 1,
    jump: 1,
    engineTone: 0.82,
    twoWheeler: false,
    perks: ['Turbo potente y duradero', 'Embestida ×1,6', 'Derrapa en las curvas'],
    unlock: { text: 'Supera el nivel 2', current: (s) => Math.min(s.unlocked, 3), target: 3 },
  },
  {
    id: 'armored',
    name: 'Bóveda',
    role: 'Blindado',
    description: 'El furgón blindado que transportaba el dinero del banco. Ahora trabaja para ustedes.',
    spec: spec(27, 13, 1.6, 6, 1.3, 2.8, 7, 32),
    hp: 340,
    ammoStart: 50,
    ammoMax: 100,
    turboMul: 1.3,
    turboDrain: 0.34,
    turboRegen: 0.1,
    offroad: 0.8,
    sandProof: false,
    ram: 2.6,
    armor: 0.65,
    jump: 0.75,
    engineTone: 0.6,
    twoWheeler: false,
    perks: ['Blindaje: −35 % de daño de balas, explosiones, ácido y fuego', 'Embestida ×2,6 · 100 balas', 'Muy lento'],
    unlock: {
      text: 'Gana la campaña (supera el nivel 3) o recorre 3 km en el nivel infinito',
      current: (s) => (s.victories > 0 ? 3000 : s.bestEndless),
      target: 3000,
      progress: (s) => (s.victories > 0 ? 'campaña ganada' : `${(Math.min(3000, s.bestEndless) / 1000).toFixed(1)}/3 km`),
    },
  },
];

export function vehicleById(id: string): VehicleDef {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
}

export function isUnlocked(def: VehicleDef, s: UnlockState): boolean {
  return !def.unlock || def.unlock.current(s) >= def.unlock.target;
}

/** Identificadores de los vehículos desbloqueados. */
export function unlockedIds(s: UnlockState): Set<VehicleId> {
  return new Set(VEHICLES.filter((v) => isUnlocked(v, s)).map((v) => v.id));
}

/** Barras de la tarjeta (0..1) comparando contra el mejor de cada atributo. */
export function vehicleStats(def: VehicleDef): { label: string; value: number }[] {
  const max = (f: (v: VehicleDef) => number) => Math.max(...VEHICLES.map(f));
  return [
    { label: 'Velocidad', value: (def.spec.maxSpeed * def.turboMul) / max((v) => v.spec.maxSpeed * v.turboMul) },
    { label: 'Aceleración', value: def.spec.accel / max((v) => v.spec.accel) },
    { label: 'Manejo', value: (def.spec.steerRate * 0.6 + def.spec.grip * 0.15) / max((v) => v.spec.steerRate * 0.6 + v.spec.grip * 0.15) },
    { label: 'Vida', value: def.hp / max((v) => v.hp) },
    { label: 'Embestida', value: def.ram / max((v) => v.ram) },
    { label: 'Munición', value: def.ammoMax / max((v) => v.ammoMax) },
  ];
}
