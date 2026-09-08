import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type * as THREE from 'three';
import { scanSectors } from '../../src/game/specials/mapscan.ts';
import { gridMap, addTransferLine } from '../fixtures/gridmap.ts';
import { specialsRig, vertexHeights, USE_INPUT, TIC } from '../fixtures/specialsrig.ts';
import type { Pos2 } from '../../src/types.ts';

/**
 * A Boom 242 control sector whose floor moves moves the drawn water surface
 * with it — the two share no linedef, so the rebuild edge is explicit.
 * See docs/specials-transfers.md § Deep water.
 */

/**
 * A pool at (3,1) drawing its surface from a control cell at (1,1) that a
 * switch raises by 24 — Boom's rising water.
 */
function risingPool() {
  const grid = gridMap(['#####', '#...#', '#####'], {
    heights: { '.': { floor: 0, ceil: 128 } },
  });
  const map = grid.map;
  const pool = grid.index(3, 1);
  const control = grid.index(1, 1);
  map.sectors[pool].floorHeight = -64;
  map.sectors[pool].tag = 6;
  map.sectors[control].tag = 7;
  addTransferLine(map, control, 242, 6);

  // S1 raise floor by 24 on the control sector: the water level rises, and the
  // mover is aimed at a sector the pool shares no line with.
  const sw = grid.westEdge(2, 1);
  map.linedefs[sw].special = 15;
  map.linedefs[sw].tag = 7;
  return { map, grid, pool, control };
}

/** The heights of every flat fan drawn for `sector`, static batches and mover meshes alike. */
function fanHeights(scene: THREE.Object3D, built: { flatSurfaces: { sector: number; height: number }[] }, sector: number): number[] {
  return [
    ...built.flatSurfaces.filter((f) => f.sector === sector).map((f) => f.height),
    ...vertexHeights(scene, (key) => key.startsWith('flat:')),
  ];
}

/** Press the switch the player is standing at, then let whatever it started run to a stop. */
function pressSwitch(rig: ReturnType<typeof specialsRig>, at: Pos2): void {
  rig.specials.update(TIC, { ...at, angle: 0 }, USE_INPUT, new Set());
  for (let i = 0; i < 200; i++) rig.tick(TIC);
}

/** The one texture in the level, so every vertex the scan below finds is the upper step under test. */
const UPPER = 'STEPUP';
/** The control sector's ceiling, and so the height the pool *draws* its ceiling at. */
const FAKE_CEIL = 96;

/**
 * The same pool, with a movable neighbour looking into it across a two-sided
 * line, and a switch that lowers the control sector's **ceiling**. The
 * neighbour's upper step is sized from the pool's drawn ceiling — i.e. the
 * control sector's — so it goes stale with a sector it shares no line with and
 * never touches. Repro: literalism.wad MAP18 sector 176, whose quads onto water
 * sector 189 (control 187) kept their old height.
 */
function poolBesideNeighbour() {
  const grid = gridMap(['######', '#....#', '######'], { heights: { '.': { floor: 0, ceil: 128 } } });
  const map = grid.map;
  const control = grid.index(1, 1);
  const neighbour = grid.index(3, 1);
  const pool = grid.index(4, 1);
  map.sectors[pool].floorHeight = -64;
  map.sectors[pool].tag = 6;
  map.sectors[control].tag = 7;
  map.sectors[control].ceilHeight = FAKE_CEIL;
  map.sectors[neighbour].tag = 8;
  addTransferLine(map, control, 242, 6);

  // S1 lower the control sector's ceiling to its floor: what the pool draws as
  // its ceiling drops, without the pool or the neighbour moving at all.
  const sw = grid.westEdge(2, 1);
  map.linedefs[sw].special = 41;
  map.linedefs[sw].tag = 7;
  // A special aimed at the neighbour, so it owns its own side of the shared
  // line rather than having the pool's mesh build it (MapMeshOptions.movableSectors).
  const spare = grid.westEdge(3, 1);
  map.linedefs[spare].special = 41;
  map.linedefs[spare].tag = 8;
  // The upper step itself, on both sides so it exists whichever side owns it.
  const shared = grid.westEdge(4, 1);
  map.sidedefs[map.linedefs[shared].right].upper = UPPER;
  map.sidedefs[map.linedefs[shared].left].upper = UPPER;
  return { map, grid, control, neighbour };
}

/** The flat the pool's bottom borrows from its control sector, and the pool's own surface flat. */
const CONTROL_FLAT = 'CTRLFLAT';
const POOL_FLAT = 'POOLFLAT';

/**
 * A pool whose control sector's floor *texture* is swapped out from under it by
 * Boom's 241 (`EV_DoChange`), with nothing moving at all — the pool's bottom
 * wears that flat, so the repaint has to travel the same control → dependent
 * edge a height change does.
 */
function poolWithChangingFlat() {
  const grid = gridMap(['######', '#....#', '######'], { heights: { '.': { floor: 0, ceil: 128 } } });
  const map = grid.map;
  const control = grid.index(1, 1);
  const pool = grid.index(4, 1);
  map.sectors[pool].floorHeight = -64;
  map.sectors[pool].tag = 6;
  map.sectors[pool].floorTex = POOL_FLAT;
  map.sectors[control].tag = 7;
  map.sectors[control].floorTex = CONTROL_FLAT;
  addTransferLine(map, control, 242, 6);
  // Any mover aimed at the control sector, so it is movable and has a mesh —
  // the 241 below never moves anything and so never makes one on its own.
  const lift = grid.westEdge(3, 1);
  map.linedefs[lift].special = 15;
  map.linedefs[lift].tag = 7;
  // S1 change floor texture and type: the control sector takes a neighbour's flat.
  const sw = grid.westEdge(2, 1);
  map.linedefs[sw].special = 241;
  map.linedefs[sw].tag = 7;
  return { map, grid, control, pool };
}

describe('Specials · moving water', () => {
  test('a movable control sector makes the water it drives movable too', () => {
    const { map, pool, control } = risingPool();
    const movable = scanSectors(map).movable;
    assert.ok(movable.has(control), 'the control sector moves');
    assert.ok(movable.has(pool), 'so the water it draws must be rebuildable');
  });

  test('raising the control sector raises the drawn surface', () => {
    const { map, grid, pool, control } = risingPool();
    const rig = specialsRig(map, grid.centre(1, 1));
    const surfaceHeights = () =>
      new Set(fanHeights(rig.scene, rig.built, pool).filter((h) => h !== -64 && h !== 128));

    assert.ok(surfaceHeights().has(0), 'surface starts at the control sector floor');

    pressSwitch(rig, grid.centre(1, 1));

    assert.equal(map.sectors[control].floorHeight, 24, 'the control floor rose by 24');
    assert.ok(surfaceHeights().has(24), 'and the water surface rose with it');
    assert.equal(surfaceHeights().has(0), false, 'nothing is left at the old level');
  });

  test("a neighbour's upper step follows the water's drawn ceiling", () => {
    const { map, grid, control, neighbour } = poolBesideNeighbour();
    const rig = specialsRig(map, grid.centre(1, 1));
    assert.ok(rig.movableSectors.has(neighbour), 'the neighbour owns its own side of the shared line');

    // Only mover meshes hang on the rig's scene, so this is the neighbour's
    // own upper step and nothing else.
    const stepBottom = () => Math.min(...vertexHeights(rig.scene, (key) => key === 'wall:' + UPPER));

    assert.equal(stepBottom(), FAKE_CEIL, 'the step starts on the drawn ceiling');
    pressSwitch(rig, grid.centre(1, 1));

    assert.equal(map.sectors[control].ceilHeight, 0, 'the control ceiling came down to its floor');
    assert.equal(stepBottom(), 0, 'and the step came down with it');
  });

  test("changing the control sector's flat repaints the pool bottom wearing it", () => {
    const { map, grid, control, pool } = poolWithChangingFlat();
    const rig = specialsRig(map, grid.centre(1, 1));
    // Batch keys, i.e. the textures this sector's mesh actually draws with.
    const poolFlats = () => {
      const meshes = (rig.specials as unknown as { geometry: { moverMeshes: Map<number, { mesh: { meshes: Map<string, unknown> } }> } })
        .geometry.moverMeshes.get(pool);
      return [...(meshes?.mesh.meshes.keys() ?? [])].filter((k) => k.startsWith('flat:')).sort();
    };

    assert.ok(poolFlats().includes('flat:' + CONTROL_FLAT), 'the bottom starts in the control sector flat');

    pressSwitch(rig, grid.centre(1, 1));

    assert.notEqual(map.sectors[control].floorTex, CONTROL_FLAT, 'the control sector took the model flat');
    assert.equal(poolFlats().includes('flat:' + CONTROL_FLAT), false, 'the pool stopped drawing the old one');
    assert.ok(poolFlats().includes('flat:' + map.sectors[control].floorTex), 'and picked up the new one');
  });
});
