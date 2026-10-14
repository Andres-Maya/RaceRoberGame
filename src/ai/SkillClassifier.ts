import { clamp01, sigmoid } from '../core/math';
import type { PerformanceMetrics } from './PerformanceTracker';

/**
 * Vector de características normalizadas (0 = mal desempeño, 1 = excelente).
 * Es la misma entrada que recibiría un modelo de TensorFlow.js entrenado más adelante:
 * el historial guardado en localStorage contiene estos vectores para construir el dataset.
 */
export const FEATURES = [
  { key: 'avoidance', label: 'Esquive de obstáculos', weight: 1.6 },
  { key: 'collisions', label: 'Pocos choques', weight: 1.2 },
  { key: 'integrity', label: 'Integridad de la moto', weight: 1.2 },
  { key: 'speed', label: 'Velocidad media', weight: 1.8 },
  { key: 'nearMiss', label: 'Pasadas al límite', weight: 0.8 },
  { key: 'control', label: 'Control en la vía', weight: 0.8 },
  { key: 'smoothness', label: 'Suavidad de manejo', weight: 0.4 },
  { key: 'composure', label: 'Sangre fría', weight: 1.0 },
] as const;

export type FeatureKey = (typeof FEATURES)[number]['key'];
export type FeatureVector = Record<FeatureKey, number>;

export type SkillTier = 'Novato' | 'Intermedio' | 'Experto' | 'Leyenda';

export interface SkillProfile {
  skill: number;
  tier: SkillTier;
  features: FeatureVector;
  /** Cuántos niveles se han usado para estimar la habilidad. */
  samples: number;
  classifier: string;
}

export function extractFeatures(m: PerformanceMetrics): FeatureVector {
  const minutes = Math.max(m.time / 60, 0.1);
  const players = Math.max(1, m.players);
  const encountered = m.obstaclesPassed + m.obstaclesHit;
  return {
    avoidance: encountered > 0 ? m.obstaclesPassed / encountered : 0.5,
    collisions: 1 - clamp01(m.collisions / players / minutes / 10),
    integrity: 1 - clamp01(m.damageTaken / players / 120),
    speed: m.speedSamples > 0 ? clamp01(((m.speedSum / m.speedSamples) - 0.25) / 0.65) : 0,
    nearMiss: clamp01(m.nearMisses / players / minutes / 8),
    control: 1 - clamp01(((m.offroadTime + m.hazardTime) / Math.max(m.time, 1)) * 2.5),
    smoothness: 1 - clamp01((m.steerChanges / players / minutes - 25) / 90),
    composure: 1 - clamp01((m.dangerTime / Math.max(m.time, 1)) * 4),
  };
}

export function tierFor(skill: number): SkillTier {
  if (skill < 0.35) return 'Novato';
  if (skill < 0.65) return 'Intermedio';
  if (skill < 0.85) return 'Experto';
  return 'Leyenda';
}

/** Contrato común para el clasificador por reglas y uno futuro basado en TensorFlow.js. */
export interface SkillClassifier {
  readonly name: string;
  predict(features: FeatureVector): number;
}

/**
 * Primera versión recomendada: un modelo lineal con pesos ajustados a mano
 * seguido de una sigmoide (equivale a una regresión logística sin entrenar).
 * Un modelo de TF.js podría reemplazarlo implementando la misma interfaz:
 *   const model = await tf.loadLayersModel('/models/skill/model.json');
 *   predict = f => model.predict(tf.tensor2d([FEATURES.map(x => f[x.key])])).dataSync()[0]
 */
export class RuleBasedClassifier implements SkillClassifier {
  readonly name = 'Reglas ponderadas v1';

  predict(f: FeatureVector): number {
    let z = 0;
    for (const { key, weight } of FEATURES) z += weight * (f[key] - 0.5);
    return sigmoid(z * 0.9);
  }
}

export function buildProfile(classifier: SkillClassifier, m: PerformanceMetrics): SkillProfile {
  const features = extractFeatures(m);
  const skill = classifier.predict(features);
  return { skill, tier: tierFor(skill), features, samples: 1, classifier: classifier.name };
}

/**
 * Reajuste tras un nivel de persecución: el nivel 0 pesa más, pero el perfil
 * se mueve hacia el desempeño reciente para que la dificultad siga al jugador.
 */
export function blendProfile(previous: SkillProfile, recent: SkillProfile, weightRecent = 0.3): SkillProfile {
  const skill = previous.skill * (1 - weightRecent) + recent.skill * weightRecent;
  const features = { ...previous.features };
  for (const { key } of FEATURES) features[key] = previous.features[key] * (1 - weightRecent) + recent.features[key] * weightRecent;
  return { skill, tier: tierFor(skill), features, samples: previous.samples + 1, classifier: previous.classifier };
}
