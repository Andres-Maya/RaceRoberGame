import { Link } from './Link';

/*
 * Conexión por hotspot sin internet: WebRTC sin servidor de señalización.
 * El anfitrión muestra su "oferta" en un código QR, el invitado la escanea y
 * responde con otro QR que el anfitrión escanea. Después los teléfonos se
 * hablan directo por la red del hotspot.
 */

/** Prefijo de los códigos: versión, tipo (O oferta / A respuesta) y compresión (z / p). */
const MAGIC = 'RR1';
/** Segundos para que se abra el canal tras intercambiar los códigos. */
const OPEN_TIMEOUT = 45;

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/**
 * Quita del SDP lo que no hace falta en una red local para que el QR sea más
 * pequeño: candidatos TCP, externos e IPv6 de enlace local, y los datos
 * opcionales al final de cada candidato.
 */
function minify(sdp: string): string {
  return sdp
    .split('\r\n')
    .filter((l) => l && !/^a=candidate:.* tcp /i.test(l) && !/typ (srflx|relay)/.test(l) && !/ fe80:/i.test(l) && !l.startsWith('a=extmap-allow-mixed') && !l.startsWith('a=msid-semantic'))
    .map((l) => (l.startsWith('a=candidate:') ? l.replace(/( typ host).*$/, '$1') : l))
    .join('\r\n')
    .concat('\r\n');
}

async function pack(desc: RTCSessionDescription | null, kind: 'O' | 'A'): Promise<string> {
  if (!desc) throw new Error('No se pudo preparar la conexión.');
  const bytes = new TextEncoder().encode(minify(desc.sdp));
  if (typeof CompressionStream !== 'undefined') {
    try {
      return `${MAGIC}${kind}z${toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
    } catch {
      /* sin compresión */
    }
  }
  return `${MAGIC}${kind}p${toBase64Url(bytes)}`;
}

async function unpack(text: string, kind: 'O' | 'A'): Promise<RTCSessionDescriptionInit> {
  const t = text.trim();
  if (!t.startsWith(MAGIC)) throw new Error('Ese código no es de Race Robber.');
  if (t[3] !== kind) throw new Error(kind === 'O' ? 'Ese es el código de respuesta: escanea el que muestra el anfitrión.' : 'Ese es el código del anfitrión: escanea el que muestra el invitado.');
  let bytes = fromBase64Url(t.slice(5));
  if (t[4] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  return { type: kind === 'O' ? 'offer' : 'answer', sdp: new TextDecoder().decode(bytes) };
}

/** Tipo de código ('O' oferta del anfitrión, 'A' respuesta del invitado) o null si no es del juego. */
export function qrKind(text: string): 'O' | 'A' | null {
  const t = text.trim();
  return t.startsWith(MAGIC) && (t[3] === 'O' || t[3] === 'A') ? (t[3] as 'O' | 'A') : null;
}

/** Espera a que terminen de reunirse las direcciones de red (sin servidores externos es casi inmediato). */
function gathered(pc: RTCPeerConnection, ms = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    window.setTimeout(resolve, ms);
  });
}

/** Imagen del código QR (como data URL). */
export async function qrImage(text: string): Promise<string> {
  const qrcode = (await import('qrcode-generator')).default;
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createDataURL(4, 4);
}

export class QrLink extends Link {
  readonly kind = 'qr';
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private closed = false;

  constructor() {
    super();
    // Sin servidores STUN/TURN: solo direcciones de la red local (el hotspot).
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if ((s === 'failed' || s === 'disconnected' || s === 'closed') && this.dc && !this.closed) {
        const was = this.dc.readyState === 'open';
        this.dc = null;
        if (was) this.onPeerLeft('Se perdió la conexión con el otro jugador.');
      }
    });
  }

  get connected(): boolean {
    return this.dc?.readyState === 'open';
  }

  /** Anfitrión: código QR con la oferta. */
  async offer(): Promise<string> {
    this.wire(this.pc.createDataChannel('race-robber', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    return pack(this.pc.localDescription, 'O');
  }

  /** Anfitrión: aplica la respuesta escaneada y espera a que se abra el canal. */
  async accept(answer: string): Promise<void> {
    await this.pc.setRemoteDescription(await unpack(answer, 'A'));
    await this.waitOpen();
  }

  /** Invitado: a partir de la oferta escaneada, crea el código QR de respuesta. */
  async answer(offer: string): Promise<string> {
    this.pc.addEventListener('datachannel', (e) => this.wire(e.channel));
    await this.pc.setRemoteDescription(await unpack(offer, 'O'));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    return pack(this.pc.localDescription, 'A');
  }

  /** Espera a que el canal de datos quede abierto. */
  waitOpen(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const check = () => {
        if (this.closed) return reject(new Error('Conexión cancelada.'));
        if (this.connected) return resolve();
        if (this.pc.connectionState === 'failed' || performance.now() - start > OPEN_TIMEOUT * 1000) {
          return reject(new Error('No se pudo conectar. Revisa que los dos teléfonos estén en el mismo hotspot o Wi-Fi y vuelve a intentarlo.'));
        }
        window.setTimeout(check, 200);
      };
      check();
    });
  }

  private wire(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.addEventListener('open', () => this.onPeer());
    dc.addEventListener('message', (e) => {
      if (typeof e.data === 'string') this.receive(e.data);
    });
    dc.addEventListener('close', () => {
      if (this.dc !== dc || this.closed) return;
      this.dc = null;
      this.onPeerLeft('Se perdió la conexión con el otro jugador.');
    });
  }

  protected sendRaw(text: string): void {
    this.dc?.send(text);
  }

  close(): void {
    this.closed = true;
    this.dc?.close();
    this.dc = null;
    this.pc.close();
  }
}
