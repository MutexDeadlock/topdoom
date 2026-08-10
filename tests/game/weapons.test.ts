import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WeaponSystem } from '../../src/game/weapons.ts';
import { createInventory, type Inventory, type WeaponId } from '../../src/game/inventory.ts';
import type { Input } from '../../src/game/input.ts';
import type { AudioEngine } from '../../src/audio/audio.ts';

/**
 * The right button's "switch to previous weapon" binding. What's worth pinning is
 * that `previousWeapon` is tracked off the once-a-frame comparison rather than
 * at each switch site, so a switch nothing routed through `handleSwitching`
 * (a pickup, a berserk pack) still counts — docs/weapons.md § Slot keys.
 */

const AUDIO = { play: () => {} } as unknown as AudioEngine;
const AT = { x: 0, y: 0, z: 0 };

/** Right-clicking with the button bound to `previousweapon`, and nothing else pressed. */
const CLICK = {
  pressed: () => false,
  rightMousePressed: (a: string) => a === 'previousweapon',
} as unknown as Input;
const IDLE = { pressed: () => false, rightMousePressed: () => false } as unknown as Input;

/** One frame that doesn't click: lets `updateSounds` notice whatever was selected. */
function settle(weapons: WeaponSystem, inv: Inventory): void {
  weapons.handleSwitching(IDLE, inv, 0);
  weapons.updateSounds(0.016, false, inv, AUDIO, AT);
}

function selectDirectly(weapons: WeaponSystem, inv: Inventory, weapon: WeaponId): void {
  inv.currentWeapon = weapon;
  settle(weapons, inv);
}

describe('Weapons · switch to previous weapon', () => {
  test('a click toggles back to the previous weapon, and again returns', () => {
    const inv = createInventory();
    const weapons = new WeaponSystem();
    weapons.beginLevel(inv);
    assert.equal(inv.currentWeapon, 'pistol');

    selectDirectly(weapons, inv, 'fist');
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'pistol');

    // The same frame's updateSounds records the weapon just left, so the next
    // click goes the other way rather than sticking on the pistol.
    weapons.updateSounds(0.016, false, inv, AUDIO, AT);
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });

  test('a click before any switch does nothing', () => {
    const inv = createInventory();
    const weapons = new WeaponSystem();
    weapons.beginLevel(inv);

    settle(weapons, inv);
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'pistol');
  });

  test('a weapon that is not owned is never switched back to', () => {
    const inv = createInventory();
    const weapons = new WeaponSystem();
    weapons.beginLevel(inv);

    selectDirectly(weapons, inv, 'fist');
    // Only reachable by starting a new game, but the guard is what keeps a
    // stale `previousWeapon` from selecting a weapon with no `WeaponDef` state.
    inv.weapons.delete('pistol');
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });

  test('the level start forgets the previous weapon', () => {
    const inv = createInventory();
    const weapons = new WeaponSystem();
    weapons.beginLevel(inv);

    selectDirectly(weapons, inv, 'fist');
    weapons.beginLevel(inv);
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });
});
