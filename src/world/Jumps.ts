import type { Audio } from '../core/Audio';
import { clamp, clamp01, wrapAngle } from '../core/math';
import type { Player } from '../entities/Player';
import type { Effects } from '../fx/Particles';
import type { Track } from './Track';

/** Lo que los saltos necesitan del nivel. */
export interface JumpHost {
  track: Track;
  fx: Effects;
  audio: Audio;
  message(text: string, color?: string, seconds?: number): void;
  /** Prefijo de los avisos ("J2: ") cuando hay varios jugadores. */
  who(p: Player): string;
  damage(p: Player, amount: number): void;
  score(points: number): void;
  /** Temblor de cámara mínimo. */
  shake(amount: number): void;
}

/** Rampa tal como la necesitan los saltos: centro y medio ancho/largo. */
export interface RampZone {
  x: number;
  d: number;
  hw: number;
  hd: number;
}

/**
 * Rampas y saltos de los jugadores: despegue (normal o torcido según cuántas
 * llantas suben), rozones con la esquina, vuelo y aterrizaje.
 */
export class Jumps {
  /** Saltos completados en el nivel (para las estadísticas y desbloqueos). */
  landed = 0;

  constructor(private host: JumpHost) {}

  /** Cuenta atrás del rozón: al terminar, el vehículo vuelve a chocar con todo. */
  tick(p: Player, dt: number): void {
    if (p.graze <= 0) return;
    p.graze -= dt;
    if (p.graze <= 0 && p.air <= 0 && !p.cutscene) p.setGhost(false);
  }

  /**
   * ¿Toma la rampa? Basta con entrar de frente, con buena parte del vehículo
   * sobre ella y algo de velocidad: despega justo antes de tocarla. Si no (de
   * lado, desde atrás, casi detenido), la rampa es sólida y choca.
   */
  tryRamp(p: Player, h: RampZone, dt: number): boolean {
    const v = p.vehicle;
    const s = v.spec;
    const speed = v.speed;
    if (p.air > 0 || p.graze > 0 || speed < 4) return false;
    // Posición en el sistema de la rampa, que está girada con la curva de la carretera:
    // `along` hacia adelante (como d) y `lat` hacia su derecha.
    const a = this.host.track.angle(h.d);
    const dx = v.px - h.x;
    const dz = v.pz + h.d;
    const along = -dx * Math.sin(a) - dz * Math.cos(a);
    const lat = dx * Math.cos(a) - dz * Math.sin(a);
    // Entre un poco antes del borde de entrada (lo que avanzará este cuadro) y el final de la rampa.
    if (along + s.hz + speed * dt * 2 + 0.4 < -h.hd || along - s.hz > h.hd) return false;
    // De frente: rumbo parecido al de la rampa.
    if (Math.abs(wrapAngle(v.heading - a)) > 0.75) return false;
    const clearance = h.hd - along + s.hz + 1;
    const overlap = Math.min(lat + s.hx, h.hw) - Math.max(lat - s.hx, -h.hw);
    if (overlap <= 0) return false;
    // La moto tiene una sola línea de ruedas: salta aunque tome la rampa por la esquina.
    if (p.def.twoWheeler) {
      if (Math.abs(lat) > h.hw + s.hx * 0.5) this.graze(p, Math.sign(lat) || 1, overlap);
      else this.launch(p, clearance);
      return true;
    }
    // Con cuatro ruedas cuenta qué parte del ancho sube a la rampa.
    const cover = overlap / Math.min(2 * s.hx, 2 * h.hw);
    if (cover >= 0.8) {
      this.launch(p, clearance);
      return true;
    }
    // Menos de un tercio: la esquina de la rampa lo golpea de refilón y lo desvía.
    if (cover < 0.3) {
      this.graze(p, Math.sign(lat) || 1, overlap);
      return true;
    }
    // Solo un lado de llantas sube: salto torcido hacia el lado que quedó fuera.
    this.launch(p, clearance, Math.sign(lat) || 1, cover);
    return true;
  }

  /**
   * Rozón con la esquina de una rampa: un golpe de refilón que desvía el
   * vehículo hacia afuera, lo hace girar y le quita velocidad, sin frenarlo en
   * seco. Pasa de largo un instante sin engancharse en la rampa.
   */
  private graze(p: Player, side: number, overlap: number): void {
    const v = p.vehicle;
    const road = this.host.track.angle(v.d);
    const hit = Math.min(1, overlap / 0.8);
    // Giro brusco hacia afuera y empujón lateral para salir de la rampa.
    v.heading -= side * (0.18 + hit * 0.22);
    const push = 4 + hit * 4;
    v.vx = v.vx * 0.8 + Math.cos(road) * side * push;
    v.vz = v.vz * 0.8 - Math.sin(road) * side * push;
    v.apply();
    p.setGhost(true);
    p.graze = 0.22;
    const fwd = this.host.track.angle(v.d);
    this.host.fx.sparks(v.px - side * v.spec.hx * Math.cos(fwd), v.pz + side * v.spec.hx * Math.sin(fwd), 16);
    this.host.audio.crash(0.45 + hit * 0.3);
    this.host.shake(0.4 + hit * 0.3);
    this.host.damage(p, 3 + hit * 6);
    this.host.message(`${this.host.who(p)}¡Rozón!`, '#ff9f43', 0.8);
  }

  /**
   * Despegue desde una rampa: en el aire no hay colisiones ni se puede girar.
   * `side` (±1) indica un salto torcido: solo las llantas del lado contrario
   * subieron (`cover` = parte del ancho sobre la rampa). El vehículo vuela más
   * bajo, se inclina, sale empujado hacia ese lado y gira desviándose.
   */
  private launch(p: Player, clearance = 0, side = 0, cover = 1): void {
    const v = p.vehicle;
    // Vuela al menos lo necesario para pasar la rampa completa (aunque se tome despacio).
    const minAir = clearance > 0 ? clearance / Math.max(4, v.speed * 1.05) : 0;
    if (side) {
      const off = 1 - cover;
      p.airDur = clamp(minAir * 0.9, 0.4, 0.9);
      p.airLift = 0.35 + cover * 0.35;
      p.airRoll = side * (0.35 + off * 0.5);
      // Gira hacia el lado que cae: con el rumbo hacia la derecha (+X) el ángulo baja.
      p.airYaw = (-side * (0.35 + off * 0.6)) / p.airDur;
      // Empujón lateral (perpendicular a la carretera) y algo de velocidad perdida.
      const road = this.host.track.angle(v.d);
      const push = 3 + off * 4;
      v.vx = v.vx * 0.92 + Math.cos(road) * side * push;
      v.vz = v.vz * 0.92 - Math.sin(road) * side * push;
      this.host.fx.sparks(v.px + side * v.spec.hx, v.pz, 8);
      this.host.audio.crash(0.3);
    } else {
      p.airDur = clamp(Math.max((0.45 + (v.speed / v.spec.maxSpeed) * 0.5) * p.def.jump, minAir), 0.45, 1.6);
      p.airLift = 1;
      p.airRoll = 0;
      p.airYaw = 0;
      v.vx *= 1.05;
      v.vz *= 1.05;
      this.host.audio.blip(520);
    }
    p.air = p.airDur;
    p.setGhost(true);
    this.host.fx.dust(v.px, v.pz, 0x9a9a9a, 6, 1.6);
  }

  updateAir(p: Player, dt: number): void {
    const v = p.vehicle;
    p.air -= dt;
    const t = clamp01(1 - p.air / p.airDur);
    const h = Math.sin(t * Math.PI);
    p.mesh.position.y = h * 3.2 * (p.airDur / 0.9) * p.airLift;
    p.mesh.scale.setScalar(1 + h * 0.35 * p.airLift);
    p.mesh.rotation.x = (0.5 - t) * 0.8 * p.airLift;
    // Salto torcido: alabeo hacia el lado que no tocó la rampa y giro en el aire.
    p.mesh.rotation.z = -p.airRoll * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (1 - t * 0.5);
    v.heading += p.airYaw * dt;
    // En el aire no hay roce con el suelo: conserva la velocidad del despegue.
    v.apply();
    // Nunca aterrizar dentro de un edificio ni sobre el río.
    const lat = this.host.track.lateral(v.px, v.d);
    const edge = this.host.track.waterEdge(v.d);
    const maxLat = Math.min(edge !== null ? edge - 1 : Infinity, this.host.track.halfWidth(v.d) + 1.5);
    if (Math.abs(lat) > maxLat) {
      const x = this.host.track.centerX(v.d) + Math.sign(lat) * maxLat;
      v.body.setTranslation({ x, y: 1, z: v.pz }, true);
      v.px = x;
      v.vx *= 0.3;
    }
    if (p.air <= 0) {
      p.air = 0;
      this.landed++;
      p.mesh.position.y = 0;
      p.mesh.scale.setScalar(1);
      p.mesh.rotation.x = 0;
      p.mesh.rotation.z = 0;
      p.setGhost(false);
      this.host.fx.dust(v.px, v.pz, 0x8a8a8a, 10, 2.2);
      this.host.fx.sparks(v.px, v.pz, 6);
      if (p.airRoll) {
        // Aterrizaje torcido: cae sobre un lado, pierde velocidad y se golpea.
        const hard = Math.abs(p.airRoll);
        v.vx *= 0.78;
        v.vz *= 0.78;
        v.apply();
        this.host.fx.sparks(v.px, v.pz, 14);
        this.host.audio.crash(0.6 + hard * 0.4);
        this.host.shake(0.7);
        this.host.damage(p, 4 + hard * 10);
        this.host.score(100);
        this.host.message(`${this.host.who(p)}¡Salto torcido! +100`, '#ff9f43', 1.2);
        p.airRoll = 0;
        p.airYaw = 0;
      } else {
        this.host.audio.crash(0.35);
        this.host.shake(0.45);
        this.host.score(300);
        p.turbo = Math.min(1, p.turbo + 0.15);
        this.host.message(`${this.host.who(p)}¡Salto! +300`, '#ffd27a', 1);
      }
    }
  }
}
