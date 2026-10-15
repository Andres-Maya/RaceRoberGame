import { BASE_LEVELS } from '../config/levels';
import type { LevelConfig, PursuerKind } from '../config/types';
import { clamp, clamp01 } from '../core/math';
import type { SkillProfile } from './SkillClassifier';

/** Peso relativo de cada tipo habilitado, del más común al más raro. */
const TYPE_WEIGHTS = [1, 0.75, 0.6, 0.55, 0.45, 0.35];

/** Campos que la IA modifica en caliente al terminar la calibración. */
export type Adjustment = Pick<
  LevelConfig,
  | 'distance'
  | 'obstacleDensity'
  | 'obstacleWeights'
  | 'hazardDensity'
  | 'trafficDensity'
  | 'pursuers'
  | 'roadblockEvery'
  | 'helicopter'
  | 'adaptiveNotes'
>;

/**
 * Dificultad adaptativa dentro del mismo nivel. Cada nivel de persecución
 * arranca con una fase de calibración neutral (pocos perseguidores del tipo
 * más básico); al terminarla, el perfil medido decide cuántos tipos de
 * vehículos aparecen, cuántos a la vez, cuántos obstáculos hay y cuánto falta
 * para la meta.
 */
export class AdaptiveDifficulty {
  /** Configuración neutral para la fase de calibración. */
  calibrationConfig(level: 1 | 2 | 3, players = 1): LevelConfig {
    // (el nivel infinito tiene su propia rampa: ver Level.enterZone)
    const base = structuredClone(BASE_LEVELS[level]);
    const p = base.pursuers!;
    base.pursuers = {
      maxActive: 2 + (players - 1),
      spawnInterval: p.spawnInterval * 1.3,
      kinds: { [base.roster[0]]: 1 },
      aggression: p.aggression * 0.7,
      accuracy: p.accuracy * 0.7,
      fireRate: p.fireRate * 0.7,
    };
    base.obstacleDensity *= 0.85;
    base.roadblockEvery = 0;
    base.helicopter = false;
    return base;
  }

  adjust(level: 1 | 2 | 3, profile: SkillProfile, players = 1): Adjustment {
    const base = BASE_LEVELS[level];
    const s = profile.skill;
    const f = profile.features;

    // Número de tipos de vehículo: 1 para novatos, los 4 para expertos.
    const typeCount = clamp(Math.round(1 + s * (base.roster.length - 1) * 0.9 + (level - 1) * 0.4), 1, base.roster.length);
    const kinds: Partial<Record<PursuerKind, number>> = {};
    base.roster.slice(0, typeCount).forEach((k, i) => (kinds[k] = TYPE_WEIGHTS[i]));

    const bp = base.pursuers!;
    const pursuers = {
      maxActive: Math.max(2, Math.round(bp.maxActive * (0.7 + 0.8 * s)) + (players - 1)),
      spawnInterval: clamp(bp.spawnInterval / (0.7 + 0.7 * s), 1.8, 10),
      kinds,
      aggression: clamp01(bp.aggression + (s - 0.5) * 0.4),
      accuracy: clamp01(bp.accuracy + (s - 0.5) * 0.3),
      fireRate: bp.fireRate * (0.75 + 0.6 * s),
    };

    // Cantidad de obstáculos: según habilidad y qué tan bien esquivó en la calibración.
    const obstacleDensity = base.obstacleDensity * (0.6 + 0.9 * s) * (0.85 + 0.3 * f.avoidance);
    // Quien avanza rápido recibe obstáculos duros; quien va lento, blandos.
    const weights = { ...base.obstacleWeights };
    const hardBias = 0.6 + f.speed * 0.9;
    for (const k of ['barrier', 'wreck', 'dumpster', 'container'] as const) if (weights[k]) weights[k] = weights[k]! * hardBias;
    for (const k of ['cone', 'crate'] as const) if (weights[k]) weights[k] = weights[k]! * (1.6 - f.speed * 0.8);
    // Los zombis abundan más para quien los esquiva con facilidad.
    if (weights.zombie) weights.zombie *= 0.7 + 0.8 * s;

    // El tramo restante es más largo para jugadores hábiles.
    const distance = Math.round(base.calibration + (base.distance - base.calibration) * (0.8 + 0.45 * s));
    const roadblockEvery = Math.round(base.roadblockEvery / (0.7 + 0.6 * s));
    const helicopter = base.faction === 'police' && s > 0.7;

    const pct = (x: number) => `${x >= 1 ? '+' : ''}${Math.round((x - 1) * 100)}%`;
    const names = base.roster.slice(0, typeCount).map(kindLabel).join(', ');
    const adaptiveNotes = [
      `Tipos de perseguidores: ${typeCount} de ${base.roster.length} (${names})`,
      `Perseguidores simultáneos: ${pursuers.maxActive}`,
      `Obstáculos: ${pct(obstacleDensity / base.obstacleDensity)}${f.avoidance > 0.8 ? ' (esquivas bien)' : f.avoidance < 0.5 ? ' (chocas seguido)' : ''}`,
      `Distancia total: ${(distance / 1000).toFixed(1)} km (base ${(base.distance / 1000).toFixed(1)} km)`,
      `Agresividad: ${Math.round(pursuers.aggression * 100)}% · Puntería: ${Math.round(pursuers.accuracy * 100)}%`,
    ];
    if (helicopter) adaptiveNotes.push('Helicóptero policial: eres demasiado bueno');

    return {
      distance,
      obstacleDensity,
      obstacleWeights: weights,
      hazardDensity: base.hazardDensity * (0.7 + 0.6 * s),
      trafficDensity: base.trafficDensity * (0.8 + 0.4 * s),
      pursuers,
      roadblockEvery,
      helicopter,
      adaptiveNotes,
    };
  }
}

export function kindLabel(k: PursuerKind): string {
  return {
    patrol: 'patrullas',
    moto: 'motos policiales',
    suv: 'SUVs',
    swat: 'SWAT',
    muscle: 'muscle cars',
    biker: 'moteros',
    pickup: 'pickups armadas',
    truck: 'tráileres',
    van: 'furgón blindado',
    buggy: 'buggies',
    mutant: 'mutantes',
    flyer: 'harpías mutantes',
    pyro: 'incineradores con lanzallamas',
    raider: 'moteros mutantes',
    rig: 'camiones de guerra',
  }[k];
}
