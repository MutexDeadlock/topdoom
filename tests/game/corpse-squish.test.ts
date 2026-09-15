import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { MoverOccupancy, squashCorpses } from '../../src/game/specials/moverblocking.ts';
import { CORPSE_GIB, MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { ThingsSnapshot } from '../../src/game/snapshot.ts';
import { addControlLine, gridMap, thingAt } from '../fixtures/gridmap.ts';
import { MATERIALS, recordingBank } from '../fixtures/spritestubs.ts';
import { AWAY, crushSources, occupant, specialsRig, TIC } from '../fixtures/specialsrig.ts';
import { savedThing } from '../fixtures/snapshot.ts';

/**
 * `PIT_ChangeSector`'s corpse branch: a body a moving plane leaves no room for is crunched to a
 * pool of blood, at a quarter of its living height and under any mover at all — not only a crusher,
 * and on no damage clock. docs/specials-crushers.md § Crushed corpses.
 */

const DEMON = MONSTER_STATS[ThingType.demon];
const POOL = CORPSE_GIB.sprite + CORPSE_GIB.frames[0];

/** One closed room with a single demon in it, and the ceiling as the plane that moves. */
function room(restore?: ThingsSnapshot) {
  const grid = gridMap(['###', '#.#', '###'], { cell: 128 });
  const map = grid.map;
  map.things.push(thingAt(grid, 1, 1, ThingType.demon));
  const sectorIndex = grid.index(1, 1);
  const world = new World(map);
  const { bank, askedSprites } = recordingBank();
  const things = buildThingSprites(world, { bank, materials: MATERIALS, skill: 3, restore });
  return {
    things,
    /** Drops the ceiling to `gap` above the floor and runs `P_ChangeSector` over the sector. */
    squashAt(gap: number) {
      map.sectors[sectorIndex].ceilHeight = map.sectors[sectorIndex].floorHeight + gap;
      squashCorpses(world, crushSources({ things: () => things }), sectorIndex);
    },
    /** What the demon's billboard is drawn as right now. */
    drawn() {
      askedSprites.length = 0;
      things.draw(1, 0);
      assert.equal(askedSprites.length, 1, 'the demon is the only thing drawn');
      return askedSprites[0];
    },
  };
}

/** Kills the demon outright, leaving an ordinary settled corpse. */
function kill(things: ThingLayer): void {
  things.damage(0, MONSTER_HEALTH[ThingType.demon]);
  things.update(DOOM_TIC, [null]);
}

/** Whether the save says this corpse has been crunched. */
function crushed(things: ThingLayer): boolean {
  return savedThing(things.snapshot(), 0)?.monster?.crushed === true;
}

describe('Death · corpses under a mover', () => {
  test('a corpse the ceiling has no room for becomes a pool of blood', () => {
    const fx = room();
    kill(fx.things);
    assert.notEqual(fx.drawn(), POOL, 'an ordinary corpse first');
    fx.squashAt(8);
    assert.ok(crushed(fx.things), 'crunched');
    assert.equal(fx.drawn(), POOL, `drawn as ${POOL}`);
  });

  test('a corpse is a quarter of its living height, so a half-closed door leaves it alone', () => {
    assert.equal(DEMON.height, 56, "MT_SERGEANT's own mobjinfo height");
    const fx = room();
    kill(fx.things);
    // Under the demon's own height and well over a corpse's 14: the live body would be caught here.
    fx.squashAt(20);
    assert.equal(crushed(fx.things), false, 'nothing to crunch yet');
    fx.squashAt(12);
    assert.ok(crushed(fx.things), 'and the last few units do it');
  });

  test('a living body is the crush damage’s business, not this one’s', () => {
    const fx = room();
    fx.squashAt(8);
    assert.equal(crushed(fx.things), false);
    assert.notEqual(fx.drawn(), POOL);
  });

  test('a player’s corpse is crunched too, at a quarter of the player’s height', () => {
    const grid = gridMap(['###', '#.#', '###'], { cell: 128 });
    const sectorIndex = grid.index(1, 1);
    const world = new World(grid.map);
    const corpse = occupant({ ...grid.centre(1, 1), z: 0 });
    const squashed: number[] = [];
    // Slot 1 lies in the room; slot 0 is somewhere else entirely.
    const sources = crushSources({
      slots: [occupant(AWAY), corpse],
      squashSlot: (slot) => void squashed.push(slot),
    });
    const squashAt = (gap: number) => {
      grid.map.sectors[sectorIndex].ceilHeight = grid.map.sectors[sectorIndex].floorHeight + gap;
      squashCorpses(world, sources, sectorIndex);
    };
    squashAt(8);
    assert.deepEqual(squashed, [], 'a living player is the crush damage’s business');
    corpse.dead = true;
    // `PLAYER_HEIGHT` is 56, quartered by `P_KillMobj` like any other corpse's.
    squashAt(20);
    assert.deepEqual(squashed, [], 'a corpse still fits 20 units');
    squashAt(12);
    assert.deepEqual(squashed, [1], 'the slot lying there, and nobody else');
    corpse.crushed = true;
    squashAt(8);
    assert.deepEqual(squashed, [1], 'a pool is passed over');
  });

  test('a squashed corpse reloads as the pool it was, not as the corpse it started as', () => {
    const live = room();
    kill(live.things);
    live.squashAt(8);
    const loaded = room(live.things.snapshot());
    assert.equal(loaded.drawn(), POOL);
  });

  /**
   * The wiring, end to end: an ordinary S1 close line (50) over a real thing layer, with no crusher
   * anywhere. `P_ChangeSector` runs off every plane that moved, so the door does this.
   */
  test('a plain closing door squashes what is lying under it', () => {
    const grid = gridMap(['..']);
    const map = grid.map;
    const door = grid.index(1, 0);
    map.sectors[door].tag = 1;
    addControlLine(map, 64, 0, 50, 1);
    const closeLine = map.linedefs.length - 1;
    const centre = grid.centre(1, 0);
    map.things.push({ x: centre.x, y: centre.y, angle: 0, type: ThingType.demon, flags: 7 });

    // The thing layer is built after the rig, which owns the `World` both need — the same late
    // binding `game.ts` has, and what `OccupancySources.things`' thunk is there for.
    let layer: ThingLayer | null = null;
    const rig = specialsRig(map, grid.centre(0, 0), {
      occupancy: (world) => new MoverOccupancy(world, crushSources({ things: () => layer })),
    });
    const { bank, askedSprites } = recordingBank();
    const things = buildThingSprites(rig.world, { bank, materials: MATERIALS, skill: 3 });
    layer = things;

    kill(things);
    (rig.specials as unknown as { trigger(line: number, keys: Set<never>): unknown }).trigger(closeLine, new Set());
    for (let i = 0; i < Math.round(4 / TIC); i++) rig.tick();
    assert.equal(map.sectors[door].ceilHeight, 0, 'the door is shut');
    assert.ok(crushed(things), 'and what was lying under it is a pool of blood');
    askedSprites.length = 0;
    things.draw(1, 0);
    assert.equal(askedSprites[0], POOL);
  });
});
