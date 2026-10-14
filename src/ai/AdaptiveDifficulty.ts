import { BASE_LEVELS } from '../config/levels';
import type { LevelConfig, PoliceKind } from '../config/types';
import { clamp, clamp01 } from '../core/math';
import type { SkillProfile } from './SkillClassifier';

/**
 * Sistema de dificultad adaptativa: recibe el perfil de habilidad (detectado en el
 * nivel 0 y reajustado después de cada nivel) y genera la configuración concreta
 * de los niveles 1, 2 y 3: cantidad y distribución de obstáculos, tráfico, policía
 * y la duración de cada nivel.
 */
export class AdaptiveDifficulty {
  configFor(level: 1 | 2 | 3, profile: SkillProfile | null, players = 1): LevelConfig {
    const base = BASE_LEVELS[level];
    const s = profile ? profile.skill : 0.5;
    const f = profile?.features;

    // Multiplicador general: 0.6 (novato) .. 1.5 (leyenda).
    const mult = 0.6 + 0.9 * s;
    // Jugadores hábiles corren niveles más largos; los novatos, más cortos.
    const duration = Math.round(base.duration * (0.8 + 0.45 * s));

    // Si esquiva bien, más obstáculos; si choca mucho, la IA alivia la densidad.
    const avoidance = f ? f.avoidance : 0.5;
    const obstacleDensity = base.obstacleDensity * mult * (0.85 + 0.3 * avoidance);

    // Quien va rápido recibe más obstáculos "duros" (barreras, chatarra);
    // quien va lento, obstáculos blandos que solo frenan (conos, cajas).
    const speed = f ? f.speed : 0.5;
    const weights = { ...base.obstacleWeights };
    const hardBias = 0.6 + speed * 0.9;
    for (const k of ['barrier', 'wreck', 'dumpster'] as const) if (weights[k]) weights[k] = weights[k]! * hardBias;
    for (const k of ['cone', 'crate'] as const) if (weights[k]) weights[k] = weights[k]! * (1.6 - speed * 0.8);

    let police = base.police;
    if (police) {
      const kinds: Partial<Record<PoliceKind, number>> = { ...police.kinds };
      // Pilotos expertos atraen unidades rápidas (motos) antes de tiempo.
      if (s > 0.6 && level >= 1) kinds.moto = (kinds.moto ?? 0) + (s - 0.6) * 0.8;
      if (s > 0.75 && level >= 2) kinds.swat = (kinds.swat ?? 0) + (s - 0.75) * 0.8;
      police = {
        maxActive: Math.max(2, Math.round(police.maxActive * (0.7 + 0.7 * s) + (players - 1))),
        spawnInterval: clamp(police.spawnInterval / (0.7 + 0.7 * s), 1.8, 10),
        kinds,
        aggression: clamp01(police.aggression + (s - 0.5) * 0.4),
        accuracy: clamp01(police.accuracy + (s - 0.5) * 0.3),
        fireRate: police.fireRate * (0.75 + 0.6 * s),
      };
    }

    const roadblockEvery =
      base.roadblockEvery > 0 ? Math.round(base.roadblockEvery / (0.7 + 0.6 * s)) : s > 0.8 && level === 1 ? 900 : 0;

    const config: LevelConfig = {
      ...base,
      duration,
      obstacleDensity,
      obstacleWeights: weights,
      hazardDensity: base.hazardDensity * (0.7 + 0.6 * s),
      trafficDensity: base.trafficDensity * (0.8 + 0.4 * s),
      police,
      roadblockEvery,
      helicopter: base.helicopter || (level === 2 && s > 0.85),
      adaptiveNotes: [],
    };

    const pct = (x: number) => `${x >= 1 ? '+' : ''}${Math.round((x - 1) * 100)}%`;
    config.adaptiveNotes = [
      `Duración: ${duration} s (base ${base.duration} s)`,
      `Obstáculos: ${pct(obstacleDensity / base.obstacleDensity)} ${avoidance > 0.7 ? '(esquivas bien)' : avoidance < 0.4 ? '(chocas seguido)' : ''}`.trim(),
      `Obstáculos duros: ${pct(hardBias)} ${speed > 0.65 ? '(vas muy rápido)' : ''}`.trim(),
      `Tráfico civil: ${pct(config.trafficDensity / base.trafficDensity)}`,
    ];
    if (police && base.police) {
      config.adaptiveNotes.push(
        `Patrullas simultáneas: ${police.maxActive} (base ${base.police.maxActive})`,
        `Agresividad policial: ${Math.round(police.aggression * 100)}% · Puntería: ${Math.round(police.accuracy * 100)}%`,
      );
    }
    if (roadblockEvery > 0) config.adaptiveNotes.push(`Retenes cada ~${roadblockEvery} m`);
    if (config.helicopter && !base.helicopter) config.adaptiveNotes.push('Helicóptero adelantado: eres demasiado bueno');
    return config;
  }
}
