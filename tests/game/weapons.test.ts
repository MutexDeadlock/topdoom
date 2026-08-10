import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WeaponSystem, WEAPONS } from '../../src/game/weapons.ts';
import { createInventory, type Inventory, type WeaponId } from '../../src/game/inventory.ts';
import type { Input } from '../../src/game/input.ts';
import type { AudioEngine } from '../../src/audio/audio.ts';
import { DOOM_TIC } from '../../src/constants.ts';

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

/**
 * Fire rate is the one thing in `WeaponSystem` a player notices instantly and
 * no other test covered — which is how a tic-lock refactor shipped a pistol
 * firing 7% fast and, after a pause with the trigger up, an unlimited burst.
 * Both came from tracking the cooldown as seconds remaining; it is a whole
 * number of tics. See docs/weapons.md § Fire rates.
 */
describe('Game rules · fire rates', () => {
  /** Tic indices, over `seconds` of held trigger, on which a shot came out. */
  function fireTics(weapon: WeaponId, seconds: number, idleSeconds = 0): number[] {
    const ws = new WeaponSystem();
    const inv = createInventory();
    inv.currentWeapon = weapon;
    for (const ammo of Object.keys(inv.ammo) as (keyof typeof inv.ammo)[]) inv.ammo[ammo] = 999_999;
    ws.beginLevel(inv);
    for (let i = 0; i < Math.round(idleSeconds / DOOM_TIC); i++) ws.update(false, inv, 0);
    const fired: number[] = [];
    for (let i = 0; i < Math.round(seconds / DOOM_TIC); i++) if (ws.update(true, inv, 0).length > 0) fired.push(i);
    return fired;
  }

  const gapsOf = (tics: number[]): number[] => [...new Set(tics.slice(1).map((t, i) => t - tics[i]))];

  test('every weapon fires exactly its vanilla state length apart', () => {
    for (const [id, def] of Object.entries(WEAPONS) as [WeaponId, (typeof WEAPONS)[WeaponId]][]) {
      const want = Math.round(def.cooldown / DOOM_TIC);
      // Long enough for several shots even from the BFG's 40-tic chain.
      assert.deepEqual(gapsOf(fireTics(id, 5)), [want], `${id} fires every ${want} tics, evenly`);
    }
  });

  test('holding the trigger up banks no credit', () => {
    // Takes two things together: the counter must clamp at zero while idle, and
    // firing must *assign* the cooldown rather than add to it. Break either
    // alone and this still passes — it is the combination that fires every tic
    // until the banked debt is paid off, and the combination that shipped.
    for (const id of ['pistol', 'plasmaRifle', 'bfg'] as const) {
      const cold = fireTics(id, 4);
      const afterIdle = fireTics(id, 4, 3);
      assert.deepEqual(afterIdle, cold, `${id} fires the same held from cold as after 3s idle`);
    }
  });

  test('the first shot of a hold comes out immediately', () => {
    // Vanilla's trigger pull fires on the tic it is pressed; only the *next*
    // shot waits out the chain.
    assert.equal(fireTics('pistol', 1)[0], 0);
    assert.equal(fireTics('bfg', 1)[0], 0);
  });
});
