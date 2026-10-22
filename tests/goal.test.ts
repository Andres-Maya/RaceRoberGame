import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DT, hooks, initPhysics, seedRandom, silent } from './helpers';

before(initPhysics);

async function startLevel(index: 0 | 4) {
  seedRandom(99);
  const { Level } = await import('../src/world/Level');
  const { RuleBasedClassifier } = await import('../src/ai/SkillClassifier');
  const { LEVEL_0, ENDLESS_LEVEL } = await import('../src/config/levels');
  const cfg = structuredClone(index === 0 ? LEVEL_0 : ENDLESS_LEVEL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const L: any = new Level(cfg, 1, silent, hooks, new RuleBasedClassifier());
  for (let i = 0; i < 300 && L.state !== 'running'; i++) L.update(DT, [null]);
  return L;
}

test('la flecha apunta a la carretera hacia la meta y, cerca, a la meta misma', async () => {
  const L = await startLevel(0);
  const v = L.players[0].vehicle;
  const far = L.goalPoint;
  assert.ok(far, 'hay flecha durante la carrera');
  assert.equal(far.near, false, 'la meta todavía está lejos');
  assert.ok(far.z < v.pz - 40, 'apunta adelante, por la carretera');
  assert.ok(Math.abs(far.x - L.track.centerX(-far.z)) < 0.01, 'sobre el centro de la carretera');

  // Meta generada y cerca: la flecha señala la meta (por ejemplo, la puerta del banco).
  L.chunks.finishZone = { kind: 'bank', x: 12, d: L.maxD + 150, hw: 6, hd: 4 };
  const near = L.goalPoint;
  assert.deepEqual(near, { x: 12, z: -(L.maxD + 150), near: true });

  // Al llegar, la flecha desaparece.
  L.state = 'ending';
  assert.equal(L.goalPoint, null);
  L.dispose();
});

test('el nivel infinito no tiene flecha de meta', async () => {
  const L = await startLevel(4);
  assert.equal(L.goalPoint, null);
  L.dispose();
});
