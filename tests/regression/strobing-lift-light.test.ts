import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { SpecialsController } from '../../src/game/specials.ts';
import { computeMovableSectors } from '../../src/game/specials/mapscan.ts';
import { buildMapMesh, litColor } from '../../src/render/mapmesh.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import type { Input } from '../../src/game/input.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A sector that both strobes and moves has its geometry in its own mover mesh,
 * not the static batch `recolorSector` was originally limited to — so its light
 * pattern only ever showed while it happened to be moving (a height change
 * rebuilds the mesh from the live `sector.light` anyway). Reported against
 * DOOM1 E1M5 sectors 2 and 32, the tag-1 strobing lifts; reproduced here on
 * synthetic geometry. See docs/specials.md § Light changes.
 */

/** `buildMoverMesh` only asks a bank for texture sizes and materials — neither needs a GPU. */
const BANK = {
  size: () => ({ w: 64, h: 128 }),
  get: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialBank;

const NO_INPUT = { pressed: () => false, rightMousePressed: () => false } as unknown as Input;

const BASE_LIGHT = 192;
const NEIGHBOR_LIGHT = 160; // gridMap's default, and so the strobe's dark level

/** Vertex colours are a Float32 attribute, so compare against the rounded value. */
const expected = (light: number) => new Set([Math.fround(litColor(light))]);

/** Every RGB value in `group`'s flat batches — the lift's own floor, nothing else. */
function flatColors(group: THREE.Object3D): number[] {
  const out: number[] = [];
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.name.startsWith('flat:')) return;
    const attr = obj.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < attr.count; i++) out.push(attr.getX(i), attr.getY(i), attr.getZ(i));
  });
  return out;
}

function strobingLift() {
  const grid = gridMap(['#####', '#...#', '#####']);
  const map = grid.map;
  const lift = grid.index(2, 1);
  // Sector type 2 is vanilla's fast strobe; the tag plus a lift line is what
  // puts this sector in `computeMovableSectors` and thus in a mover mesh.
  map.sectors[lift].special = 2;
  map.sectors[lift].tag = 1;
  map.sectors[lift].light = BASE_LIGHT;
  map.linedefs[0].special = 88; // WR lift, tag-matched — never triggered here
  map.linedefs[0].tag = 1;

  const world = new World(map);
  const movableSectors = computeMovableSectors(map);
  assert.ok(movableSectors.has(lift), 'the strobing sector is a mover');

  const built = buildMapMesh(map, BANK, { movableSectors });
  const scene = new THREE.Group();
  const start = grid.centre(1, 1);
  const fog = new FogOfWar(world, built.occluders, start.x, start.y);
  const specials = new SpecialsController(
    map,
    world,
    BANK,
    scene,
    fog,
    built.polys,
    built,
    {},
    () => {},
    () => {},
    () => false,
    () => false,
    () => false,
    start.x,
    start.y,
    movableSectors,
  );

  // The player never moves and never presses use, so nothing triggers the lift:
  // this test is about the sector's light while its geometry sits still.
  const tick = (dt: number) => specials.update(dt, start.x, start.y, 0, NO_INPUT, new Set());
  return { map, lift, scene, tick };
}

describe('Regressions · strobing lift light', () => {
  test('a strobing sector that is also a mover relights while standing still', () => {
    const { map, lift, scene, tick } = strobingLift();

    assert.deepEqual(
      new Set(flatColors(scene)),
      expected(BASE_LIGHT),
      'built at the sector’s own light',
    );

    // blink05 starts bright with an expired timer, so the first tick flips it
    // to the darkest neighbour's level.
    tick(1 / 35);
    assert.equal(map.sectors[lift].light, NEIGHBOR_LIGHT, 'the strobe went dark');
    assert.deepEqual(
      new Set(flatColors(scene)),
      expected(NEIGHBOR_LIGHT),
      'and the mover geometry followed it',
    );
  });

  test('the vertex alpha the faders own is left alone by a relight', () => {
    const { scene, tick } = strobingLift();
    const alphas = () => {
      const out: number[] = [];
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const attr = obj.geometry.getAttribute('color') as THREE.BufferAttribute;
        for (let i = 0; i < attr.count; i++) out.push(attr.getW(i));
      });
      return out;
    };
    const before = alphas();
    tick(1 / 35);
    assert.deepEqual(alphas(), before);
  });
});
