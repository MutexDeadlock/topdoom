import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { Player } from '../../src/game/player.ts';
import { PICKUP_RANGE } from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { thingLayer } from '../fixtures/spritestubs.ts';
import { heldInput } from '../fixtures/input.ts';

/**
 * `P_CheckPosition` picks items up at the position the move *attempted*, before
 * `P_TryMove` rejects it for a step over 24 — so an item in an alcove raised out
 * of reach is still collected by running at its edge. EPIC.WAD MAP02's green
 * armor sits 28 units inside a 32-unit-high alcove, 44 from where the player's
 * box stops: out of the 36-unit reach box at rest, inside it while running.
 *
 * Sealed geometry is the one thing that reach does not pass, because vanilla's
 * own per-step `P_CheckPosition` never gets far enough inside one to touch what
 * it holds — Going Down MAP08's crate, below. docs/items.md § Collecting things.
 */
describe('Items · a pickup reaches where the move was headed', () => {
  const CELL = 256;
  const LEDGE = 32; // Over MAX_STEP_UP, so the player never gets in.

  /**
   * Two cells stacked north-south: the player's own floor below, and north of it
   * either an alcove `LEDGE` above it (`'L'`) or a cell sealed by its floor
   * meeting its ceiling (`'+'`). The armor sits `inside` units north of the
   * boundary between them.
   */
  function arena(inside: number, north: 'L' | '+' = 'L') {
    const grid = gridMap(['###', `#${north}#`, '#.#', '###'], {
      cell: CELL,
      heights: { L: { floor: LEDGE, ceil: 128 } },
    });
    const floor = grid.centre(1, 2);
    const edgeY = floor.y + CELL / 2;
    grid.map.things.push({ x: floor.x, y: edgeY + inside, angle: 0, type: ThingType.greenArmor, flags: 7 });
    const world = new World(grid.map);
    const player = new Player(world);
    player.moveTo({ x: floor.x, y: floor.y });
    return { player, layer: thingLayer(world), edgeY };
  }

  /** North at `forwardDeg` 90, so `getAutorun` runs. */
  const RUN_NORTH = heldInput('KeyW');

  /** Runs north long enough to reach full speed and hold at the ledge, collecting as `game.ts` does. */
  function runAtTheLedge(inside: number, north: 'L' | '+' = 'L'): { taken: number; stoppedAt: number; edgeY: number } {
    const { player, layer, edgeY } = arena(inside, north);
    let taken = 0;
    for (let tic = 0; tic < 20; tic++) {
      player.update(DOOM_TIC, RUN_NORTH, null, 90);
      layer.tryPickup(player, player.attempted, PICKUP_RANGE, () => (taken++, true));
    }
    return { taken, stoppedAt: player.y, edgeY };
  }

  test('an item too far to touch at rest is collected by running at the ledge', () => {
    const { taken, stoppedAt, edgeY } = runAtTheLedge(28);
    assert.ok(edgeY + 28 - stoppedAt > PICKUP_RANGE, 'the ledge leaves the armor outside the resting reach box');
    assert.equal(taken, 1, 'vanilla collects this; only testing the settled position would not');
  });

  test('the attempted move is one tic long, not a free extra reach', () => {
    // A tic of full-speed running covers 500/35 ≈ 14.3 units, so an item this
    // far past the ledge stays out of reach however long the player pushes.
    assert.equal(runAtTheLedge(28 + PICKUP_RANGE).taken, 0);
  });

  test('the same reach stops at geometry with no opening at all', () => {
    // Going Down MAP08: the invulnerability sphere sits 32 units inside a crate
    // whose 8-unit sides are two-sided lines with their floor at their ceiling,
    // and running at one of them collected it through the wall.
    const { taken, stoppedAt, edgeY } = runAtTheLedge(28, '+');
    assert.equal(stoppedAt, runAtTheLedge(28).stoppedAt, 'the two arenas stop the player in the same place');
    assert.ok(edgeY + 28 - stoppedAt > PICKUP_RANGE, 'and out of the resting reach box, as the ledge is');
    assert.equal(taken, 0, 'a ledge is reached over; a sealed sector is not reached into');
  });
});
