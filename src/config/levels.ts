import type { LevelConfig } from './types';

/**
 * Nivel 0 (prólogo): todo el recorrido es calibración y su configuración es
 * fija para que todos los jugadores sean medidos bajo las mismas condiciones.
 */
export const LEVEL_0: LevelConfig = {
  index: 0,
  name: 'Nivel 0 — La Ruta del Polvo',
  subtitle: 'Cruza el desierto y llega al Banco Central',
  intro: [
    'Tres días antes del golpe. La banda cruza el desierto de Sonora rumbo a Ciudad Cobalto.',
    'Una tormenta de arena avanza detrás de ustedes y no perdona a los lentos.',
    'Mientras conducen, “El Analista”, la IA de la banda, estudia cada maniobra para planear la ruta de escape.',
    'Esquiva rocas, cactus y barriles. Llega a la ciudad... y entra al Banco Central.',
  ],
  distance: 1800,
  calibration: 1800,
  faction: null,
  roster: [],
  start: 'road',
  finish: 'bank',
  obstacleDensity: 7,
  obstacleWeights: { cone: 2, barrel: 2, crate: 1.5, barrier: 1, parkedCar: 1.5, dumpster: 1 },
  hazardDensity: 1.2,
  hazardWeights: { sand: 1, oil: 0.6 },
  trafficDensity: 2.2,
  pursuers: null,
  roadblockEvery: 0,
  helicopter: false,
  mood: 'day',
  adaptiveNotes: [],
};

/**
 * Valores base de los niveles de persecución. Durante la calibración se usa
 * una versión neutral; al terminarla la IA los escala con la habilidad medida.
 */
export const BASE_LEVELS: Record<1 | 2 | 3, LevelConfig> = {
  1: {
    index: 1,
    name: 'Nivel 1 — El Golpe',
    subtitle: 'Escapa de la policía y llega al túnel del puente',
    intro: [
      '¡BOOM! La bóveda del Banco Central vuela por los aires.',
      'Con el botín en la mochila saltan por la puerta principal entre el humo... y las sirenas ya suenan.',
      'La única salida de Ciudad Cobalto es el puente del río y el túnel de la montaña.',
      'Las patrullas intentarán embestirte. Algunos agentes disparan desde la ventanilla.',
    ],
    distance: 2400,
    calibration: 550,
    faction: 'police',
    roster: ['patrol', 'moto', 'suv', 'swat'],
    start: 'bank',
    finish: 'tunnel',
    obstacleDensity: 6,
    obstacleWeights: { cone: 3, barrel: 2, crate: 1.5, parkedCar: 2, dumpster: 1, barrier: 1.5 },
    hazardDensity: 1.2,
    hazardWeights: { oil: 1, spikes: 0.4 },
    trafficDensity: 3,
    pursuers: { maxActive: 3, spawnInterval: 5.5, kinds: { patrol: 1 }, aggression: 0.45, accuracy: 0.3, fireRate: 0.3 },
    roadblockEvery: 800,
    helicopter: false,
    mood: 'afternoon',
    adaptiveNotes: [],
  },
  2: {
    index: 2,
    name: 'Nivel 2 — Territorio Enemigo',
    subtitle: 'La banda rival quiere el botín: llega a la planta nuclear',
    intro: [
      'Al salir del túnel no hay patrullas... sino algo peor.',
      'Los Cuervos, la banda rival, se enteraron del golpe y quieren el botín.',
      'Muscle cars, moteros armados, pickups con tiradores y un furgón blindado cierran el paso en la zona industrial.',
      'El único escondite es la vieja planta nuclear al final de la carretera.',
    ],
    distance: 2700,
    calibration: 550,
    faction: 'gang',
    roster: ['muscle', 'biker', 'pickup', 'van'],
    start: 'tunnel',
    finish: 'plant',
    obstacleDensity: 7.5,
    obstacleWeights: { container: 1.5, barrel: 2, crate: 2, wreck: 1, dumpster: 1.5, barrier: 1.5 },
    hazardDensity: 1.6,
    hazardWeights: { oil: 1.4, spikes: 0.6 },
    trafficDensity: 1.8,
    pursuers: { maxActive: 4, spawnInterval: 4.8, kinds: { muscle: 1 }, aggression: 0.55, accuracy: 0.38, fireRate: 0.45 },
    roadblockEvery: 700,
    helicopter: false,
    mood: 'sunset',
    adaptiveNotes: [],
  },
  3: {
    index: 3,
    name: 'Nivel 3 — Tierra Baldía',
    subtitle: 'Sobrevive a mutantes y zombis hasta la zona segura',
    intro: [
      'Los Cuervos los siguieron dentro de la planta... y el reactor no aguantó.',
      'Una explosión verde los lanza fuera mientras la radiación cubre todo el valle.',
      'Saqueadores en buggies, moteros mutantes, camiones de guerra y mutantes a pie salen de las ruinas.',
      'Los zombis vagan por la carretera y los charcos de ácido queman. Llega a la zona segura.',
    ],
    distance: 3000,
    calibration: 550,
    faction: 'wasteland',
    roster: ['buggy', 'mutant', 'raider', 'rig'],
    start: 'plant',
    finish: 'safeZone',
    obstacleDensity: 8,
    obstacleWeights: { zombie: 4, wreck: 1.5, toxicBarrel: 2, rock: 1.2, barrier: 0.6 },
    hazardDensity: 2,
    hazardWeights: { acid: 1.4, oil: 0.5, sand: 0.5 },
    trafficDensity: 0,
    pursuers: { maxActive: 5, spawnInterval: 4, kinds: { buggy: 1 }, aggression: 0.65, accuracy: 0.45, fireRate: 0.5 },
    roadblockEvery: 600,
    helicopter: false,
    mood: 'toxic',
    adaptiveNotes: [],
  },
};

export const VICTORY_TEXT = [
  'Dejan atrás la nube verde y cruzan la zona segura.',
  'Policía, banda rival, mutantes: nadie logró quitarles el botín.',
  'El Analista calcula el reparto. Ciudad Cobalto nunca olvidará este golpe.',
];
