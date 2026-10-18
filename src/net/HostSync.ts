import type { Audio } from '../core/Audio';
import type { DriveInput } from '../core/Input';
import { hudState } from '../ui/Hud';
import type { Level, LevelHooks } from '../world/Level';
import type { Link } from './Link';
import { FX_CALLS, SFX_CALLS, type NetCall, type PackedInput } from './protocol';
import { SceneEncoder } from './SceneSync';

/** Envíos por segundo al invitado (el invitado interpola entre ellos). */
const SEND_RATE = 30;

export function unpackInput(i: PackedInput): DriveInput {
  return {
    throttle: i[0],
    brake: i[1],
    steer: i[2],
    turbo: i[3] === 1,
    shoot: i[4] === 1,
    aim: i[5] !== null && i[6] !== null ? { x: i[5], z: i[6] } : null,
  };
}

export function packInput(d: DriveInput): PackedInput {
  const r = (x: number) => Math.round(x * 100) / 100;
  return [d.throttle, d.brake, r(d.steer), d.turbo ? 1 : 0, d.shoot ? 1 : 0, d.aim ? r(d.aim.x) : null, d.aim ? r(d.aim.z) : null];
}

/**
 * Lado del anfitrión de una partida en línea: graba sonidos, efectos y avisos
 * del nivel y envía al invitado la escena y el HUD unas 30 veces por segundo.
 */
export class HostSync {
  private encoder = new SceneEncoder();
  private fx: NetCall[] = [];
  private sfx: NetCall[] = [];
  private msg: [string, string | undefined, number | undefined][] = [];
  private flashes: string[] = [];
  private engine: [number, boolean, number] = [0, false, 1];
  private siren = 0;
  private acc = 0;
  private fxDepth = 0;

  constructor(private link: Link) {}

  /** Audio para el nivel: suena en el anfitrión y se repite en el invitado. */
  wrapAudio(audio: Audio): Audio {
    return new Proxy(audio, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        const name = String(prop);
        return (...args: unknown[]) => {
          if (name === 'engine') this.engine = [args[0] as number, args[1] as boolean, (args[2] as number) ?? 1];
          else if (name === 'siren') this.siren = args[0] as number;
          else if (SFX_CALLS.has(name)) this.sfx.push([name, args]);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  wrapHooks(hooks: LevelHooks): LevelHooks {
    return {
      message: (text, color, seconds) => {
        this.msg.push([text, color, seconds]);
        hooks.message(text, color, seconds);
      },
      flash: (color) => {
        this.flashes.push(color);
        hooks.flash(color);
      },
    };
  }

  /** Graba los efectos del nivel (solo la llamada externa: `blast` ya incluye su explosión). */
  attach(level: Level): void {
    const fx = level.fx as unknown as Record<string, (...a: unknown[]) => void>;
    for (const name of FX_CALLS) {
      const orig = fx[name].bind(fx);
      fx[name] = (...args: unknown[]) => {
        if (this.fxDepth === 0) this.fx.push([name, args]);
        this.fxDepth++;
        try {
          orig(...args);
        } finally {
          this.fxDepth--;
        }
      };
    }
  }

  /** Primer envío: la escena completa y el HUD. */
  init(level: Level, baseCash: number): void {
    this.link.send({ t: 'init', me: 1, baseCash, scene: this.encoder.encode(level.scene), hud: hudState(level) });
    this.clear();
  }

  tick(dt: number, level: Level, intensity: number): void {
    this.acc += dt;
    if (this.acc < 1 / SEND_RATE) return;
    this.acc = 0;
    const alive = level.alivePlayers;
    const ref = alive.length ? alive : level.players;
    this.link.send({
      t: 'frame',
      scene: this.encoder.encode(level.scene),
      hud: hudState(level),
      cam: {
        targets: ref.map((p) => ({ px: p.vehicle.px, pz: p.vehicle.pz, vx: p.vehicle.vx, vz: p.vehicle.vz })),
        shake: level.shake,
        zoom: level.cameraZoom,
      },
      fx: this.fx,
      sfx: this.sfx,
      msg: this.msg,
      flash: this.flashes,
      engine: this.engine,
      siren: this.siren,
      intensity,
    });
    this.clear();
  }

  private clear(): void {
    this.fx = [];
    this.sfx = [];
    this.msg = [];
    this.flashes = [];
  }
}
