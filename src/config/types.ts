export type Biome =
  | 'desert'
  | 'outskirts'
  | 'city'
  | 'plaza'
  | 'bankBack'
  | 'bankEnd'
  | 'bridge'
  | 'tunnelEnd'
  | 'tunnelExit'
  | 'industrial'
  | 'plantEnd'
  | 'plantBack'
  | 'wasteland'
  | 'safeZone';

export type ObstacleKind =
  | 'rock'
  | 'cactus'
  | 'tumbleweed'
  | 'barrel'
  | 'cone'
  | 'barrier'
  | 'wreck'
  | 'crate'
  | 'dumpster'
  | 'parkedCar'
  | 'container'
  | 'toxicBarrel'
  | 'fuelBarrel'
  | 'zombie';

/** 'ramp': rampa de salto (no es un peligro, pero se detecta igual). */
export type HazardKind = 'sand' | 'oil' | 'spikes' | 'acid' | 'ramp';

/** Quién persigue a los jugadores en cada nivel. */
export type Faction = 'police' | 'gang' | 'wasteland';

export type PursuerKind =
  // Policía (nivel 1)
  | 'patrol'
  | 'moto'
  | 'suv'
  | 'swat'
  // Banda rival (nivel 2)
  | 'muscle'
  | 'biker'
  | 'pickup'
  | 'truck'
  | 'van'
  // Tierra baldía (nivel 3)
  | 'buggy'
  | 'mutant'
  | 'flyer'
  | 'pyro'
  | 'raider'
  | 'rig';

export interface PursuerConfig {
  /** Perseguidores simultáneos máximos. */
  maxActive: number;
  /** Segundos entre refuerzos. */
  spawnInterval: number;
  /** Probabilidad relativa de cada tipo habilitado. */
  kinds: Partial<Record<PursuerKind, number>>;
  /** 0..1: frecuencia e intensidad de las embestidas. */
  aggression: number;
  /** 0..1: precisión de los disparos. */
  accuracy: number;
  /** Disparos por segundo de cada unidad armada. */
  fireRate: number;
}

export type Mood = 'day' | 'afternoon' | 'sunset' | 'night' | 'toxic';

export type StartScene = 'road' | 'bank' | 'tunnel' | 'plant';
/** 'none': nivel infinito, sin meta. */
export type FinishScene = 'bank' | 'tunnel' | 'plant' | 'safeZone' | 'none';

export interface LevelConfig {
  /** 4 = nivel infinito. */
  index: 0 | 1 | 2 | 3 | 4;
  name: string;
  subtitle: string;
  intro: string[];
  /** Distancia (m) hasta la estructura final. La IA la ajusta tras la calibración. */
  distance: number;
  /** Metros iniciales de calibración (en el nivel 0, todo el recorrido). */
  calibration: number;
  faction: Faction | null;
  /** Tipos de perseguidores del nivel, de menor a mayor amenaza. */
  roster: PursuerKind[];
  start: StartScene;
  finish: FinishScene;
  /** Obstáculos por cada 100 m de carretera. */
  obstacleDensity: number;
  obstacleWeights: Partial<Record<ObstacleKind, number>>;
  /** Zonas peligrosas por cada 100 m. */
  hazardDensity: number;
  hazardWeights: Partial<Record<HazardKind, number>>;
  /** Autos civiles por cada 100 m. */
  trafficDensity: number;
  pursuers: PursuerConfig | null;
  /** Metros entre retenes / barricadas (0 = ninguno). */
  roadblockEvery: number;
  helicopter: boolean;
  mood: Mood;
  /** Explicación legible de los ajustes que hizo la IA. */
  adaptiveNotes: string[];
}
