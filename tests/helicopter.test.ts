import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as THREE from 'three';
import { DT, initPhysics, seedRandom } from './helpers';

before(initPhysics);

test('el helicóptero se retira volando en lugar de desaparecer', async () => {
  seedRandom(5);
  const { Helicopter } = await import('../src/entities/Helicopter');
  const { Rng } = await import('../src/core/Rng');
  const scene = new THREE.Scene();
  const heli = new Helicopter(scene, 0, -40);
  // Un jugador quieto como objetivo y una configuración de disparo agresiva.
  const player = { alive: true, vehicle: { px: 0, pz: 0, vx: 0, vz: -20 } };
  const cfg = { fireRate: 3, accuracy: 1 } as never;
  const rng = new Rng(1);
  let shots = 0;
  // La primera ráfaga llega a los 4 s.
  for (let i = 0; i < 360; i++) if (heli.update(DT, [player] as never, cfg, rng)) shots++;
  assert.ok(shots > 0, 'mientras persigue, dispara');
  assert.ok(heli.chasing);

  const start = heli.model.group.position.clone();
  heli.leave(0, 0);
  assert.equal(heli.chasing, false);
  let maxAlt = 0;
  let shotsLeaving = 0;
  let steps = 0;
  while (!heli.gone && steps < 600) {
    if (heli.update(DT, [player] as never, cfg, rng)) shotsLeaving++;
    maxAlt = Math.max(maxAlt, heli.model.group.position.y);
    steps++;
  }
  const end = heli.model.group.position;
  assert.ok(heli.gone, 'termina de irse');
  assert.ok(steps * DT > 3 && steps * DT < 6, `la retirada dura unos segundos (${(steps * DT).toFixed(1)} s)`);
  assert.equal(shotsLeaving, 0, 'no dispara al irse');
  assert.ok(maxAlt > start.y + 20, 'sube');
  assert.ok(Math.hypot(end.x - start.x, end.z - start.z) > 100, 'se aleja');
  assert.ok(end.z < start.z, 'se va hacia adelante');
  assert.equal(heli.model.spot.visible, false, 'apaga el reflector');
  assert.ok((heli.model.shadow.material as THREE.MeshBasicMaterial).opacity < 0.02, 'la sombra se desvanece');
  heli.dispose();
});

test('el helicóptero no atraviesa los edificios de la ciudad', async () => {
  seedRandom(9);
  const { Helicopter } = await import('../src/entities/Helicopter');
  const { ChunkManager } = await import('../src/world/ChunkManager');
  const { Physics } = await import('../src/world/Physics');
  const { Track, CHUNK } = await import('../src/world/Track');
  const { Rng } = await import('../src/core/Rng');
  const { BASE_LEVELS } = await import('../src/config/levels');
  const scene = new THREE.Scene();
  const track = new Track(new Rng(3));
  const chunks = new ChunkManager(
    {
      scene,
      physics: new Physics(),
      track,
      rng: new Rng(4),
      config: structuredClone(BASE_LEVELS[1]),
      biomeFor: (i) => (i < 4 ? 'city' : i < 7 ? 'industrial' : 'city'),
      spawnCivilian: () => {},
    },
    0,
  );
  const cfg = { fireRate: 1, accuracy: 0.5 } as never;
  // Con el pasillo normal vuela sobre la calle; con uno enorme cruza las manzanas y debe subir.
  for (const wide of [false, true]) {
    const world = {
      ceiling: (x: number, z: number, r: number) => chunks.ceiling(x, z, r),
      corridor: (z: number) => ({ cx: track.centerX(-z), half: wide ? 40 : track.halfWidth(-z) - 3.5 }),
    };
    const heli = new Helicopter(scene, track.centerX(60) + 30, -60);
    const player = { alive: true, vehicle: { px: 0, pz: 0, vx: 0, vz: 0 } };
    const rng = new Rng(1);
    let maxRoof = 0;
    let worst = Infinity;
    for (let d = 10; d < 9 * CHUNK; d += 28 * DT) {
      chunks.update(d + 40, d - 80, DT);
      const heading = track.angle(d);
      Object.assign(player.vehicle, { px: track.centerX(d), pz: -d, vx: -Math.sin(heading) * 28, vz: -Math.cos(heading) * 28 });
      heli.update(DT, [player] as never, cfg, rng, world);
      const g = heli.model.group.position;
      // Lo que hay bajo el rotor (5,7 m de radio) frente a la altura de los patines.
      const roof = chunks.ceiling(g.x, g.z, 5.7);
      if (roof > 0) {
        maxRoof = Math.max(maxRoof, roof);
        worst = Math.min(worst, g.y - 0.45 - roof);
      }
    }
    if (wide) assert.ok(maxRoof > 15, `cruzó por encima de edificios altos (${maxRoof.toFixed(1)} m)`);
    assert.ok(worst > 0, `los patines quedan sobre los techos (margen mínimo ${worst.toFixed(2)} m, pasillo ${wide ? 'ancho' : 'normal'})`);
    heli.dispose();
  }
  chunks.dispose();
});
