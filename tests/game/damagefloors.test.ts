import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SectorEffects } from '../../src/game/specials/sectoreffects.ts';
import { createInventory } from '../../src/game/inventory.ts';
import { World } from '../../src/game/world.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { DAMAGE_FLOOR_INTERVAL } from '../../src/game/specials/tables.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * Sector special 11, E1M8's finale floor: the one damage floor that also ends the level.
 * See docs/specials.md § Damage floors.
 */
describe('specials · the E1M8 exit-damage floor', () => {
  /** A one-cell map whose floor carries `special`, plus everything `SectorEffects.update` needs. */
  function pit(special: number) {
    const grid = gridMap(['.']);
    grid.map.sectors[grid.index(0, 0)].special = special;
    const world = new World(grid.map);
    const inv = createInventory();
    const at = { ...grid.centre(0, 0), z: 0 };
    const effects = new SectorEffects(grid.map);
    const bleed = (amount: number) => {
      inv.health = Math.max(0, inv.health - amount);
    };
    return {
      inv,
      /** One tic in the pit; returns whether the level should end. */
      tic: () => effects.update(DOOM_TIC, world, at, inv, bleed).exit,
      /** `game.ts`'s question when the player is killed by something else entirely. */
      exitsOnDeath: () => effects.exitsOnDeath(world, at),
    };
  }

  test('the pulse that kills the player still ends the level', () => {
    const { inv, tic } = pit(11);
    inv.health = 20;
    let exit = false;
    for (let i = 0; i < 40 && !exit; i++) exit = tic();
    // Vanilla's `case 11` runs `if (player->health <= 10) G_ExitLevel()` right after the hit,
    // with no lower bound: 20 HP - 20 = 0 exits, it does not merely leave a corpse in the pit.
    assert.equal(inv.health, 0, 'the pulse should have taken all 20');
    assert.equal(exit, true);
  });

  test('walking in already below the threshold exits before any damage pulse', () => {
    const { inv, tic } = pit(11);
    inv.health = 8;
    // The health test is outside the `leveltime&0x1f` pulse, so it fires on the very first tic,
    // long before `DAMAGE_FLOOR_INTERVAL` elapses.
    assert.equal(tic(), true);
    assert.equal(inv.health, 8, 'no damage yet on the first tic');
  });

  test('full health takes the whole ride down, then exits', () => {
    const { inv, tic } = pit(11);
    let exit = false;
    let tics = 0;
    while (!exit && tics < 35 * 60) {
      exit = tic();
      tics++;
    }
    assert.equal(exit, true);
    assert.ok(inv.health <= 10, `exited at ${inv.health} HP`);
    // Five 20-HP pulses at one per 32 tics; the first needs the full interval to come round.
    assert.ok(tics >= (5 * DAMAGE_FLOOR_INTERVAL) / DOOM_TIC, `exited after only ${tics} tics`);
  });

  test('a death from anything else in the same sector ends the level too', () => {
    // Vanilla only asks this from `P_PlayerInSpecialSector`, which a dead player never reaches — so
    // a monster killing the player in E1M8's pit leaves the episode unfinished. Deliberate
    // deviation, and deliberately not gated on standing on the floor either.
    assert.equal(pit(11).exitsOnDeath(), true);
  });

  test('no other sector ends the level on death', () => {
    assert.equal(pit(7).exitsOnDeath(), false, 'an ordinary damage floor');
    assert.equal(pit(9).exitsOnDeath(), false, 'a secret');
    assert.equal(pit(0).exitsOnDeath(), false, 'a plain floor');
  });

  test('an ordinary damage floor never ends the level, however low the player gets', () => {
    const { inv, tic } = pit(7); // nukage, 5 HP
    for (let i = 0; i < 35 * 60; i++) assert.equal(tic(), false);
    assert.equal(inv.health, 0);
  });
});
