import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WeaponSystem, WEAPONS } from '../../src/game/weapons.ts';
import { createInventory, type Inventory, type WeaponId } from '../../src/game/inventory.ts';
import type { SfxId, SoundEmitter } from '../../src/audio/sfx.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { stepFor } from '../fixtures/tics.ts';

/**
 * What a weapon does once it is the one in hand: how fast it fires, what it sounds like reloading,
 * and what happens when the ammo runs out. Which weapon that is is `tests/game/weapons.test.ts`.
 * See docs/weapons.md § Fire rates.
 */

/** Where the player stands; a shot is raised from here. */
const AT = { x: 0, y: 0, z: 0 };

/** A system begun on `inv`, as a level load hands it one. */
function started(inv: Inventory): WeaponSystem {
  const weapons = new WeaponSystem();
  weapons.beginLevel(inv);
  return weapons;
}

/**
 * Fire rate is the one thing in `WeaponSystem` a player notices instantly and
 * no other test covered — which is how a tic-lock refactor shipped a pistol
 * firing 7% fast and, after a pause with the trigger up, an unlimited burst.
 * Both came from tracking the cooldown as seconds remaining; it is a whole
 * number of tics. See docs/weapons.md § Fire rates.
 */
describe('Weapons · fire rates', () => {
  /** Tic indices, over `seconds` of held trigger, on which a shot came out. */
  function fireTics(weapon: WeaponId, seconds: number, idleSeconds = 0): number[] {
    const ws = new WeaponSystem();
    const inv = createInventory();
    inv.currentWeapon = weapon;
    for (const ammo of Object.keys(inv.ammo) as (keyof typeof inv.ammo)[]) inv.ammo[ammo] = 999_999;
    ws.beginLevel(inv);
    stepFor(idleSeconds, () => ws.fire(false, inv, 0));
    const fired: number[] = [];
    stepFor(seconds, (i) => {
      if (ws.fire(true, inv, 0).length > 0) fired.push(i);
    });
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
describe('Weapons · super shotgun reload sounds', () => {
  /** `[tic since the shot, sound]` for one trigger pull, over `tics` of held-then-idle trigger. */
  function reloadSounds(shells: number, tics: number, switchAwayAt = -1): [number, string][] {
    const played: [number, string][] = [];
    let tic = 0;
    const audio: SoundEmitter = { play: (id: SfxId) => played.push([tic, id]) };
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
describe('Weapons · running dry', () => {
  /**
   * A player holding `weapon` with `ammo` in stock and `owned` in the bag, fired once and then
   * left alone for `tics` with the trigger up (`hold`: down), switching under `autoSwitch`. Returns
   * what they end up holding.
   */
  function afterFiring(
    weapon: WeaponId,
    ammo: Partial<Inventory['ammo']>,
    owned: WeaponId[],
    { tics = 80, hold = false, autoSwitch = true } = {},
  ): WeaponId {
    const inv = createInventory();
    inv.ammo = { bullets: 0, shells: 0, rockets: 0, cells: 0, ...ammo };
    inv.weapons = new Set([weapon, ...owned]);
    inv.currentWeapon = weapon;
    const ws = started(inv);
    ws.autoSwitch = autoSwitch;
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
    assert.equal(afterFiring('pistol', { bullets: 1, shells: 10 }, ['shotgun'], { hold: true }), 'shotgun');
  });

  /**
   * The chain is one tic wide and a load could afford to lose it, but a replay's keyframe restore
   * has to land on the tic the recording ran — docs/replays.md § Seeking.
   */
  test('a save taken mid-chain still ends the chain after the restore', () => {
    const inv = createInventory();
    inv.ammo = { bullets: 1, shells: 10, rockets: 0, cells: 0 };
    inv.weapons = new Set<WeaponId>(['pistol', 'shotgun']);
    inv.currentWeapon = 'pistol';
    const ws = started(inv);
    ws.fire(true, inv, 0);
    const saved = JSON.parse(JSON.stringify(ws.snapshot()));

    const loaded = started(inv);
    loaded.restore(saved, inv);
    for (let i = 0; i < 80; i++) loaded.fire(false, inv, 0);
    assert.equal(inv.currentWeapon, 'shotgun', 'the restored chain still ran its A_ReFire check');
  });

  test('nothing switches mid-chain, only once the cooldown has run out', () => {
    const cooldown = Math.round(WEAPONS.rocketLauncher.cooldown / DOOM_TIC);
    for (let t = 1; t <= cooldown; t++) {
      const held = afterFiring('rocketLauncher', { rockets: 1, shells: 10 }, ['shotgun'], { tics: t });
      assert.equal(held, 'rocketLauncher', `still the launcher ${t} tics in, chain ends at ${cooldown}`);
    }
    assert.equal(
      afterFiring('rocketLauncher', { rockets: 1, shells: 10 }, ['shotgun'], { tics: cooldown + 1 }),
      'shotgun',
    );
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
    const off = { autoSwitch: false };
    assert.equal(afterFiring('rocketLauncher', { rockets: 1, shells: 10 }, ['shotgun'], off), 'rocketLauncher');
    const inv = createInventory();
    inv.ammo.bullets = 0;
    const ws = started(inv);
    ws.autoSwitch = false;
    assert.deepEqual(ws.fire(true, inv, 0), []);
  });
});
