import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  blockCapHeight,
  findSolidBlocks,
  findSolidCaps,
  movableBlocks,
  pocketsOf,
  pointInPolygon,
} from '../../src/render/solids.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMapMesh, buildMoverMesh, refreshMoverMesh } from '../../src/render/mapmesh.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import { FlatFader } from '../../src/render/occlusion.ts';
import { LF, loadMap, NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { Wad } from '../../src/wad/wad.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { seg, wall } from '../fixtures/bspmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * The lids over a map's solid structures — the rings of one-sided linedefs
 * enclosing no sector, which a camera looking down would otherwise see straight
 * through. See docs/render-solids.md.
 */

const WALL = 'STARTAN2';

/** A map made of `rings` of vertexes, each ring one closed loop of one-sided lines. */
function mapWith(rings: { points: [number, number][]; sector?: number; reversed?: boolean }[], sectors = 1): DoomMap {
  const map: DoomMap = {
    name: 'TEST',
    vertexes: [],
    sectors: Array.from({ length: sectors }, () => ({
      floorHeight: 0,
      ceilHeight: 128,
      floorTex: 'FLOOR0_1',
      ceilTex: 'CEIL1_1',
      light: 160,
      special: 0,
      tag: 0,
    })),
    sidedefs: [],
    linedefs: [],
    segs: [],
    subsectors: [],
    nodes: [],
    things: [],
    reject: undefined,
    nodeFormat: 'vanilla',
    bounds: { minX: -1024, minY: -1024, maxX: 1024, maxY: 1024 },
  } as unknown as DoomMap;

  for (const ring of rings) {
    const base = map.vertexes.length;
    for (const [x, y] of ring.points) map.vertexes.push({ x, y });
    for (let i = 0; i < ring.points.length; i++) {
      const a = base + i;
      const b = base + ((i + 1) % ring.points.length);
      const side = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: WALL, sector: ring.sector ?? 0 }) - 1;
      // A linedef's front (right) side is the one its sidedef faces; reversing
      // the ring's winding is what flips which side the sector is on.
      const [v1, v2] = ring.reversed ? [b, a] : [a, b];
      map.linedefs.push({ v1, v2, flags: 0, special: 0, tag: 0, right: side, left: NO_SIDE });
    }
  }
  return map;
}

/**
 * A square wound so that every linedef's front side faces *away* from its
 * middle — the sector is outside, which is how a mapper draws a pillar.
 */
const square = (cx: number, cy: number, r: number): [number, number][] => [
  [cx - r, cy - r],
  [cx + r, cy - r],
  [cx + r, cy + r],
  [cx - r, cy + r],
];

describe('Rendering · solid structure lids', () => {
  test('a pillar gets one lid, at the ceiling, in its own wall texture', () => {
    const map = mapWith([{ points: square(0, 0, 64) }]);
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].height, 128, 'the ceiling of the sector it stands in');
    assert.equal(caps[0].texture, WALL);
    assert.equal(caps[0].sector, 0);
    assert.ok(pointInPolygon(caps[0].points, 0, 0), 'and it covers the structure');
  });

  test('the lid takes the lowest ceiling the ring borders', () => {
    const map = mapWith([{ points: square(0, 0, 64) }], 2);
    map.sectors[1].ceilHeight = 72;
    // One of the four walls faces the lower room.
    map.sidedefs[2].sector = 1;
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].height, 72, 'never above a wall top, or the gap reopens');
    assert.equal(caps[0].sector, 1);
    assert.equal(caps[0].line, 2, 'and the texture phase comes from that wall — the one the lid meets');
  });

  test('the lid is lit by a brighter wall beside the light its own walls mostly carry', () => {
    // Three of the four faces stand in the shade at the structure's foot, the fourth in the lit
    // part of the same level. That shade is what the structure casts, and vanilla lays it on the
    // floor, never on the block. docs/render-solids.md.
    const map = mapWith([{ points: square(0, 0, 64) }], 2);
    map.sectors[1].light = 192;
    map.sidedefs[1].sector = 1;
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].sector, 0, 'the ceiling that set the height still owns the fans');
    assert.equal(caps[0].lightSector, 1);
  });

  test('a far brighter sector the structure only borders does not light its top', () => {
    // The same ring, but the one lit face is a light strip two shading steps up rather than the
    // level's own brightness — a region of its own, not this structure's ambient.
    const map = mapWith([{ points: square(0, 0, 64) }], 2);
    map.sectors[1].light = 255;
    map.sidedefs[1].sector = 1;
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].lightSector, 0);
  });

  test('a face that stops where the level above it begins gets its own cap, not the lid', () => {
    // A crate beside a step: three of its walls face the platform (floor 64, ceiling 128), the
    // fourth the tunnel running under it (floor 0, ceiling 64). That tunnel ceiling is where the
    // platform begins, not where the crate stops — taking it would open the box from above.
    // docs/render-solids.md.
    const map = mapWith([{ points: square(0, 0, 64) }], 2);
    map.sectors[0].floorHeight = 64;
    map.sectors[1].ceilHeight = 64;
    map.sidedefs[1].sector = 1;
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 2, 'the lid, and a cap at the level the buried face stops at');
    assert.equal(caps[0].height, 128, 'the lid caps the walls that are the crate’s own top');
    assert.equal(caps[0].sector, 0);
    // From the tunnel the crate’s wall ends at 64, so the box is closed there too — lit by the
    // tunnel, and phased from its wall.
    assert.equal(caps[1].height, 64);
    assert.equal(caps[1].sector, 1);
    assert.equal(caps[1].line, 1);
    assert.equal(caps[1].points, caps[0].points, 'over the same footprint');
    assert.deepEqual([caps[0].under, caps[1].under], [false, true], 'and only the second is one');
  });

  test('a wall split into segments is buried as one, not only at its ends', () => {
    // Three faces stand in the nook the structure passes through, the fourth on the level above.
    // The middle of the three touches nothing but its own fellows, so the direct test misses it and
    // it sinks the lid to the nook's ceiling — GoingDown.wad MAP08's crate at (-397, 4), whose
    // upper half is a wooden box reaching 128. docs/render-solids.md.
    const map = mapWith([{ points: square(0, 0, 64) }], 2);
    map.sectors[0].floorHeight = 64;
    map.sectors[1].ceilHeight = 64;
    for (const side of [0, 1, 2]) map.sidedefs[side].sector = 1;
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 2);
    assert.equal(caps[0].height, 128, 'the level the ring’s fourth face reaches');
    assert.equal(caps[1].height, 64, 'and the nook’s own level is closed under it');
    assert.equal(caps[1].under, true);
  });

/**
 * A pillar with a niche cut into its east face: sector 0 is the room (ceiling 128), sector 1 the
 * niche, `deep` units into the pillar and open to the room on its other three sides, so the
 * pillar's own material stands over it.
 */
function recessRig(deep = 32, niche = 80): DoomMap {
  const map = mapWith([{ points: square(0, 0, 64) }], 2);
  map.sectors[1].ceilHeight = niche;
  map.sidedefs[1].sector = 1;
  const a = map.vertexes.push({ x: 64 + deep, y: -64 }) - 1;
  const b = map.vertexes.push({ x: 64 + deep, y: 64 }) - 1;
  const side = (sector: number): number =>
    map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;
  // Ring corner 1 is (64, -64) and corner 2 is (64, 64), so the niche hangs off the face between
  // them, wound with the room on each line's right.
  for (const [v1, v2] of [[1, a], [a, b], [b, 2]] as const) {
    map.linedefs.push({ v1, v2, flags: LF.TWO_SIDED, special: 0, tag: 0, right: side(0), left: side(1) });
  }
  return map;
}

  test('a niche cut into a structure does not set its lid', () => {
    // The wall facing into a switch alcove stops at the alcove's ceiling because the alcove is cut
    // into the structure, not because the structure ends there — DOOM1 E1M2's tower at
    // (-640…-592, 1056…1120), lidded at 80 inside itself and left an open box.
    // docs/render-solids.md.
    const caps = findSolidCaps(recessRig(), []);
    assert.equal(caps.length, 2, 'the lid, and a cap at the level the niche closes');
    assert.equal(caps[0].height, 128, 'the top its other three walls reach, not the niche\u2019s 80');
    assert.equal(caps[1].height, 80);
    assert.equal(caps[1].under, true, 'closing the box from inside the niche');
  });

  test('a level the structure merely leans over sets it as before', () => {
    // Too much material over it to be a niche: `POCKET_RISE`, the reach `pocketsOf` roofs one at.
    assert.equal(findSolidCaps(recessRig(32, 56), [])[0].height, 56);
    // And too little of its wall the structure's own: `POCKET_SHARE`, asked of the same shape.
    assert.equal(findSolidCaps(recessRig(512), [])[0].height, 80);
  });

  test('a face onto a sector with no height between floor and ceiling still sets the lid', () => {
    // A shut door, or the solid filler a mapper leaves between rooms, is not a level the structure
    // passes through. Counting one lifts the lid off the wall stubs welded into a level's own wall
    // network — DOOM1 E1M2's 97-line ring, roofed at 48 instead of the -16 it belongs at.
    // docs/render-solids.md.
    const map = mapWith([{ points: square(0, 0, 64) }], 3);
    // Two faces onto a ledge high enough to bury the closed sector between them...
    map.sectors[0].floorHeight = 128;
    map.sectors[0].ceilHeight = 300;
    map.sectors[1].floorHeight = 100;
    map.sectors[1].ceilHeight = 100;
    map.sidedefs[1].sector = 1;
    // ...and the fourth onto the ground the structure actually stands on.
    map.sectors[2].ceilHeight = 300;
    map.sidedefs[3].sector = 2;
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1, 'and it closes no level of its own: there is no wall there to close');
    assert.equal(caps[0].height, 100, 'not the 300 the ledges would lift it to');
    assert.equal(caps[0].sector, 1);
  });

  test('a structure whose lid would sit in the ground around it is left alone', () => {
    // One face onto a closed sector at ground level puts the lid at the floor, where it closes
    // nothing — and where a level's void shows it as a plate under the floors. DOOM1 E1M2's
    // 97-line ring is the case, at -16. docs/render-solids.md.
    const map = mapWith([{ points: square(0, 0, 64) }], 2);
    map.sectors[1].ceilHeight = 0;
    map.sidedefs[1].sector = 1;
    assert.deepEqual(findSolidCaps(map, []), []);
  });

  test('a ring standing entirely in closed sectors is left alone', () => {
    // Every face onto nothing at all: the lid would land on the floor it stands on.
    const map = mapWith([{ points: square(0, 0, 64) }]);
    map.sectors[0].floorHeight = 64;
    map.sectors[0].ceilHeight = 64;
    assert.deepEqual(findSolidCaps(map, []), []);
  });

  test('a lid carries a probe for every side of its ring', () => {
    // Fog of war reveals a cap by the leaves its probes land in, so every face has to offer one:
    // with only the longest edge's, a crate stays topless until the player walks behind it.
    // docs/render-solids.md.
    const map = mapWith([{ points: square(0, 0, 64) }]);
    const [cap] = findSolidCaps(map, []);
    assert.equal(cap.probes.length / 2, 4, 'one per edge');
    for (let i = 0; i < cap.probes.length; i += 2) {
      const x = cap.probes[i];
      const y = cap.probes[i + 1];
      assert.ok(!pointInPolygon(cap.points, x, y), `probe ${i / 2} is outside the ring`);
      assert.ok(Math.max(Math.abs(x), Math.abs(y)) <= 66, `probe ${i / 2} stays against the face`);
    }
  });

  test('a room’s own outer wall is not a structure', () => {
    // Same square wound the other way: now the sector is *inside* the ring.
    const map = mapWith([{ points: square(0, 0, 64), reversed: true }]);
    assert.deepEqual(findSolidCaps(map, []), []);
  });

  test('a ring enclosing floor is a building, and is left alone', () => {
    const map = mapWith([{ points: square(0, 0, 64) }]);
    // One subsector's worth of room inside the ring — a courtyard or a hall.
    const polys = [{ sector: 0, points: new Float64Array([-32, -32, -32, 32, 32, 32, 32, -32]) }];
    assert.deepEqual(findSolidCaps(map, polys), [], 'roofing this would bury the rooms inside it');
    // The same ring with the floor outside it is still a structure.
    const outside = [{ sector: 0, points: new Float64Array([512, 512, 512, 576, 576, 576, 576, 512]) }];
    assert.equal(findSolidCaps(map, outside).length, 1);
  });

  test('a footprint too large to be an object is left alone unless it ends at one height', () => {
    // 512 units square with one wall running higher: `MAX_CAP_AREA` over, so it is the level's own
    // wall mass, whose walls end at as many heights as the rooms around it have ceilings, and the
    // lid at the lowest of them is a plate through it. docs/render-solids.md.
    const mass = mapWith([{ points: square(0, 0, 256) }], 2);
    mass.sectors[1].ceilHeight = 200;
    mass.sidedefs[2].sector = 1;
    assert.deepEqual(findSolidCaps(mass, []), []);
    // The same mass with every wall ending at 128 is closed all round, and its size costs it
    // nothing: DOOM1 E1M6's two computer banks at (-224, -128) and (96, -128), 40,960 units² each.
    assert.equal(findSolidCaps(mapWith([{ points: square(0, 0, 256) }]), []).length, 1);
    // A crate's footprint is under the limit lip or no lip: 128 square is exactly `MAX_CAP_AREA`,
    // and the cut is exclusive.
    const crate = mapWith([{ points: square(0, 0, 64) }], 2);
    crate.sectors[1].ceilHeight = 200;
    crate.sidedefs[2].sector = 1;
    assert.equal(findSolidCaps(crate, []).length, 1);
  });

  test('a structure welded to other geometry is lidded from its own void face', () => {
    const map = mapWith([{ points: square(0, 0, 64) }]);
    // A stub line off the (-64, 64) corner: that vertex now joins three one-sided
    // lines, so which one continues the pillar's outline is a real choice. The
    // simple walk gives up here; the void face keeps to the pillar by taking the
    // rightmost turn — the stub is the leftward one, 154° against the corner's 90°.
    const v = map.vertexes.push({ x: 200, y: -64 }) - 1;
    const side = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: WALL, sector: 0 }) - 1;
    map.linedefs.push({ v1: 3, v2: v, flags: 0, special: 0, tag: 0, right: side, left: NO_SIDE });

    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1, 'the weld no longer costs the structure its lid');
    assert.equal(caps[0].points.length / 2, 4, 'and the lid is the pillar itself, not a walk off down the stub');
    assert.ok(pointInPolygon(caps[0].points, 0, 0));
  });

  test('an open chain of one-sided lines is still left alone', () => {
    // Two lines meeting at a corner and going nowhere: no face to close, so
    // there is nothing to lid and nothing to guess at.
    const map = mapWith([{ points: square(0, 0, 64) }]);
    map.linedefs.length = 2;
    assert.deepEqual(findSolidCaps(map, []), []);
  });

/**
 * Three crate blocks on a platform Q around a nook P, P opening onto the room R: sector 0 = R,
 * 1 = P (floor 0, ceiling 64, ceiling `CRATOP1`), 2 = Q (floor 64). The blocks are rings 0..2 —
 * west, east and north of P — each wound with its front outside, sides numbered bottom/east/top/
 * west from `square`, and their faces toward P are the buried ones.
 */
function pocketRig(): { map: DoomMap; opening: number; a: number; b: number } {
  const map = mapWith(
    [
      { points: square(32, 96, 32), sector: 2 },
      { points: square(160, 96, 32), sector: 2 },
      { points: square(96, 160, 32), sector: 2 },
    ],
    3,
  );
  map.sectors[1].ceilHeight = 64;
  map.sectors[1].ceilTex = 'CRATOP1';
  map.sectors[2].floorHeight = 64;
  map.sidedefs[0 * 4 + 1].sector = 1; // west block, east face
  map.sidedefs[1 * 4 + 3].sector = 1; // east block, west face
  map.sidedefs[2 * 4 + 0].sector = 1; // north block, south face
  // P's opening onto R, two-sided: R on the right of (64,64)->(128,64), P on the left.
  const a = map.vertexes.push({ x: 64, y: 64 }) - 1;
  const b = map.vertexes.push({ x: 128, y: 64 }) - 1;
  const toR = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector: 0 }) - 1;
  const toP = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector: 1 }) - 1;
  const opening = map.linedefs.push({ v1: a, v2: b, flags: LF.TWO_SIDED, special: 0, tag: 0, right: toR, left: toP }) - 1;
  // R has an outer wall of its own, so it is a room, not a pocket.
  const c = map.vertexes.push({ x: 0, y: -64 }) - 1;
  const d = map.vertexes.push({ x: 192, y: -64 }) - 1;
  const outer = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: WALL, sector: 0 }) - 1;
  map.linedefs.push(wall(c, d, outer));
  return { map, opening, a, b };
}

  test('a pocket in a structure is roofed at the lid, in the flat its ceiling names', () => {
    // A nook P (floor 0, ceiling 64, ceiling `CRATOP1`) walled on three sides by crate blocks whose
    // other faces stand on a platform Q (floor 64): the crates' faces toward P are buried, P's
    // fourth side opens onto the room R. From above P is not a hole showing its floor but part of
    // the stack's top face — roofed at the blocks' own lid height, 128, and `CRATOP1` is what the
    // mapper says that top looks like, so the lids wear it too. docs/render-solids.md.
    const { map, opening, a, b } = pocketRig();

    const caps = findSolidCaps(map, []);
    const lids = caps.filter((cap) => !cap.under);
    assert.equal(lids.length, 3, 'three blocks, three lids');
    assert.equal(lids[0].height, 128, 'each lid stands clear of the nook it walls');
    const { roofs, lidFlat } = pocketsOf(map, [], caps);
    assert.deepEqual([...roofs.keys()], [1], 'P alone is a pocket — R has a wall of its own, Q too');
    assert.equal(roofs.get(1)!.lightSector, 2, 'lit by the sector the lid around it takes its light from');
    // Q lights the roof, not P: the roof is the stack's top, and P is dim because it is the shade
    // under it — so P's light is left to P's own floor.
    map.sectors[1].light = 112;
    map.sectors[2].light = 144;
    assert.deepEqual(
      pocketsOf(map, [], caps).roofs.get(1),
      { height: 128, flat: 'CRATOP1', lightSector: 2 },
      'roofed at the lid, in P’s ceiling flat, under Q’s light',
    );
    assert.equal(new Set(lidFlat.values()).size, 1, 'and every lid around it wears that flat');

    // Through the mesh: P as one leaf of four segs, which is all `buildSubSectorPolys` needs. A
    // seg keeps its sector on its right, so the loop runs clockwise: along each crate face in the
    // linedef's own direction (P is its front), and back along the opening against it (P is its
    // back).
    const lineAt = (ring: number, side: number) => ring * 4 + side;
    const along = (line: number) => seg(map.linedefs[line].v1, map.linedefs[line].v2, line);
    map.segs = [
      along(lineAt(0, 1)), // west face, (64,64) -> (64,128)
      along(lineAt(2, 0)), // north face, (64,128) -> (128,128)
      along(lineAt(1, 3)), // east face, (128,128) -> (128,64)
      seg(b, a, opening, 1),
    ];
    map.subsectors = [{ first: 0, count: 4 }];
    const built = buildMapMesh(map, BANK, {});
    // The leaf's own fans — a cap carries `revealedBy`, a leaf's fan never does.
    const roof = built.flatSurfaces.filter((f) => f.sector === 1 && f.texName === 'CRATOP1' && f.revealedBy === undefined);
    assert.ok(roof.length > 0, 'P is roofed');
    for (const fan of roof) {
      assert.equal(fan.height, 128, 'flush with the lids around it, not sunk to P’s own ceiling');
      assert.equal(fan.isCeiling, false, 'facing up: it is a top seen from above');
    }
    // And the lids themselves, over the blocks' own footprints, wear the same flat.
    const lidFans = built.flatSurfaces.filter((f) => f.height === 128 && f.revealedBy !== undefined);
    assert.ok(lidFans.length > 0, 'the blocks are lidded');
    for (const fan of lidFans) {
      assert.equal(fan.texName, 'CRATOP1', 'the crate top the nook’s ceiling names, not the wall texture');
    }
    // A cap under a lid is seen from nowhere but the level it closes, so it wears that level's own
    // ceiling flat rather than the ring's wall texture (docs/render-solids.md).
    const underFans = built.flatSurfaces.filter((f) => f.height === 64 && f.revealedBy !== undefined);
    assert.ok(underFans.length > 0, 'the blocks are closed at the nook’s level too');
    for (const fan of underFans) {
      assert.equal(fan.texName, 'CRATOP1', 'the level’s own ceiling flat');
      assert.ok(fan.key.startsWith('flat:'), 'drawn as a flat, not as the ring’s wall texture');
    }
    assert.ok(
      built.flatSurfaces.some((f) => f.sector === 1 && f.texName === 'FLOOR0_1' && f.height === 0),
      'and its floor is still there underneath, for whoever walks in',
    );
  });

  test('a nook is roofed only where the structure beside it has material over it', () => {
    // A lid far above the nook's ceiling belongs to a tower it merely leans on, not to a stack it
    // is cut into (freedoom2 MAP17's sector 83, 336 under one), and a roof may never reach past
    // the ceiling the nook opens onto or it hides the room next door.
    // docs/render-solids.md.
    const tall = pocketRig();
    tall.map.sectors[0].ceilHeight = 300; // R, so the opening is not what refuses it
    tall.map.sectors[2].ceilHeight = 300; // Q, lifting the blocks' lid to 300 over a 64 ceiling
    assert.deepEqual([...pocketsOf(tall.map, [], findSolidCaps(tall.map, [])).roofs.keys()], []);

    const low = pocketRig();
    low.map.sectors[0].ceilHeight = 96; // R, under the blocks' lid at 128
    assert.deepEqual([...pocketsOf(low.map, [], findSolidCaps(low.map, [])).roofs.keys()], []);

    // The nook itself is unchanged in both: with the room back at the lid it is a pocket again.
    const ok = pocketRig();
    assert.deepEqual([...pocketsOf(ok.map, [], findSolidCaps(ok.map, [])).roofs.keys()], [1]);
  });

  test('lids reach the geometry as fadeable, fog-aware flat surfaces', () => {
    // A real map: DOOM1 E1M1's pillars, through the whole builder.
    // `doom1_e1m1.wad` is that map's own lumps and nothing else, so it loads
    // with no IWAD behind it — the mesh builder never looks a texture up.
    const map = loadMap(new Wad([fixtureWad('doom1_e1m1.wad')]), 'E1M1');
    const caps = findSolidCaps(map, buildSubSectorPolys(map));
    assert.ok(caps.length > 0, 'E1M1 has solid structures');
    // A ring is traced from an arbitrary direction, so every footprint must
    // come out counter-clockwise: wound the other way the lid faces down, is
    // culled, and the hole it exists to close stays open.
    for (const cap of caps) {
      let area = 0;
      const n = cap.points.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += cap.points[i * 2] * cap.points[j * 2 + 1] - cap.points[j * 2] * cap.points[i * 2 + 1];
      }
      assert.ok(area > 0, 'lid footprint faces up');
    }
    // None of them may sit over a thing: that would mean a room got roofed.
    for (const cap of caps) {
      for (const thing of map.things) {
        assert.ok(!pointInPolygon(cap.points, thing.x, thing.y), `lid over thing ${thing.type}`);
      }
    }

    const built = buildMapMesh(map, BANK, {});
    const lids = built.flatSurfaces.filter((f) => f.key.startsWith('wall:'));
    assert.ok(lids.length >= caps.length, 'every lid is emitted, one surface per triangle');
    for (const lid of lids) {
      assert.equal(lid.points.length, 6, 'triangles only — FlatFader’s footprint test is convex-only');
      assert.ok(built.flatMeshes.has(lid.key), 'and its mesh is reachable as a flat');
    }

    // Anchored to the structure, not to the world grid: a lid starts at its own
    // footprint's west edge, at the texture row its wall shows where the lid
    // sits (docs/render-solids.md).
    let anchored = 0;
    for (const lid of lids) {
      const midX = (lid.vertexXY[0] + lid.vertexXY[2] + lid.vertexXY[4]) / 3;
      const midY = (lid.vertexXY[1] + lid.vertexXY[3] + lid.vertexXY[5]) / 3;
      const cap = caps.find((c) => c.height === lid.height && pointInPolygon(c.points, midX, midY));
      if (!cap) continue;
      const line = map.linedefs[cap.line];
      const side = map.sidedefs[line.right];
      // `BANK` hands back 64x128 for every texture, which is what these expectations are in.
      const own = map.sectors[side.sector];
      const pegRef: number = (line.flags & LF.LOWER_UNPEGGED) !== 0 ? own.floorHeight + 128 : own.ceilHeight;
      let minX: number = Infinity;
      let maxY: number = -Infinity;
      for (let i = 0; i < cap.points.length; i += 2) {
        minX = Math.min(minX, cap.points[i]);
        maxY = Math.max(maxY, cap.points[i + 1]);
      }
      const uv = built.flatMeshes.get(lid.key)!.geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < lid.vertexCount; i++) {
        const x = lid.vertexXY[i * 2];
        const y = lid.vertexXY[i * 2 + 1];
        assert.ok(Math.abs(uv.getX(lid.vertexStart + i) - (x - minX) / 64) < 1e-3, 'u starts at the footprint');
        const row: number = maxY + pegRef - cap.height + side.yOffset - y;
        assert.ok(Math.abs(uv.getY(lid.vertexStart + i) - row / 128) < 1e-3, 'v continues the wall’s own peg');
      }
      anchored++;
    }
    assert.ok(anchored > 0, 'and that was checked against a real lid');

    // A cap belongs to no leaf of its own, so it is revealed by the leaves around its ring rather
    // than by one subsector (docs/render-solids.md) — its own among them.
    const lidsWithReveal = lids.filter((lid) => lid.revealedBy !== undefined);
    assert.equal(lidsWithReveal.length, lids.length, 'every lid says what reveals it');
    assert.ok(
      lids.some((lid) => (lid.revealedBy?.length ?? 0) > 1),
      'and a structure with several sides is revealed by more than one leaf',
    );
    for (const lid of lids) {
      assert.ok(lid.revealedBy!.includes(lid.subsector), 'the fan’s own subsector is one of them');
    }

    // Fog of war must be able to hide one: it is written through the same
    // vertex alpha every other flat uses.
    const fader = new FlatFader(built.flatSurfaces, built.flatMeshes);
    const lid = lids[0];
    const attr = built.flatMeshes.get(lid.key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
    fader.commit(() => 0);
    assert.equal(attr.getW(lid.vertexStart), 0, 'unseen: hidden');
    fader.commit(() => 1);
    assert.equal(attr.getW(lid.vertexStart), 1, 'seen: drawn');
  });
});

describe('Rendering · blocks built out of a sector', () => {
  /**
   * A roomless sector — floor at or above ceiling — is solid material, and the level around it
   * carries it on up to its own ceiling in an upper texture. GoingDown.wad MAP08's sector 1 is the
   * case. See docs/render-solids.md § Blocks built out of a sector.
   */
  const RAISED = { B: { floor: 64, ceil: 64 }, F: { floor: 0, ceil: 0 }, p: { floor: 0, ceil: 64 } };

  function blocks(art: readonly string[]) {
    const { map } = gridMap(art, { heights: RAISED });
    return { map, caps: findSolidBlocks(map) };
  }

  test('a roomless sector standing above the ground beside it is capped at the level’s ceiling', () => {
    const { map, caps } = blocks(['...', '.B.', '...']);
    assert.equal(caps.length, 1, 'one cap, whatever the leaves under it');
    const [cap] = caps;
    assert.equal(cap.height, 128, 'at the lowest ceiling the level around it carries');
    assert.equal(cap.flat, 'CEIL1_1', 'wearing its own ceiling flat, which nothing in the level sees');
    assert.ok(cap.probes.length > 0, 'and revealed from outside, never by its own leaf');
    assert.equal(blockCapHeight(map, cap), 128, 'the height a rebuild re-decides is the same one');
  });

  test('a block keeps its cap while the material over it stands', () => {
    // What holds a top up is the material over the block, not its floor. A lift that drops a
    // crate's floor opens a nook under material that has not moved — GoingDown.wad MAP08's crate at
    // (-352, -272), the secret hidden in one; the ceiling rising to the level's own is what ends
    // it, which is what Literalism MAP18's `40` does beside the `38`/`219` under its pillars.
    const { map, caps } = blocks(['...', '.B.', '...']);
    const block = map.sectors.findIndex((s) => s.floorHeight === 64);
    map.sectors[block].floorHeight = 0;
    assert.equal(blockCapHeight(map, caps[0]), 128, 'the floor dropped; the crate above it did not');
    map.sectors[block].ceilHeight = 128;
    assert.equal(blockCapHeight(map, caps[0]), null, 'the ceiling reaches the level’s own: no material left');
    map.sectors[block].ceilHeight = 64;
    map.sectors[block].floorHeight = 64;
    assert.equal(blockCapHeight(map, caps[0]), 128, 'and the top comes back when the crate does');
  });

  test('one level with the floor around it is a shut door, and is not capped', () => {
    assert.deepEqual(blocks(['...', '.F.', '...']).caps, [], 'nothing to stand on top of');
  });

  test('one carrying a wall of its own is the doorway that wall belongs to', () => {
    // The corner cell's north and west edges are the map's own outer wall.
    assert.deepEqual(blocks(['B..', '...', '...']).caps, [], 'a door sits in a wall; a crate does not');
  });

  test('a sector sealed inside a block is capped with it', () => {
    // MAP08's crate in miniature: a light well the crate closes over, whose own ceiling is under
    // the block's floor. Capping the ring alone would leave the top a hole.
    const { map } = gridMap(['.....', '.BBB.', '.BpB.', '.BBB.', '.....'], { heights: RAISED });
    const sealed = map.sectors.findIndex((s) => s.floorHeight === 0 && s.ceilHeight === 64);
    map.sectors[sealed].ceilTex = 'CRATOP1';
    for (const sector of map.sectors) {
      if (sector.floorHeight >= sector.ceilHeight) sector.ceilTex = 'RROCK14';
    }
    const caps = findSolidBlocks(map);
    assert.equal(caps.length, 1, 'the well and the ring around it are one structure');
    assert.ok(caps[0].sectors.has(sealed), 'the well is capped');
    assert.equal(caps[0].height, 128, 'at the block’s own height, not at the well’s ceiling');
    // The well's ceiling is the block's underside, and the only drawing of this block there is —
    // it beats the block's own ceiling, which is the room's flat carried in.
    assert.equal(caps[0].flat, 'CRATOP1', 'wearing what the block stands over');
  });

  test('a block with one sector on a lift is mover-owned whole', () => {
    // GoingDown.wad MAP08's crate at (-352, -272): an 8-unit rim on a lift around a light well
    // that carries no tag. Leaving the well in the static batches kept its lid over the pit the
    // rim had just opened. docs/render-solids.md § Blocks built out of a sector.
    const { map } = gridMap(['.....', '.BBB.', '.BpB.', '.BBB.', '.....'], { heights: RAISED });
    const rim = map.sectors.findIndex((s) => s.floorHeight === 64);
    const blocks = movableBlocks(map, new Set([rim]));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].length, 9, 'the eight rim cells and the well sealed inside them');
    assert.deepEqual(movableBlocks(map, new Set()), [], 'and a block no special drives is left alone');
  });

  test('a nook under a block is a pocket, roofed at the block’s top', () => {
    // GoingDown.wad MAP08's sector 257: an 8-unit slot open to the room, its ceiling under the
    // block's floor and the block's material running on over it. The face between them is what a
    // ring's buried face is to `pocketsOf`, and the slot is roofed flush with the block's cap.
    // 64-unit cells: a nook is small, and `POCKET_AREA` says so.
    const { map } = gridMap(['...', '.Bp', '...'], { heights: RAISED, cell: 64 });
    const nook = map.sectors.findIndex((s) => s.floorHeight === 0 && s.ceilHeight === 64);
    map.sectors[nook].ceilTex = 'CRATOP2';
    const polys = buildSubSectorPolys(map);
    const caps = findSolidBlocks(map);
    const { roofs } = pocketsOf(map, polys, caps);
    assert.deepEqual(roofs.get(nook), { height: 128, flat: 'CRATOP2', lightSector: caps[0].lightSector });
  });

  test('a chamber reaching over the block around it is not sealed inside it', () => {
    // Asked of the whole region: `q` meets the block and is under its floor, but `r` is nested
    // inside `q` and its ceiling rises past it. Sunder MAP07's sector 13 is the case, and
    // GoingDown.wad MAP09's library the one this keeps out — a wall ring around a room.
    const art = ['.......', '.BBBBB.', '.BqqqB.', '.BqrqB.', '.BqqqB.', '.BBBBB.', '.......'];
    const heights = { ...RAISED, q: { floor: 0, ceil: 64 }, r: { floor: 0, ceil: 64 } };
    const sealed = gridMap(art, { heights }).map;
    assert.ok(findSolidBlocks(sealed).length > 0, 'all of it under the block');

    const open = gridMap(art, { heights: { ...heights, r: { floor: 0, ceil: 96 } } }).map;
    assert.deepEqual(findSolidBlocks(open), [], 'the middle reaches past it');
  });

  test('a block a mover sinks takes its cap with it', () => {
    // Why a block's cap is drawn from its leaves rather than baked with the ring lids: Literalism
    // MAP18's 140 pillars all sink during play, and a cap left at the height the level loaded
    // with would hang 600 units over the floor they uncover. docs/render.md § Mover meshes.
    const grid = gridMap(['...', '.B.', '...'], { heights: RAISED });
    const map = grid.map;
    // An unset texture slot draws no quad, and a mover with no walls has nothing to refuse over.
    for (const side of map.sidedefs) {
      side.upper = WALL;
      side.lower = WALL;
      side.middle = WALL;
    }
    const sector = grid.index(1, 1);
    const polys = buildSubSectorPolys(map);
    const mover = {
      map,
      polys,
      bank: BANK,
      options: { movableSectors: new Set([sector]) },
      index: buildMoverIndex(map, polys),
    };
    const mesh = buildMoverMesh(mover, sector);
    assert.ok(
      mesh.flatFans.some((fan) => fan.height === 128),
      'the block’s top is the mover’s own geometry, not the static batch’s',
    );

    // The sink: the floor drops to the ground beside it and the ceiling rises to the level's own,
    // which is the pair Literalism MAP18 puts under each cluster.
    map.sectors[sector].floorHeight = 0;
    map.sectors[sector].ceilHeight = 128;
    assert.equal(refreshMoverMesh(mesh, mover, sector), false, 'a cap that has to go is no mere height change');
    assert.deepEqual(
      buildMoverMesh(mover, sector).flatFans.filter((fan) => fan.height === 128),
      [],
      'and the rebuild leaves none',
    );
  });

  test('a block whose outside is more than one loop is the level’s wall mass', () => {
    // The well now has a wall of its own, so it is a room the ring runs around rather than
    // something sealed inside it — GoingDown.wad MAP26's sector 257 at scale.
    const { map } = gridMap(['.....', '.BBB.', '.BpB.', '.BBB.', '.....'], { heights: RAISED });
    const well = map.sectors.findIndex((s) => s.floorHeight === 0 && s.ceilHeight === 64);
    const a = map.vertexes.push({ x: 0, y: -512 }) - 1;
    const b = map.vertexes.push({ x: 64, y: -512 }) - 1;
    const side = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: WALL, sector: well }) - 1;
    map.linedefs.push(wall(a, b, side));
    assert.deepEqual(findSolidBlocks(map), [], 'capping it would fill the walls in');
  });
});
