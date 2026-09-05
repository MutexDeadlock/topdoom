import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { MonsterRef } from '../../src/game/things/defs.ts';
import { rayThrough } from '../fixtures/aimray.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

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
  const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
  return { grid, layer };
}

describe('Auto-aim · the pick is the body box, not the sprite', () => {
  test('a body under the ray is picked, and the nearest one wins', () => {
    const { grid, layer } = arena();
    const row = grid.centre(3, 1).y;
    // Along the row from the west wall, at chest height: both imps are on this
    // line, and the near one has to absorb the pick.
    const west = { x: 0, y: row, z: CHEST };
    const picked = layer.pickMonster(rayThrough(west, { x: 4000, y: row, z: CHEST }));
    assert.equal(picked?.type, ThingType.imp);
    assert.equal(picked?.x, grid.centre(3, 1).x, 'the nearer of the two imps');

    // The same line walked the other way picks the other one.
    const east = { x: 4000, y: row, z: CHEST };
    const back = layer.pickMonster(rayThrough(east, { x: 0, y: row, z: CHEST }));
    assert.equal(back?.x, grid.centre(6, 1).x, 'the nearer one from the east');
  });

  test('the reach either side is that body’s own mobjinfo radius', () => {
    const { grid, layer } = arena();
    const impRow = grid.centre(3, 2).y;
    const fatsoRow = grid.centre(3, 3).y;
    const alongRow = (y: number, off: number): MonsterRef | null =>
      layer.pickMonster(rayThrough({ x: 0, y: y + off, z: CHEST }, { x: 4000, y: y + off, z: CHEST }));

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
      layer.pickMonster(rayThrough({ x: 0, y: row, z }, { x: 4000, y: row, z }));

    assert.equal(atHeight(IMP.height - 1)?.type, ThingType.imp, 'level with its head');
    assert.equal(atHeight(IMP.height + 1), null, 'over it');
    assert.equal(atHeight(-1), null, 'under its feet');
  });

  test('a ray straight down from overhead grabs what stands under it', () => {
    const { grid, layer } = arena();
    // The shape a real pick ray has: the camera hangs above and looks down.
    const over = grid.centre(3, 1);
    const above = { x: over.x, y: over.y, z: 700 };
    assert.equal(layer.pickMonster(rayThrough(above, { ...over, z: 0 }))?.type, ThingType.imp);

    // A hand's breadth beside the body is a miss, however tall the art is.
    const beside = { x: over.x + IMP.radius + 4, y: over.y };
    const off = { x: beside.x, y: beside.y, z: 700 };
    assert.equal(layer.pickMonster(rayThrough(off, { ...beside, z: 0 })), null);
  });

  test('a barrel is lockable and the Icon of Sin’s brain is not', () => {
    const { grid, layer } = arena();
    const along = (y: number) => layer.pickMonster(rayThrough({ x: 0, y, z: CHEST }, { x: 4000, y, z: CHEST }));

    assert.equal(along(grid.centre(3, 4).y)?.type, ThingType.barrel, 'barrels join the monsters');
    // `NO_AUTO_AIM_TYPES`: its whole body sits below the slot the eye watches
    // through, so hovering it only ever threw the shot into the wall.
    assert.equal(along(grid.centre(3, 5).y), null, 'the brain refuses the lock');
  });
});
