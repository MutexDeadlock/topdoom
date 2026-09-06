/**
 * The thing grid's per-cell skip against the sweep it replaces: after bodies have walked and
 * teleported since the rebuild, every query still answers exactly as the unskipped scan would, in
 * the same order. docs/monster-ai.md § Spatial indexing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { AIM_SLOPE_LIMIT, type MonsterRef } from '../../src/game/things/defs.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { blastDistanceToBox, segmentEntersBox, traceHitsBox } from '../../src/util/geom.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import type { Pos3 } from '../../src/types.ts';

const CELL = 128;
const SIZE = 24;
/** Wide enough to cover the whole map: nothing is ever skipped, so this is the plain scan. */
const EVERYTHING = 1e9;
const TICS = 90;
/**
 * The tics a monster is teleported on, and how far: further than any tic's step, so the cell the
 * grid filed it in can be skipped by a query at its landing, yet inside that query's search box —
 * a hop the unskipped sweep, which visits by filed cell, still finds.
 */
const TELEPORT_TICS = new Set([30, 60]);
const HOP = 170;

const TYPES = [ThingType.imp, ThingType.demon, ThingType.cacodemon, ThingType.zombieman, ThingType.cyberdemon, ThingType.spiderMastermind];

function scene(): { things: ThingLayer; player: Pos3 } {
  const art: string[] = ['#'.repeat(SIZE)];
  for (let r = 1; r < SIZE - 1; r++) art.push('#' + '.'.repeat(SIZE - 2) + '#');
  art.push('#'.repeat(SIZE));
  const grid = gridMap(art, { cell: CELL });
  let n = 0;
  for (let r = 2; r < SIZE - 2; r += 2) {
    for (let c = 2; c < SIZE - 2; c += 2) {
      // Every other spot stays empty, so the crowd has room to walk and bump.
      if ((r * 3 + c) % 5 === 0) continue;
      grid.map.things.push(thingAt(grid, c, r, TYPES[n % TYPES.length]));
      n++;
    }
  }
  const world = new World(grid.map);
  const things = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
  const start = grid.centre(1, 1);
  return { things, player: { x: start.x, y: start.y, z: 0 } };
}

/** Every living, shootable body, in grid order — the unskipped sweep. */
function all(things: ThingLayer): MonsterRef[] {
  return things.monstersNear({ x: 0, y: 0 }, EVERYTHING);
}

function ids(refs: readonly MonsterRef[]): number[] {
  return refs.map((m) => m.id);
}

function nearestByScan(refs: readonly MonsterRef[], origin: Pos3, angle: number, maxDist: number): { id: number; dist: number } | null {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let nearest: { id: number; dist: number } | null = null;
  for (const m of refs) {
    const t = traceHitsBox(origin.x, origin.y, dx, dy, m.x, m.y, m.radius);
    if (t === null || t > maxDist || (nearest && t >= nearest.dist)) continue;
    const dist = Math.max(t, 1e-6);
    if ((m.z + m.height - origin.z) / dist < -AIM_SLOPE_LIMIT) continue;
    if ((m.z - origin.z) / dist > AIM_SLOPE_LIMIT) continue;
    nearest = { id: m.id, dist: t };
  }
  return nearest;
}

describe('Thing grid · the per-cell skip answers exactly as the unskipped sweep', () => {
  test('box, step and ray queries agree with a plain scan every tic, teleports included', () => {
    const { things, player } = scene();
    const everyone = all(things);
    assert.ok(everyone.length >= 80, `a crowd, not a handful: ${everyone.length}`);
    for (const m of everyone) things.damage(m.id, 1); // wake the lot, all chasing the corner
    const teleported = everyone[0].id;
    let landing: Pos3 | null = null;
    for (let tic = 1; tic <= TICS; tic++) {
      landing = null;
      things.update(DOOM_TIC, player, undefined, (_prev, mover) => {
        if (!TELEPORT_TICS.has(tic) || mover.id !== teleported) return null;
        landing = { x: mover.x + HOP, y: mover.y, z: 0 };
        return { x: landing.x, y: landing.y, angle: 0 };
      });
      const refs = all(things);
      // Box queries, centred on bodies and on fixed points, at three radii. On a teleport tic the
      // body-centred ones stay out: the sweep files the hopped body where it stood, and a centre
      // on the far side of its landing could have that cell outside the box but the body in range.
      const middle: Pos3 = { x: CELL * 12, y: CELL * 12, z: 0 };
      const centres: Pos3[] = landing ? [player, middle, landing] : [player, middle, ...refs.slice(0, 6)];
      for (const c of centres) {
        for (const radius of [40, 128, 300]) {
          const expected = refs.filter((m) => blastDistanceToBox(c.x, c.y, m.x, m.y, m.radius) < radius);
          assert.deepEqual(ids(things.monstersNear(c, radius)), ids(expected), `monstersNear tic ${tic}`);
        }
        const to = { x: c.x + 40, y: c.y + 24, z: c.z };
        const expectedStep = refs.filter((m) => segmentEntersBox(c.x, c.y, to.x, to.y, m.x, m.y, m.radius + 11) !== null);
        assert.deepEqual(ids(things.monstersAlongStep(c, to, 11)), ids(expectedStep), `monstersAlongStep tic ${tic}`);
      }
      // Rays across the crowd from the corner and from the middle.
      for (const origin of [player, middle]) {
        for (let k = 0; k < 8; k++) {
          const angle = (k * Math.PI) / 4 + 0.1;
          const hit = things.raycastMonster(origin, angle, 2048, { includeHidden: true });
          const expected = nearestByScan(refs, origin, angle, 2048);
          assert.deepEqual(hit ? { id: hit.id, dist: hit.dist } : null, expected, `raycastMonster tic ${tic}`);
        }
      }
      if (landing) {
        const at = landing as Pos3;
        const near = things.monstersNear(at, 64);
        assert.ok(near.some((m) => m.id === teleported), `the teleported body is found where it landed, tic ${tic}`);
      }
    }
  });
});
