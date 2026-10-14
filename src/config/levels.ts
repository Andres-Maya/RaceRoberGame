import type { LevelConfig } from './types';

/**
 * Nivel 0: calibración. Su configuración es fija para que todos los jugadores
 * sean medidos bajo las mismas condiciones.
 */
export const LEVEL_0: LevelConfig = {
  index: 0,
  name: 'Nivel 0 — La Ruta del Polvo',
  subtitle: 'Cruza el desierto antes de que la tormenta te alcance',
  intro: [
    'Tres días antes del golpe. La banda cruza el desierto de Sonora rumbo a Ciudad Cobalto.',
    'Una tormenta de arena avanza detrás de ustedes y no perdona a los lentos.',
    'Mientras conducen, “El Analista”, la IA de la banda, estudia cada maniobra para planear la ruta de escape perfecta.',
    'Esquiva rocas, cactus y barriles. Llega a la ciudad... y entra al Banco Central.',
  ],
  duration: 60,
  obstacleDensity: 7,
  obstacleWeights: { cone: 2, barrel: 2, crate: 1.5, barrier: 1, parkedCar: 1.5, dumpster: 1 },
  hazardDensity: 1.2,
  hazardWeights: { sand: 1, oil: 0.6 },
  trafficDensity: 2.2,
  police: null,
  roadblockEvery: 0,
  helicopter: false,
  mood: 'day',
  adaptiveNotes: [],
};

/** Valores base de los niveles de persecución; la IA los escala con la habilidad detectada. */
export const BASE_LEVELS: Record<1 | 2 | 3, LevelConfig> = {
  1: {
    index: 1,
    name: 'Nivel 1 — El Golpe',
    subtitle: 'Sobrevive a la primera ola de patrullas',
    intro: [
      '¡BOOM! La bóveda del Banco Central vuela por los aires.',
      'Con el botín en la mochila sales por la puerta principal entre el humo... y las sirenas ya suenan.',
      'Las patrullas intentarán embestirte. Algunos agentes disparan desde la ventanilla.',
      'Resiste hasta que el cronómetro llegue a cero para perderlos en el tráfico.',
    ],
    duration: 70,
    obstacleDensity: 5,
    obstacleWeights: { cone: 3, barrel: 2, crate: 1.5, parkedCar: 2, dumpster: 1, barrier: 1 },
    hazardDensity: 1.0,
    hazardWeights: { oil: 1, spikes: 0.3 },
    trafficDensity: 3,
    police: {
      maxActive: 3,
      spawnInterval: 6,
      kinds: { patrol: 1 },
      aggression: 0.45,
      accuracy: 0.25,
      fireRate: 0.3,
    },
    roadblockEvery: 0,
    helicopter: false,
    mood: 'afternoon',
    adaptiveNotes: [],
  },
  2: {
    index: 2,
    name: 'Nivel 2 — Avenida en Llamas',
    subtitle: 'Llegan motos policiales y camionetas blindadas',
    intro: [
      'Lograron cambiar de avenida, pero la central activó el código rojo.',
      'Ahora persiguen motos policiales —rápidas y armadas— y camionetas SUV que embisten con fuerza.',
      'Hay retenes en la vía y más obstáculos: busca siempre el hueco.',
    ],
    duration: 85,
    obstacleDensity: 7.5,
    obstacleWeights: { cone: 2, barrel: 2, crate: 1.5, parkedCar: 2, dumpster: 1.5, barrier: 2, wreck: 1 },
    hazardDensity: 1.8,
    hazardWeights: { oil: 1, spikes: 0.7 },
    trafficDensity: 3.8,
    police: {
      maxActive: 5,
      spawnInterval: 4.5,
      kinds: { patrol: 0.5, moto: 0.3, suv: 0.2 },
      aggression: 0.6,
      accuracy: 0.4,
      fireRate: 0.45,
    },
    roadblockEvery: 700,
    helicopter: false,
    mood: 'sunset',
    adaptiveNotes: [],
  },
  3: {
    index: 3,
    name: 'Nivel 3 — Último Cerco',
    subtitle: 'SWAT, helicóptero y retenes: escapa al desierto',
    intro: [
      'Anochece sobre Ciudad Cobalto. Toda la fuerza pública está tras ustedes.',
      'Furgonetas SWAT, un helicóptero con francotirador y retenes cada pocas cuadras.',
      'Si logran salir de la ciudad y volver al desierto, el botín es suyo.',
    ],
    duration: 100,
    obstacleDensity: 10,
    obstacleWeights: { cone: 2, barrel: 2, crate: 1, parkedCar: 2, dumpster: 1.5, barrier: 3, wreck: 2 },
    hazardDensity: 2.6,
    hazardWeights: { oil: 1, spikes: 1.2, sand: 0.4 },
    trafficDensity: 4.2,
    police: {
      maxActive: 7,
      spawnInterval: 3.5,
      kinds: { patrol: 0.3, moto: 0.25, suv: 0.25, swat: 0.2 },
      aggression: 0.75,
      accuracy: 0.55,
      fireRate: 0.6,
    },
    roadblockEvery: 450,
    helicopter: true,
    mood: 'dusk',
    adaptiveNotes: [],
  },
};

export const VICTORY_TEXT = [
  'Las sirenas se apagan detrás de las dunas.',
  'El Analista calcula el reparto: nadie en Ciudad Cobalto volverá a ver ese dinero.',
];
