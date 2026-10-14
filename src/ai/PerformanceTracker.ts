/**
 * Recolecta métricas de desempeño durante un nivel. En el nivel 0 alimenta a la IA
 * que clasifica la habilidad del jugador; en los niveles 1-3 sirve para reajustarla.
 */
export interface PerformanceMetrics {
  players: number;
  time: number;
  distance: number;
  speedSum: number;
  speedSamples: number;
  collisions: number;
  damageTaken: number;
  obstaclesPassed: number;
  obstaclesHit: number;
  nearMisses: number;
  offroadTime: number;
  hazardTime: number;
  dangerTime: number;
  steerChanges: number;
  bulletsFired: number;
  bulletsHit: number;
  copsWrecked: number;
}

export const emptyMetrics = (players: number): PerformanceMetrics => ({
  players,
  time: 0,
  distance: 0,
  speedSum: 0,
  speedSamples: 0,
  collisions: 0,
  damageTaken: 0,
  obstaclesPassed: 0,
  obstaclesHit: 0,
  nearMisses: 0,
  offroadTime: 0,
  hazardTime: 0,
  dangerTime: 0,
  steerChanges: 0,
  bulletsFired: 0,
  bulletsHit: 0,
  copsWrecked: 0,
});

export class PerformanceTracker {
  readonly m: PerformanceMetrics;
  private lastSteer: number[] = [];

  constructor(players: number) {
    this.m = emptyMetrics(players);
  }

  tick(dt: number): void {
    this.m.time += dt;
  }

  /** Se llama una vez por frame por cada jugador vivo. */
  samplePlayer(index: number, dt: number, speed: number, maxSpeed: number, steer: number, offroad: boolean): void {
    this.m.speedSum += speed / maxSpeed;
    this.m.speedSamples++;
    if (offroad) this.m.offroadTime += dt / this.m.players;
    const s = Math.sign(Math.round(steer));
    if (this.lastSteer[index] !== undefined && s !== this.lastSteer[index]) this.m.steerChanges++;
    this.lastSteer[index] = s;
  }

  setDistance(d: number): void {
    this.m.distance = Math.max(this.m.distance, d);
  }

  collision(damage: number): void {
    this.m.collisions++;
    this.m.damageTaken += damage;
  }

  damage(amount: number): void {
    this.m.damageTaken += amount;
  }

  obstacle(hit: boolean, nearMiss: boolean): void {
    if (hit) this.m.obstaclesHit++;
    else this.m.obstaclesPassed++;
    if (!hit && nearMiss) this.m.nearMisses++;
  }

  hazard(dt: number): void {
    this.m.hazardTime += dt / this.m.players;
  }

  danger(dt: number): void {
    this.m.dangerTime += dt / this.m.players;
  }

  bullet(hit: boolean): void {
    this.m.bulletsFired++;
    if (hit) this.m.bulletsHit++;
  }

  copWrecked(): void {
    this.m.copsWrecked++;
  }
}
