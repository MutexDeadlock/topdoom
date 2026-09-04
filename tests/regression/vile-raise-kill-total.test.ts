import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { stepFor } from '../fixtures/tics.ts';
import { changedThing } from '../fixtures/snapshot.ts';

/**
 * The kill counter against an arch-vile. Vanilla's `P_KillMobj` counts every death with no
 * already-counted guard and `A_VileChase` adjusts neither counter, so a vanilla level reads over
 * 100% kills once anything has been raised — a real SCYTHE.WAD MAP11 save showed 75/67. This engine
 * deviates on purpose, following ZDoom's `AActor::Revive`: the raise adds one to the *total*, so
 * re-killing a raised monster still lands on exactly 100%.
 *
 * The rule this pins: **`kills` counts deaths and `totalKills` counts raises**, and the two stay in
 * step. docs/hud.md § Level stats, docs/monster-archvile.md § Resurrection.
 */

const IMP_ID = 0;
const VILE_ID = 1;

/**
 * A long corridor with the imp between the arch-vile and the player, so the vile's ordinary chase
 * walks it over the corpse and `A_VileChase` finds it there. Long on purpose: inside the vile's
 * own 896-unit missile range it would stand and cast instead of ever taking a step.
 */
function arena(): { layer: ThingLayer; player: Pos3 } {
  clearRandom();
  const cells = 24;
  const grid = gridMap(['#'.repeat(cells), `#${'.'.repeat(cells - 2)}#`, '#'.repeat(cells)], { cell: 128 });
  const map = grid.map;
  map.things.push(
    thingAt(grid, 1, 1, 1),
    thingAt(grid, cells - 5, 1, ThingType.imp),
    // Facing west, down the corridor: `A_Look`'s FOV check is what wakes it, and a vile spawned
    // facing away never sees the player at all.
    thingAt(grid, cells - 3, 1, ThingType.archVile, 180),
  );
  const layer = buildThingSprites(new World(map), { bank: BANK, materials: MATERIALS, skill: 3 });
  return { layer, player: { ...grid.centre(1, 1), z: 0 } };
}

/** Runs up to `seconds` of simulation at the fixed tic, stopping early once `done` holds. */
function run(layer: ThingLayer, player: Pos3, seconds: number, done?: () => boolean): void {
  stepFor(seconds, () => layer.update(DOOM_TIC, player), done);
}

/** The imp's live health, read off the snapshot's sparse block — an absent `health` is the spawn default. */
const impHealth = (layer: ThingLayer) =>
  changedThing(layer.snapshot(), IMP_ID).monster?.health ?? MONSTER_HEALTH[ThingType.imp];

describe('Regressions · an arch-vile’s raise counts toward the kill total', () => {
  test('a raised monster adds one to totalKills, so re-killing it lands back on 100%', () => {
    const { layer, player } = arena();
    assert.equal(layer.stats.totalKills, 2, 'the map placed two monsters');

    layer.damage(IMP_ID, MONSTER_HEALTH[ThingType.imp]);
    assert.deepEqual(
      { kills: layer.stats.kills, total: layer.stats.totalKills },
      { kills: 1, total: 2 },
      'one of two dead',
    );

    // The vile has to wake, walk over the corpse and find it lying still first.
    run(layer, player, 60, () => impHealth(layer) > 0);
    assert.ok(impHealth(layer) > 0, 'the vile actually raised the imp');
    assert.deepEqual(
      { kills: layer.stats.kills, total: layer.stats.totalKills },
      { kills: 1, total: 3 },
      'the raise adds a monster to kill rather than leaving 1/2 standing',
    );

    layer.damage(IMP_ID, MONSTER_HEALTH[ThingType.imp]);
    assert.equal(layer.stats.kills, 2, 'the second death counts again, as in vanilla');
    assert.equal(layer.stats.kills, layer.stats.totalKills - 1, 'only the vile is left to kill');
  });

  test('an ordinary death still moves only the kill count', () => {
    const { layer } = arena();
    layer.damage(VILE_ID, MONSTER_HEALTH[ThingType.archVile]);
    assert.deepEqual(
      { kills: layer.stats.kills, total: layer.stats.totalKills },
      { kills: 1, total: 2 },
      'nothing but a resurrection touches the total after map load',
    );
  });
});
