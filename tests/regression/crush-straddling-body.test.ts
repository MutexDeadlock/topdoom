import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { applyCrushDamage } from '../../src/game/specials/moverblocking.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * `PIT_ChangeSector` crushes a body whose *clipped headroom* is under its own
 * height, not whichever body's centre point happens to resolve to the crushing
 * sector. The engine pinned a straddling monster (its movement check is box
 * aware) but never damaged it, so a room split into a tagged and an untagged
 * half left a row of monsters standing frozen and unhurt under the ceiling
 * grinding over them. Repro: NoSp2.wad MAP04, sectors 198 (tag 84) and 141.
 * See docs/specials.md § Crushers.
 */

const KNIGHT = MONSTER_STATS[ThingType.hellKnight];
const CELL = 128;
/** Far enough away that the player is nobody's business here. */
const PLAYER = { x: -1000, y: -1000 };

/**
 * A two-cell room, each cell its own sector, with the west one crushing: its
 * ceiling is already down to 24, the east one is untouched at 128. The hell
 * knight stands `inset` units east of the shared edge.
 */
function scene(inset: number) {
  const grid = gridMap(['####', '#..#', '####'], { cell: CELL });
  const map = grid.map;
  const crusher = grid.index(1, 1);
  const room = grid.index(2, 1);
  const centre = grid.centre(2, 1);
  map.things.push({ x: 2 * CELL + inset, y: centre.y, angle: 0, type: ThingType.hellKnight, flags: 7 });
  map.sectors[crusher].ceilHeight = 24;
  const world = new World(map);
  const things = buildThingSprites(map, world, BANK, MATERIALS, 3);
  return { map, world, things, crusher, room };
}

/** One crush pulse over the crushing sector; reports `nofit` and what the monster has left. */
function pulse(room: ReturnType<typeof scene>): { caught: boolean; health: number } {
  const caught = applyCrushDamage(
    room.world,
    room.map,
    room.things,
    PLAYER,
    room.crusher,
    () => assert.fail('the player is nowhere near this crusher'),
    true,
  );
  return { caught, health: healthOf(room.things) };
}

/** The knight's health, through the snapshot — which elides the field entirely while it is untouched. */
function healthOf(things: ReturnType<typeof buildThingSprites>): number {
  return things.snapshot().things[0].monster?.health ?? MONSTER_HEALTH[ThingType.hellKnight];
}

describe('Regressions · a body straddling a crusher edge', () => {
  test('a monster in the next sector with its box under the ceiling is crushed', () => {
    assert.equal(KNIGHT.radius, 24, "MT_KNIGHT's own mobjinfo radius");
    // 12 units east of the shared edge: the centre is in the untouched sector,
    // the box reaches 12 units into the crushing one.
    const { caught, health } = pulse(scene(12));
    assert.ok(caught, "nofit: it doesn't fit, so the crusher keeps grinding");
    assert.equal(health, 490, 'and it takes the pulse — 500 spawn health, 10 crush damage');
  });

  test('one standing clear of the edge is left alone', () => {
    // A knight's own radius past the edge: the box stops exactly at it.
    const { caught, health } = pulse(scene(KNIGHT.radius + 1));
    assert.equal(caught, false, 'nothing is caught, so the descent stays at full speed');
    assert.equal(health, 500, 'and nothing is hurt');
  });

  test('one squarely inside the crushing sector is crushed as it always was', () => {
    const { caught, health } = pulse(scene(-CELL / 2));
    assert.ok(caught, 'the ordinary case is untouched');
    assert.equal(health, 490);
  });
});
