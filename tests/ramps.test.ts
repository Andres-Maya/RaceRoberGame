import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DT, hooks, initPhysics, seedRandom, silent } from './helpers';

before(initPhysics);

type Outcome = 'salto' | 'torcido' | 'rozón' | 'ninguno';

/**
 * Coloca una rampa en un nivel real y hace llegar un vehículo a ella con el
 * desplazamiento lateral pedido (medido en el sistema de la rampa). Devuelve
 * qué pasó en la rampa y si en algún momento la atravesó sin volar.
 */
async function rampRun(vehicle: string, lat: number, speed: number, opts: { crossing?: boolean } = {}) {
  seedRandom(1234);
  const { Level } = await import('../src/world/Level');
  const { RuleBasedClassifier } = await import('../src/ai/SkillClassifier');
  const { LEVEL_0 } = await import('../src/config/levels');
  const { vehicleById } = await import('../src/config/vehicles');
  const { RAMP_HW, RAMP_HD } = await import('../src/world/ChunkManager');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const L: any = new Level(structuredClone(LEVEL_0), 1, silent, hooks, new RuleBasedClassifier(), [vehicleById(vehicle)]);
  for (let i = 0; i < 240 && L.state !== 'running'; i++) L.update(DT, [null]);
  const p = L.players[0];
  const v = p.vehicle;
  if (L.storm) L.storm.front = -1e6;
  const rd = v.d + 60;
  // Tramo despejado: los obstáculos cercanos se apartan.
  for (const o of [...L.chunks.obstacles()]) if (Math.abs(o.d - rd) < 30) o.body.setTranslation({ x: 9000 + o.d, y: 1, z: 9000 }, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chunk = [...L.chunks.chunks.values()].find((c: any) => rd >= c.d0 && rd < c.d1);
  L.chunks.hazard(chunk, 'ramp', rd, 0, RAMP_HW, RAMP_HD);
  const h = chunk.hazards[chunk.hazards.length - 1];
  const a = L.track.angle(rd);
  // Ejes de la rampa en el mundo: adelante y derecha.
  const fx = -Math.sin(a);
  const fz = -Math.cos(a);
  const rx = Math.cos(a);
  const rz = -Math.sin(a);
  const hz = -rd;
  if (opts.crossing) {
    // Cruza por delante, de derecha a izquierda.
    v.teleport(h.x + rx * 9, hz + rz * 9, a + Math.PI / 2);
  } else {
    v.teleport(h.x - fx * 7 + rx * lat, hz - fz * 7 + rz * lat, a);
  }
  v.vx = -Math.sin(v.heading) * speed;
  v.vz = -Math.cos(v.heading) * speed;
  v.apply();
  let outcome: Outcome = 'ninguno';
  let through = false;
  for (let i = 0; i < 300; i++) {
    p.invuln = 1;
    L.update(DT, [{ throttle: v.speed < speed ? 1 : 0, brake: 0, steer: 0, turbo: false, shoot: false }]);
    const dx = v.px - h.x;
    const dz = v.pz - hz;
    const along = dx * fx + dz * fz;
    const side = dx * rx + dz * rz;
    if (outcome === 'ninguno' && Math.abs(along) < 6) {
      if (p.graze > 0) outcome = 'rozón';
      else if (p.air > 0) outcome = p.airRoll ? 'torcido' : 'salto';
    }
    if (Math.abs(side) < h.hw - 0.15 && Math.abs(along) < h.hd - 0.15 && p.air <= 0 && !p.ghost) through = true;
  }
  const result = { outcome, through, speed: Math.hypot(v.vx, v.vz), passed: (v.px - h.x) * fx + (v.pz - hz) * fz > h.hd };
  L.dispose();
  return result;
}

test('de frente y centrado, cualquier vehículo salta la rampa completa', async () => {
  for (const id of ['cacharro', 'moto', 'armored']) {
    const r = await rampRun(id, 0, 26);
    assert.equal(r.outcome, 'salto', id);
    assert.equal(r.through, false, id);
    assert.ok(r.passed, `${id} pasa la rampa`);
  }
});

test('despacio también salta si entra de frente (sin frenar en el aire)', async () => {
  const r = await rampRun('cacharro', 0, 6);
  assert.equal(r.outcome, 'salto');
  assert.ok(r.passed);
});

test('la moto salta aunque tome la rampa por la esquina', async () => {
  const r = await rampRun('moto', 2.3, 26);
  assert.equal(r.outcome, 'salto');
});

test('con cuatro ruedas, si sube un solo lado hace un salto torcido', async () => {
  const r = await rampRun('truck', 2.3, 26);
  assert.equal(r.outcome, 'torcido');
  assert.equal(r.through, false);
  assert.ok(r.speed < 24, 'pierde velocidad al aterrizar');
});

test('si apenas roza la esquina se desvía sin frenarse en seco', async () => {
  const r = await rampRun('truck', 3.05, 26);
  assert.equal(r.outcome, 'rozón');
  assert.equal(r.through, false);
  assert.ok(r.speed > 15, `sigue andando (${r.speed.toFixed(1)} m/s)`);
});

test('casi detenido o cruzando por delante, choca: nunca la atraviesa', async () => {
  const slow = await rampRun('cacharro', 0, 3);
  assert.equal(slow.outcome, 'ninguno');
  assert.equal(slow.through, false);
  const cross = await rampRun('armored', 0, 18, { crossing: true });
  assert.equal(cross.through, false);
});
