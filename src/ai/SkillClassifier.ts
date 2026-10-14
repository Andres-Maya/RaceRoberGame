import { clamp01, sigmoid } from '../core/math';
import type { PerformanceMetrics } from './PerformanceTracker';

/**
 * Vector de características normalizadas (0 = mal desempeño, 1 = excelente).
 * Es la misma entrada que recibiría un modelo de TensorFlow.js entrenado más adelante:
 * el historial guardado en localStorage contiene estos vectores para construir el dataset.
 */
/**
 * `ref` es el valor que obtendría un jugador promedio: la IA compara cada
 * característica contra esa referencia (no contra 0.5), porque varias métricas
 * salen altas incluso jugando mal (p. ej. el control en la vía).
 */
export const FEATURES = [
  { key: 'avoidance', label: 'Esquive de obstáculos', weight: 1.6, ref: 0.75 },
  { key: 'collisions', label: 'Pocos choques', weight: 1.4, ref: 0.5 },
  { key: 'integrity', label: 'Integridad de la moto', weight: 1.4, ref: 0.6 },
  { key: 'speed', label: 'Avance real', weight: 1.6, ref: 0.55 },
  { key: 'nearMiss', label: 'Pasadas al límite', weight: 0.5, ref: 0.3 },
  { key: 'control', label: 'Control en la vía', weight: 0.8, ref: 0.8 },
  { key: 'smoothness', label: 'Suavidad de manejo', weight: 0.3, ref: 0.5 },
  { key: 'composure', label: 'Sangre fría', weight: 1.0, ref: 0.7 },
] as const;

/** Velocidad de referencia (u/s) de un recorrido limpio sin turbo. */
const IDEAL_SPEED = 34;

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
  // Cada golpe pesa como tres esquives: chocar debe notarse en el perfil.
  const weighted = m.obstaclesPassed + m.obstaclesHit * 3;
  // Avance real: distancia por segundo, que ya refleja frenazos y choques
  // (mantener el acelerador presionado no basta).
  const progress = m.time > 1 ? m.distance / m.time / IDEAL_SPEED : 0;
  return {
    avoidance: weighted > 0 ? m.obstaclesPassed / weighted : 0.5,
    collisions: 1 - clamp01(m.collisions / players / minutes / 5),
    integrity: 1 - clamp01(m.damageTaken / players / 80),
    speed: clamp01((progress - 0.35) / 0.55),
    nearMiss: clamp01(m.nearMisses / players / minutes / 10),
    control: 1 - clamp01(((m.offroadTime + m.hazardTime) / Math.max(m.time, 1)) * 3),
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
  readonly name = 'Reglas ponderadas v2';

  predict(f: FeatureVector): number {
    let z = 0;
    for (const { key, weight, ref } of FEATURES) z += weight * (f[key] - ref);
    return sigmoid(z * 1.3);
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
