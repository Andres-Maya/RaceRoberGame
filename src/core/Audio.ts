import { Music, type MusicMode } from './Music';

/**
 * Audio sintetizado con WebAudio: no requiere archivos externos.
 * Motor (oscilador según velocidad), sirena, disparos, choques, explosiones
 * y la banda sonora de death metal (ver Music).
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineOsc!: OscillatorNode;
  private engineGain!: GainNode;
  private sirenOsc!: OscillatorNode;
  private sirenGain!: GainNode;
  private noise!: AudioBuffer;
  private sirenPhase = 0;
  private music: Music | null = null;
  /** Modo pedido antes de desbloquear el audio; se aplica al crear la música. */
  private pendingMusic: { mode: MusicMode; level: number } = { mode: 'menu', level: 0 };
  muted = false;
  musicOn = true;

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
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 50;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(lp).connect(this.engineGain).connect(this.master);
    this.engineOsc.start();

    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 700;
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain).connect(this.master);
    this.sirenOsc.start();

    const len = ctx.sampleRate * 1.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.music = new Music(ctx, this.master);
    this.music.setEnabled(this.musicOn);
    this.music.setMode(this.pendingMusic.mode, this.pendingMusic.level);
  }

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
    if (this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  /** speed01: 0..1, active: si hay motos en marcha. */
  engine(speed01: number, active: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime(45 + speed01 * 130, t, 0.08);
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

  private burst(duration: number, freq: number, type: BiquadFilterType, volume: number, pitchDrop = 0): void {
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
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + duration);
  }

  shot(): void {
    this.burst(0.12, 2500, 'highpass', 0.25);
  }

  crash(strength = 1): void {
    this.burst(0.25 + strength * 0.2, 900, 'lowpass', 0.35 * Math.min(1.5, strength), 0.3);
  }

  explosion(): void {
    this.burst(1.3, 700, 'lowpass', 0.9, 0.08);
  }

  blip(freq = 880): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(g).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  }
}
