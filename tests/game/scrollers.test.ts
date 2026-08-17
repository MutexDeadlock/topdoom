import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Forces } from '../../src/game/specials/forces.ts';
import { World } from '../../src/game/world.ts';
import { NO_SIDE, type DoomMap, type LineDef, type Sector, type SideDef, type Vertex } from '../../src/wad/map.ts';

/**
 * Boom's scroller family as `P_SpawnScrollers`/`T_Scroll` define it: the
 * `SCROLL_SHIFT` rate, `CARRYFACTOR`, the displacement and accelerative
 * variants, and 254's rotation into the target wall's own frame.
 * See docs/specials.md § Scrollers and conveyors.
 */
describe('Boom scrollers', () => {
  const TICS = 35;

  interface Spec {
    /** `[x1, y1, x2, y2, special, tag]` per line; the first sidedef of each is its front. */
    lines: [number, number, number, number, number, number][];
    /** Sector tags, index 0 being the sector every sidedef names unless `sectorOf` says otherwise. */
    tags?: number[];
    sideOffsets?: [number, number][];
    /** Which sector each line's front sidedef belongs to, for control-sector cases. */
    sectorOf?: number[];
  }

  function build(spec: Spec): DoomMap {
    const vertexes: Vertex[] = [];
    const linedefs: LineDef[] = [];
    const sidedefs: SideDef[] = [];
    for (const [i, [x1, y1, x2, y2, special, tag]] of spec.lines.entries()) {
      vertexes.push({ x: x1, y: y1 }, { x: x2, y: y2 });
      const [xOffset, yOffset] = spec.sideOffsets?.[i] ?? [0, 0];
      sidedefs.push({ xOffset, yOffset, upper: '-', lower: '-', middle: 'WALL', sector: spec.sectorOf?.[i] ?? 0 });
      linedefs.push({ v1: i * 2, v2: i * 2 + 1, flags: 0, special, tag, right: i, left: NO_SIDE });
    }
    const sectors: Sector[] = (spec.tags ?? [0]).map((tag) => ({
      floorHeight: 0,
      ceilHeight: 128,
      floorTex: 'FLAT1',
      ceilTex: 'FLAT1',
      light: 160,
      special: 0,
      tag,
    }));
    return {
      name: 'TEST',
      nodeFormat: 'vanilla',
      vertexes,
      sectors,
      sidedefs,
      linedefs,
      segs: [],
      subsectors: [],
      nodes: [],
      things: [],
      bounds: { minX: -1024, minY: -1024, maxX: 1024, maxY: 1024 },
    } as unknown as DoomMap;
  }

  /** `Forces` needs a `World` for its per-body queries; the scan itself reads the map alone. */
  function forcesFor(map: DoomMap): Forces {
    return new Forces(map, new World(map));
  }

  /** One tic of simulation, then a second of presentation — the offsets a whole second produces. */
  function runOneSecond(forces: Forces): void {
    forces.tick();
    forces.advanceOffsets(1);
  }

  test('the rate is the control line vector divided by 32, per tic', () => {
    // A 128-unit line east: 128/32 = 4 units/tic, and the flat half negates x.
    const forces = forcesFor(build({ lines: [[0, 0, 128, 0, 251, 7]], tags: [7] }));
    runOneSecond(forces);
    assert.equal(forces.flatOffset(0, false).x, -4 * TICS);
    assert.equal(forces.flatOffset(0, false).y, 0);
    // The ceiling of the same sector is untouched by a floor scroller.
    assert.equal(forces.flatOffset(0, true).x, 0);
  });

  test('250 scrolls the ceiling flat, 251 the floor', () => {
    const forces = forcesFor(build({ lines: [[0, 0, 0, 64, 250, 7]], tags: [7] }));
    runOneSecond(forces);
    // A line north: dx 0, dy 64/32 = 2.
    assert.equal(forces.flatOffset(0, true).y, 2 * TICS);
    assert.equal(forces.flatOffset(0, false).y, 0);
  });

  test('252 carries at CARRYFACTOR — 3/32 of the scroll rate, in units per second', () => {
    const forces = forcesFor(build({ lines: [[0, 0, 128, 0, 252, 7]], tags: [7] }));
    forces.tick();
    const carry = forces.carryInSector(0);
    assert.ok(carry, 'expected a carry impulse');
    // 4 units/tic × 0.09375 = 0.375 units/tic = 13.125 units/sec.
    assert.ok(Math.abs(carry.x - 0.375 * TICS) < 1e-9, `carry.x was ${carry.x}`);
    assert.equal(carry.y, 0);
    // A conveyor does not scroll its own flat.
    assert.equal(forces.flatOffset(0, false).x, 0);
  });

  test('253 both scrolls the flat and carries, and the carry keeps the unnegated vector', () => {
    const forces = forcesFor(build({ lines: [[0, 0, 128, 0, 253, 7]], tags: [7] }));
    runOneSecond(forces);
    assert.equal(forces.flatOffset(0, false).x, -4 * TICS);
    const carry = forces.carryInSector(0)!;
    assert.ok(Math.abs(carry.x - 0.375 * TICS) < 1e-9, `carry.x was ${carry.x}`);
  });

  test('several conveyor lines on one sector are cumulative', () => {
    const forces = forcesFor(
      build({
        lines: [
          [0, 0, 128, 0, 252, 7],
          [0, 0, 128, 0, 252, 7],
        ],
        tags: [7],
      }),
    );
    forces.tick();
    assert.ok(Math.abs(forces.carryInSector(0)!.x - 2 * 0.375 * TICS) < 1e-9);
  });

  test('254 rotates the rate into the target wall’s own frame', () => {
    // Control line 64 units east; target wall 128 units east, tag 7.
    const along = forcesFor(
      build({
        lines: [
          [0, 0, 64, 0, 254, 7],
          [0, 0, 128, 0, 0, 7],
        ],
      }),
    );
    runOneSecond(along);
    // Parallel: horizontal motion, and vanilla's own negated sign.
    assert.equal(along.sideOffset(1).x, -2 * TICS);
    assert.equal(along.sideOffset(1).y, 0);

    // Control line 64 units north against the same east-west wall.
    const across = forcesFor(
      build({
        lines: [
          [0, 0, 0, 64, 254, 7],
          [0, 0, 128, 0, 0, 7],
        ],
      }),
    );
    runOneSecond(across);
    assert.equal(across.sideOffset(1).x, 0);
    assert.equal(across.sideOffset(1).y, 2 * TICS);
  });

  test('254 never scrolls the line carrying the special itself', () => {
    const forces = forcesFor(build({ lines: [[0, 0, 64, 0, 254, 7]] }));
    runOneSecond(forces);
    assert.equal(forces.sideOffset(0).x, 0);
  });

  test('255 scrolls by its own sidedef offsets, x negated', () => {
    const forces = forcesFor(build({ lines: [[0, 0, 128, 0, 255, 0]], sideOffsets: [[3, 5]] }));
    runOneSecond(forces);
    assert.equal(forces.sideOffset(0).x, -3 * TICS);
    assert.equal(forces.sideOffset(0).y, 5 * TICS);
  });

  test('a displacement scroller moves only while its control sector does', () => {
    // Line 1's front sidedef is in sector 1 — the control sector; sector 0 carries the tag.
    const map = build({
      // 246 is the displacement twin of 251 (245 is 250's, the ceiling).
      lines: [[0, 0, 128, 0, 246, 7]],
      tags: [7, 0],
      sectorOf: [1],
    });
    const forces = forcesFor(map);
    runOneSecond(forces);
    assert.equal(forces.flatOffset(0, false).x, 0, 'a still control sector scrolls nothing');

    // Raise the control sector's floor by 8: rate = authored × delta.
    map.sectors[1].floorHeight += 8;
    runOneSecond(forces);
    assert.equal(forces.flatOffset(0, false).x, -4 * 8 * TICS);

    // Stopped again — the offset holds where it was.
    const held = forces.flatOffset(0, false).x;
    runOneSecond(forces);
    assert.equal(forces.flatOffset(0, false).x, held);
  });

  test('an accelerative scroller keeps its built-up rate after the control sector stops', () => {
    // 215 is the accelerative twin of 251.
    const map = build({ lines: [[0, 0, 128, 0, 215, 7]], tags: [7, 0], sectorOf: [1] });
    const forces = forcesFor(map);
    map.sectors[1].floorHeight += 8;
    forces.tick();
    // vdx has taken on -4 × 8 = -32 units/tic and stays there.
    forces.advanceOffsets(1);
    assert.equal(forces.flatOffset(0, false).x, -32 * TICS);
    forces.tick();
    forces.advanceOffsets(1);
    assert.equal(forces.flatOffset(0, false).x, -2 * 32 * TICS, 'the rate persists with the control sector still');
  });

  test('the renderer’s indexes name only the surfaces that actually scroll', () => {
    const forces = forcesFor(
      build({
        lines: [
          [0, 0, 128, 0, 48, 0],
          [0, 0, 128, 0, 251, 7],
          [0, 0, 128, 0, 252, 7],
        ],
        tags: [7],
      }),
    );
    assert.deepEqual(forces.scrollingLines(), [0]);
    assert.deepEqual(forces.scrollingFlats(), [{ sector: 0, isCeiling: false }]);
    assert.deepEqual(forces.counts(), { side: 1, floorTex: 1, ceilTex: 0, carry: 1 });
  });

  test('a scroller with no tagged sector spawns nothing', () => {
    const forces = forcesFor(build({ lines: [[0, 0, 128, 0, 251, 9]], tags: [7] }));
    assert.equal(forces.hasScrollers, false);
  });
});
