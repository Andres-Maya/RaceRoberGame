import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DT, hooks, initPhysics, seedRandom, silent } from './helpers';

before(initPhysics);

/** Nivel listo para jugar con un "río" a ambos lados de la vía a partir de 11,3 m del centro. */
async function riverLevel() {
  seedRandom(2468);
  const { Level } = await import('../src/world/Level');
  const { RuleBasedClassifier } = await import('../src/ai/SkillClassifier');
  const { LEVEL_0 } = await import('../src/config/levels');
  const { vehicleById } = await import('../src/config/vehicles');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const L: any = new Level(structuredClone(LEVEL_0), 1, silent, hooks, new RuleBasedClassifier(), [vehicleById('cacharro')]);
  for (let i = 0; i < 240 && L.state !== 'running'; i++) L.update(DT, [null]);
  if (L.storm) L.storm.front = -1e6;
  L.track.isWater = (x: number, d: number) => Math.abs(L.track.lateral(x, d)) > 11.3;
  return L;
}

const idle = { throttle: 0, brake: 0, steer: 0, turbo: false, shoot: false };

test('el jugador que cae al río se hunde y reaparece unos metros atrás con menos vida', async () => {
  const L = await riverLevel();
  const p = L.players[0];
  const v = p.vehicle;
  const d = v.d + 20;
  p.invuln = 1; // ni siquiera la invulnerabilidad lo salva del agua
  v.teleport(L.track.centerX(d) + 16, -d, L.track.angle(d));
  const hp = p.hp;
  L.update(DT, [idle]);
  assert.ok(p.sinking, 'se está hundiendo');
  assert.equal(p.hp, hp - 30);
  assert.ok(p.ghost, 'mientras se hunde no choca con nada');
  for (let i = 0; i < 20; i++) L.update(DT, [idle]);
  assert.ok(p.mesh.position.y < -0.4, 'el vehículo baja bajo el agua');
  for (let i = 0; i < 120 && p.sinking; i++) L.update(DT, [idle]);
  assert.ok(!p.sinking && p.alive, 'reaparece');
  assert.ok(Math.abs(d - 12 - v.d) < 1, `reaparece 12 m antes (cayó en ${d.toFixed(1)}, vuelve en ${v.d.toFixed(1)})`);
  assert.ok(Math.abs(L.track.lateral(v.px, v.d)) < 1, 'en el centro de la vía');
  assert.equal(p.mesh.position.y, 0);
  assert.ok(!p.ghost && p.mesh.visible);
  assert.equal(p.hp, hp - 30, 'la vida perdida no se recupera');
  L.dispose();
});

test('si al caer al río se queda sin vida, se hunde y no reaparece', async () => {
  const L = await riverLevel();
  const p = L.players[0];
  const v = p.vehicle;
  p.hp = 20;
  v.teleport(L.track.centerX(v.d) - 16, v.pz, v.heading);
  for (let i = 0; i < 150; i++) L.update(DT, [idle]);
  assert.ok(!p.alive, 'quedó destruido');
  assert.ok(!p.mesh.visible, 'terminó de hundirse');
  L.dispose();
});

test('el estribo del puente es tierra firme y el río empieza después', async () => {
  const { Track, CHUNK, BRIDGE_ABUTMENT } = await import('../src/world/Track');
  const { Rng } = await import('../src/core/Rng');
  const t = new Track(new Rng(1));
  t.setBiome(0, 'city');
  t.setBiome(1, 'bridge');
  t.setBiome(2, 'bridge');
  const side = (d: number) => t.centerX(d) + 20;
  assert.ok(!t.isWater(side(CHUNK - 1), CHUNK - 1), 'antes del puente');
  assert.ok(!t.isWater(side(CHUNK + 1), CHUNK + 1), 'sobre el estribo');
  assert.ok(t.isWater(side(CHUNK + BRIDGE_ABUTMENT + 1), CHUNK + BRIDGE_ABUTMENT + 1), 'pasado el estribo');
  assert.ok(t.isWater(side(2 * CHUNK + 1), 2 * CHUNK + 1), 'el segundo tramo del puente no tiene estribo');
  assert.ok(!t.isWater(t.centerX(CHUNK + 20), CHUNK + 20), 'la calzada del puente no es agua');
});
