import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WeaponSystem } from '../../src/game/weapons.ts';
import { createInventory, type Inventory, type WeaponId } from '../../src/game/inventory.ts';
import type { Input } from '../../src/game/input.ts';
import { SILENT } from '../../src/audio/sfx.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { NO_INPUT, PREV_WEAPON_INPUT } from '../fixtures/input.ts';

/**
 * Which weapon a frame ends up holding: the right button's "switch to previous weapon" binding,
 * the per-slot memory a digit key walks, and the wheel. What's worth pinning is that
 * `previousWeapon` is tracked off the once-a-frame comparison rather than at each switch site, so
 * a switch nothing routed through `handleSwitching` (a pickup, a berserk pack) still counts.
 * What a weapon then *does* is `tests/game/weapon-firing.test.ts`.
 * See docs/weapons.md § Slot keys.
 */

/** Where the player stands; nothing in the switch path reads it. */
const AT = { x: 0, y: 0, z: 0 };


/**
 * One frame of the switch path: the input (nothing pressed by default) and any
 * wheel scroll, then the `update` that notices what ended up selected.
 */
function settle(weapons: WeaponSystem, inv: Inventory, input: Input = NO_INPUT, wheel = 0): WeaponId {
  weapons.handleSwitching(input, inv, wheel);
  weapons.update(DOOM_TIC, false, inv, SILENT, AT);
  return inv.currentWeapon;
}

function selectDirectly(weapons: WeaponSystem, inv: Inventory, weapon: WeaponId): void {
  inv.currentWeapon = weapon;
  settle(weapons, inv);
}

/** A system begun on `inv`, as a level load hands it one. */
function started(inv: Inventory): WeaponSystem {
  const weapons = new WeaponSystem();
  weapons.beginLevel(inv);
  return weapons;
}

/** One frame with digit key `n` down, and what it selected. */
function press(weapons: WeaponSystem, inv: Inventory, n: number): WeaponId {
  const key = { ...NO_INPUT, pressed: (code: string) => code === `Digit${n}` } as unknown as Input;
  return settle(weapons, inv, key);
}

describe('Weapons · switch to previous weapon', () => {
  test('a click toggles back to the previous weapon, and again returns', () => {
    const inv = createInventory();
    const weapons = started(inv);
    assert.equal(inv.currentWeapon, 'pistol');

    selectDirectly(weapons, inv, 'fist');
    weapons.handleSwitching(PREV_WEAPON_INPUT, inv, 0);
    assert.equal(inv.currentWeapon, 'pistol');

    // The same frame's update records the weapon just left, so the next
    // click goes the other way rather than sticking on the pistol.
    weapons.update(DOOM_TIC, false, inv, SILENT, AT);
    weapons.handleSwitching(PREV_WEAPON_INPUT, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });

  test('a click before any switch does nothing', () => {
    const inv = createInventory();
    const weapons = started(inv);

    settle(weapons, inv);
    weapons.handleSwitching(PREV_WEAPON_INPUT, inv, 0);
    assert.equal(inv.currentWeapon, 'pistol');
  });

  test('a weapon that is not owned is never switched back to', () => {
    const inv = createInventory();
    const weapons = started(inv);

    selectDirectly(weapons, inv, 'fist');
    // Only reachable by starting a new game, but the guard is what keeps a
    // stale `previousWeapon` from selecting a weapon with no `WeaponDef` state.
    inv.weapons.delete('pistol');
    weapons.handleSwitching(PREV_WEAPON_INPUT, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });

  test('the level start forgets the previous weapon', () => {
    const inv = createInventory();
    const weapons = started(inv);

    selectDirectly(weapons, inv, 'fist');
    weapons.beginLevel(inv);
    weapons.handleSwitching(PREV_WEAPON_INPUT, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });
});

/**
 * Coming back to a slot returns the weapon last used out of it. Maintained in
 * `update` rather than at the switch site, exactly like `previousWeapon`, so
 * what's worth pinning is that the memory survives a detour through another
 * slot and that a fresh level starts without one. docs/weapons.md § Slot keys.
 */
describe('Weapons · per-slot memory', () => {
  test('a slot hands back the weapon last selected out of it', () => {
    const inv = createInventory();
    inv.weapons.add('chainsaw');
    const weapons = started(inv);

    // Slot 1 unused so far, so its best comes up; a second press toggles.
    assert.equal(press(weapons, inv, 1), 'chainsaw');
    assert.equal(press(weapons, inv, 1), 'fist');
    assert.equal(press(weapons, inv, 2), 'pistol');
    assert.equal(press(weapons, inv, 1), 'fist');
    // And the toggle still steps on from wherever the memory landed.
    assert.equal(press(weapons, inv, 1), 'chainsaw');
    assert.equal(press(weapons, inv, 2), 'pistol');
    assert.equal(press(weapons, inv, 1), 'chainsaw');
  });

  test('a weapon picked up, not switched to by key, is what its slot remembers', () => {
    const inv = createInventory();
    inv.weapons.add('shotgun');
    inv.weapons.add('supershotgun');
    const weapons = started(inv);

    // What `applyPickup` does: select it outright, no `handleSwitching` involved.
    selectDirectly(weapons, inv, 'shotgun');
    assert.equal(press(weapons, inv, 2), 'pistol');
    assert.equal(press(weapons, inv, 3), 'shotgun');
  });

  test('a fresh level forgets the slots it is not carrying a weapon out of', () => {
    const inv = createInventory();
    inv.weapons.add('chainsaw');
    const weapons = started(inv);

    press(weapons, inv, 1);
    assert.equal(press(weapons, inv, 1), 'fist');
    assert.equal(press(weapons, inv, 2), 'pistol');

    weapons.beginLevel(inv);
    // The next level knows nothing of the fist, so slot 1 offers its best again.
    assert.equal(press(weapons, inv, 1), 'chainsaw');
  });

  test('the weapon carried into a level is what its own slot remembers', () => {
    const inv = createInventory();
    inv.weapons.add('chainsaw');
    inv.currentWeapon = 'fist';
    const weapons = started(inv);

    assert.equal(press(weapons, inv, 2), 'pistol');
    assert.equal(press(weapons, inv, 1), 'fist');
  });

  test('the memory survives a save/restore round trip', () => {
    const inv = createInventory();
    inv.weapons.add('chainsaw');
    const weapons = started(inv);

    press(weapons, inv, 1);
    press(weapons, inv, 1);
    press(weapons, inv, 2);
    const saved = JSON.parse(JSON.stringify(weapons.snapshot()));

    const loaded = started(inv);
    loaded.restore(saved, inv);
    assert.equal(press(loaded, inv, 1), 'fist');
  });

  test('a save from before the memory existed falls back to the slot best', () => {
    const inv = createInventory();
    inv.weapons.add('chainsaw');
    const weapons = started(inv);

    const old = weapons.snapshot();
    delete old.slotWeapon;
    weapons.restore(old, inv);
    assert.equal(press(weapons, inv, 1), 'chainsaw');
  });
});

/**
 * The wheel walks the digit keys' slot order, each shared slot weakest first.
 * What this pins is that order, that nothing owned is unreachable, and that
 * unowned weapons are skipped rather than eating a notch.
 * docs/weapons.md § The wheel walks the slot order
 */
describe('Weapons · mouse wheel', () => {
  /** One notch, positive scrolling down the list, and what it selected. */
  function scroll(weapons: WeaponSystem, inv: Inventory, dir: number): WeaponId {
    return settle(weapons, inv, NO_INPUT, dir);
  }

  test('one notch is one weapon, and weapons not owned are skipped', () => {
    const inv = createInventory();
    inv.weapons.add('chaingun');
    inv.weapons.add('bfg');
    const weapons = started(inv);

    // pistol (2) → chaingun (4), the shotgun slot owning nothing; then the BFG
    // (7), then round to the fist.
    assert.equal(scroll(weapons, inv, 1), 'chaingun');
    assert.equal(scroll(weapons, inv, 1), 'bfg');
    assert.equal(scroll(weapons, inv, 1), 'fist');
  });

  test('a shared slot is walked weakest first', () => {
    const inv = createInventory();
    inv.weapons.add('chainsaw');
    inv.weapons.add('shotgun');
    inv.weapons.add('supershotgun');
    const weapons = started(inv);

    // Scrolling up the pickup progression: shotgun before super shotgun, fist
    // before chainsaw — not the best-first order the digit keys hand out.
    assert.equal(scroll(weapons, inv, 1), 'shotgun');
    assert.equal(scroll(weapons, inv, 1), 'supershotgun');
    assert.equal(scroll(weapons, inv, 1), 'fist');
    assert.equal(scroll(weapons, inv, 1), 'chainsaw');
    assert.equal(scroll(weapons, inv, 1), 'pistol');
  });

  test('scrolling up walks the same order backwards', () => {
    const inv = createInventory();
    inv.weapons.add('rocketLauncher');
    const weapons = started(inv);

    assert.equal(scroll(weapons, inv, -1), 'fist');
    assert.equal(scroll(weapons, inv, -1), 'rocketLauncher');
    assert.equal(scroll(weapons, inv, -1), 'pistol');
  });

  test('owning a single weapon leaves the wheel on it', () => {
    const inv = createInventory();
    inv.weapons.delete('pistol');
    inv.currentWeapon = 'fist';

    assert.equal(scroll(started(inv), inv, 1), 'fist');
  });

  test('the wheel feeds the same per-slot memory the digit keys read', () => {
    const inv = createInventory();
    inv.weapons.add('chainsaw');
    const weapons = started(inv);

    // Scrolled onto the fist, then away: slot 1 hands the fist back rather
    // than the chainsaw it would offer as its best.
    assert.equal(scroll(weapons, inv, -1), 'chainsaw');
    assert.equal(scroll(weapons, inv, -1), 'fist');
    assert.equal(scroll(weapons, inv, -1), 'pistol');
    assert.equal(press(weapons, inv, 1), 'fist');
  });
});
