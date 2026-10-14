export type Biome = 'desert' | 'outskirts' | 'city' | 'plaza' | 'bankBack' | 'bankEnd';

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
  | 'parkedCar';

export type HazardKind = 'sand' | 'oil' | 'spikes';

export type PoliceKind = 'patrol' | 'moto' | 'suv' | 'swat';

export interface PoliceConfig {
  /** Patrullas simultáneas máximas. */
  maxActive: number;
  /** Segundos entre refuerzos. */
  spawnInterval: number;
  /** Probabilidad relativa de cada tipo de vehículo. */
  kinds: Partial<Record<PoliceKind, number>>;
  /** 0..1: frecuencia e intensidad de las embestidas. */
  aggression: number;
  /** 0..1: precisión de los disparos. */
  accuracy: number;
  /** Disparos por segundo de cada unidad armada. */
  fireRate: number;
}

export interface LevelConfig {
  index: 0 | 1 | 2 | 3;
  name: string;
  subtitle: string;
  intro: string[];
  /** Duración del nivel en segundos (la IA la modifica en los niveles 1-3). */
  duration: number;
  /** Obstáculos por cada 100 m de carretera. */
  obstacleDensity: number;
  obstacleWeights: Partial<Record<ObstacleKind, number>>;
  /** Zonas peligrosas (arena, aceite, púas) por cada 100 m. */
  hazardDensity: number;
  hazardWeights: Partial<Record<HazardKind, number>>;
  /** Autos civiles por cada 100 m. */
  trafficDensity: number;
  police: PoliceConfig | null;
  /** Metros entre retenes policiales (0 = sin retenes). */
  roadblockEvery: number;
  helicopter: boolean;
  /** Ambiente visual. */
  mood: 'day' | 'afternoon' | 'sunset' | 'dusk';
  /** Explicación legible de los ajustes que hizo la IA. */
  adaptiveNotes: string[];
}
