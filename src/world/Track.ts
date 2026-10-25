import type { Biome } from '../config/types';
import { clamp01 } from '../core/math';
import type { Rng } from '../core/Rng';

/** Longitud de cada tramo generado. */
export const CHUNK = 40;
/** Ancho de las aceras de la ciudad. */
export const SIDEWALK = 3;
/** Límite lateral (paredes invisibles) en tramos normales. */
export const BOUND = 34;
/** Límite lateral en tramos con calles transversales. */
export const WIDE_BOUND = 62;

export const HALF_WIDTH: Record<Biome, number> = {
  desert: 8,
  outskirts: 9,
  city: 12,
  plaza: 12,
  bankBack: 12,
  bankEnd: 12,
  bridge: 10,
  tunnelEnd: 10,
  tunnelExit: 11,
  industrial: 11,
  plantEnd: 11,
  plantBack: 10,
  wasteland: 10,
  safeZone: 10,
};

/** Largo del estribo de concreto a la entrada del puente (tierra firme sobre el río). */
export const BRIDGE_ABUTMENT = 6;

/** Biomas donde salirse del asfalto frena la moto (tierra, arena, escombros). */
export const ROUGH_BIOMES = new Set<Biome>(['desert', 'outskirts', 'wasteland', 'safeZone']);

/**
 * Trazado de la carretera. El avance se mide con "d" (distancia recorrida),
 * y en el mundo z = -d: avanzar es subir en pantalla. El centro de la vía
 * serpentea con dos senos superpuestos.
 */
export class Track {
  private readonly p1: number;
  private readonly p2: number;
  private readonly p3: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly a3: number;
  private readonly f1: number;
  private readonly f2: number;
  private readonly f3: number;
  private biomes = new Map<number, Biome>();

  constructor(rng: Rng) {
    // Cada partida tiene su propio trazado: amplitudes y frecuencias aleatorias.
    this.p1 = rng.range(0, Math.PI * 2);
    this.p2 = rng.range(0, Math.PI * 2);
    this.p3 = rng.range(0, Math.PI * 2);
    this.a1 = rng.range(8, 20);
    this.a2 = rng.range(3, 9);
    this.a3 = rng.range(0.5, 2.5);
    this.f1 = rng.range(0.003, 0.0055);
    this.f2 = rng.range(0.008, 0.013);
    this.f3 = rng.range(0.018, 0.026);
  }

  centerX(d: number): number {
    const ramp = clamp01((d - 30) / 160);
    const wave = (a: number, f: number, p: number) => a * (Math.sin(d * f + p) - Math.sin(p));
    return ramp * (wave(this.a1, this.f1, this.p1) + wave(this.a2, this.f2, this.p2) + wave(this.a3, this.f3, this.p3));
  }

  slope(d: number): number {
    return this.centerX(d + 0.5) - this.centerX(d - 0.5);
  }

  /** Ángulo (convención del juego) de la dirección de la vía en d. */
  angle(d: number): number {
    return -Math.atan(this.slope(d));
  }

  setBiome(chunkIndex: number, biome: Biome): void {
    this.biomes.set(chunkIndex, biome);
  }

  biomeAt(d: number): Biome {
    return this.biomes.get(Math.floor(d / CHUNK)) ?? this.biomes.get(0) ?? 'desert';
  }

  halfWidth(d: number): number {
    return HALF_WIDTH[this.biomeAt(d)];
  }

  /** Distancia lateral al centro de la vía (en unidades del mundo). */
  lateral(x: number, d: number): number {
    return x - this.centerX(d);
  }

  /**
   * Distancia lateral a partir de la cual hay agua (río bajo el puente), o null
   * si en ese punto no hay río. Las barandas del puente están justo en ese borde.
   */
  waterEdge(d: number): number | null {
    const biome = this.biomeAt(d);
    if (biome === 'bridge') {
      // El estribo de concreto (los primeros metros del puente) es tierra firme.
      const i = Math.floor(d / CHUNK);
      if (this.biomes.get(i - 1) !== 'bridge' && d - i * CHUNK < BRIDGE_ABUTMENT) return null;
      return HALF_WIDTH.bridge + 1.3;
    }
    // El túnel final empieza con 10 m de puente.
    if (biome === 'tunnelEnd' && d - Math.floor(d / CHUNK) * CHUNK < 10) return HALF_WIDTH.tunnelEnd + 1.3;
    return null;
  }

  isWater(x: number, d: number): boolean {
    const edge = this.waterEdge(d);
    return edge !== null && Math.abs(this.lateral(x, d)) > edge;
  }

  isOffroad(x: number, d: number): boolean {
    const biome = this.biomeAt(d);
    const margin = ROUGH_BIOMES.has(biome) ? 1.5 : SIDEWALK;
    return Math.abs(this.lateral(x, d)) > HALF_WIDTH[biome] + margin;
  }
}
