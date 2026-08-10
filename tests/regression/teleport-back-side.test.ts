import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { SpecialsController } from '../../src/game/specials.ts';
import { computeMovableSectors } from '../../src/game/specials/mapscan.ts';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import type { Input } from '../../src/game/input.ts';
import type { Placement } from '../../src/types.ts';
import { NO_SIDE } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { ThingType } from '../../src/game/thingtypes.ts';

/**
 * `EV_Teleport` ignores a crossing that came from the back of the line, "so you
 * can get out of teleporter" — without it, stepping off the pad you just landed
 * on crosses that pad's own teleport line and bounces you straight back.
 * Reported against freedoom2 MAP01's tag-3/tag-5 pair (sectors 167 and 133),
 * reproduced here on synthetic geometry. See docs/specials.md § Teleporters.
 */

const BANK = {
  size: () => ({ w: 64, h: 128 }),
  get: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialBank;

const NO_INPUT = { pressed: () => false, rightMousePressed: () => false } as unknown as Input;

const WR_TELEPORT = 97;

/** The one linedef with `front` on its right side and `back` on its left. */
function edgeBetween(map: ReturnType<typeof gridMap>['map'], front: number, back: number): number {
  for (let i = 0; i < map.linedefs.length; i++) {
    const l = map.linedefs[i];
    if (l.left === NO_SIDE) continue;
    if (map.sidedefs[l.right].sector === front && map.sidedefs[l.left].sector === back) return i;
  }
  throw new Error(`no linedef with front sector ${front} and back sector ${back}`);
}

/**
 * A corridor of five cells with a teleport pad at cell 2 and another at cell 4,
 * each sending the player to the other. Both pads carry their teleport special
 * on their *west* boundary only, which the grid fixture winds with the western
 * (corridor) cell on the front side — so walking east onto a pad is a
 * front-side crossing and walking back west off it is a back-side one.
 */
function setup() {
  const padACell = 2;
  const padBCell = 4;
  const grid = gridMap(['#######', '#.....#', '#######'], {
    things: [],
  });
  const map = grid.map;
  const padA = grid.index(padACell, 1);
  const padB = grid.index(padBCell, 1);
  map.sectors[padA].tag = 1;
  map.sectors[padB].tag = 2;
  map.things.push(
    { ...grid.centre(padACell, 1), angle: 0, type: ThingType.teleportDest, flags: 7 },
    { ...grid.centre(padBCell, 1), angle: 0, type: ThingType.teleportDest, flags: 7 },
  );

  const intoA = edgeBetween(map, grid.index(padACell - 1, 1), padA);
  const intoB = edgeBetween(map, grid.index(padBCell - 1, 1), padB);
  map.linedefs[intoA].special = WR_TELEPORT;
  map.linedefs[intoA].tag = 2; // pad A sends you to pad B
  map.linedefs[intoB].special = WR_TELEPORT;
  map.linedefs[intoB].tag = 1;

  const world = new World(map);
  const built = buildMapMesh(map, BANK, { movableSectors: computeMovableSectors(map) });
  const start = { x: grid.centre(padACell, 1).x - 70, y: grid.centre(padACell, 1).y };
  const fog = new FogOfWar(world, built.occluders, start.x, start.y);
  const teleports: Placement[] = [];
  const specials = new SpecialsController(
    map,
    world,
    BANK,
    new THREE.Group(),
    fog,
    built.polys,
    built,
    {},
    () => {},
    (dest) => teleports.push(dest),
    () => {},
    () => false,
    () => false,
    start.x,
    start.y,
  );

  /** One frame of the player standing at (x, y) — the same call `game.ts` makes. */
  const tick = (x: number, y: number) => specials.update(1 / 35, x, y, 0, NO_INPUT, new Set());
  return { grid, teleports, tick, start, padBCentre: grid.centre(padBCell, 1) };
}

describe('Regressions · teleport back side', () => {
  test('walking off the pad you landed on does not teleport you back', () => {
    const { grid, teleports, tick, start, padBCentre } = setup();
    const boundary = grid.centre(4, 1).x - grid.cell / 2; // pad B's west edge

    // Step east onto pad A: a front-side crossing, so it fires and lands us on pad B.
    tick(start.x + 12, start.y);
    assert.equal(teleports.length, 1, 'walking onto the pad teleports');
    assert.deepEqual({ x: teleports[0].x, y: teleports[0].y }, padBCentre, 'landed on the other pad');

    // `game.ts` moves the player to the landing spot; now step back west off it,
    // crossing pad B's own teleport line from the back.
    tick(boundary + 18, padBCentre.y);
    tick(boundary - 6, padBCentre.y);
    assert.equal(teleports.length, 1, 'stepping off the landing pad does not re-teleport');
  });

  test('a front-side crossing still teleports', () => {
    const { grid, teleports, tick } = setup();
    const boundary = grid.centre(4, 1).x - grid.cell / 2;

    // Approach pad B from the west, the side its line faces.
    tick(boundary - 18, grid.centre(4, 1).y);
    tick(boundary + 6, grid.centre(4, 1).y);
    assert.equal(teleports.length, 1, 'pad B fired');
    assert.deepEqual({ x: teleports[0].x, y: teleports[0].y }, grid.centre(2, 1), 'landed on pad A');
  });
});
