import { Rng } from './Rng';

/**
 * Banda sonora de brutal death metal sintetizada en tiempo real con WebAudio:
 * guitarras afinadas muy grave con distorsión (dos pistas, izquierda y derecha),
 * bajo, batería con blast beats y doble bombo, y un coro épico con reverberación.
 * No usa archivos: los riffs se generan por nivel y la intensidad sigue a la acción.
 */

/**
 * calm: menú principal (guitarra limpia y coro suave).
 * epic: historia de cada nivel. level: persecución. victory: resultados.
 * death: réquiem cuando caen todas las motos.
 */
export type MusicMode = 'off' | 'calm' | 'epic' | 'level' | 'victory' | 'death';

type Section = 'blast' | 'chug' | 'breakdown' | 'epic';

interface Note {
  /** Semitonos sobre la tónica. */
  n: number;
  /** Duración en semicorcheas. */
  len: number;
  mute: boolean;
  chord: boolean;
}

interface Kit {
  kick: AudioBuffer;
  snare: AudioBuffer;
  hat: AudioBuffer;
  ride: AudioBuffer;
  china: AudioBuffer;
  crash: AudioBuffer;
  toms: AudioBuffer[];
}

/** Un compás de 16 semicorcheas. */
type Bar = (Note | null)[];

interface Style {
  bpm: number;
  root: number;
  scale: number[];
  seed: number;
}

const STYLES: Record<number, Style> = {
  // Prólogo: frigio en La, rápido pero contenido.
  0: { bpm: 176, root: 55, scale: [0, 1, 3, 5, 7, 8, 10], seed: 11 },
  // Policía: frigio dominante (sonido "épico") en Si bemol.
  1: { bpm: 196, root: 58.27, scale: [0, 1, 4, 5, 7, 8, 11], seed: 23 },
  // Banda rival: locrio en Si.
  2: { bpm: 208, root: 61.74, scale: [0, 1, 3, 5, 6, 8, 10], seed: 37 },
  // Tierra baldía: cromático y disonante, el más brutal.
  3: { bpm: 222, root: 55, scale: [0, 1, 2, 3, 6, 7, 8], seed: 51 },
};
const EPIC_STYLE: Style = { bpm: 92, root: 55, scale: [0, 2, 3, 5, 7, 8, 10], seed: 5 };
const VICTORY_STYLE: Style = { bpm: 100, root: 58.27, scale: [0, 2, 3, 5, 7, 8, 10], seed: 7 };
/** Menú principal: La menor tranquilo. */
const CALM_STYLE: Style = { bpm: 72, root: 110, scale: [0, 2, 3, 5, 7, 8, 10], seed: 3 };
/** Réquiem al morir: Re menor, muy lento. */
const DEATH_STYLE: Style = { bpm: 56, root: 73.42, scale: [0, 2, 3, 5, 7, 8, 10], seed: 9 };

const MINOR = [1, 1.2, 1.5, 0.5];
const MAJOR = [1, 1.26, 1.5, 0.5];

/** Menú: La menor → Fa → Do → Sol, en arpegios de guitarra limpia (semitonos sobre La). */
const CALM_CHORDS: { notes: number[]; quality: number[] }[] = [
  { notes: [0, 7, 12, 15, 19], quality: MINOR },
  { notes: [-4, 3, 8, 12, 15], quality: MAJOR },
  { notes: [3, 10, 15, 19, 22], quality: MAJOR },
  { notes: [-2, 5, 10, 14, 17], quality: MAJOR },
];
const CALM_ARPEGGIO = [0, 1, 2, 3, 4, 3, 2, 1];

/** Réquiem: Re menor → Mi bemol → Si bemol → La (cadencia trágica). */
const DEATH_CHORDS: { root: number; third: number; quality: number[] }[] = [
  { root: 0, third: 3, quality: MINOR },
  { root: 1, third: 4, quality: MAJOR },
  { root: -4, third: 4, quality: MAJOR },
  { root: -5, third: 4, quality: MAJOR },
];

/** Progresión del coro (grados en semitonos) para las secciones épicas. */
const EPIC_PROGRESSION = [0, 8, 10, 7];

const VOLUME = 0.55;

/**
 * Voz de guitarra persistente: los osciladores y la distorsión existen todo el
 * tiempo y cada nota solo programa frecuencia, tono y envolvente. Crear una
 * cadena de distorsión por nota (a 200+ BPM en semicorcheas) es demasiado
 * costoso para el audio en tiempo real.
 */
class GuitarVoice {
  private root: OscillatorNode;
  private octave: OscillatorNode;
  private fifth: OscillatorNode;
  private fifthGain: GainNode;
  private tone: BiquadFilterNode;
  private env: GainNode;

  constructor(
    ctx: AudioContext,
    curve: Float32Array<ArrayBuffer>,
    pan: number,
    private detune: number,
    out: AudioNode,
  ) {
    const drive = ctx.createGain();
    drive.gain.value = 3;
    const osc = (type: OscillatorType, gain: number): [OscillatorNode, GainNode] => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(drive);
      o.start();
      return [o, g];
    };
    [this.root] = osc('sawtooth', 0.6);
    [this.octave] = osc('square', 0.3);
    [this.fifth, this.fifthGain] = osc('sawtooth', 0);
    const shaper = ctx.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 4200;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 75;
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    drive.connect(shaper).connect(this.tone).connect(hp).connect(this.env).connect(panner).connect(out);
  }

  play(t: number, freq: number, dur: number, muted: boolean, chord: boolean): void {
    const f = freq * this.detune;
    this.root.frequency.setValueAtTime(f, t);
    this.octave.frequency.setValueAtTime(f * 2, t);
    this.fifth.frequency.setValueAtTime(f * 1.4983, t);
    this.fifthGain.gain.setValueAtTime(chord ? 0.5 : 0, t);
    this.tone.frequency.setValueAtTime(muted ? 700 : 4200, t);
    const g = this.env.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(muted ? 0.9 : 0.75, t + 0.004);
    const end = t + (muted ? Math.min(dur, 0.11) : dur);
    if (muted) {
      g.exponentialRampToValueAtTime(0.001, end);
    } else {
      g.setValueAtTime(0.75, Math.max(t + 0.005, end - 0.015));
      g.linearRampToValueAtTime(0, end);
    }
  }
}

/** Bajo persistente que dobla la tónica de las guitarras una octava abajo. */
class BassVoice {
  private osc: OscillatorNode;
  private env: GainNode;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.osc.connect(lp).connect(this.env).connect(out);
    this.osc.start();
  }

  play(t: number, freq: number, dur: number): void {
    this.osc.frequency.setValueAtTime(freq, t);
    const g = this.env.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.5, t);
    g.exponentialRampToValueAtTime(0.001, t + Math.max(0.06, dur * 0.95));
  }
}

export class Music {
  private out: GainNode;
  private guitarBus: GainNode;
  private drumBus: GainNode;
  private reverb: ConvolverNode;
  private distCurve: Float32Array<ArrayBuffer>;
  private guitars: GuitarVoice[];
  private bassVoice: BassVoice;
  private kit: Kit;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private phrase = 0;
  private section: Section = 'chug';
  private mode: MusicMode = 'off';
  private style: Style = EPIC_STYLE;
  private riffs: Record<Section, Bar[]> = { blast: [], chug: [], breakdown: [], epic: [] };
  private enabled = true;
  private ducked = false;
  /** 0..1: qué tan intensa debe sonar (persecución, peligro). */
  intensity = 0.5;

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.out.connect(comp).connect(destination);

    // Simulador de gabinete: medios recortados y presencia marcada.
    this.guitarBus = ctx.createGain();
    this.guitarBus.gain.value = 0.55;
    const scoop = ctx.createBiquadFilter();
    scoop.type = 'peaking';
    scoop.frequency.value = 750;
    scoop.gain.value = -7;
    scoop.Q.value = 0.9;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2600;
    presence.gain.value = 5;
    const cab = ctx.createBiquadFilter();
    cab.type = 'lowpass';
    cab.frequency.value = 5200;
    this.guitarBus.connect(scoop).connect(presence).connect(cab).connect(this.out);

    this.drumBus = ctx.createGain();
    this.drumBus.gain.value = 0.72;
    this.drumBus.connect(this.out);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.8);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.reverb.connect(wet).connect(this.out);

    this.distCurve = new Float32Array(2048);
    const k = 380;
    for (let i = 0; i < this.distCurve.length; i++) {
      const x = (i / (this.distCurve.length - 1)) * 2 - 1;
      this.distCurve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    // Dos guitarras abiertas a izquierda y derecha, ligeramente desafinadas entre sí.
    this.guitars = [new GuitarVoice(ctx, this.distCurve, -0.7, 1, this.guitarBus), new GuitarVoice(ctx, this.distCurve, 0.7, 1.004, this.guitarBus)];
    this.bassVoice = new BassVoice(ctx, this.out);
    this.kit = this.buildKit();
  }

  // ------------------------------------------------------------ control

  setMode(mode: MusicMode, level = 0): void {
    if (mode === this.mode && (mode !== 'level' || this.style === STYLES[level])) return;
    const wasPlaying = this.mode !== 'off';
    this.mode = mode;
    if (mode === 'off') {
      this.stop();
      return;
    }
    this.style = { calm: CALM_STYLE, epic: EPIC_STYLE, victory: VICTORY_STYLE, death: DEATH_STYLE, level: STYLES[level] ?? STYLES[0] }[mode];
    this.buildRiffs();
    this.step = 0;
    this.bar = 0;
    this.phrase = 0;
    this.section = mode === 'level' ? 'chug' : 'epic';
    // Transición: bajar el volumen, cambiar de pieza y volver a subirlo.
    const now = this.ctx.currentTime;
    const gap = wasPlaying ? 0.4 : 0.08;
    if (wasPlaying) this.out.gain.setTargetAtTime(0.0001, now, 0.08);
    this.nextTime = now + gap;
    this.applyGain(gap);
    if (this.timer === null) this.timer = window.setInterval(() => this.schedule(), 25);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyGain();
  }

  /** Baja el volumen (pausa) sin detener la música. */
  duck(on: boolean): void {
    this.ducked = on;
    this.applyGain();
  }

  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  /** Tras volver de una pestaña oculta, no intentar recuperar compases perdidos. */
  resync(): void {
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
  }

  private applyGain(delay = 0): void {
    const full = VOLUME;
    const target = !this.enabled || this.mode === 'off' ? 0 : this.ducked ? full * 0.3 : full;
    this.out.gain.setTargetAtTime(target, this.ctx.currentTime + delay, delay > 0 ? 0.5 : 0.25);
  }

  private stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.applyGain();
  }

  // ------------------------------------------------------------ composición

  private buildRiffs(): void {
    const rng = new Rng(this.style.seed);
    const sc = this.style.scale;
    const deg = (i: number) => sc[((i % sc.length) + sc.length) % sc.length] + 12 * Math.floor(i / sc.length);

    // Trémolo: cuatro notas por compás, picadas en semicorcheas, con tendencia cromática.
    const tremolo = (): Bar => {
      const bar: Bar = new Array(16).fill(null);
      let d = rng.int(0, 3);
      for (let q = 0; q < 4; q++) {
        const n = q === 0 ? 0 : deg(d);
        for (let s = 0; s < 4; s++) bar[q * 4 + s] = { n, len: 1, mute: false, chord: false };
        d += rng.pick([-2, -1, 1, 2, 3]);
        d = Math.max(0, Math.min(8, d));
      }
      return bar;
    };

    // Chugs: tónica apagada con acentos abiertos en otros grados.
    const CHUG_PATTERNS = ['x.xxx.xxx.xx.x.x', 'xx.xxx.xx.xxx.x.', 'x..xx..xx.x.xxxx', 'xxx.xxx.xx.xxx..'];
    const chug = (): Bar => {
      const pat = rng.pick(CHUG_PATTERNS);
      return [...pat].map((c, i) => {
        if (c !== 'x') return null;
        const accent = i % 4 === 3 && rng.chance(0.45);
        return accent ? { n: deg(rng.int(1, 6)), len: 1, mute: false, chord: true } : { n: 0, len: 1, mute: true, chord: false };
      });
    };

    // Breakdown: acordes largos sincopados, con un semitono disonante.
    const breakdown = (): Bar => {
      const bar: Bar = new Array(16).fill(null);
      const hits: [number, number, number][] = [
        [0, 0, 5],
        [6, rng.pick([0, 1]), 3],
        [10, rng.pick([1, 6, 0]), 4],
      ];
      for (const [at, n, len] of hits) bar[at] = { n, len, mute: false, chord: true };
      for (const at of [14, 15]) if (rng.chance(0.6)) bar[at] = { n: 0, len: 1, mute: true, chord: false };
      return bar;
    };

    // Épico: un acorde sostenido por compás siguiendo la progresión del coro.
    const epic = (i: number): Bar => {
      const bar: Bar = new Array(16).fill(null);
      bar[0] = { n: EPIC_PROGRESSION[i % EPIC_PROGRESSION.length], len: 12, mute: false, chord: true };
      bar[12] = { n: EPIC_PROGRESSION[i % EPIC_PROGRESSION.length], len: 2, mute: true, chord: false };
      bar[14] = { n: EPIC_PROGRESSION[i % EPIC_PROGRESSION.length], len: 2, mute: true, chord: false };
      return bar;
    };

    this.riffs = {
      blast: [tremolo(), tremolo(), tremolo()],
      chug: [chug(), chug(), chug()],
      breakdown: [breakdown(), breakdown()],
      epic: EPIC_PROGRESSION.map((_, i) => epic(i)),
    };
  }

  /** Elige la sección de la siguiente frase (4 compases) según el modo y la intensidad. */
  private nextSection(): Section {
    if (this.mode !== 'level') return this.phrase % 4 === 3 ? 'breakdown' : 'epic';
    // Cada cuatro frases, un breakdown épico con coro.
    if (this.phrase % 4 === 3) return 'breakdown';
    const i = this.intensity;
    if (i > 0.62) return 'blast';
    if (i > 0.32) return this.phrase % 2 === 0 ? 'blast' : 'chug';
    return 'chug';
  }

  // ------------------------------------------------------------ secuenciador

  private schedule(): void {
    const sixteenth = 60 / this.style.bpm / 4;
    // Si la pestaña estuvo congelada, saltar al presente.
    if (this.nextTime < this.ctx.currentTime - 0.2) this.nextTime = this.ctx.currentTime + 0.05;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      if (this.step === 0 && this.bar % 4 === 0) {
        this.phrase = this.bar / 4;
        this.section = this.nextSection();
      }
      this.playStep(this.nextTime, sixteenth);
      this.nextTime += sixteenth;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }

  private playStep(t: number, sixteenth: number): void {
    if (this.mode === 'calm') return this.playCalm(t, sixteenth);
    if (this.mode === 'death') return this.playRequiem(t, sixteenth);
    const s = this.step;
    const barInPhrase = this.bar % 4;
    const riffs = this.riffs[this.section];
    // Forma A A B A' dentro de cada frase.
    const riff = riffs[this.section === 'epic' ? barInPhrase % riffs.length : [0, 0, 1, 2][barInPhrase] % riffs.length];
    const note = riff[s];
    if (note) {
      const freq = this.style.root * 2 ** (note.n / 12);
      const dur = note.len * sixteenth;
      for (const g of this.guitars) g.play(t, freq, dur, note.mute, note.chord);
      this.bassVoice.play(t, freq / 2, dur);
    }
    if ((this.section === 'epic' || this.section === 'breakdown') && s === 0) {
      const chord = this.section === 'epic' ? EPIC_PROGRESSION[barInPhrase % EPIC_PROGRESSION.length] : 0;
      this.choir(this.style.root * 4 * 2 ** (chord / 12), t, sixteenth * 16);
    }
    this.drums(t, s, barInPhrase);
  }

  /** Menú principal: arpegios de guitarra limpia, coro suave y percusión mínima. */
  private playCalm(t: number, sixteenth: number): void {
    const s = this.step;
    const chord = CALM_CHORDS[this.bar % CALM_CHORDS.length];
    const root = this.style.root;
    if (s % 2 === 0) {
      const n = chord.notes[CALM_ARPEGGIO[s / 2]];
      this.pluck(root * 2 ** (n / 12), t, 1.8, (s / 2) % 2 === 0 ? -0.35 : 0.35, 0.34);
    }
    if (s === 0) {
      this.choir(root * 2 * 2 ** (chord.notes[0] / 12), t, sixteenth * 16, 0.07, chord.quality);
      this.softBass((root / 2) * 2 ** (chord.notes[0] / 12), t, sixteenth * 16);
    }
    // A partir de la segunda frase entra una percusión muy suave.
    if (this.bar >= 4) {
      if (s === 0) this.kick(t, 0.3);
      if (s === 8) this.kick(t, 0.2);
      if (s % 4 === 2) this.hat(t, 0.07);
    }
  }

  /** Muerte: campana grave, coro trágico, timbal y arpegios lentos en Re menor. */
  private playRequiem(t: number, sixteenth: number): void {
    const s = this.step;
    const chord = DEATH_CHORDS[this.bar % DEATH_CHORDS.length];
    const root = this.style.root * 2 ** (chord.root / 12);
    if (s === 0) {
      if (this.bar % 2 === 0) this.bell(this.style.root * 2, t);
      this.choir(root * 4, t, sixteenth * 16, 0.09, chord.quality);
      this.softBass(root / 2, t, sixteenth * 16);
      this.tom(t, 85);
    }
    if (s === 8) this.tom(t, 85);
    if (s % 4 === 0) {
      const tones = [0, 7, 12 + chord.third, 7];
      this.pluck(root * 2 * 2 ** (tones[s / 4] / 12), t, 2.4, s % 8 === 0 ? -0.3 : 0.3, 0.13);
    }
  }

  private drums(t: number, s: number, barInPhrase: number): void {
    const phraseStart = s === 0 && barInPhrase === 0;
    if (phraseStart) this.crash(t);
    const fill = barInPhrase === 3 && s >= 12;
    switch (this.section) {
      case 'blast':
        if (fill) {
          this.tom(t, 150 - (s - 12) * 20);
          this.kick(t);
          break;
        }
        // Blast beat: bombo en cada semicorchea, caja en los contratiempos.
        this.kick(t);
        if (s % 2 === 1) this.snare(t, 0.9);
        if (s % 2 === 0) this.ride(t);
        break;
      case 'chug':
        if (fill) {
          this.snare(t, 0.7);
          if (s % 2 === 0) this.kick(t);
          break;
        }
        // Doble bombo continuo y caja en 2 y 4.
        this.kick(t, 0.85);
        if (s === 4 || s === 12) this.snare(t, 1);
        if (s % 2 === 0) this.hat(t);
        break;
      case 'breakdown':
        if ([0, 6, 10].includes(s)) this.kick(t, 1.1);
        if (s === 8) this.snare(t, 1.1);
        if (s % 4 === 0) this.china(t);
        if (fill && s % 2 === 0) this.tom(t, 120 - (s - 12) * 15);
        break;
      case 'epic':
        if (s === 0 || s === 10) this.kick(t, 1);
        if (s === 8) this.snare(t, 0.8);
        if (s % 4 === 2) this.hat(t);
        if (fill) this.tom(t, 140 - (s - 12) * 18);
        break;
    }
  }

  // ------------------------------------------------------------ instrumentos

  /** Coro "aah": sierras desafinadas a través de formantes, con reverberación. */
  private choir(freq: number, t: number, dur: number, vol = 0.11, ratios = MINOR): void {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vol, t + 0.45);
    env.gain.setValueAtTime(vol, t + dur * 0.8);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.6);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 720;
    f1.Q.value = 3;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1150;
    f2.Q.value = 4;
    const mix = ctx.createGain();
    mix.gain.value = 2.2;
    f1.connect(mix);
    f2.connect(mix);
    mix.connect(env);
    env.connect(this.out);
    env.connect(this.reverb);
    for (const ratio of ratios) {
      for (const cents of [-9, 0, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq * ratio;
        o.detune.value = cents;
        o.connect(f1);
        o.connect(f2);
        o.start(t);
        o.stop(t + dur + 0.7);
      }
    }
  }

  // Batería: cada pieza se sintetiza una sola vez en un buffer; cada golpe
  // reproduce el buffer con su propio volumen (solo dos nodos por golpe).

  /** Guitarra limpia: nota pulsada que se apaga lentamente, con reverberación. */
  private pluck(freq: number, t: number, dur: number, pan: number, vol: number): void {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vol, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + dur * 0.5);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    lp.connect(env).connect(panner);
    panner.connect(this.out);
    panner.connect(this.reverb);
    for (const [ratio, type, gain] of [
      [1, 'triangle', 1],
      [2, 'sine', 0.35],
      [3, 'sine', 0.12],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * ratio;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  /** Bajo suave de onda senoidal para las piezas tranquilas. */
  private softBass(freq: number, t: number, dur: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Campana fúnebre: parciales inarmónicos con caídas largas. */
  private bell(freq: number, t: number): void {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.22;
    out.connect(this.out);
    out.connect(this.reverb);
    for (const [ratio, gain, decay] of [
      [1, 1, 4.5],
      [2, 0.5, 3.2],
      [2.76, 0.35, 2.4],
      [5.4, 0.2, 1.5],
      [8.93, 0.1, 0.8],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
  }

  private kick(t: number, vol = 1): void {
    this.hit(this.kit.kick, t, 0.95 * vol);
  }

  private snare(t: number, vol: number): void {
    this.hit(this.kit.snare, t, 0.8 * vol, true);
  }

  private hat(t: number, vol = 0.22): void {
    this.hit(this.kit.hat, t, vol);
  }

  private ride(t: number): void {
    this.hit(this.kit.ride, t, 0.16);
  }

  private china(t: number): void {
    this.hit(this.kit.china, t, 0.32, true);
  }

  private crash(t: number): void {
    this.hit(this.kit.crash, t, 0.34, true);
  }

  private tom(t: number, freq: number): void {
    const toms = this.kit.toms;
    this.hit(toms[freq > 130 ? 0 : freq > 100 ? 1 : 2], t, 0.75);
  }

  private hit(buffer: AudioBuffer, t: number, vol: number, wet = false): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this.drumBus);
    if (wet) g.connect(this.reverb);
    src.start(t);
  }

  /** Sintetiza el kit de batería (muestras cortas generadas con fórmulas). */
  private buildKit(): Kit {
    const rate = this.ctx.sampleRate;
    const make = (seconds: number, fn: (t: number, i: number) => number): AudioBuffer => {
      const len = Math.floor(rate * seconds);
      const buf = this.ctx.createBuffer(1, len, rate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = fn(i / rate, i);
      return buf;
    };
    const white = (len: number) => Float32Array.from({ length: len }, () => Math.random() * 2 - 1);
    // Paso alto de un polo, aplicado dos veces para una pendiente más marcada.
    const highpass = (x: Float32Array, fc: number): Float32Array => {
      const a = 1 / (1 + 2 * Math.PI * fc / rate);
      for (let pass = 0; pass < 2; pass++) {
        let prevX = 0;
        let prevY = 0;
        for (let i = 0; i < x.length; i++) {
          const y = a * (prevY + x[i] - prevX);
          prevX = x[i];
          prevY = y;
          x[i] = y;
        }
      }
      return x;
    };
    const noiseHp = (seconds: number, fc: number) => highpass(white(Math.floor(rate * seconds)), fc);

    let phase = 0;
    const clickNoise = noiseHp(0.02, 3000);
    const kick = make(0.25, (t, i) => {
      phase += (2 * Math.PI * (42 + 118 * Math.exp(-t / 0.018))) / rate;
      const body = Math.sin(phase) * Math.exp(-t / 0.07);
      const click = i < clickNoise.length ? clickNoise[i] * Math.exp(-t / 0.002) * 0.6 : 0;
      return body + click;
    });

    const snareNoise = noiseHp(0.22, 1400);
    const snare = make(0.22, (t, i) => snareNoise[i] * Math.exp(-t / 0.05) * 0.85 + Math.sin(2 * Math.PI * 195 * t) * Math.exp(-t / 0.03) * 0.5);

    const hatNoise = noiseHp(0.06, 8000);
    const hat = make(0.06, (t, i) => hatNoise[i] * Math.exp(-t / 0.012));

    const rideNoise = noiseHp(0.35, 5000);
    const ride = make(0.35, (t, i) => rideNoise[i] * Math.exp(-t / 0.09) * 0.8 + Math.sin(2 * Math.PI * 3100 * t) * Math.exp(-t / 0.15) * 0.15);

    const chinaNoise = noiseHp(0.8, 2800);
    const china = make(0.8, (t, i) => chinaNoise[i] * Math.exp(-t / 0.2) * (1 + 0.6 * Math.sin(2 * Math.PI * 430 * t)));

    const crashNoise = noiseHp(1.9, 4000);
    const crash = make(1.9, (t, i) => crashNoise[i] * Math.exp(-t / 0.55));

    const toms = [150, 115, 85].map((f0) => {
      let ph = 0;
      return make(0.32, (t) => {
        ph += (2 * Math.PI * f0 * (0.6 + 0.4 * Math.exp(-t / 0.08))) / rate;
        return Math.sin(ph) * Math.exp(-t / 0.11);
      });
    });

    return { kick, snare, hat, ride, china, crash, toms };
  }

  private impulse(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6;
    }
    return buf;
  }
}
