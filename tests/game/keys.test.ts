import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPickup, createInventory, satisfiesLock, type KeySlot } from '../../src/game/inventory.ts';
import { lockedLineMessage } from '../../src/ui/hud/message.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, USE_INPUT, TIC } from '../fixtures/specialsrig.ts';

/**
 * Six-slot keys and `LockRule` (Boom `P_CanUnlockGenDoor` semantics): cards and
 * skulls are separate pickups, vanilla color locks accept either, generalized
 * locks can demand exact slots, any key, or all keys.
 * See docs/items.md § Locked doors and use triggers.
 */

const keys = (...slots: KeySlot[]): ReadonlySet<KeySlot> => new Set(slots);

describe('Keys · pickups land in exact slots', () => {
  test('each key thing fills its own card/skull slot', () => {
    const inv = createInventory();
    applyPickup(inv, ThingType.blueSkullKey);
    applyPickup(inv, ThingType.redKeycard);
    assert.deepEqual([...inv.keys].sort(), ['blueSkull', 'redCard']);
  });
});

describe('Keys · satisfiesLock', () => {
  test('color locks accept card or skull of the color, nothing else', () => {
    const lock = { kind: 'color', color: 'blue' } as const;
    assert.ok(satisfiesLock(keys('blueCard'), lock));
    assert.ok(satisfiesLock(keys('blueSkull'), lock));
    assert.ok(!satisfiesLock(keys('redCard', 'yellowSkull'), lock));
  });

  test('slot locks demand the exact card or skull', () => {
    const lock = { kind: 'slot', slot: 'redSkull' } as const;
    assert.ok(satisfiesLock(keys('redSkull'), lock));
    assert.ok(!satisfiesLock(keys('redCard'), lock));
  });

  test('any accepts any single key', () => {
    assert.ok(satisfiesLock(keys('yellowSkull'), { kind: 'any' }));
    assert.ok(!satisfiesLock(keys(), { kind: 'any' }));
  });

  test('all with colorsSuffice wants one of each color', () => {
    const lock = { kind: 'all', colorsSuffice: true } as const;
    assert.ok(satisfiesLock(keys('blueCard', 'redSkull', 'yellowCard'), lock));
    assert.ok(!satisfiesLock(keys('blueCard', 'redSkull'), lock));
  });

  test('all without colorsSuffice wants all six slots', () => {
    const lock = { kind: 'all', colorsSuffice: false } as const;
    assert.ok(!satisfiesLock(keys('blueCard', 'redCard', 'yellowCard'), lock));
    assert.ok(
      satisfiesLock(keys('blueCard', 'redCard', 'yellowCard', 'blueSkull', 'redSkull', 'yellowSkull'), lock),
    );
  });
});

describe('Keys · refusal messages', () => {
  const text = (runs: ReturnType<typeof lockedLineMessage>): string =>
    runs.map((r) => (typeof r === 'string' ? r : r.text)).join('');

  test('a color word is drawn in that color, the rest in the message default', () => {
    // Found in the finished line rather than composed into it, which is what lets a patched
    // `PD_*` keep the coloring — docs/dehacked.md § Locked-door lines.
    assert.deepEqual(lockedLineMessage({ kind: 'slot', slot: 'yellowCard' }, 'door'), [
      'You need a ',
      { text: 'yellow', color: [215, 187, 67] },
      ' card to open this door',
    ]);
    // "Any key will open this door" names no color, so it is one plain run.
    assert.deepEqual(lockedLineMessage({ kind: 'any' }, 'door'), ['Any key will open this door']);
  });

  test("the Boom wordings are d_englsh.h's own", () => {
    assert.equal(text(lockedLineMessage({ kind: 'color', color: 'blue' }, 'door')), 'You need a blue key to open this door');
    assert.equal(
      text(lockedLineMessage({ kind: 'color', color: 'red' }, 'switch')),
      'You need a red key to activate this object',
    );
    assert.equal(text(lockedLineMessage({ kind: 'slot', slot: 'yellowCard' }, 'door')), 'You need a yellow card to open this door');
    assert.equal(text(lockedLineMessage({ kind: 'slot', slot: 'blueSkull' }, 'door')), 'You need a blue skull to open this door');
    assert.equal(text(lockedLineMessage({ kind: 'any' }, 'door')), 'Any key will open this door');
    assert.equal(text(lockedLineMessage({ kind: 'all', colorsSuffice: true }, 'door')), 'You need all three keys to open this door');
    assert.equal(text(lockedLineMessage({ kind: 'all', colorsSuffice: false }, 'door')), 'You need all six keys to open this door');
  });
});

describe('Keys · locked lines in the controller', () => {
  /** One open cell and a shut manual door behind its east edge, special 32 (D1 blue). */
  function lockedDoorRig() {
    const grid = gridMap(['.+'], { cell: 64 });
    const { map } = grid;
    map.linedefs[grid.westEdge(1, 0)].special = 32;
    const rig = specialsRig(map, { x: 32, y: 32 });
    return { map, rig };
  }

  test('using a keyed door without the key refuses, reports the lock, and stays unspent', () => {
    const { map, rig } = lockedDoorRig();
    rig.specials.update(TIC, { x: 32, y: 32, angle: 0 }, USE_INPUT, new Set());
    assert.deepEqual(rig.specials.consumeLockedLine(0), { lock: { kind: 'color', color: 'blue' }, kind: 'door' });
    assert.equal(map.sectors[1].ceilHeight, 0);

    // The skull opens a card-agnostic color lock, and the earlier refusal spent nothing.
    rig.specials.update(TIC, { x: 32, y: 32, angle: 0 }, USE_INPUT, new Set<KeySlot>(['blueSkull']));
    assert.equal(rig.specials.consumeLockedLine(0), null);
    for (let i = 0; i < 5; i++) rig.tick();
    assert.ok(map.sectors[1].ceilHeight > 0);
  });
});
