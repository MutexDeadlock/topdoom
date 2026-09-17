import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { MonsterRef } from '../../src/game/things/defs.ts';
import type { Pos3 } from '../../src/types.ts';
import { vecLength } from '../../src/util/geom.ts';
import { rayThrough } from '../fixtures/aimray.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { thingLayer } from '../fixtures/spritestubs.ts';

/**
 * Auto-aim's pick tests the aim ray against each body's own `mobjinfo` box, never
 * against its drawn sprite. The sprite version made the game WAD's *art* an input
 * to the simulation: a NUTS.WAD run recorded on DOOM2.WAD desynced about 12 s in
 * when replayed on freedoom2.wad as a stand-in, because 139 of 144 monster sprite
 * quads differ between the two and the same ray therefore locked onto a different
 * body. The box comes from `MONSTER_STATS`, which is the engine's own `info.c`
 * table and identical on every WAD set.
 * See docs/combat.md § Auto-aim and docs/replays.md § What breaks determinism.
 */

const IMP = MONSTER_STATS[ThingType.imp];
const FATSO = MONSTER_STATS[ThingType.mancubus];
/** Chest height on a floor of 0, well inside every body used here. */
const CHEST = 28;

/**
 * One subject per row, so a ray fired along a row can only ever meet what that
 * row is about — except row 1, whose two imps are the subject.
 */
function arena() {
  const grid = gridMap(
    ['##########', '#........#', '#........#', '#........#', '#........#', '#........#', '##########'],
    { cell: 128 },
  );
  const map = grid.map;
  map.things.push(
    thingAt(grid, 1, 1, 1), // player start
    thingAt(grid, 3, 1, ThingType.imp),
    thingAt(grid, 6, 1, ThingType.imp),
    thingAt(grid, 3, 2, ThingType.imp),
    thingAt(grid, 3, 3, ThingType.mancubus),
    thingAt(grid, 3, 4, ThingType.barrel),
    thingAt(grid, 3, 5, ThingType.bossBrain),
  );
  const world = new World(map);
  const layer = thingLayer(world);
  return { grid, layer };
}

describe('Auto-aim · the pick is the body box, not the sprite', () => {
  test('a body under the ray is picked, and the nearest one wins', () => {
    const { grid, layer } = arena();
    const row = grid.centre(3, 1).y;
    // Along the row from the west wall, at chest height: both imps are on this
    // line, and the near one has to absorb the pick.
    const west = { x: 0, y: row, z: CHEST };
    const east = { x: 4000, y: row, z: CHEST };
    const picked = layer.pickMonster(rayThrough(west, east), east);
    assert.equal(picked?.type, ThingType.imp);
    assert.equal(picked?.x, grid.centre(3, 1).x, 'the nearer of the two imps');

    // The same line walked the other way picks the other one.
    const back = layer.pickMonster(rayThrough(east, west), west);
    assert.equal(back?.x, grid.centre(6, 1).x, 'the nearer one from the east');
  });

  test('the reach either side is that body’s own mobjinfo radius', () => {
    const { grid, layer } = arena();
    const impRow = grid.centre(3, 2).y;
    const fatsoRow = grid.centre(3, 3).y;
    const alongRow = (y: number, off: number): MonsterRef | null =>
      layer.pickMonster(rayThrough({ x: 0, y: y + off, z: CHEST }, { x: 4000, y: y + off, z: CHEST }), {
        x: 4000,
        y: y + off,
        z: CHEST,
      });

    // An imp's `TROO` art is 41 px wide, within half a unit of its own 20-unit
    // radius, which is why the change is barely felt on one. Where box and sprite
    // really part company is a lost soul (16 against a 44 px `SKUL`) and the
    // mancubus below, whose box is the *wider* of the two.
    assert.equal(IMP.radius, 20);
    assert.equal(alongRow(impRow, IMP.radius - 1)?.type, ThingType.imp, 'inside the box');
    assert.equal(alongRow(impRow, IMP.radius + 1), null, 'outside the box, inside the old quad');

    // Per-species, not one shared hitbox: the mancubus is reached from more than
    // twice as far off-centre as the imp, and its 73 px `FATT` art is narrower
    // than the body it draws.
    assert.equal(FATSO.radius, 48);
    assert.equal(alongRow(fatsoRow, FATSO.radius - 1)?.type, ThingType.mancubus);
    assert.equal(alongRow(fatsoRow, FATSO.radius + 1), null);
    assert.equal(alongRow(fatsoRow, IMP.radius + 1)?.type, ThingType.mancubus, 'wide where an imp is not');
  });

  test('the vertical reach is the body’s own height, from its feet up', () => {
    const { grid, layer } = arena();
    const row = grid.centre(3, 2).y;
    const atHeight = (z: number): MonsterRef | null =>
      layer.pickMonster(rayThrough({ x: 0, y: row, z }, { x: 4000, y: row, z }), { x: 4000, y: row, z });

    assert.equal(atHeight(IMP.height - 1)?.type, ThingType.imp, 'level with its head');
    assert.equal(atHeight(IMP.height + 1), null, 'over it');
    assert.equal(atHeight(-1), null, 'under its feet');
  });

  test('a ray straight down from overhead grabs what stands under it', () => {
    const { grid, layer } = arena();
    // The shape a real pick ray has: the camera hangs above and looks down.
    const over = grid.centre(3, 1);
    const above = { x: over.x, y: over.y, z: 700 };
    assert.equal(layer.pickMonster(rayThrough(above, { ...over, z: 0 }), { ...over, z: 0 })?.type, ThingType.imp);

    // A hand's breadth beside the body is a miss, however tall the art is.
    const beside = { x: over.x + IMP.radius + 4, y: over.y };
    const off = { x: beside.x, y: beside.y, z: 700 };
    assert.equal(layer.pickMonster(rayThrough(off, { ...beside, z: 0 }), { ...beside, z: 0 }), null);
  });

  test('a barrel is lockable and the Icon of Sin’s brain is not', () => {
    const { grid, layer } = arena();
    const along = (y: number) =>
      layer.pickMonster(rayThrough({ x: 0, y, z: CHEST }, { x: 4000, y, z: CHEST }), { x: 4000, y, z: CHEST });

    assert.equal(along(grid.centre(3, 4).y)?.type, ThingType.barrel, 'barrels join the monsters');
    // `NO_AUTO_AIM_TYPES`: its whole body sits below the slot the eye watches
    // through, so hovering it only ever threw the shot into the wall.
    assert.equal(along(grid.centre(3, 5).y), null, 'the brain refuses the lock');
  });
});

/**
 * Auto-aim's pick ray is bounded where it passes into the ground past the pointer's own aim point
 * (`World.groundReach`, docs/combat.md § Auto-aim). Repro: NUTS.WAD MAP01 from the raised walkway
 * at (1024, -559), where the unbounded ray ran on under the walkway and locked monsters in the
 * crowd 400-1400 units off, up to 180° from the pointer — and the lock aims the shot and turns
 * the player.
 */

/** The walkway's floor, and the aim plane over it — `AIM_HEIGHT_OFFSET` above the player's feet. */
const LEDGE = 300;
const AIM_Z = LEDGE + 36;

/**
 * A raised walkway (`P`, floor 300) with open ground beyond it and an imp out on that ground —
 * NUTS.WAD's shape in miniature. The camera sits on the backward extension of the aim point → imp
 * line, so the two stand on **one screen pixel** and only the ground bound separates them.
 */
function ledge() {
  const grid = gridMap(['#############', '#PPPPPP.....#', '#############'], {
    cell: 128,
    heights: { P: { floor: LEDGE, ceil: 800 }, '.': { floor: 0, ceil: 800 } },
  });
  grid.map.things.push(thingAt(grid, 1, 1, 1), thingAt(grid, 10, 1, ThingType.imp));
  const world = new World(grid.map);
  const layer = thingLayer(world);
  const row = grid.centre(1, 1).y;
  const onLedge = { x: grid.centre(2, 1).x, y: row, z: AIM_Z };
  const impChest = { x: grid.centre(10, 1).x, y: row, z: CHEST };
  return { grid, world, layer, row, onLedge, impChest, camera: behind(onLedge, impChest, 700) };
}

/** `dist` units back along the line from `at` through `beyond` — where a camera aiming so looks from. */
function behind(at: Pos3, beyond: Pos3, dist: number): Pos3 {
  const len = vecLength(vecLength(beyond.x - at.x, beyond.y - at.y), beyond.z - at.z);
  return {
    x: at.x - ((beyond.x - at.x) / len) * dist,
    y: at.y - ((beyond.y - at.y) / len) * dist,
    z: at.z - ((beyond.z - at.z) / len) * dist,
  };
}

describe('Auto-aim · the pick ray stops where it enters the ground', () => {
  test('a body out past the walkway the pointer is on is not what the pointer is over', () => {
    const { layer, onLedge, impChest, camera } = ledge();
    // The ray meets the walkway's floor a cell past the aim point and runs under it from there;
    // the imp it goes on to cross stands on the ground beyond the walkway's edge.
    assert.equal(layer.pickMonster(rayThrough(camera, impChest), impChest)?.type, ThingType.imp, 'same ray');
    assert.equal(layer.pickMonster(rayThrough(camera, onLedge), onLedge), null, 'the aim point is on the walkway');
  });

  test('the ray is stopped at the first line past the floor it met, one crossing late', () => {
    const { world, onLedge, camera, grid } = ledge();
    const slope = (onLedge.z - camera.z) / (onLedge.x - camera.x);
    // The trace tests line crossings only, so it stops at the cell boundary after the flat the ray
    // actually met — one crossing late, inside the walkway, where no body's box reaches.
    const metFloor = camera.x + (LEDGE - camera.z) / slope;
    const reach = world.groundReach(camera, onLedge);
    const stopX = camera.x + ((onLedge.x - camera.x) / vecLength(onLedge.x - camera.x, onLedge.z - camera.z)) * reach;
    assert.ok(stopX > metFloor, `stopped at x ${stopX.toFixed(0)}, past the floor it met at ${metFloor.toFixed(0)}`);
    assert.ok(stopX - metFloor < grid.cell, 'and no further than one cell past it');
    assert.ok(stopX < grid.centre(6, 1).x + 64, 'well short of the walkway’s own east edge');
  });

  test('nothing between the camera and the aim point is tested', () => {
    const { grid, layer, row, impChest } = ledge();
    // A low camera looking along the walkway: the ray crosses its east edge *below* the walkway's
    // floor, so a bound measured from the camera would refuse the imp beyond it.
    const camera = { x: grid.centre(1, 1).x, y: row, z: LEDGE + 90 };
    const edgeX = grid.centre(6, 1).x + 64;
    const atEdge =
      camera.z + ((impChest.z - camera.z) / (impChest.x - camera.x)) * (edgeX - camera.x);
    assert.ok(atEdge < LEDGE, `the ray is at ${atEdge.toFixed(0)} over the walkway's edge, under its floor of ${LEDGE}`);
    assert.equal(layer.pickMonster(rayThrough(camera, impChest), impChest)?.type, ThingType.imp);
  });
});
