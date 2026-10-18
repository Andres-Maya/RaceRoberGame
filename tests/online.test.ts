import assert from 'node:assert/strict';
import http from 'node:http';
import { before, test } from 'node:test';
import * as THREE from 'three';
import { WebSocket } from 'ws';
import { DT, hooks, initPhysics, seedRandom, silent } from './helpers';

before(initPhysics);

test('el invitado reconstruye la escena del anfitrión', async () => {
  seedRandom(77);
  const { Level } = await import('../src/world/Level');
  const { RuleBasedClassifier } = await import('../src/ai/SkillClassifier');
  const { AdaptiveDifficulty } = await import('../src/ai/AdaptiveDifficulty');
  const { vehicleById } = await import('../src/config/vehicles');
  const { HostSync, packInput, unpackInput } = await import('../src/net/HostSync');
  const { GuestView } = await import('../src/net/GuestView');

  // Enlace en memoria: cada mensaje pasa por JSON, como por la red.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let guest: any = null;
  const link = {
    send(msg: object) {
      const m = JSON.parse(JSON.stringify(msg));
      if (m.t === 'init') guest = new GuestView(m.scene, m.hud, silent, 512);
      else if (m.t === 'frame') guest.apply(m);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new HostSync(link as any);
  const cfg = new AdaptiveDifficulty().calibrationConfig(1, 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const L: any = new Level(cfg, 2, sync.wrapAudio(silent), sync.wrapHooks(hooks), new RuleBasedClassifier(), [vehicleById('cacharro'), vehicleById('truck')]);
  sync.attach(L);
  sync.init(L, 500000);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 600);
  for (let i = 0; i < 60 * 12; i++) {
    for (const p of L.players) p.invuln = 1;
    // El invitado acelera; sus controles viajan empaquetados.
    const remote = unpackInput(JSON.parse(JSON.stringify(packInput({ throttle: 1, brake: 0, steer: 0, turbo: false, shoot: true }))));
    L.update(DT, [{ throttle: 1, brake: 0, steer: 0, turbo: false, shoot: false }, remote]);
    sync.tick(DT, L, 0.5);
    guest.update(DT, camera, 1);
  }
  sync.tick(1, L, 0.5);
  guest.update(10, camera, 1);

  // Mallas visibles (posición en el mundo y color) en ambos lados.
  const meshes = (scene: THREE.Scene) => {
    const out: [number, number, number, string][] = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (o as THREE.InstancedMesh).isInstancedMesh) return;
      for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible || n.userData.noSync) return;
      const pos = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      out.push([pos.x, pos.y, pos.z, ((mesh.material as THREE.MeshBasicMaterial).color?.getHexString() ?? '')]);
    });
    return out;
  };
  const host = meshes(L.scene);
  const copy = meshes(guest.scene);
  assert.equal(copy.length, host.length, 'misma cantidad de mallas visibles');
  // Cada malla del anfitrión tiene su copia (mismo color, a menos de 0,11 m por el redondeo).
  const byColor = new Map<string, [number, number, number][]>();
  for (const [x, y, z, c] of copy) byColor.set(c, [...(byColor.get(c) ?? []), [x, y, z]]);
  let worst = 0;
  for (const [x, y, z, c] of host) {
    const best = Math.min(...(byColor.get(c) ?? []).map(([a, b, d]) => Math.hypot(a - x, b - y, d - z)));
    worst = Math.max(worst, best);
  }
  assert.ok(worst < 0.11, `diferencia máxima ${worst.toFixed(3)} m`);
  assert.equal(guest.hud.players[1].name, 'Toro');
  assert.ok(L.players[1].vehicle.d > 100, 'el invitado avanzó con sus controles');
  guest.dispose();
  L.dispose();
});

test('el código QR de conexión se lee idéntico y se rechaza el equivocado', async () => {
  const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=candidate:1 1 udp 2122260223 192.168.43.1 46243 typ host generation 0 network-id 1\r\na=candidate:2 1 tcp 1518280447 192.168.43.1 9 typ host tcptype active\r\na=ice-ufrag:Fk0X\r\na=ice-pwd:4ZcVw9uYxBg7sLmNq2Tr8Kp1\r\na=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n';
  const received: RTCSessionDescriptionInit[] = [];
  // RTCPeerConnection simulada: Node no tiene WebRTC.
  (globalThis as Record<string, unknown>).RTCPeerConnection = class {
    iceGatheringState = 'complete';
    connectionState = 'new';
    localDescription: RTCSessionDescriptionInit | null = null;
    addEventListener() {}
    removeEventListener() {}
    createDataChannel() {
      return { readyState: 'connecting', addEventListener() {}, close() {} };
    }
    async createOffer() {
      return { type: 'offer', sdp: SDP };
    }
    async createAnswer() {
      return { type: 'answer', sdp: SDP.replace('actpass', 'active') };
    }
    async setLocalDescription(d: RTCSessionDescriptionInit) {
      this.localDescription = d;
    }
    async setRemoteDescription(d: RTCSessionDescriptionInit) {
      received.push(d);
    }
    close() {}
  };
  const { QrLink, qrKind } = await import('../src/net/QrLink');
  const qrcode = (await import('qrcode-generator')).default;
  const jsQR = (await import('jsqr')).default;
  const read = (text: string) => {
    const qr = qrcode(0, 'L');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const cell = 4;
    const size = (n + 8) * cell;
    const px = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c))
          for (let y = 0; y < cell; y++)
            for (let x = 0; x < cell; x++) {
              const i = (((r + 4) * cell + y) * size + (c + 4) * cell + x) * 4;
              px[i] = px[i + 1] = px[i + 2] = 0;
            }
    return jsQR(px, size, size)?.data;
  };
  const offer = await new QrLink().offer();
  assert.equal(qrKind(offer), 'O');
  assert.equal(read(offer), offer, 'la cámara lee el mismo texto');
  const answer = await new QrLink().answer(offer);
  assert.equal(qrKind(answer), 'A');
  const sdp = String(received[0].sdp);
  assert.ok(sdp.includes('192.168.43.1 46243 typ host') && sdp.includes('a=ice-pwd:4ZcVw9uYxBg7sLmNq2Tr8Kp1'), 'conserva dirección y credenciales');
  assert.ok(!sdp.includes('tcptype'), 'quita candidatos innecesarios');
  await assert.rejects(new QrLink().answer(answer), /código de respuesta/);
});

test('el servidor de red local empareja anfitrión e invitado', async () => {
  // @ts-expect-error módulo JavaScript sin tipos
  const { attachRelay } = await import('../server/lan.mjs');
  const server = http.createServer((_q, r) => r.writeHead(404).end());
  attachRelay(server);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const log: string[] = [];
  const open = (role: string) =>
    new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay?role=${role}`);
      ws.on('message', (d) => log.push(`${role}:${d}`));
      ws.on('open', () => resolve(ws));
    });
  const wait = () => new Promise((r) => setTimeout(r, 120));
  const early = await open('guest');
  await wait();
  const host = await open('host');
  const guest = await open('guest');
  const third = await open('guest');
  await wait();
  host.send('{"t":"welcome"}');
  guest.send('{"t":"hello"}');
  await wait();
  guest.close();
  await wait();
  assert.ok(log.some((l) => l.startsWith('guest:') && l.includes('Todavía no hay una partida')), 'sin anfitrión se rechaza');
  assert.ok(log.includes('host:{"$relay":"peer"}') && log.includes('guest:{"$relay":"peer"}'), 'se emparejan');
  assert.ok(log.some((l) => l.includes('ya tiene dos jugadores')), 'un tercero se rechaza');
  assert.ok(log.includes('guest:{"t":"welcome"}') && log.includes('host:{"t":"hello"}'), 'los mensajes se reenvían');
  assert.ok(log.includes('host:{"$relay":"left"}'), 'el anfitrión sabe que el invitado se fue');
  for (const ws of [host, early, third]) ws.close();
  server.close();
});
