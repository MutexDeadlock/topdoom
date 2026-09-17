import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DOOM_TIC } from '../../src/constants.ts';
import { consumeSecret, decodeSectorType } from '../../src/game/specials/sectortypes.ts';
import { SectorEffects } from '../../src/game/specials/sectoreffects.ts';
import { createInventory } from '../../src/game/inventory.ts';
import { World } from '../../src/game/world.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { DAMAGE_FLOOR_INTERVAL } from '../../src/game/specials/tables.ts';

/**
 * Boom's generalized sector-type bitfield (p_spec.h masks, semantics from
 * P_SpawnSpecials / P_PlayerInSpecialSector) in front of the vanilla tables.
 * See docs/specials.md § Generalized sector types.
 */
describe('Specials · generalized sector types', () => {
  test('vanilla numbers pass through untouched', () => {
    assert.equal(decodeSectorType(9).secret, true);
    assert.equal(decodeSectorType(9).damage, null);
    assert.equal(decodeSectorType(7).damage?.amount, 5);
    assert.equal(decodeSectorType(2).lightPattern, 'blink05');
    // P_SpawnSpecials pairs the *synced* types the other way round from the
    // unsynced ones: 12 is SLOWDARK and 13 FASTDARK.
    assert.equal(decodeSectorType(3).lightPattern, 'blink1');
    assert.equal(decodeSectorType(12).lightPattern, 'syncBlink1');
    assert.equal(decodeSectorType(13).lightPattern, 'syncBlink05');
    assert.equal(decodeSectorType(10).doorTimer, 'closeIn30');
    assert.equal(decodeSectorType(0).secret, false);
  });

  test('damage bits 5-6 pick the class, with the suit leak only on the 20 tier', () => {
    assert.equal(decodeSectorType(0x100).damage, null, 'class 0 under a generalized bit');
    assert.deepEqual(decodeSectorType(1 << 5).damage, { amount: 5, suit: 'blocks' });
    assert.deepEqual(decodeSectorType(2 << 5).damage, { amount: 10, suit: 'blocks' });
    assert.deepEqual(decodeSectorType(3 << 5).damage, { amount: 20, suit: 'leaks' });
  });

  test('bits 0-4 keep the vanilla behaviors under the generalized bits', () => {
    const d = decodeSectorType(0x80 | (1 << 5) | 2);
    assert.equal(d.lightPattern, 'blink05');
    assert.equal(d.secret, true);
    assert.equal(d.damage?.amount, 5);
    assert.equal(decodeSectorType(0x80 | 10).doorTimer, 'closeIn30');
  });

  test('friction and push bits decode', () => {
    assert.equal(decodeSectorType(0x100).friction, true);
    assert.equal(decodeSectorType(0x200).push, true);
    assert.equal(decodeSectorType(0x100).push, false);
    assert.equal(decodeSectorType(5).friction, false);
  });

  test('consuming a secret clears vanilla 9 wholesale, the generalized bit surgically', () => {
    assert.equal(consumeSecret(9), 0);
    assert.equal(consumeSecret(0x80 | (2 << 5)), 2 << 5);
    // Nothing but low bits left -> Boom zeroes the special outright.
    assert.equal(consumeSecret(0x80 | 2), 0);
  });

  test('a generalized secret+damage sector counts, damages and consumes correctly', () => {
    const grid = gridMap(['..']);
    const { map } = grid;
    map.sectors[0].special = 0x80 | (3 << 5); // secret + 20 HP damage
    const effects = new SectorEffects(map);
    assert.equal(effects.totalSecrets, 1);

    const world = new World(map);
    const inv = createInventory();
    let dealt = 0;
    const at = { ...grid.centre(0, 0), z: 0 };
    const first = effects.update(DOOM_TIC, world, at, inv, (n) => (dealt += n));
    assert.equal(first.secretFound, true);
    assert.equal(effects.secretsFound, 1);
    // The secret bit is gone, the damage class stays armed.
    assert.equal(map.sectors[0].special, 3 << 5);
    for (let i = 0; i < 40; i++) effects.update(DAMAGE_FLOOR_INTERVAL / 32, world, at, inv, (n) => (dealt += n));
    assert.ok(dealt >= 20, `damage floor under the generalized bits dealt ${dealt}`);
    assert.equal(effects.update(DOOM_TIC, world, at, inv, () => {}).secretFound, false);
  });
});
