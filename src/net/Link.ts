import type { DataConnection, Peer as PeerClient } from 'peerjs';
import type { NetMessage } from './protocol';

/** Tamaño máximo de cada fragmento (los canales de datos limitan el tamaño de un mensaje). */
const CHUNK = 16_000;
/** Prefijo de los fragmentos: "\u0001id|índice|total|datos". */
const PART = '\u0001';
/** Prefijo de las salas en el servidor de señalización de PeerJS. */
const PEER_PREFIX = 'race-robber-';

/**
 * Conexión entre anfitrión e invitado. Envía mensajes JSON, los fragmenta si
 * son grandes y avisa cuando el otro lado se conecta o se va.
 */
export abstract class Link {
  onMessage: (msg: NetMessage) => void = () => {};
  /** El otro jugador se conectó (anfitrión) o la conexión quedó lista (invitado). */
  onPeer: () => void = () => {};
  /** El otro jugador se fue o la conexión se cayó. */
  onPeerLeft: (reason: string) => void = () => {};
  /** Error grave: no se pudo abrir o mantener la sala. */
  onError: (text: string) => void = () => {};

  private partId = 0;
  private parts = new Map<string, string[]>();

  abstract readonly kind: 'code' | 'ip';
  protected abstract sendRaw(text: string): void;
  abstract get connected(): boolean;
  abstract close(): void;

  send(msg: NetMessage): void {
    if (!this.connected) return;
    const text = JSON.stringify(msg);
    if (text.length <= CHUNK) {
      this.sendRaw(text);
      return;
    }
    const id = (this.partId++).toString(36);
    const total = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < total; i++) this.sendRaw(`${PART}${id}|${i}|${total}|${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }

  /** Recibe texto crudo: arma los fragmentos y entrega el mensaje completo. */
  protected receive(text: string): void {
    if (text.startsWith(PART)) {
      const a = text.indexOf('|');
      const b = text.indexOf('|', a + 1);
      const c = text.indexOf('|', b + 1);
      const id = text.slice(1, a);
      const i = Number(text.slice(a + 1, b));
      const total = Number(text.slice(b + 1, c));
      let list = this.parts.get(id);
      if (!list) {
        list = new Array<string>(total);
        this.parts.set(id, list);
      }
      list[i] = text.slice(c + 1);
      if (list.filter((p) => p !== undefined).length < total) return;
      this.parts.delete(id);
      text = list.join('');
    }
    let msg: NetMessage;
    try {
      msg = JSON.parse(text) as NetMessage;
    } catch {
      return;
    }
    this.onMessage(msg);
  }
}

// ------------------------------------------------------------ código (WebRTC)

/** PeerJS se descarga solo al usar la conexión por código. */
async function loadPeer(): Promise<typeof PeerClient> {
  try {
    return (await import('peerjs')).Peer;
  } catch {
    throw new Error('No se pudo cargar el módulo de conexión. Revisa tu conexión a internet.');
  }
}

/** Código corto y fácil de dictar (sin letras que se confundan). */
function randomCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function peerErrorText(type: string): string {
  switch (type) {
    case 'peer-unavailable':
      return 'No existe una sala con ese código.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'No hay conexión con el servidor de salas. Revisa que el dispositivo tenga internet (los datos del hotspot sirven) o usa la conexión por IP.';
    case 'browser-incompatible':
      return 'Este navegador no permite conexiones WebRTC.';
    default:
      return `Error de conexión (${type}).`;
  }
}

/**
 * Conexión directa entre navegadores (WebRTC) usando un código de sala.
 * El servidor público de PeerJS solo presenta a los dos dispositivos; después
 * los datos van directo (en un hotspot, por la red local).
 */
export class PeerLink extends Link {
  readonly kind = 'code';
  code = '';
  private peer: PeerClient | null = null;
  private conn: DataConnection | null = null;
  private closed = false;

  get connected(): boolean {
    return !!this.conn?.open;
  }

  /** Crea la sala; resuelve con el código cuando el servidor la registra. */
  async host(): Promise<string> {
    const Peer = await loadPeer();
    return new Promise((resolve, reject) => {
      const attempt = (tries: number) => {
        const code = randomCode();
        const peer = new Peer(PEER_PREFIX + code, { debug: 0 });
        this.peer = peer;
        peer.on('open', () => {
          this.code = code;
          resolve(code);
        });
        peer.on('connection', (conn) => {
          // Solo un invitado por sala.
          if (this.conn?.open) {
            conn.on('open', () => conn.close());
            return;
          }
          this.attach(conn);
        });
        peer.on('error', (err: { type: string }) => {
          if (err.type === 'unavailable-id' && tries < 4) {
            peer.destroy();
            attempt(tries + 1);
            return;
          }
          if (!this.code) reject(new Error(peerErrorText(err.type)));
          else if (!this.closed && err.type !== 'peer-unavailable') this.onError(peerErrorText(err.type));
        });
        peer.on('disconnected', () => {
          // Se perdió el servidor de señalización: la partida en curso sigue, pero se intenta volver.
          if (!this.closed && !peer.destroyed) peer.reconnect();
        });
      };
      attempt(0);
    });
  }

  /** Se une a una sala por su código. */
  async join(code: string): Promise<void> {
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const Peer = await loadPeer();
    return new Promise((resolve, reject) => {
      const peer = new Peer({ debug: 0 });
      this.peer = peer;
      let done = false;
      const timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('La sala no respondió. Revisa el código y que ambos tengan conexión.'));
        this.close();
      }, 15000);
      peer.on('open', () => {
        const conn = peer.connect(PEER_PREFIX + clean, { reliable: true, serialization: 'raw' });
        this.attach(conn, () => {
          if (done) return;
          done = true;
          window.clearTimeout(timer);
          resolve();
        });
      });
      peer.on('error', (err: { type: string }) => {
        if (!done) {
          done = true;
          window.clearTimeout(timer);
          reject(new Error(peerErrorText(err.type)));
          this.close();
        } else if (!this.closed) {
          this.onError(peerErrorText(err.type));
        }
      });
    });
  }

  private attach(conn: DataConnection, opened?: () => void): void {
    conn.on('open', () => {
      this.conn = conn;
      opened?.();
      this.onPeer();
    });
    conn.on('data', (data) => {
      if (typeof data === 'string') this.receive(data);
    });
    const left = () => {
      if (this.conn !== conn) return;
      this.conn = null;
      if (!this.closed) this.onPeerLeft('Se perdió la conexión con el otro jugador.');
    };
    conn.on('close', left);
    conn.on('error', left);
  }

  protected sendRaw(text: string): void {
    this.conn?.send(text);
  }

  close(): void {
    this.closed = true;
    this.conn?.close();
    this.conn = null;
    this.peer?.destroy();
    this.peer = null;
  }
}

// ------------------------------------------------------------ IP (red local)

/** Datos del servidor de red local (`npm run lan`), si el juego se abrió desde él. */
export interface LanInfo {
  ips: string[];
  port: number;
}

export async function lanInfo(): Promise<LanInfo | null> {
  if (location.protocol !== 'http:') return null;
  try {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('/lan-info', { signal: ctrl.signal, cache: 'no-store' });
    window.clearTimeout(timer);
    if (!res.ok) return null;
    const info = (await res.json()) as LanInfo;
    return Array.isArray(info.ips) ? info : null;
  } catch {
    return null;
  }
}

/** Normaliza lo que escribe el jugador: "192.168.1.5", "192.168.1.5:8080" o una URL. */
export function lanAddress(input: string, defaultPort: number): string {
  let s = input.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (!s) return '';
  if (!/:\d+$/.test(s)) s += `:${defaultPort}`;
  return s;
}

/**
 * Conexión por la red local a través del servidor `npm run lan` del
 * anfitrión: un retransmisor WebSocket que une al anfitrión con un invitado.
 */
export class WsLink extends Link {
  readonly kind = 'ip';
  private ws: WebSocket | null = null;
  private paired = false;
  private closed = false;

  constructor(
    readonly address: string,
    private role: 'host' | 'guest',
  ) {
    super();
  }

  get connected(): boolean {
    return this.paired && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Abre la conexión con el servidor; el invitado resuelve cuando queda emparejado. */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (text: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(text));
        this.close();
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${this.address}/relay?role=${this.role}`);
      } catch {
        fail('Dirección no válida.');
        return;
      }
      this.ws = ws;
      const timer = window.setTimeout(() => fail(`No se pudo conectar con ${this.address}. ¿Están en la misma red y el anfitrión ejecutó "npm run lan"?`), 8000);
      ws.onopen = () => {
        if (this.role === 'host') {
          window.clearTimeout(timer);
          settled = true;
          resolve();
        }
      };
      ws.onmessage = (e) => {
        const text = String(e.data);
        if (text.startsWith('{"$relay"')) {
          const ctl = JSON.parse(text) as { $relay: string; text?: string };
          if (ctl.$relay === 'peer') {
            this.paired = true;
            if (!settled) {
              window.clearTimeout(timer);
              settled = true;
              resolve();
            }
            this.onPeer();
          } else if (ctl.$relay === 'left') {
            this.paired = false;
            this.onPeerLeft(this.role === 'host' ? 'El jugador 2 se desconectó.' : 'El anfitrión cerró la partida.');
          } else if (ctl.$relay === 'error') {
            window.clearTimeout(timer);
            fail(ctl.text ?? 'El servidor rechazó la conexión.');
          }
          return;
        }
        this.receive(text);
      };
      ws.onclose = () => {
        window.clearTimeout(timer);
        if (!settled) {
          fail(`No se pudo conectar con ${this.address}. ¿Están en la misma red y el anfitrión ejecutó "npm run lan"?`);
          return;
        }
        const was = this.paired;
        this.paired = false;
        if (!this.closed) {
          if (was) this.onPeerLeft('Se perdió la conexión con el otro jugador.');
          else this.onError('Se cerró la conexión con el servidor de red local.');
        }
      };
    });
  }

  protected sendRaw(text: string): void {
    this.ws?.send(text);
  }

  close(): void {
    this.closed = true;
    this.paired = false;
    this.ws?.close();
    this.ws = null;
  }
}
