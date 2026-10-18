import { Music, type MusicMode } from './Music';

/** Canales de volumen ajustables por el jugador. */
export type SoundChannel = 'master' | 'music' | 'engine' | 'player' | 'enemies' | 'impacts' | 'ui';

export type Volumes = Record<SoundChannel, number>;

export const DEFAULT_VOLUMES: Volumes = { master: 1, music: 0.8, engine: 0.8, player: 0.8, enemies: 0.8, impacts: 0.9, ui: 0.8 };

/** Ganancia del bus maestro con el volumen general al 100 %. */
const MASTER_GAIN = 0.5;

/**
 * Audio sintetizado con WebAudio: no requiere archivos externos.
 * Cada tipo de sonido va por su propio bus con volumen independiente:
 * música, motor de la moto, enemigos (sirenas y disparos), choques y
 * explosiones, e interfaz. Todos terminan en el bus general.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses = {} as Record<Exclude<SoundChannel, 'master'>, GainNode>;
  private engineOsc!: OscillatorNode;
  private engineGain!: GainNode;
  private sirenOsc!: OscillatorNode;
  private sirenGain!: GainNode;
  private noise!: AudioBuffer;
  private sirenPhase = 0;
  private music: Music | null = null;
  /** Modo pedido antes de desbloquear el audio; se aplica al crear la música. */
  private pendingMusic: { mode: MusicMode; level: number } = { mode: 'calm', level: 0 };
  private lastPreview = 0;
  muted = false;
  musicOn = true;
  volumes: Volumes = { ...DEFAULT_VOLUMES };

  /** Debe llamarse tras una interacción del usuario (política de autoplay). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    for (const ch of ['music', 'engine', 'player', 'enemies', 'impacts', 'ui'] as const) {
      const bus = ctx.createGain();
      bus.connect(this.master);
      this.buses[ch] = bus;
    }
    this.applyVolumes();

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 50;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(lp).connect(this.engineGain).connect(this.buses.engine);
    this.engineOsc.start();

    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 700;
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain).connect(this.buses.enemies);
    this.sirenOsc.start();

    const len = ctx.sampleRate * 1.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.music = new Music(ctx, this.buses.music);
    this.music.setEnabled(this.musicOn);
    this.music.setMode(this.pendingMusic.mode, this.pendingMusic.level);
  }

  // ------------------------------------------------------------ volumen

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_GAIN * this.volumes.master, t, 0.05);
    for (const ch of Object.keys(this.buses) as (keyof typeof this.buses)[]) this.buses[ch].gain.setTargetAtTime(this.volumes[ch], t, 0.05);
  }

  setVolume(channel: SoundChannel, v: number): void {
    this.volumes[channel] = Math.max(0, Math.min(1, v));
    this.applyVolumes();
  }

  setVolumes(volumes: Volumes): void {
    this.volumes = { ...DEFAULT_VOLUMES, ...volumes };
    this.applyVolumes();
  }

  /** Sonido de muestra al mover un control de volumen (con un mínimo entre muestras). */
  preview(channel: SoundChannel): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastPreview < 0.18) return;
    this.lastPreview = now;
    switch (channel) {
      case 'engine': {
        const t = this.ctx.currentTime;
        this.engineOsc.frequency.setValueAtTime(70, t);
        this.engineOsc.frequency.linearRampToValueAtTime(160, t + 0.35);
        this.engineGain.gain.setValueAtTime(0.11, t);
        this.engineGain.gain.setTargetAtTime(0, t + 0.4, 0.08);
        break;
      }
      case 'enemies':
        this.shot();
        break;
      case 'player':
        this.playerShot();
        break;
      case 'impacts':
        this.crash(0.8);
        break;
      case 'master':
      case 'ui':
        this.blip(880);
        break;
      case 'music':
        // La música ya suena de fondo: no hace falta muestra.
        break;
    }
  }

  // ------------------------------------------------------------ música

  playMusic(mode: MusicMode, level = 0): void {
    this.pendingMusic = { mode, level };
    this.music?.setMode(mode, level);
  }

  setMusicOn(on: boolean): void {
    this.musicOn = on;
    this.music?.setEnabled(on);
  }

  musicIntensity(v: number): void {
    this.music?.setIntensity(v);
  }

  duckMusic(on: boolean): void {
    this.music?.duck(on);
  }

  resyncMusic(): void {
    this.music?.resync();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolumes();
  }

  // ------------------------------------------------------------ efectos

  /** speed01: 0..1, active: si hay vehículos en marcha, tone: tono del motor (1 = moto). */
  engine(speed01: number, active: boolean, tone = 1): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime((45 + speed01 * 130) * tone, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.05 + speed01 * 0.07 : 0, t, 0.1);
  }

  /** intensity: 0..1 según cercanía de la policía. */
  siren(intensity: number, dt: number): void {
    if (!this.ctx) return;
    this.sirenPhase += dt;
    const t = this.ctx.currentTime;
    const hi = Math.floor(this.sirenPhase * 1.6) % 2 === 0;
    this.sirenOsc.frequency.setTargetAtTime(hi ? 920 : 640, t, 0.03);
    this.sirenGain.gain.setTargetAtTime(intensity * 0.05, t, 0.15);
  }

  stopLoops(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(0, t, 0.05);
    this.sirenGain.gain.setTargetAtTime(0, t, 0.05);
  }

  private burst(bus: GainNode, duration: number, freq: number, type: BiquadFilterType, volume: number, pitchDrop = 0): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    if (pitchDrop > 0) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq * pitchDrop), ctx.currentTime + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.connect(filter).connect(gain).connect(bus);
    src.start();
    src.stop(ctx.currentTime + duration);
  }

  /** Disparo del arma de la moto (más grave que el de los enemigos). */
  playerShot(): void {
    this.burst(this.buses.player, 0.1, 1400, 'highpass', 0.28);
    this.burst(this.buses.player, 0.14, 300, 'lowpass', 0.3, 0.5);
  }

  /** Clic del arma sin munición. */
  emptyClick(): void {
    this.burst(this.buses.player, 0.03, 4000, 'highpass', 0.15);
  }

  /** Disparos de los enemigos. */
  shot(): void {
    this.burst(this.buses.enemies, 0.12, 2500, 'highpass', 0.25);
  }

  crash(strength = 1): void {
    this.burst(this.buses.impacts, 0.25 + strength * 0.2, 900, 'lowpass', 0.35 * Math.min(1.5, strength), 0.3);
  }

  explosion(): void {
    this.burst(this.buses.impacts, 1.3, 700, 'lowpass', 0.9, 0.08);
  }

  /** Avisos de interfaz: cuenta regresiva, recompensas. */
  blip(freq = 880): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(g).connect(this.buses.ui);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  }
}
