// Servidor de red local de Race Robber: sirve el juego compilado (dist/) y une
// al anfitrión con un invitado por WebSocket. Sirve con un hotspot del celular o
// cualquier red Wi-Fi, sin internet.
//
// Uso: npm run lan            (compila y arranca en el puerto 8080)
//      PORT=9000 npm run lan  (otro puerto)
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

/** Direcciones IPv4 de la red local de este equipo. */
export function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * Retransmisor: un anfitrión y un invitado por servidor. Reenvía los mensajes
 * de uno al otro y avisa cuando el otro se conecta o se va.
 */
export function attachRelay(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  let host = null;
  let guest = null;
  const ctl = (ws, msg) => ws?.readyState === 1 && ws.send(JSON.stringify({ $relay: msg.type, text: msg.text }));

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/relay') return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const role = url.searchParams.get('role');
      if (role === 'host') {
        if (host && host.readyState === 1) {
          ctl(ws, { type: 'error', text: 'Ya hay una partida creada en este servidor.' });
          ws.close();
          return;
        }
        host = ws;
        if (guest && guest.readyState === 1) {
          ctl(host, { type: 'peer' });
          ctl(guest, { type: 'peer' });
        }
      } else {
        if (!host || host.readyState !== 1) {
          ctl(ws, { type: 'error', text: 'Todavía no hay una partida creada: el anfitrión debe elegir "Crear partida por IP".' });
          ws.close();
          return;
        }
        if (guest && guest.readyState === 1) {
          ctl(ws, { type: 'error', text: 'La partida ya tiene dos jugadores.' });
          ws.close();
          return;
        }
        guest = ws;
        ctl(host, { type: 'peer' });
        ctl(guest, { type: 'peer' });
      }
      ws.on('message', (data, isBinary) => {
        const other = ws === host ? guest : ws === guest ? host : null;
        if (other && other.readyState === 1) other.send(data, { binary: isBinary });
      });
      ws.on('close', () => {
        if (ws === host) {
          host = null;
          ctl(guest, { type: 'left' });
          guest?.close();
          guest = null;
        } else if (ws === guest) {
          guest = null;
          ctl(host, { type: 'left' });
        }
      });
    });
  });
}

/** Respuesta de /lan-info: con ella el juego sabe que puede ofrecer la conexión por IP. */
export function lanInfoHandler(port) {
  return (req, res, next) => {
    if (!req.url?.startsWith('/lan-info')) return next?.();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ips: localIps(), port: port() }));
  };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

async function main() {
  const port = Number(process.env.PORT ?? 8080);
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  try {
    await stat(path.join(dist, 'index.html'));
  } catch {
    console.error('No se encontró dist/index.html. Ejecuta primero "npm run build" (o usa "npm run lan", que compila).');
    process.exit(1);
  }
  const info = lanInfoHandler(() => port);
  const server = http.createServer(async (req, res) => {
    let handled = true;
    info(req, res, () => {
      handled = false;
    });
    if (handled) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dist)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = path.join(dist, 'index.html');
    }
    try {
      await stat(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  attachRelay(server);
  server.listen(port, '0.0.0.0', () => {
    const ips = localIps();
    console.log('\nRace Robber — servidor de red local');
    console.log(`  En este equipo:     http://localhost:${port}`);
    for (const ip of ips) console.log(`  Desde otro equipo:  http://${ip}:${port}`);
    if (!ips.length) console.log('  (No se detectó red local: conéctate a un Wi-Fi o al hotspot del celular.)');
    console.log('\nEl anfitrión abre la dirección y elige EN LÍNEA > Crear partida por IP.');
    console.log('El otro jugador abre la misma dirección desde su celular o PC y elige Unirse por IP.\n');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
