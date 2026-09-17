import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKY_FLAT } from '../../src/wad/map.ts';
import { gridMap, type CellHeights } from '../fixtures/gridmap.ts';
import { impBody, rocket, shotRig } from '../fixtures/shotrig.ts';
import { World } from '../../src/game/world.ts';
import { PUFF_FRAMES } from '../../src/game/spritefx/tables.ts';
import { drawnLumps, fxLayer } from '../fixtures/spritestubs.ts';
/**
 * A missile flying into a sky ceiling lower than itself used to burst against the sky, splash and
 * all. `P_XYMovement` removes it without an explosion when the line that stopped it has a sky
 * ceiling behind it, and Boom narrows that to a missile above that ceiling, so a rocket still
 * bursts against the lower wall of a sky sector it flew under. See docs/combat.md § Where an impact
 * sits.
 */

/** Open floor to the west, the low sector `S` to the east; the rocket flies east at 32. */
const ART = ['############', '#.....SSSSS#', '#.....SSSSS#', '#.....SSSSS#', '############'];
/** An imp a cell above the flight line, near enough to the low sector's face to take splash. */
const BYSTANDER_CELL = { col: 5, row: 1 };
const ROCKET = rocket({ radius: 128, damage: 128, hitsPlayer: false });

/** One rocket fired east into `S`, with every sector's ceiling sky or not. */
function fireInto(heights: { floor: number; ceil: number }, sky: boolean) {
  const grid = gridMap(ART, { cell: 64, heights: { S: heights } });
  // The face the rocket meets has `S` behind it, the side `P_XYMovement` reads.
  const face = grid.map.linedefs[grid.westEdge(6, 2)];
  assert.equal(grid.map.sidedefs[face.left].sector, grid.index(6, 2), 'the low sector is the back side');
  if (sky) for (const s of grid.map.sectors) s.ceilTex = SKY_FLAT;
  const bystander = impBody(1, grid.centre(BYSTANDER_CELL.col, BYSTANDER_CELL.row));
  const rig = shotRig(grid, grid.centre(1, 2), [bystander]);
  rig.launch(ROCKET, null);
  rig.fly();
  return rig;
}

describe('Projectiles · a missile that flies into the sky vanishes', () => {
  test('a rocket meeting a sky ceiling below it is removed with no explosion and no splash', () => {
    const rig = fireInto({ floor: 0, ceil: 24 }, true);
    assert.equal(rig.inFlight(), 0, 'nothing is left in flight');
    assert.deepEqual(rig.impacts, []);
    assert.deepEqual(rig.damaged, []);
  });

  test('the same ceiling without sky is a surface it bursts against', () => {
    const rig = fireInto({ floor: 0, ceil: 24 }, false);
    assert.equal(rig.impacts.length, 1);
    assert.deepEqual(rig.damaged, [1], 'the bystander takes splash');
  });

  test('a rocket under a sky sector’s ceiling still bursts against its lower wall', () => {
    const rig = fireInto({ floor: 48, ceil: 128 }, true);
    assert.equal(rig.impacts.length, 1);
    assert.deepEqual(rig.damaged, [1]);
  });
});

/**
 * A two-sided line with sky on both sides ate the bullet puff over its whole
 * face, so on a map roofed with `F_SKY1` throughout no shot at any wall left a
 * mark — GoingDown MAP01, 439 of its 485 sectors, where every step and wall
 * around the player start is such a line. Only the band actually drawn as sky
 * eats it now, which is Boom's own narrowing of vanilla's test.
 * See docs/combat.md § Bullet puffs.
 */


const SHOT_Z = 36;
const EAST = 0;
const PUFF = `PUFF${PUFF_FRAMES[0]}0`;

/** Shooter's cell west of `back`, both roofed with sky. Returns what the shot drew. */
function puffAgainst(back: CellHeights): string[] {
  const grid = gridMap(['.b'], { cell: 256, heights: { '.': { floor: 0, ceil: 512 }, b: back } });
  for (const sector of grid.map.sectors) sector.ceilTex = SKY_FLAT;
  const world = new World(grid.map);
  const effects = fxLayer({ fogVisible: () => true });
  effects.beginLevel(world);

  const at = grid.centre(0, 0);
  const path = world.shotPath({ x: at.x, y: at.y, z: SHOT_Z }, EAST, null, 2048, null);
  assert.notEqual(path.lineIndex, null, 'the shot has to stop on the shared line for this to test anything');
  effects.spawnWallPuff(path, EAST);
  return drawnLumps(effects);
}

describe('Projectiles · the bullet puff on a sky-hack wall', () => {
  test('a step between two open-air sectors takes the puff', () => {
    assert.deepEqual(puffAgainst({ floor: 96, ceil: 512 }), [PUFF], 'lower texture, a real wall');
  });

  test('the sky band above a lowered ceiling still eats it', () => {
    assert.deepEqual(puffAgainst({ floor: 0, ceil: 16 }), [], 'shot passed over the back ceiling');
  });
});
