import * as THREE from 'three';
import type { Audio } from '../core/Audio';
import { Effects } from '../fx/Particles';
import type { HudState } from '../ui/Hud';
import { CameraRig, type CamTarget } from '../world/CameraRig';
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
  private targets: CamTarget[] = [];
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
    this.targets = f.cam.targets;
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

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.decoder.update(dt);
    this.fx.update(dt);
    if (!this.placed && this.targets.length) {
      this.placed = true;
      this.rig.place(this.targets[0].px, this.targets[0].pz - 8);
    }
    this.rig.update(camera, dt, this.targets, this.shake, this.zoom);
  }

  dispose(): void {
    this.fx.dispose();
    this.decoder.dispose();
  }
}
