import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnlocked, unlockedIds, VEHICLES, vehicleById, type UnlockState } from '../src/config/vehicles';

const fresh = (): UnlockState => ({ unlocked: 0, victories: 0, bestEndless: 0, totals: { wrecks: 0, jumps: 0 } });

test('el vehículo inicial es de cuatro ruedas y el único disponible al empezar', () => {
  const starter = VEHICLES[0];
  assert.equal(starter.unlock, null);
  assert.equal(starter.twoWheeler, false);
  assert.deepEqual([...unlockedIds(fresh())], [starter.id]);
  // Todos los demás tienen una forma de conseguirse.
  for (const v of VEHICLES.slice(1)) assert.ok(v.unlock, `${v.id} debe tener desbloqueo`);
});

test('cada vehículo se desbloquea con su objetivo', () => {
  const cases: [string, Partial<UnlockState>][] = [
    ['moto', { unlocked: 1 }],
    ['sport', { unlocked: 2 }],
    ['muscle', { unlocked: 3 }],
    ['truck', { totals: { wrecks: 40, jumps: 0 } }],
    ['buggy', { totals: { wrecks: 0, jumps: 15 } }],
    ['armored', { victories: 1 }],
    ['armored', { bestEndless: 3000 }],
  ];
  for (const [id, change] of cases) {
    const def = vehicleById(id);
    assert.equal(isUnlocked(def, fresh()), false, `${id} empieza bloqueado`);
    assert.equal(isUnlocked(def, { ...fresh(), ...change }), true, `${id} se desbloquea con ${JSON.stringify(change)}`);
  }
});

test('el progreso visible no pasa de la meta', () => {
  const s = { ...fresh(), totals: { wrecks: 95, jumps: 3 } };
  assert.equal(vehicleById('truck').unlock!.progress!(s), '40/40');
  assert.equal(vehicleById('buggy').unlock!.progress!(s), '3/15');
});

test('un identificador desconocido usa el vehículo inicial', () => {
  assert.equal(vehicleById('inexistente').id, VEHICLES[0].id);
});
