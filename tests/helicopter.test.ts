import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DT, seedRandom } from './helpers';

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
