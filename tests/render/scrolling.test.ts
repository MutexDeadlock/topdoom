import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SurfaceScroller } from '../../src/render/scroller.ts';
import { Forces } from '../../src/game/specials/forces.ts';
import { World } from '../../src/game/world.ts';
import type { FlatSurface, WallOccluder } from '../../src/render/mapmesh.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';

/**
 * The pin on vanilla special 48's scroll rate and reach, written against the
 * numbers the engine shipped before Boom's general scroller model folded 48
 * into it (`Add_Scroller(sc_side, FRACUNIT, 0)`) — so every stock IWAD
 * waterfall still looks exactly as it did.
 *
 * The invariants: **35 map-units/sec** (`FRACUNIT` per tic) divided by the
 * texture's own width, the **front sidedef only**, and horizontally only.
 * See docs/render.md § Scrolling textures.
 */
describe('Rendering · scrolling textures, special 48', () => {
  const TEX_WIDTH = 64;
  const TEX_HEIGHT = 128;

  /** One 128-unit linedef carrying `special`, enough of a `DoomMap` for the scroller scan. */
  function oneLineMap(special: number): DoomMap {
    return {
      name: 'TEST',
      nodeFormat: 'vanilla',
      vertexes: [
        { x: 0, y: 0 },
        { x: 128, y: 0 },
      ],
      sectors: [{ floorHeight: 0, ceilHeight: 128, floorTex: 'FLAT1', ceilTex: 'FLAT1', light: 160, special: 0, tag: 0 }],
      sidedefs: [{ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: 'WALL', sector: 0 }],
      linedefs: [{ v1: 0, v2: 1, flags: 0, special, tag: 0, right: 0, left: NO_SIDE }],
      segs: [],
      subsectors: [],
      nodes: [],
      things: [],
      bounds: { minX: 0, minY: 0, maxX: 128, maxY: 128 },
    } as unknown as DoomMap;
  }

  /** A quad's six vertices in `addWall`'s `[A, D, C, A, C, B]` order (128 units of wall over a 64-wide texture). */
  function quadMesh(): THREE.Mesh {
    const uv = new Float32Array([0, 1, 0, 0, 2, 0, 0, 1, 2, 0, 2, 1]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return new THREE.Mesh(geom);
  }

  function occluder(line: number, frontSide: boolean): WallOccluder {
    return {
      key: 'wall:WALL',
      texName: 'WALL',
      vertexStart: 0,
      vertexCount: 6,
      ax: 0,
      ay: 0,
      bx: 128,
      by: 0,
      botH: 0,
      topH: 128,
      segAx: 0,
      segAy: 0,
      segBx: 128,
      segBy: 0,
      sector: 0,
      line,
      frontSide,
      subsector: -1,
    };
  }

  const BANK = { size: () => ({ w: TEX_WIDTH, h: TEX_HEIGHT }) } as unknown as MaterialBank;
  const NO_FLATS: FlatSurface[] = [];

  /** `Forces` needs a `World` for its per-body queries; the scroller scan reads the map alone. */
  function forcesFor(map: DoomMap): Forces {
    return new Forces(map, new World(map));
  }

  function rig(special: number, frontSide = true) {
    const mesh = quadMesh();
    const meshes = new Map([['wall:WALL', mesh]]);
    const forces = forcesFor(oneLineMap(special));
    const scroller = new SurfaceScroller(
      forces,
      { occluders: [occluder(0, frontSide)], wallMeshes: meshes, flatSurfaces: NO_FLATS, flatMeshes: new Map() },
      BANK,
    );
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    /** One tic of simulation plus `seconds` of presentation, the way `game.ts` drives the pair. */
    const run = (seconds: number) => {
      forces.tick();
      forces.advanceOffsets(seconds);
      scroller.update();
    };
    return { run, uv };
  }

  test('scrolls 35 map units per second, divided by the texture width', () => {
    const { run, uv } = rig(48);
    // A full second is 35 units = 35/64 of a 64-wide texture.
    run(1);
    assert.ok(Math.abs(uv.getX(0) - 35 / TEX_WIDTH) < 1e-6, `left edge U was ${uv.getX(0)}`);
    assert.ok(Math.abs(uv.getX(2) - (2 + 35 / TEX_WIDTH)) < 1e-6, `right edge U was ${uv.getX(2)}`);
  });

  test('accumulates across frames and wraps into [0, 1) without drifting', () => {
    const { run, uv } = rig(48);
    // Two seconds in 70 tic-sized steps: 70 units = 1.09375 textures, wrapped.
    for (let i = 0; i < 70; i++) run(1 / 35);
    const expected = (70 / TEX_WIDTH) % 1;
    assert.ok(Math.abs(uv.getX(0) - expected) < 1e-5, `left edge U was ${uv.getX(0)}, expected ${expected}`);
  });

  test("the quad edges keep addWall's [A, D, C, A, C, B] vertex order", () => {
    const { run, uv } = rig(48);
    run(1);
    // 0/1/3 are the left edge, 2/4/5 the right — the same U on each side.
    assert.equal(uv.getX(0), uv.getX(1));
    assert.equal(uv.getX(0), uv.getX(3));
    assert.equal(uv.getX(2), uv.getX(4));
    assert.equal(uv.getX(2), uv.getX(5));
  });

  test('the back sidedef never scrolls', () => {
    const { run, uv } = rig(48, false);
    run(1);
    assert.equal(uv.getX(0), 0);
    assert.equal(uv.getX(2), 2);
  });

  test('a line without a scroll special never scrolls', () => {
    const { run, uv } = rig(0);
    run(1);
    assert.equal(uv.getX(0), 0);
  });

  test('V is untouched — vanilla 48 scrolls horizontally only', () => {
    const { run, uv } = rig(48);
    run(1);
    assert.equal(uv.getY(0), 1);
    assert.equal(uv.getY(1), 0);
  });

  test('Boom 85 is the same rate in the opposite direction', () => {
    const { run, uv } = rig(85);
    run(1);
    assert.ok(Math.abs(uv.getX(0) + 35 / TEX_WIDTH) < 1e-6, `left edge U was ${uv.getX(0)}`);
  });
});
