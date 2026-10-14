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
};

/**
 * Trazado de la carretera. El avance se mide con "d" (distancia recorrida),
 * y en el mundo z = -d: avanzar es subir en pantalla. El centro de la vía
 * serpentea con dos senos superpuestos.
 */
export class Track {
  private readonly p1: number;
  private readonly p2: number;
  private readonly a1: number;
  private readonly a2: number;
  private biomes = new Map<number, Biome>();

  constructor(rng: Rng) {
    this.p1 = rng.range(0, Math.PI * 2);
    this.p2 = rng.range(0, Math.PI * 2);
    this.a1 = rng.range(12, 20);
    this.a2 = rng.range(5, 9);
  }

  centerX(d: number): number {
    const ramp = clamp01((d - 30) / 160);
    return ramp * (this.a1 * Math.sin(d * 0.004 + this.p1) + this.a2 * Math.sin(d * 0.011 + this.p2) - this.a1 * Math.sin(this.p1) - this.a2 * Math.sin(this.p2));
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

  isOffroad(x: number, d: number): boolean {
    const biome = this.biomeAt(d);
    const margin = biome === 'desert' || biome === 'outskirts' ? 1.5 : SIDEWALK;
    return Math.abs(this.lateral(x, d)) > HALF_WIDTH[biome] + margin;
  }
}
