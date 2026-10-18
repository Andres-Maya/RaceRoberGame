import type { FeatureVector, SkillProfile } from '../ai/SkillClassifier';
import type { VehicleId } from '../config/vehicles';
import { DEFAULT_VOLUMES, type Volumes } from './Audio';

const KEY = 'racerober.save.v1';

export interface RunRecord {
  date: string;
  players: number;
  level: number;
  skill: number;
  features: FeatureVector;
}

export interface SaveData {
  /** Nivel más alto desbloqueado (0..3). */
  unlocked: number;
  profile: SkillProfile | null;
  bestScore: number;
  bestCash: number;
  runs: number;
  victories: number;
  /** Historial de vectores de características: dataset para entrenar un modelo TF.js. */
  history: RunRecord[];
  muted: boolean;
  musicOn: boolean;
  /** Volumen de cada canal de sonido (0..1). */
  volumes: Volumes;
  /** Mejor distancia (m) en el nivel infinito. */
  bestEndless: number;
  /** Vehículo elegido en el garaje por cada jugador. */
  vehicles: VehicleId[];
  /** Totales de todas las partidas (desbloquean vehículos). */
  totals: { wrecks: number; jumps: number };
  /** Campaña en curso: nivel por jugar, botín y puntaje acumulados (JUGAR continúa desde aquí). */
  campaign: SavedCampaign | null;
}

export interface SavedCampaign {
  level: number;
  cash: number;
  score: number;
}

const defaults = (): SaveData => ({
  unlocked: 0,
  profile: null,
  bestScore: 0,
  bestCash: 0,
  runs: 0,
  victories: 0,
  history: [],
  muted: false,
  musicOn: true,
  volumes: { ...DEFAULT_VOLUMES },
  bestEndless: 0,
  vehicles: ['cacharro', 'cacharro'],
  totals: { wrecks: 0, jumps: 0 },
  campaign: null,
});

export class Storage {
  data: SaveData;

  constructor() {
    this.data = defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // Partidas guardadas antes de los canales de sonido: conservar el volumen de música.
        const volumes = { ...DEFAULT_VOLUMES, ...(saved.volumes ?? {}) };
        if (!saved.volumes && typeof saved.musicVolume === 'number') volumes.music = saved.musicVolume;
        delete saved.musicVolume;
        const vehicles = Array.isArray(saved.vehicles) ? [...saved.vehicles, 'cacharro', 'cacharro'].slice(0, 2) : ['cacharro', 'cacharro'];
        const totals = { wrecks: Number(saved.totals?.wrecks) || 0, jumps: Number(saved.totals?.jumps) || 0 };
        this.data = { ...defaults(), ...saved, volumes, vehicles, totals };
      }
    } catch {
      // Sin almacenamiento disponible (modo privado): se juega sin guardar.
    }
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignorado */
    }
  }

  record(run: RunRecord): void {
    this.data.history.push(run);
    if (this.data.history.length > 60) this.data.history.splice(0, this.data.history.length - 60);
    this.save();
  }

  reset(): void {
    const { muted, musicOn, volumes } = this.data;
    this.data = { ...defaults(), muted, musicOn, volumes };
    this.save();
  }
}
