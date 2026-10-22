import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DT, hooks, initPhysics, seedRandom, silent } from './helpers';

before(initPhysics);

/**
 * Pone un bidón de combustible delante del vehículo y lo conduce contra él.
 * `steerAway`: tras el primer contacto se desvía (solo un golpe, sin empujar).
 */
async function barrelRun(vehicle: string, speed: number, opts: { steerAway?: boolean; seconds?: number } = {}) {
  seedRandom(4321);
  const { Level } = await import('../src/world/Level');
  const { RuleBasedClassifier } = await import('../src/ai/SkillClassifier');
  const { LEVEL_0 } = await import('../src/config/levels');
  const { vehicleById } = await import('../src/config/vehicles');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const L: any = new Level(structuredClone(LEVEL_0), 1, silent, hooks, new RuleBasedClassifier(), [vehicleById(vehicle)]);
  for (let i = 0; i < 240 && L.state !== 'running'; i++) L.update(DT, [null]);
  if (L.storm) L.storm.front = -1e6;
  const p = L.players[0];
  const v = p.vehicle;
  const bd = v.d + 25;
  // Tramo despejado y un bidón en el centro de la vía.
  for (const o of [...L.chunks.obstacles()]) if (Math.abs(o.d - bd) < 60) o.body.setTranslation({ x: 9000 + o.d, y: 1, z: 9000 }, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chunk = [...L.chunks.chunks.values()].find((c: any) => bd >= c.d0 && bd < c.d1);
  const barrel = L.chunks.addObstacle(chunk, 'fuelBarrel', bd, 0, 0, true);
  v.teleport(L.track.centerX(v.d), v.pz, L.track.angle(v.d));
  v.vx = -Math.sin(v.heading) * speed;
  v.vz = -Math.cos(v.heading) * speed;
  v.apply();
  let touchedAt = -1;
  let explodedAt = -1;
  let minHp = 100;
  const frames = Math.round((opts.seconds ?? 6) / DT);
  for (let i = 0; i < frames; i++) {
    p.invuln = 1;
    if (touchedAt < 0 && barrel.hp !== undefined) touchedAt = i * DT;
    // Sigue la carretera; si solo se quiere un golpe, tras tocarlo se aparta del bidón.
    const look = L.track.angle(v.d + 10);
    let steer = Math.max(-1, Math.min(1, -(look - v.heading) * 3));
    if (opts.steerAway && touchedAt >= 0) steer = 1;
    L.update(DT, [{ throttle: v.speed < speed ? 1 : 0, brake: 0, steer, turbo: false, shoot: false }]);
    minHp = Math.min(minHp, barrel.hp ?? 100);
    if (barrel.dead && explodedAt < 0) explodedAt = i * DT;
  }
  L.dispose();
  return { touchedAt, explodedAt, minHp };
}

test('un choque a toda velocidad no hace estallar el bidón', async () => {
  for (const id of ['cacharro', 'moto', 'armored']) {
    const r = await barrelRun(id, 30, { steerAway: true, seconds: 3 });
    assert.ok(r.touchedAt >= 0, `${id} chocó el bidón`);
    assert.equal(r.explodedAt, -1, `${id}: no estalla de un golpe (aguante mínimo ${r.minHp.toFixed(0)})`);
  }
});

test('empujarlo un buen rato lo hace estallar', async () => {
  const r = await barrelRun('cacharro', 14, { seconds: 8 });
  assert.ok(r.touchedAt >= 0, 'lo alcanzó');
  assert.ok(r.explodedAt > 0, 'termina estallando');
  const pushed = r.explodedAt - r.touchedAt;
  assert.ok(pushed > 1.2 && pushed < 4.5, `estalla tras empujarlo ${pushed.toFixed(1)} s`);
});
