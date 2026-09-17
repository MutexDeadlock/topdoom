import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { MidCover } from '../../src/render/midcover.ts';
import type { Bitmap } from '../../src/wad/graphics.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A midtexture opaque over a two-sided line's whole opening is a wall at eye level, so the fog
 * does not draw what it sees past one. Reported on GoingDown MAP02, whose monster closet (sectors
 * 123/129) showed through the MODWALL1 fake wall on line 566. The rule is the draw gate's only:
 * what is explored — and so shootable — stays what it was. docs/fogofwar.md § Covering midtextures.
 */
describe('Fog of war · covering midtextures', () => {
  test('an opaque midtexture facing the eye hides what is past it from drawing only', () => {
    const { world, cover, start, leaf } = window('WALL', '-');
    const fog = new FogOfWar(world, [], [start], 0, { cover });
    for (const col of [1, 2]) {
      assert.equal(fog.isVisible(leaf(col)), true, `cell ${col} is explored`);
      assert.equal(fog.isDrawn(leaf(col)), false, `cell ${col} is not drawn`);
      assert.equal(fog.alphaOf(leaf(col)), 0, `cell ${col} is dark`);
    }
  });

  test('what is explored is the same with the cover as without it', () => {
    const { world, cover, start, grid } = window('WALL');
    const plain = new FogOfWar(world, [], [start], 0);
    const covered = new FogOfWar(world, [], [start], 0, { cover });
    assert.deepEqual(covered.snapshotExplored(), plain.snapshotExplored(), 'from the spawn seed');
    const across = grid.centre(2, 0);
    plain.tick([across]);
    covered.tick([across]);
    assert.deepEqual(covered.snapshotExplored(), plain.snapshotExplored(), 'after a tic');
  });

  test('a grate, a midtexture short of the opening, or one facing away hides nothing', () => {
    const cases = [
      ['a grate', 'GRATE', 'GRATE'],
      ['a texture short of the opening', 'SHORT', 'SHORT'],
      ['a wall facing away from the eye', '-', 'WALL'],
    ] as const;
    for (const [label, front, back] of cases) {
      const { world, cover, start, leaf } = window(front, back);
      const fog = new FogOfWar(world, [], [start], 0, { cover });
      assert.equal(fog.isDrawn(leaf(2)), true, label);
    }
  });

  test('a leaf is drawn once something sees it past no covering midtexture', () => {
    const { world, cover, start, leaf, grid } = window('WALL', '-');
    const fog = new FogOfWar(world, [], [start], 0, { cover });
    fog.tick([grid.centre(1, 0)]);
    assert.equal(fog.isDrawn(leaf(1)), true, 'standing in it');
    assert.equal(fog.isDrawn(leaf(2)), true, 'seen from there, past a bare line');
  });

  test('a save keeps such a leaf undrawn, and a save from before the field draws it', () => {
    const { world, cover, start, leaf, grid } = window('WALL', '-');
    const saved = new FogOfWar(world, [], [start], 0, { cover });
    const runs = saved.snapshotExplored();
    const undrawn = saved.snapshotUndrawn();
    // From the far room nothing hangs in the way, so only the restore can hide the window cell.
    const far = grid.centre(2, 0);

    const restored = new FogOfWar(world, [], [far], 0, { cover });
    assert.equal(restored.isDrawn(leaf(1)), true, 'seen cleanly before the restore');
    restored.restoreExplored(runs, undrawn);
    assert.equal(restored.isDrawn(leaf(1)), false, 'the save’s undrawn leaf');

    const older = new FogOfWar(world, [], [far], 0, { cover });
    older.restoreExplored(runs);
    assert.equal(older.isDrawn(leaf(1)), true, 'absent means drawn');
  });
});

/** A texture of `height` rows, transparent across the rows `hole` picks. */
function texture(height: number, hole: (row: number) => boolean = () => false): Bitmap {
  const width = 8;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = hole(y) ? 0 : 255;
  }
  return { width, height, data };
}

const TEXTURES: Record<string, Bitmap> = {
  WALL: texture(128),
  GRATE: texture(128, (row) => row % 16 === 8),
  SHORT: texture(32),
};

/**
 * `.w.`: a window sector 64 high between two rooms, its west line hung with `front` (facing the
 * start in cell 0) and `back`.
 */
function window(front: string, back = front) {
  const grid = gridMap(['.w.'], { heights: { w: { floor: 0, ceil: 64 } } });
  const { map } = grid;
  const line = map.linedefs[grid.westEdge(1, 0)];
  map.sidedefs[line.right].middle = front;
  map.sidedefs[line.left].middle = back;
  const world = new World(map);
  const cover = new MidCover(world, (name) => TEXTURES[name] ?? null);
  const leaf = (col: number): number => {
    const p = grid.centre(col, 0);
    return world.subsectorAt(p.x, p.y);
  };
  return { grid, world, cover, start: grid.centre(0, 0), leaf };
}
