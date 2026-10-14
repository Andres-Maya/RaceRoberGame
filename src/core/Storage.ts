import type { FeatureVector, SkillProfile } from '../ai/SkillClassifier';

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
});

export class Storage {
  data: SaveData;

  constructor() {
    this.data = defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.data = { ...defaults(), ...JSON.parse(raw) };
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
    const { muted, musicOn } = this.data;
    this.data = { ...defaults(), muted, musicOn };
    this.save();
  }
}
