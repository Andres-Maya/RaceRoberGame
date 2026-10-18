import * as THREE from 'three';
import type { Audio } from '../core/Audio';
import { Effects } from '../fx/Particles';
import type { HudState } from '../ui/Hud';
import { CameraRig, cameraFocus, type CamPlayer } from '../world/CameraRig';
import { FX_CALLS, SFX_CALLS, type FrameMessage, type NetCall } from './protocol';
import { SceneDecoder, type SceneDelta } from './SceneSync';

const FX_SET = new Set<string>(FX_CALLS);

/**
 * Lado del invitado: reconstruye la escena del anfitrión, repite efectos y
 * sonidos, y sigue a los jugadores con su propia cámara.
 */
export class GuestView {
  readonly scene = new THREE.Scene();
  hud: HudState;
  private decoder: SceneDecoder;
  private fx: Effects;
  private rig = new CameraRig();
  /** Vehículos de todos los jugadores según el último cuadro. */
  players: CamPlayer[] = [];
  private sun: THREE.DirectionalLight | null = null;
  private shake = 0;
  private zoom = 0;
  private placed = false;
  engine: [number, boolean, number] = [0, false, 1];
  siren = 0;
  intensity = 0;

  constructor(
    scene: SceneDelta,
    hud: HudState,
    private audio: Audio,
    shadowSize: number,
  ) {
    this.decoder = new SceneDecoder(this.scene, shadowSize);
    this.fx = new Effects(this.scene);
    this.decoder.apply(scene, false);
    this.hud = hud;
  }

  /** Aplica un cuadro; devuelve los avisos y destellos para el HUD. */
  apply(f: FrameMessage): void {
    this.decoder.apply(f.scene, true);
    this.hud = f.hud;
    this.players = Array.isArray(f.cam.players) ? f.cam.players : [];
    this.shake = f.cam.shake;
    this.zoom = f.cam.zoom;
    this.engine = f.engine;
    this.siren = f.siren;
    this.intensity = f.intensity;
    this.replay(this.fx as unknown as Record<string, unknown>, f.fx, FX_SET);
    this.replay(this.audio as unknown as Record<string, unknown>, f.sfx, SFX_CALLS);
  }

  /** Repite llamadas recibidas, solo de la lista permitida. */
  private replay(target: Record<string, unknown>, calls: NetCall[], allowed: Set<string>): void {
    for (const [name, args] of calls) {
      if (!allowed.has(name) || !Array.isArray(args)) continue;
      const fn = target[name];
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(target, args);
    }
  }

  /** `me`: índice del jugador de este dispositivo (su cámara lo sigue a él). */
  update(dt: number, camera: THREE.PerspectiveCamera, me: number): void {
    this.decoder.update(dt);
    this.fx.update(dt);
    const focus = cameraFocus(this.players, me);
    if (!this.placed && focus) {
      this.placed = true;
      this.rig.place(focus.px, focus.pz - 8);
    }
    this.rig.update(camera, dt, focus, this.shake, this.zoom);
    // El sol del anfitrión sigue a su cámara; aquí se mueve con la del invitado para que haya sombras donde se mira.
    if (!this.sun?.parent) {
      this.sun = null;
      this.scene.traverse((o) => {
        if ((o as THREE.DirectionalLight).isDirectionalLight) this.sun = o as THREE.DirectionalLight;
      });
    }
    if (this.sun) {
      this.sun.position.set(this.rig.x + 35, 110, this.rig.z + 25);
      this.sun.target.position.set(this.rig.x, 0, this.rig.z);
    }
  }

  dispose(): void {
    this.fx.dispose();
    this.decoder.dispose();
  }
}
