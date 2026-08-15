import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEN_DOOR_TAG } from '../../src/game/specials/mapscan.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig } from '../fixtures/specialsrig.ts';

/**
 * The player-alive gate is `A_BossDeath`'s alone: `A_KeenDie` (and `A_BrainDie`, which `IconOfSin`
 * owns) are separate action functions with no such check, so a boss dying in the same blast that
 * killed the player must still fire theirs. SCYTHE.WAD MAP10 is the map this cost — its exit is
 * killing the boss brain with barrels that also kill the player, and the brain needs one more
 * blast than the player survives. See docs/death.md § Dying on the way out.
 *
 * **Scope**: this covers `SpecialsController`'s half only. `Game` needs a WebGL renderer and the
 * DOM, so the fan-out that must reach `specials` and `icon` separately, `A_BrainDie` firing over a
 * corpse, and the overlay/`R`/reborn behavior are all out of reach here.
 */

/** One open cell and one shut door sector, the latter tagged only where the test acts on it. */
function bossMap(name: string, doorTag = 0) {
  const grid = gridMap(['####', '#.+#', '####'], { name });
  const door = grid.index(2, 1);
  grid.map.sectors[door].tag = doorTag;
  return { grid, map: grid.map, door };
}

describe('Regression · a boss dying over the player’s corpse', () => {
  test("Commander Keen's door still opens with the player dead — A_KeenDie has no player-alive check", () => {
    const { grid, map, door } = bossMap('MAP12', KEEN_DOOR_TAG);
    const rig = specialsRig(map, grid.centre(1, 1));

    rig.specials.notifyBossDeath(ThingType.commanderKeen, false);
    for (let i = 0; i < 20; i++) rig.tick();
    // That a mover ran at all is the claim; where it stopped is the fixture's business. The grid's
    // walls are zero-height *sectors*, so `P_FindLowestCeilingSurrounding` lands this door at -4
    // rather than lifting it — no wall around it has a ceiling to open up to.
    assert.notEqual(map.sectors[door].ceilHeight, 0, 'the tag-666 door moved over the corpse');
  });

  test("E2M8's exit still waits for a living player — that gate is A_BossDeath's own", () => {
    const { grid, map } = bossMap('E2M8'); // the cyberdemon row is a plain exit: no tag, no door
    let exits = 0;
    const rig = specialsRig(map, grid.centre(1, 1), { onExit: () => exits++ });

    rig.specials.notifyBossDeath(ThingType.cyberdemon, false);
    assert.equal(exits, 0, 'a dead player wins nothing');
    rig.specials.notifyBossDeath(ThingType.cyberdemon, true);
    assert.equal(exits, 1, 'a living one does');
  });
});
