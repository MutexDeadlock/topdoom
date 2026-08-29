import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WeaponSystem, WEAPONS } from '../../src/game/weapons.ts';
import { createInventory, setAutoSwitchWeapon, type Inventory, type WeaponId } from '../../src/game/inventory.ts';
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

/**
 * One frame of the switch path: the input (nothing pressed by default) and any
 * wheel scroll, then the `update` that notices what ended up selected.
 */
function settle(weapons: WeaponSystem, inv: Inventory, input: Input = IDLE, wheel = 0): WeaponId {
  weapons.handleSwitching(input, inv, wheel);
  weapons.update(DOOM_TIC, false, inv, AUDIO, AT);
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
  const key = { ...IDLE, pressed: (code: string) => code === `Digit${n}` } as unknown as Input;
  return settle(weapons, inv, key);
}

describe('Weapons · switch to previous weapon', () => {
  test('a click toggles back to the previous weapon, and again returns', () => {
    const inv = createInventory();
    const weapons = started(inv);
    assert.equal(inv.currentWeapon, 'pistol');

    selectDirectly(weapons, inv, 'fist');
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'pistol');

    // The same frame's update records the weapon just left, so the next
    // click goes the other way rather than sticking on the pistol.
    weapons.update(0.016, false, inv, AUDIO, AT);
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });

  test('a click before any switch does nothing', () => {
    const inv = createInventory();
    const weapons = started(inv);

    settle(weapons, inv);
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'pistol');
  });

  test('a weapon that is not owned is never switched back to', () => {
    const inv = createInventory();
    const weapons = started(inv);

    selectDirectly(weapons, inv, 'fist');
    // Only reachable by starting a new game, but the guard is what keeps a
    // stale `previousWeapon` from selecting a weapon with no `WeaponDef` state.
    inv.weapons.delete('pistol');
    weapons.handleSwitching(CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'fist');
  });

  test('the level start forgets the previous weapon', () => {
    const inv = createInventory();
    const weapons = started(inv);

    selectDirectly(weapons, inv, 'fist');
    weapons.beginLevel(inv);
    weapons.handleSwitching(CLICK, inv, 0);
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
    return settle(weapons, inv, IDLE, dir);
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
    for (let i = 0; i < Math.round(idleSeconds / DOOM_TIC); i++) ws.fire(false, inv, 0);
    const fired: number[] = [];
    for (let i = 0; i < Math.round(seconds / DOOM_TIC); i++) if (ws.fire(true, inv, 0).length > 0) fired.push(i);
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

/**
 * The super shotgun's reload is the one weapon sound that arrives *after* its
 * shot, on tics this engine has no state chain to hang it off — so what needs
 * pinning is the schedule itself and the two things vanilla aborts it with.
 * See docs/audio.md § Weapons and projectiles.
 */
describe('Game rules · super shotgun reload sounds', () => {
  /** `[tic since the shot, sound]` for one trigger pull, over `tics` of held-then-idle trigger. */
  function reloadSounds(shells: number, tics: number, switchAwayAt = -1): [number, string][] {
    const played: [number, string][] = [];
    let tic = 0;
    const audio = { play: (id: string) => played.push([tic, id]) } as unknown as AudioEngine;
    const inv = createInventory();
    inv.weapons.add('supershotgun').add('shotgun');
    inv.currentWeapon = 'supershotgun';
    inv.ammo.shells = shells;
    const ws = new WeaponSystem();
    ws.beginLevel(inv);
    for (; tic < tics; tic++) {
      if (tic === switchAwayAt) inv.currentWeapon = 'shotgun';
      // Only the opening tic pulls the trigger: one shot, then the reload.
      ws.fire(tic === 0, inv, 0);
      ws.update(DOOM_TIC, tic === 0, inv, audio, AT);
    }
    // The fire sound itself comes from `game.ts`, not `WeaponSystem`.
    return played;
  }

  test('open, load and close land on their own vanilla tics', () => {
    // `A_OpenShotgun2` (S_DSGUN5), `A_LoadShotgun2` (S_DSGUN7) and
    // `A_CloseShotgun2` (S_DSGUN9), offset from `A_FireShotgun2` by the states
    // between — and all three inside the weapon's own 57-tic cooldown.
    assert.deepEqual(reloadSounds(50, 60), [
      [21, 'dbopn'],
      [35, 'dbload'],
      [48, 'dbcls'],
    ]);
  });

  test('a shot fired with the last shells reloads silently', () => {
    // `A_CheckReload`'s `P_CheckAmmo` lowers the weapon 14 tics in, so the
    // psprite never reaches any of the three states.
    assert.deepEqual(reloadSounds(2, 60), []);
    // One shell short of another shot is the same case: `P_CheckAmmo` wants two.
    assert.deepEqual(reloadSounds(3, 60), []);
  });

  test('switching away mid-reload drops whatever is left of it', () => {
    assert.deepEqual(reloadSounds(50, 60, 30), [[21, 'dbopn']]);
  });
});

/**
 * `P_CheckAmmo` (`p_pspr.c`): the chain a weapon that can no longer fire drops you down, and — just
 * as load-bearing — the two moments it is allowed to run. See docs/weapons.md § Automatic weapon
 * switching.
 */
describe('Game rules · running dry', () => {
  /**
   * A player holding `weapon` with `ammo` in stock and `owned` in the bag, fired once and then
   * left alone for `tics` with the trigger up. Returns what they end up holding.
   */
  function afterFiring(
    weapon: WeaponId,
    ammo: Partial<Inventory['ammo']>,
    owned: WeaponId[],
    tics = 80,
    hold = false,
  ): WeaponId {
    const inv = createInventory();
    inv.ammo = { bullets: 0, shells: 0, rockets: 0, cells: 0, ...ammo };
    inv.weapons = new Set([weapon, ...owned]);
    inv.currentWeapon = weapon;
    const ws = started(inv);
    for (let i = 0; i < tics; i++) ws.fire(hold || i === 0, inv, 0);
    return inv.currentWeapon;
  }

  test('the chain is walked in vanilla order, first match winning', () => {
    // One rocket, so the launcher fires it and is then empty. Everything below is a candidate.
    const fed = { cells: 100, shells: 10, bullets: 10, rockets: 1 };
    const all: WeaponId[] = ['plasmaRifle', 'supershotgun', 'chaingun', 'shotgun', 'pistol', 'chainsaw'];
    assert.equal(afterFiring('rocketLauncher', fed, all), 'plasmaRifle');
    assert.equal(afterFiring('rocketLauncher', { ...fed, cells: 0 }, all), 'supershotgun');
    assert.equal(afterFiring('rocketLauncher', { ...fed, cells: 0, shells: 0 }, all), 'chaingun');
    assert.equal(afterFiring('rocketLauncher', { ...fed, cells: 0, bullets: 0 }, all), 'supershotgun');
    // Shotgun over pistol needs the chaingun out of the bag, it outranking both.
    const noChaingun = all.filter((w) => w !== 'chaingun');
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, shells: 1, bullets: 10 }, noChaingun), 'shotgun');
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, bullets: 10 }, noChaingun), 'pistol');
    // And the chainsaw takes over once nothing at all is fed.
    assert.equal(afterFiring('rocketLauncher', { rockets: 1 }, all), 'chainsaw');
  });

  test('the BFG is the last rung, below the fist-adjacent weapons', () => {
    // 41 cells: enough for the BFG's own threshold, and the plasma rifle is not owned.
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, cells: 41 }, ['bfg']), 'bfg');
    // With the chainsaw owned it wins, even though the BFG has ammo — vanilla's own order.
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, cells: 41 }, ['bfg', 'chainsaw']), 'chainsaw');
  });

  test("the two thresholds are strictly greater, and are not the weapons' own ammo cost", () => {
    // The super shotgun fires on 2 shells but the chain wants 3; the BFG fires on 40 cells,
    // the chain wants 41. Vanilla's off-by-one, kept.
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, shells: 2 }, ['supershotgun']), 'fist');
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, shells: 3 }, ['supershotgun']), 'supershotgun');
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, cells: 40 }, ['bfg']), 'fist');
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, cells: 41 }, ['bfg']), 'bfg');
  });

  test('nothing owned and nothing fed ends on the fist', () => {
    assert.equal(afterFiring('pistol', { bullets: 1 }, []), 'fist');
  });

  test('releasing the trigger still switches: A_ReFire checks on either branch', () => {
    // One trigger pull, then 80 tics with it up — the shot's own chain still ends.
    assert.equal(afterFiring('pistol', { bullets: 1, shells: 10 }, ['shotgun']), 'shotgun');
    // And holding it down reaches the same place, through P_FireWeapon's own check.
    assert.equal(afterFiring('pistol', { bullets: 1, shells: 10 }, ['shotgun'], 80, true), 'shotgun');
  });

  test('nothing switches mid-chain, only once the cooldown has run out', () => {
    const cooldown = Math.round(WEAPONS.rocketLauncher.cooldown / DOOM_TIC);
    for (let t = 1; t <= cooldown; t++) {
      const held = afterFiring('rocketLauncher', { rockets: 1, shells: 10 }, ['shotgun'], t);
      assert.equal(held, 'rocketLauncher', `still the launcher ${t} tics in, chain ends at ${cooldown}`);
    }
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, shells: 10 }, ['shotgun'], cooldown + 1), 'shotgun');
  });

  test('an empty weapon merely selected while idle does not bounce off it', () => {
    // The wheel's promise that every owned weapon is a stop — docs/weapons.md § The wheel walks
    // the slot order. Nothing has been fired, so no chain is ending and no trigger is down.
    const inv = createInventory();
    inv.ammo = { bullets: 0, shells: 0, rockets: 0, cells: 0 };
    inv.weapons = new Set(['fist', 'pistol', 'shotgun']);
    inv.currentWeapon = 'shotgun';
    const ws = started(inv);
    for (let i = 0; i < 80; i++) ws.fire(false, inv, 0);
    assert.equal(inv.currentWeapon, 'shotgun');
  });

  test('with the setting off, an empty weapon stays selected and fires nothing', () => {
    setAutoSwitchWeapon(false);
    try {
      assert.equal(afterFiring('rocketLauncher', { rockets: 1, shells: 10 }, ['shotgun']), 'rocketLauncher');
      const inv = createInventory();
      inv.ammo.bullets = 0;
      const ws = started(inv);
      assert.deepEqual(ws.fire(true, inv, 0), []);
    } finally {
      setAutoSwitchWeapon(true);
    }
  });
});
