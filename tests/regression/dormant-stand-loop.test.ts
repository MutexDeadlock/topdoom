import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * A monster that loses its last target goes back to its spawnstate, where vanilla runs `A_Look` on
 * `S_SPID_STND`/`S_SPID_STND2` — `SPID` `A` and `B`, 10 tics each (`info.c`). This engine held the
 * walk cycle's first frame instead, so a monster whose target died mid-stride stood frozen on it:
 * GoingDown MAP03's spider mastermind in a coop game, once the one player it chased had died.
 *
 * The rule this pins: **a dormant monster plays its stand loop, whether it never woke or gave up.**
 * docs/sprites.md § Pain, and attack/pain poses.
 */

describe('Regressions · a monster that loses its target stands in its spawn loop', () => {
  test('the spider mastermind stands A/B once the player it chased is dead', () => {
    clearRandom();
    const grid = gridMap(['########', '#......#', '#......#', '#......#', '########'], { cell: 256 });
    const map = grid.map;
    map.things.push(thingAt(grid, 1, 2, 1), thingAt(grid, 5, 2, ThingType.spiderMastermind));
    const player = { x: map.things[0].x, y: map.things[0].y, z: 0 };
    const layer = buildThingSprites(new World(map), {
      bank: BANK,
      materials: MATERIALS,
      skill: 3,
      restore: {
        clock: 0,
        stats: { totalKills: 1, kills: 0, totalItems: 0, items: 0 },
        changed: [[0, { type: ThingType.spiderMastermind, x: map.things[1].x, y: map.things[1].y, z: 0, facingDeg: 180, monster: { alerted: true } }]],
        lastlook: '',
      },
    });
    const frame = (players: ({ x: number; y: number; z: number } | null)[]): string => {
      layer.update(DOOM_TIC, players);
      layer.draw(1, 0);
      return layer.drawnFrameKey(0).slice(4);
    };

    for (let tic = 0; tic < 30; tic++) frame([player]);
    // Long enough for an attack pose already under way to play out.
    for (let tic = 0; tic < 35; tic++) frame([null]);
    const letters: string[] = [];
    for (let tic = 0; tic < 40; tic++) letters.push(frame([null]));

    assert.deepEqual([...new Set(letters)].sort(), ['A', 'B'], `stood on ${letters.join('')}`);
    const runs = letters.join('').match(/A+|B+/g) ?? [];
    for (const run of runs.slice(1, -1)) assert.equal(run.length, 10, `a stand frame held ${run.length} tics`);
  });
});
