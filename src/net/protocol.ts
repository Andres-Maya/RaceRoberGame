import type { VehicleId } from '../config/vehicles';
import type { MusicMode } from '../core/Music';
import type { HudState } from '../ui/Hud';
import type { CamPlayer } from '../world/CameraRig';
import type { SceneDelta } from './SceneSync';

/** Cambia si el formato de los mensajes deja de ser compatible. */
export const PROTOCOL = 5;

/** Sonidos puntuales que el invitado repite. */
export const SFX_CALLS = new Set(['blip', 'crash', 'explosion', 'shot', 'playerShot', 'emptyClick', 'stopLoops']);
/** Efectos de partículas que el invitado repite con su propio sistema. */
export const FX_CALLS = ['blast', 'shockwave', 'flame', 'explosion', 'splash', 'splatter', 'sparks', 'dust', 'muzzle', 'turbo', 'smokeTrail'] as const;

/** Controles del invitado en forma compacta: [acelerar, frenar, giro, turbo, disparo, rumbo del joystick]. */
export type PackedInput = [number, number, number, 0 | 1, 0 | 1, number | null];

/** Llamada a efectos o sonidos que el invitado repite: [método, argumentos]. */
export type NetCall = [string, unknown[]];

/** Estado de un cuadro de la partida que el anfitrión envía al invitado. */
export interface FrameMessage {
  t: 'frame';
  scene: SceneDelta;
  hud: HudState;
  /** Vehículos de todos los jugadores en orden: cada uno sigue al suyo con su cámara. */
  cam: { players: CamPlayer[]; shake: number; zoom: number };
  fx: NetCall[];
  sfx: NetCall[];
  /** Avisos [texto, color, segundos] y destellos de pantalla. */
  msg: [string, string | undefined, number | undefined][];
  flash: string[];
  /** Motor [velocidad 0..1, activo, tono] y sirena (intensidad). */
  engine: [number, boolean, number];
  siren: number;
  intensity: number;
}

export type NetMessage =
  // invitado → anfitrión
  | { t: 'hello'; v: number; vehicle: VehicleId }
  | { t: 'vehicle'; vehicle: VehicleId }
  | { t: 'input'; i: PackedInput }
  | { t: 'pause' }
  // anfitrión → invitado
  | { t: 'welcome'; v: number }
  | { t: 'lobby'; text: string }
  | { t: 'screen'; html: string; variant: string }
  | { t: 'music'; mode: MusicMode; level: number }
  | { t: 'begin'; label: string }
  | { t: 'init'; me: number; baseCash: number; scene: SceneDelta; hud: HudState }
  | FrameMessage
  /** Fin del nivel, con lo que el invitado suma a su propio progreso (desbloqueos). */
  | { t: 'end'; level: number; outcome: 'complete' | 'failed'; wrecks: number; jumps: number; distance: number }
  | { t: 'bye'; text: string };
