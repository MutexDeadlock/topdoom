import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPickup,
  createInventory,
  setAutoSwitchWeapon,
  type Inventory,
  type WeaponId,
} from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';

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

/**
 * `P_GiveAmmo`'s tail: a class collected from zero raises the ready weapon to the one it feeds.
 * See docs/items.md § Ammo raises the weapon.
 */
describe('Game rules · ammo raises the weapon', () => {
  /** A player holding `weapon`, owning `owned`, at zero of everything unless `ammo` says otherwise. */
  function pickingUp(
    type: number,
    weapon: WeaponId,
    owned: WeaponId[],
    ammo: Partial<Inventory['ammo']> = {},
  ): WeaponId {
    const inv = createInventory();
    inv.ammo = { bullets: 0, shells: 0, rockets: 0, cells: 0, ...ammo };
    inv.weapons = new Set([weapon, ...owned]);
    inv.currentWeapon = weapon;
    applyPickup(inv, type, false, 3);
    return inv.currentWeapon;
  }

  test('each class raises the fist to the weapon it feeds', () => {
    assert.equal(pickingUp(ThingType.clip, 'fist', ['chaingun']), 'chaingun');
    assert.equal(pickingUp(ThingType.shells, 'fist', ['shotgun']), 'shotgun');
    assert.equal(pickingUp(ThingType.cellCharge, 'fist', ['plasmaRifle']), 'plasmaRifle');
    assert.equal(pickingUp(ThingType.rocket, 'fist', ['rocketLauncher']), 'rocketLauncher');
  });

  test('bullets fall back to the pistol when no chaingun is owned', () => {
    assert.equal(pickingUp(ThingType.clip, 'fist', ['pistol']), 'pistol');
    assert.equal(pickingUp(ThingType.clip, 'fist', []), 'fist', 'and to nothing when it is not owned either');
  });

  test('shells and cells raise the pistol too, rockets and bullets do not', () => {
    assert.equal(pickingUp(ThingType.shells, 'pistol', ['shotgun']), 'shotgun');
    assert.equal(pickingUp(ThingType.cellCharge, 'pistol', ['plasmaRifle']), 'plasmaRifle');
    // `am_misl` and `am_clip` name only the fist — the asymmetry is vanilla's.
    assert.equal(pickingUp(ThingType.rocket, 'pistol', ['rocketLauncher']), 'pistol');
    assert.equal(pickingUp(ThingType.clip, 'pistol', ['chaingun']), 'pistol');
  });

  test('anything above the fist and pistol is left holding what it holds', () => {
    assert.equal(pickingUp(ThingType.shells, 'shotgun', ['shotgun', 'supershotgun']), 'shotgun');
  });

  test('a partial stock is left alone: the player was lower on purpose', () => {
    assert.equal(pickingUp(ThingType.shells, 'fist', ['shotgun'], { shells: 1 }), 'fist');
  });

  test('a weapon pickup still wins over the ammo it carries', () => {
    // `P_GiveWeapon` runs `P_GiveAmmo` first and then overwrites its pick.
    assert.equal(pickingUp(ThingType.shotgun, 'fist', ['chaingun']), 'shotgun');
    // Re-picking one already owned leaves the ammo rule's answer standing.
    assert.equal(pickingUp(ThingType.rocketLauncher, 'fist', ['rocketLauncher']), 'rocketLauncher');
  });

  test('the backpack is walked in ammotype_t order, so the last class wins', () => {
    // `P_GiveBackpack` grants all four and each overwrites the last one's pick; `am_misl` is last,
    // which is why `AMMO_UPGRADE` may not reuse `AMMO_TYPES`' rockets-before-cells order.
    const owned: WeaponId[] = ['chaingun', 'shotgun', 'plasmaRifle', 'rocketLauncher'];
    assert.equal(pickingUp(ThingType.backpack, 'fist', owned), 'rocketLauncher');
    // Without the launcher the pick falls back to the class before it.
    assert.equal(pickingUp(ThingType.backpack, 'fist', ['plasmaRifle', 'shotgun']), 'plasmaRifle');
  });

  test('with the setting off nothing is raised, but a new weapon still selects itself', () => {
    setAutoSwitchWeapon(false);
    try {
      assert.equal(pickingUp(ThingType.shells, 'fist', ['shotgun']), 'fist');
      assert.equal(pickingUp(ThingType.backpack, 'fist', ['rocketLauncher']), 'fist');
      // Ungated, being vanilla's own "what you picked up is what you hold".
      assert.equal(pickingUp(ThingType.shotgun, 'fist', []), 'shotgun');
    } finally {
      setAutoSwitchWeapon(true);
    }
  });
});
