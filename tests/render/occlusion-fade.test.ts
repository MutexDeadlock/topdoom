import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMapMesh, WALL_CHUNK_LEN, type WallOccluder } from '../../src/render/mapmesh.ts';
import {
  FADE_ALPHA,
  FADE_CORE,
  FADE_RADIUS,
  MONSTER_FADE_RANGE,
  WallFader,
  FlatFader,
  collectFadeTargets,
  type FadeTarget,
} from '../../src/render/occlusion.ts';
import { Transfers } from '../../src/game/specials/transfers.ts';
import { World, type Opening } from '../../src/game/world.ts';
import { NO_SIDE } from '../../src/wad/map.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * The fade is a *ball* around where a sightline meets something solid, not the
 * crossed linedef and not a full-height slab of it: walls are cut into chunks
 * both ways at build time and every chunk corner carries its own alpha.
 * See docs/render.md § The fade is a hole, not a wall.
 */

/**
 * The dials are *read*, never mirrored: every fixture below sizes itself from
 * them and every expectation is derived from them, so retuning `FADE_RADIUS`,
 * `FADE_CORE`, `FADE_ALPHA` or `MONSTER_FADE_RANGE` moves this suite with it
 * instead of reddening it. They are feel dials; a test that pins one in place
 * is a bug in the test.
 */
const CHUNK = WALL_CHUNK_LEN;

/** Cells long enough that a wall runs both several chunks and several hole-widths, whole chunks either way. */
const CELL = CHUNK * Math.max(4, Math.ceil((4 * FADE_RADIUS) / CHUNK));

/** A point `t` of the way up the ramp from full fade to none — what a "fades hard"/"barely fades" assertion means once `FADE_ALPHA` can be anything. */
function ramp(t: number): number {
  return FADE_ALPHA + (1 - FADE_ALPHA) * t;
}

const WALLTEX = 'WALL';

/**
 * Three open cells in a row, walled north and south, at `CELL` per cell — so
 * each open cell's north edge is one 512-unit linedef, four chunks wide.
 * Upper textures go on every side, since a `#` cell is a zero-height sector
 * and the step up to it is what draws.
 */
function walledRow() {
  const grid = gridMap(['###', '...', '###'], { cell: CELL });
  for (const l of grid.map.linedefs) {
    if (l.right !== NO_SIDE) grid.map.sidedefs[l.right].upper = WALLTEX;
    if (l.left !== NO_SIDE) grid.map.sidedefs[l.left].upper = WALLTEX;
  }
  const built = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
  return { grid, ...built, world: new World(grid.map) };
}

/** The real opening lookup, in the shape `WallFader.update` takes it. */
function openingsOf(world: World) {
  return (line: number, out: Opening) => world.openingInto(line, out);
}

/** Every quad cut from one line side, in build order. */
function group(occluders: readonly WallOccluder[], line: number, frontSide: boolean): WallOccluder[] {
  return occluders.filter((o) => o.line === line && o.frontSide === frontSide);
}

/** The line running east-west at `y`, whichever index it landed on. */
function lineAtY(grid: ReturnType<typeof gridMap>, y: number, x: number): number {
  const { map } = grid;
  for (const [i, l] of map.linedefs.entries()) {
    const v1 = map.vertexes[l.v1];
    const v2 = map.vertexes[l.v2];
    if (v1.y !== y || v2.y !== y) continue;
    if (Math.min(v1.x, v2.x) <= x && x <= Math.max(v1.x, v2.x)) return i;
  }
  throw new Error(`no east-west line at y=${y} spanning x=${x}`);
}

/**
 * A quad's four corner alphas as `commit` wrote them, with the map position each
 * belongs to — `addWall` pushes [A, D, C, A, C, B], so indices 0/1/2/5 are
 * top-left, bottom-left, bottom-right, top-right.
 */
function corners(meshes: Map<string, THREE.Mesh>, o: WallOccluder) {
  const attr = meshes.get(o.key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
  return {
    topLeft: { a: attr.getW(o.vertexStart), x: o.ax, y: o.ay, z: o.topH },
    botLeft: { a: attr.getW(o.vertexStart + 1), x: o.ax, y: o.ay, z: o.botH },
    botRight: { a: attr.getW(o.vertexStart + 2), x: o.bx, y: o.by, z: o.botH },
    topRight: { a: attr.getW(o.vertexStart + 5), x: o.bx, y: o.by, z: o.topH },
  };
}

/** Every corner of a quad, as a flat list. */
function cornerList(meshes: Map<string, THREE.Mesh>, o: WallOccluder) {
  const c = corners(meshes, o);
  return [c.topLeft, c.botLeft, c.botRight, c.topRight];
}

/** One long `dt`, so `dampen` snaps to its target and the test reads the steady state. */
const SETTLE = 10;

describe('render · a wall is cut into chunks the fade can window', () => {
  test('a long wall builds one quad per chunk, tiling the line end to end', () => {
    const b = walledRow();
    // The middle cell's north edge: y = 2 * CELL, x from CELL to 2 * CELL.
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    assert.equal(quads.length, CELL / CHUNK, 'a wall that many chunks long is cut into that many quads');

    for (const [i, q] of quads.entries()) {
      assert.equal(q.segAx, quads[0].segAx, 'every chunk names the same parent segment');
      assert.equal(q.segBx, quads[0].segBx);
      assert.equal(Math.hypot(q.bx - q.ax, q.by - q.ay), CHUNK, 'each chunk is one chunk long');
      if (i > 0) {
        assert.deepEqual(
          { x: q.ax, y: q.ay },
          { x: quads[i - 1].bx, y: quads[i - 1].by },
          'and their footprints meet exactly, leaving no gap to see through',
        );
      }
    }
  });

  test('a wall shorter than a chunk stays one quad', () => {
    const grid = gridMap(['###', '...', '###'], { cell: CHUNK });
    for (const l of grid.map.linedefs) {
      if (l.right !== NO_SIDE) grid.map.sidedefs[l.right].upper = WALLTEX;
      if (l.left !== NO_SIDE) grid.map.sidedefs[l.left].upper = WALLTEX;
    }
    const b = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    const line = lineAtY(grid, 2 * CHUNK, CHUNK * 1.5);
    assert.equal(group(b.occluders, line, true).length, 1);
  });

  test('chunk UVs stay continuous, so the texture does not jump at a cut', () => {
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    const attr = b.wallMeshes.get(quads[0].key)!.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 1; i < quads.length; i++) {
      const previousRight = attr.getX(quads[i - 1].vertexStart + 2);
      const left = attr.getX(quads[i].vertexStart);
      assert.ok(Math.abs(previousRight - left) < 1e-6, `chunk ${i} starts where ${i - 1} ended`);
    }
  });
});

/**
 * Both faders reject on a box around the camera and its targets before doing any crossing work —
 * exactly, not approximately, since every sightline lives inside that box. A target whose
 * `fadeFloor` is 1 fades nothing but still stretches the box, which is what lets a test switch the
 * reject off without changing what should be drawn. docs/render.md § The fade is a hole, not a wall.
 */
describe('render · the sightline box rejects only what it must', () => {
  /** Both faders run over the same targets, then the alpha of every vertex they wrote. */
  function alphasFor(b: ReturnType<typeof walledRow>, camX: number, camY: number, camZ: number, ts: FadeTarget[]) {
    const walls = new WallFader(b.occluders, b.wallMeshes);
    const flats = new FlatFader(b.flatSurfaces, b.flatMeshes);
    walls.update(SETTLE, camX, camY, camZ, ts, openingsOf(b.world));
    flats.update(SETTLE, camX, camY, camZ, ts);
    walls.commit(() => 1);
    flats.commit(() => 1);
    const out: number[] = [];
    for (const meshes of [b.wallMeshes, b.flatMeshes]) {
      for (const key of [...meshes.keys()].sort()) {
        const c = meshes.get(key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
        for (let i = 0; i < c.count; i++) out.push(c.getW(i));
      }
    }
    return out;
  }

  test('a far-off target that fades nothing changes no alpha, however much box it adds', () => {
    // If the reject were dropping work it shouldn't, widening the box would bring that work back
    // and the two runs would differ.
    const b = walledRow();
    const camX = CELL * 1.5;
    const camY = 2 * CELL + 512;
    const target: FadeTarget = { x: camX, y: 2 * CELL - 512, z: 0, fadeFloor: FADE_ALPHA };
    const narrow = alphasFor(b, camX, camY, 128, [target]);
    // `fadeFloor` 1 is "pull nothing down", so these two only move the box.
    const wide = alphasFor(b, camX, camY, 128, [
      target,
      { x: -1e5, y: -1e5, z: -1e5, fadeFloor: 1 },
      { x: 1e5, y: 1e5, z: -1e5, fadeFloor: 1 },
    ]);
    assert.deepEqual(wide, narrow);
    assert.ok(
      narrow.some((a) => a < 1),
      'the fixture faded nothing at all, so the comparison proves nothing',
    );
  });
});

describe('render · the fade is a hole, not a wall', () => {
  /**
   * Camera due north of the wall looking south at a target due south of it, so
   * the sightline crosses at a known x — `where` — and at a height inside the
   * quad. The wall runs east-west at y = 2 * CELL.
   */
  function sightlineAcross(where: number) {
    const camY = 2 * CELL + 512;
    const targetY = 2 * CELL - 512;
    // Halfway along the sightline, so the crossing height is the mean of the two.
    return { camX: where, camY, camZ: 128, target: { x: where, y: targetY, z: 0, fadeFloor: FADE_ALPHA } };
  }

  test('only the chunks near the crossing fade; the rest of the wall stands', () => {
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    const segAx = quads[0].segAx;
    // Cross a quarter of the way along, so there is untouched wall on one side
    // and the far end sits well past `FADE_RADIUS`.
    const crossD = CELL / 4;
    const rig = sightlineAcross(segAx + crossD);

    const fader = new WallFader(b.occluders, b.wallMeshes);
    fader.update(SETTLE, rig.camX, rig.camY, rig.camZ, [rig.target], openingsOf(b.world));
    fader.commit(() => 1);

    // The crossing: on the wall, at the sightline's height there.
    const cross = { x: rig.camX, y: 2 * CELL, z: 64 };
    for (const q of quads) {
      for (const c of cornerList(b.wallMeshes, q)) {
        const d = Math.hypot(c.x - cross.x, c.y - cross.y, c.z - cross.z);
        const at = `(${c.x}, ${c.z}) is ${d.toFixed(0)} from the crossing`;
        // A tolerance, not equality: the floor makes a round trip through a
        // float32 buffer, and only some values survive that exactly.
        if (d <= FADE_CORE) assert.ok(Math.abs(c.a - FADE_ALPHA) < 1e-6, `corner ${at}, inside the hole — got ${c.a}`);
        else if (d >= FADE_RADIUS) assert.equal(c.a, 1, `corner ${at}, outside it`);
        else assert.ok(c.a > FADE_ALPHA && c.a < 1, `corner ${at}, on the ramp — got ${c.a}`);
      }
    }
    // The point of the whole change: some of this wall is still standing.
    assert.ok(
      quads.some((q) => cornerList(b.wallMeshes, q).every((c) => c.a === 1)),
      'a wall long enough to have far chunks keeps them opaque',
    );
  });

  test('a chunk boundary carries one value, so the gradient has no seam', () => {
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    const rig = sightlineAcross(quads[0].segAx + CELL / 4);

    const fader = new WallFader(b.occluders, b.wallMeshes);
    fader.update(SETTLE, rig.camX, rig.camY, rig.camZ, [rig.target], openingsOf(b.world));
    fader.commit(() => 1);

    for (let i = 1; i < quads.length; i++) {
      const previous = corners(b.wallMeshes, quads[i - 1]);
      const next = corners(b.wallMeshes, quads[i]);
      assert.equal(next.topLeft.a, previous.topRight.a, `chunk ${i} starts at the alpha chunk ${i - 1} ended on`);
      assert.equal(next.botLeft.a, previous.botRight.a, 'and so does its bottom');
    }
  });

  test('the hole opens where the sightline crosses, not somewhere else along the wall', () => {
    // The regression this guards: `segmentCrossT` returns its parameter along
    // the *sightline*, and treating it as a position along the wall puts the
    // hole in the wrong place entirely — here, at the wall's west end while the
    // player stands at its east.
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    const rig = sightlineAcross(quads[0].segAx + CELL - 32);

    const fader = new WallFader(b.occluders, b.wallMeshes);
    fader.update(SETTLE, rig.camX, rig.camY, rig.camZ, [rig.target], openingsOf(b.world));
    fader.commit(() => 1);

    // Which end fades is the whole claim, so the assertion compares the two
    // ends rather than naming a number: how *deep* the near one goes is what
    // the dials move, and § "only the chunks near the crossing fade" above
    // already pins that against the ramp.
    assert.ok(corners(b.wallMeshes, quads[quads.length - 1]).topRight.a < 1, 'the east end, beside the target, fades');
    assert.equal(corners(b.wallMeshes, quads[0]).topLeft.a, 1, `the west end, ${CELL - 32} units away, does not`);
  });

  test('the hole crosses onto the neighbouring linedef instead of stopping at the joint', () => {
    // The regression this guards, and the reason the window is a world-space
    // ball rather than a distance along the crossed line: DOOM walls are built
    // from many short linedefs (median 120u on E1M3), so a window clipped to
    // the crossed one dissolved that whole panel and left the panel beside it
    // fully solid — a hard-edged rectangular hole.
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    // Cross 24 units short of this line's east end, so the neighbouring line
    // begins well inside the hole.
    const joint = quads[quads.length - 1].segBx;
    const rig = sightlineAcross(joint - 24);
    const neighbour = group(b.occluders, lineAtY(b.grid, 2 * CELL, joint + CELL / 2), true);
    assert.ok(neighbour.length > 0 && neighbour[0].line !== line, 'the fixture really has a second linedef here');

    const fader = new WallFader(b.occluders, b.wallMeshes);
    fader.update(SETTLE, rig.camX, rig.camY, rig.camZ, [rig.target], openingsOf(b.world));
    fader.commit(() => 1);

    const nearest = neighbour.reduce((best, q) => (Math.abs(q.ax - joint) < Math.abs(best.ax - joint) ? q : best));
    assert.ok(corners(b.wallMeshes, nearest).topLeft.a < 1, 'the neighbour fades where it meets the hole');
    // And the two sides of the joint agree, so there is no step across it.
    const mine = quads[quads.length - 1];
    assert.equal(
      corners(b.wallMeshes, nearest).topLeft.a,
      corners(b.wallMeshes, mine).topRight.a,
      'no seam at the joint',
    );
    assert.ok(
      neighbour.some((q) => cornerList(b.wallMeshes, q).every((c) => c.a === 1)),
      'while the far end of that neighbour still stands',
    );
  });

  test('a quad the sightline misses entirely keeps its alpha', () => {
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    // A sightline running along the wall's own row never crosses it.
    const fader = new WallFader(b.occluders, b.wallMeshes);
    const target: FadeTarget = { x: quads[0].segAx, y: 1.5 * CELL, z: 0, fadeFloor: FADE_ALPHA };
    fader.update(SETTLE, 3 * CELL, 1.5 * CELL, 128, [target], openingsOf(b.world));
    fader.commit(() => 1);
    for (const q of quads) for (const c of cornerList(b.wallMeshes, q)) assert.equal(c.a, 1);
  });
});

describe('render · what the fade still refuses to touch', () => {
  test('a quad the crossing passes over or under stays put', () => {
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    const where = quads[0].segAx + CELL / 2;
    // Camera and target both at floor level: the crossing height lands at 0,
    // which is the bottom of the quad, not inside it.
    const fader = new WallFader(b.occluders, b.wallMeshes);
    fader.update(SETTLE, where, 2 * CELL + 512, 0, [{ x: where, y: 2 * CELL - 512, z: 0, fadeFloor: FADE_ALPHA }], openingsOf(b.world));
    fader.commit(() => 1);
    for (const q of quads) for (const c of cornerList(b.wallMeshes, q)) assert.equal(c.a, 1);
  });

  test('a midtexture hung inside a real opening never fades, however the sightline crosses it', () => {
    // A grate between two open cells is something to see *through*, not an
    // occluder — the passable-gap exemption, now fed by `openingInto`.
    const grid = gridMap(['.....'], { cell: CELL });
    for (const l of grid.map.linedefs) {
      if (l.left !== NO_SIDE && l.right !== NO_SIDE) grid.map.sidedefs[l.right].middle = WALLTEX;
    }
    const b = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    const world = new World(grid.map);
    assert.ok(b.occluders.length > 0, 'the fixture builds midtexture quads');

    const fader = new WallFader(b.occluders, b.wallMeshes);
    // Straight through the grates, along the row.
    fader.update(SETTLE, 0, CELL / 2, 96, [{ x: 5 * CELL, y: CELL / 2, z: 32, fadeFloor: FADE_ALPHA }], openingsOf(world));
    fader.commit(() => 1);
    for (const o of b.occluders) for (const c of cornerList(b.wallMeshes, o)) assert.equal(c.a, 1);
  });
});

describe('render · a monster fades a wall less the further off it is', () => {
  const player = { x: 0, y: 0, z: 0 };

  test('the player pulls a wall all the way down, a monster only partway', () => {
    const near = collectFadeTargets(player, [{ x: MONSTER_FADE_RANGE / 96, y: 0, z: 0 }]);
    assert.equal(near[0].fadeFloor, FADE_ALPHA, 'the player is always full strength');
    assert.ok(near[1].fadeFloor > FADE_ALPHA, 'a monster beside them is very nearly so');
    assert.ok(near[1].fadeFloor < ramp(0.02));

    const far = collectFadeTargets(player, [{ x: MONSTER_FADE_RANGE - 1, y: 0, z: 0 }]);
    assert.ok(far[1].fadeFloor > ramp(0.99), 'one at the edge of range barely fades anything');
  });

  test('the strength eases with distance rather than stepping', () => {
    const [, half] = collectFadeTargets(player, [{ x: MONSTER_FADE_RANGE / 2, y: 0, z: 0 }]);
    // Half the range: half of the way from full strength back to no fade.
    assert.ok(Math.abs(half.fadeFloor - ramp(0.5)) < 1e-6);
  });

  test('a wall settles at the floor of whichever target fades it hardest', () => {
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    // A chunk's own east corner, so the crossing sits on it exactly rather than
    // wherever a fraction of `CELL` happens to fall between two of them.
    const middle = quads[Math.floor(quads.length / 2)];
    const where = middle.bx;
    // A float32-exact floor, since the alpha makes a round trip through the
    // buffer before it is read back. Camera and target sit at the same height,
    // a little under the quad's top edge — inside the core for any core, and
    // still inside the band for any core — so the corner asserted on reads its
    // floor rather than a point on the ramp. The floor is what this is about.
    const height = middle.topH - Math.min(FADE_CORE, middle.topH - middle.botH) / 4;
    const weak: FadeTarget = { x: where, y: 2 * CELL - 512, z: height, fadeFloor: 0.5 };

    const fader = new WallFader(b.occluders, b.wallMeshes);
    fader.update(SETTLE, where, 2 * CELL + 512, height, [weak], openingsOf(b.world));
    fader.commit(() => 1);

    assert.equal(corners(b.wallMeshes, middle).topRight.a, 0.5, 'a weak target fades only to its own floor');
  });
});

describe('render · flats fade around the sightline too', () => {
  /** A raised platform of nine cells, with open floor to the south to stand on. */
  function platform() {
    const grid = gridMap(['...', '...', '...'], {
      cell: CELL,
      heights: { '.': { floor: 0, ceil: 256 } },
    });
    const built = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    return { grid, ...built };
  }

  /** Each fan vertex's alpha, keyed by the surface's own index. */
  function fanAlphas(meshes: Map<string, THREE.Mesh>, s: { key: string; vertexStart: number; vertexCount: number }) {
    const attr = meshes.get(s.key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
    return Array.from({ length: s.vertexCount }, (_, v) => attr.getW(s.vertexStart + v));
  }

  test('the pierced fan opens a hole in itself rather than dissolving whole', () => {
    const b = platform();
    // Cross the middle cell's floor: camera above it, target below the floor
    // plane so the crossing is a real one.
    const middle = b.grid.centre(1, 1);
    const surfaces = b.flatSurfaces.filter((s) => !s.isCeiling);
    const pierced = surfaces.find((s) => s.subsector === b.grid.index(1, 1))!;
    const far = surfaces.find((s) => s.subsector === b.grid.index(0, 0))!;

    const fader = new FlatFader(surfaces, b.flatMeshes);
    fader.update(SETTLE, middle.x, middle.y, 512, [{ x: middle.x, y: middle.y, z: -256, fadeFloor: FADE_ALPHA }]);
    fader.commit(() => 1);

    // A 512-unit cell is diced fine enough to carry the gradient itself: right
    // over the target it is gone, and its own far corners still stand.
    const alphas = fanAlphas(b.flatMeshes, pierced);
    const deepest = Math.min(...alphas);
    // What `FADE_CORE` buys, asserted as the relationship rather than as one
    // setting's number: at half a chunk or more, `addFlatFan`'s dicing bound
    // guarantees a drawn vertex inside the core, so the point over the target
    // reaches the floor exactly (docs/render.md § Flats). Below that it only
    // gets onto the ramp — softer, and the trade a smaller core makes.
    // Compared with a tolerance, not `includes`: the floor makes a round trip
    // through a float32 buffer and only some values survive that exactly.
    if (FADE_CORE >= CHUNK / 2) {
      assert.ok(Math.abs(deepest - FADE_ALPHA) < 1e-6, `the fan is fully dissolved where pierced, got ${deepest}`);
    } else {
      assert.ok(deepest < ramp(0.5), `the fan opens where pierced, got ${deepest}`);
    }
    assert.ok(
      alphas.some((a) => a === 1),
      'while its far corners are untouched — the platform does not vanish',
    );
    assert.deepEqual(
      new Set(fanAlphas(b.flatMeshes, far)),
      new Set([1]),
      'a fan two cells away is left alone',
    );
  });

  test('a neighbouring fan ramps: its near corners fade, its far ones barely', () => {
    // Cells one hole wide, so a single fan's own corners span the ramp — the
    // gradient is only ever as fine as the polygon has corners to carry it.
    const cell = FADE_RADIUS;
    const grid = gridMap(['...'], { cell, heights: { '.': { floor: 0, ceil: 256 } } });
    const b = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    const surfaces = b.flatSurfaces.filter((s) => !s.isCeiling);
    const neighbour = surfaces.find((s) => s.subsector === grid.index(0, 0))!;
    // Just inside the middle cell, a short way east of the shared edge — outside
    // the neighbour's own footprint, so what it gets is the ramp.
    const middle = grid.centre(1, 0);
    const x = middle.x - cell / 2 + (cell * 3) / 16;

    const fader = new FlatFader(surfaces, b.flatMeshes);
    fader.update(SETTLE, x, middle.y, 512, [{ x, y: middle.y, z: -256, fadeFloor: FADE_ALPHA }]);
    fader.commit(() => 1);

    // Read each vertex's own alpha against its own position, which also pins
    // down that `commit` hands each fan vertex the point it was built from.
    const mesh = b.flatMeshes.get(neighbour.key)!;
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const alpha = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const corners = Array.from({ length: neighbour.vertexCount }, (_, v) => {
      const i = neighbour.vertexStart + v;
      // Mesh space is (x, height, -y) — see mapmesh.ts's doomToWorld.
      return {
        d: Math.hypot(position.getX(i) - x, -position.getZ(i) - middle.y),
        a: alpha.getW(i),
      };
    }).sort((p, q) => p.d - q.d);

    assert.ok(corners[0].a < ramp(0.5), `the nearest corner fades hard, got ${corners[0].a}`);
    assert.ok(corners[corners.length - 1].a > ramp(0.75), 'the far one is nearly untouched');
    for (let i = 1; i < corners.length; i++) {
      assert.ok(corners[i].a >= corners[i - 1].a - 1e-6, 'alpha only ever rises with distance from the crossing');
    }
  });

  /**
   * A raised platform west of the floor a target stands on, and a camera that
   * can be put on either side of it. The sightline crosses the platform's
   * *height* either way; only from the west does it cross it inside the
   * platform's own footprint.
   */
  function ledge() {
    // Two hole-widths per cell: wide enough that the far side of the platform
    // is out of reach of a hole punched near its edge.
    const cell = 2 * FADE_RADIUS;
    const grid = gridMap(['R.'], {
      cell,
      heights: { R: { floor: 64, ceil: 256 }, '.': { floor: 0, ceil: 256 } },
    });
    const built = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    const open = grid.centre(1, 0);
    // A quarter of a hole east of the shared edge, so the whole platform is
    // well within reach of wherever the sightline crosses its height.
    const target = { x: open.x - cell / 2 + FADE_RADIUS / 4, y: open.y, z: 28, fadeFloor: FADE_ALPHA };
    const platform = built.flatSurfaces.filter((s) => !s.isCeiling && s.subsector === grid.index(0, 0));
    return { ...built, target, platform };
  }

  test('a raised floor the sightline only passes *beside* does not fade', () => {
    // The regression this guards: the crossing is against the floor's infinite
    // height plane, and a step up next to the target is crossed a few units
    // short of the target itself — in open air, on the floor being stood on.
    // Every DOOM stair and ledge is that case. Repro: DOOM2 MAP02 sector 1,
    // stood at (1008, 1592) with the camera due north.
    const b = ledge();
    const fader = new FlatFader(b.flatSurfaces, b.flatMeshes);
    // East of the target, so the ray meets height 64 further east still.
    fader.update(SETTLE, b.target.x + 1.5 * FADE_RADIUS, b.target.y, 300, [b.target]);
    fader.commit(() => 1);

    for (const s of b.platform) {
      assert.deepEqual(new Set(fanAlphas(b.flatMeshes, s)), new Set([1]), 'the platform hides nothing');
    }
  });

  test('the same floor fades once the sightline actually lands on it', () => {
    const b = ledge();
    const fader = new FlatFader(b.flatSurfaces, b.flatMeshes);
    // West of the platform: now the ray meets height 64 on the platform itself,
    // which is genuinely between the camera and the target beyond it.
    fader.update(SETTLE, b.target.x - 5 * FADE_RADIUS, b.target.y, 300, [b.target]);
    fader.commit(() => 1);

    const alphas = b.platform.flatMap((s) => fanAlphas(b.flatMeshes, s));
    assert.ok(Math.min(...alphas) < ramp(0.6), `a hole opens where it is pierced, got ${Math.min(...alphas)}`);
    assert.ok(alphas.includes(1), 'while the far side of the platform still stands');
  });

  test('a fan the sightline never reaches keeps its base alpha', () => {
    const b = platform();
    const surfaces = b.flatSurfaces.filter((s) => !s.isCeiling);
    const fader = new FlatFader(surfaces, b.flatMeshes);
    // Target above the floor: nothing is between it and the camera.
    const middle = b.grid.centre(1, 1);
    fader.update(SETTLE, middle.x, middle.y, 512, [{ x: middle.x, y: middle.y, z: 128, fadeFloor: FADE_ALPHA }]);
    fader.commit(() => 1);
    for (const s of surfaces) {
      assert.deepEqual(new Set(fanAlphas(b.flatMeshes, s)), new Set([1]));
    }
  });
});

describe('render · commit writes only what moved', () => {
  /** `needsUpdate` is write-only in three.js; the upload it schedules shows up as a bumped `version`. */
  function uploads(attr: THREE.BufferAttribute, act: () => void): boolean {
    const before = attr.version;
    act();
    return attr.version !== before;
  }

  test('an unchanged frame re-uploads nothing but still reports visibility', () => {
    const b = walledRow();
    const fader = new WallFader(b.occluders, b.wallMeshes, true);
    const key = b.occluders[0].key;
    fader.commit(() => 1);

    const attr = b.wallMeshes.get(key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
    assert.equal(uploads(attr, () => fader.commit(() => 1)), false, 'a settled wall costs no buffer upload');
    assert.equal(fader.maxAlphaByKey.get(key), 1, 'but it is still reported as drawn');

    assert.equal(uploads(attr, () => fader.commit(() => 0.5)), true, 'a fog change does reach the buffer');
    assert.equal(fader.maxAlphaByKey.get(key), 0.5);
  });

  test('flats do the same, per fan', () => {
    const grid = gridMap(['...', '...'], { cell: CELL });
    const b = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    const fader = new FlatFader(b.flatSurfaces, b.flatMeshes, true);
    const key = b.flatSurfaces[0].key;
    fader.commit(() => 1);

    const attr = b.flatMeshes.get(key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
    assert.equal(uploads(attr, () => fader.commit(() => 1)), false);
    assert.equal(fader.maxAlphaByKey.get(key), 1);

    assert.equal(uploads(attr, () => fader.commit(() => 0)), true);
    assert.equal(fader.maxAlphaByKey.get(key), 0);
  });
});

describe('render · fade targets', () => {
  test('both kinds of target are raised to the same eye height', () => {
    const targets = collectFadeTargets({ x: 0, y: 0, z: 16 }, [{ x: 64, y: 0, z: 48 }]);
    assert.equal(targets[0].z, 16 + PLAYER_HEIGHT / 2);
    assert.equal(targets[1].z, 48 + PLAYER_HEIGHT / 2);
  });
});
