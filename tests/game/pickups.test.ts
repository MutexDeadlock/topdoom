import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPickup, createInventory } from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/thingtypes.ts';

/**
 * What a pickup is worth, across the three paths that hand over ammo and the skills that double
 * them. `P_GiveAmmo`/`P_GiveWeapon`/`P_GiveBackpack` (`p_inter.c`), see docs/items.md § Skill.
 */
describe('Game rules · ammo pickups by skill', () => {
  /** A fresh inventory starts on 50 bullets (`createInventory`), so the gains below are the deltas. */
  const bulletsAfter = (type: number, dropped: boolean, skill: 1 | 3 | 5) => {
    const inv = createInventory();
    const before = inv.ammo.bullets;
    applyPickup(inv, type, dropped, skill);
    return inv.ammo.bullets - before;
  };

  test('a map-placed clip gives its 10 bullets, doubled on skills 1 and 5', () => {
    assert.equal(bulletsAfter(ThingType.clip, false, 3), 10);
    assert.equal(bulletsAfter(ThingType.clip, false, 1), 20);
    assert.equal(bulletsAfter(ThingType.clip, false, 5), 20);
  });

  test('a dropped clip is halved first and doubled after, so skill 1 makes it whole again', () => {
    // Vanilla reaches the same figure from the other side: a dropped clip is `P_GiveAmmo(…, 0)`,
    // i.e. `clipammo/2`, and the skill doubling applies to that.
    assert.equal(bulletsAfter(ThingType.clip, true, 3), 5);
    assert.equal(bulletsAfter(ThingType.clip, true, 1), 10);
  });

  test("a weapon's own ammo doubles too", () => {
    const inv = createInventory();
    inv.ammo.bullets = 0;
    applyPickup(inv, ThingType.chaingun, false, 5);
    assert.equal(inv.ammo.bullets, 40, 'a map-placed chaingun carries 20');
  });

  test('the backpack doubles its clip of each class, and still raises the caps', () => {
    const inv = createInventory();
    inv.ammo.bullets = 0;
    inv.ammo.shells = 0;
    applyPickup(inv, ThingType.backpack, false, 1);
    assert.equal(inv.ammo.bullets, 20, 'one clip of 10, doubled');
    assert.equal(inv.ammo.shells, 8, 'one clip of 4, doubled');
    assert.equal(inv.backpack, true);
  });

  test('the cap still wins over the doubling', () => {
    const inv = createInventory();
    inv.ammo.bullets = 195;
    applyPickup(inv, ThingType.clip, false, 1);
    assert.equal(inv.ammo.bullets, 200, 'vanilla applies the doubling to `num`, then clamps');
  });

  test('skill reaches nothing but ammo', () => {
    const inv = createInventory();
    inv.health = 50;
    applyPickup(inv, ThingType.stimpack, false, 1);
    assert.equal(inv.health, 60, 'a stimpack is 10 on every skill');
  });
});
