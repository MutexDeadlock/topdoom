import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { SpecialsController } from '../../src/game/specials.ts';
import { computeMovableSectors } from '../../src/game/specials/mapscan.ts';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import type { Input } from '../../src/game/input.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * Two rules a crusher-and-switch pair has to keep, both confirmed against
 * `linuxdoom-1.10` rather than the wiki:
 *
 * - `P_UseSpecialLine` flips a switch (and spends a one-shot line) only when its
 *   EV_ call reported it did something. A no-op press that consumed the line
 *   left an S1 switch dead for the rest of the level.
 * - `EV_CeilingCrushStop` saves `olddirection` and `P_ActivateInStasisCeiling`
 *   restores it, so a crusher frozen on its way up resumes *upward*.
 *
 * See docs/specials.md § A switch only flips when it acts and § Crushers.
 */

const BANK = {
  size: () => ({ w: 64, h: 128 }),
  get: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialBank;

const NO_INPUT = { pressed: () => false, rightMousePressed: () => false } as unknown as Input;
const TIC = 1 / 35;

/** The line between two grid cells, whichever way round its sidedefs happen to sit. */
function boundary(map: DoomMap, a: number, b: number): number {
  const i = map.linedefs.findIndex((l) => {
    if (l.left === NO_SIDE) return false;
    const f = map.sidedefs[l.right].sector;
    const k = map.sidedefs[l.left].sector;
    return (f === a && k === b) || (f === b && k === a);
  });
  assert.ok(i >= 0, 'the boundary line exists');
  return i;
}

function controller(map: DoomMap, startX: number, startY: number) {
  const world = new World(map);
  const movableSectors = computeMovableSectors(map);
  const built = buildMapMesh(map, BANK, { movableSectors });
  const fog = new FogOfWar(world, built.occluders, startX, startY);
  return new SpecialsController(
    map, world, BANK, new THREE.Group(), fog, built.polys, built, {},
    () => {}, () => {}, () => false, () => false, () => false,
    startX, startY, movableSectors,
  );
}

/**
 * Two rooms either side of a corridor. Both switch lines carry the same tag, so
 * either can drive the target sector — which is what lets one be pressed while
 * the other's effect is still running.
 */
function twoSwitchMap(special: number) {
  const grid = gridMap(['#####', '#...#', '#####'], { heights: { '.': { floor: 0, ceil: 128 } } });
  const map = grid.map;
  const left = grid.index(1, 1);
  const mid = grid.index(2, 1);
  const target = grid.index(3, 1);
  map.sectors[target].tag = 1;
  const lineA = boundary(map, left, mid);
  const lineB = boundary(map, mid, target);
  for (const i of [lineA, lineB]) {
    map.linedefs[i].special = special;
    map.linedefs[i].tag = 1;
  }
  return { grid, map, lineA, lineB, target };
}

describe('Regressions · switch gating and crusher stasis', () => {
  test('an S1 switch whose effect does nothing is neither flipped nor spent', () => {
    // 23 = S1 lower floor to lowest: one-shot, use-triggered, and slow enough
    // that the second press lands while the first is still running.
    const { grid, map, lineA, lineB } = twoSwitchMap(23);
    const start = grid.centre(1, 1);
    const specials = controller(map, start.x, start.y) as unknown as {
      trigger(i: number, keys: Set<never>): unknown;
      usedOnce: Set<number>;
      update(dt: number, x: number, y: number, a: number, input: Input, keys: Set<never>): void;
    };

    specials.trigger(lineA, new Set());
    assert.ok(specials.usedOnce.has(lineA), 'the first switch acted, so it is spent');

    // The target sector is now busy, so this one's EV_DoFloor finds nothing to do.
    specials.trigger(lineB, new Set());
    assert.equal(
      specials.usedOnce.has(lineB),
      false,
      'a switch that did nothing must stay usable — vanilla only spends it inside if (EV_DoFloor(...))',
    );

    // Let the floor finish, then the same line works and is spent.
    for (let i = 0; i < 400; i++) specials.update(TIC, start.x, start.y, 0, NO_INPUT, new Set());
    specials.trigger(lineB, new Set());
    assert.ok(specials.usedOnce.has(lineB), 'once the sector is free the switch acts and is spent');
  });

  test('a one-shot switch stays pressed; a repeatable one reverts after BUTTONTIME', () => {
    // `P_ChangeSwitchTexture` only calls `P_StartButton` when `useAgain` is set,
    // so an S1 switch has no revert timer at all. Reverting it too made every
    // pressed switch in the game flick back to its unpressed art.
    // Each switch drives its *own* target sector: pointed at the same one, the
    // second press would correctly be a no-op and never flip (§ gating above).
    const grid = gridMap(['#######', '#.....#', '#######'], { heights: { '.': { floor: 0, ceil: 128 } } });
    const map = grid.map;
    map.sectors[grid.index(4, 1)].tag = 1;
    map.sectors[grid.index(5, 1)].tag = 2;

    const once = boundary(map, grid.index(1, 1), grid.index(2, 1)); // 103 = S1 open door
    const again = boundary(map, grid.index(2, 1), grid.index(3, 1)); // 61 = SR open door
    map.linedefs[once].special = 103;
    map.linedefs[once].tag = 1;
    map.linedefs[again].special = 61;
    map.linedefs[again].tag = 2;
    for (const i of [once, again]) map.sidedefs[map.linedefs[i].right].middle = 'SW1BRCOM';

    const start = grid.centre(1, 1);
    const specials = controller(map, start.x, start.y) as unknown as {
      trigger(i: number, keys: Set<never>): unknown;
      update(dt: number, x: number, y: number, a: number, input: Input, keys: Set<never>): void;
    };
    const art = (i: number) => map.sidedefs[map.linedefs[i].right].middle;

    specials.trigger(once, new Set());
    specials.trigger(again, new Set());
    assert.equal(art(once), 'SW2BRCOM', 'both flip on the press');
    assert.equal(art(again), 'SW2BRCOM');

    // Well past BUTTONTIME (35 tics).
    for (let i = 0; i < 70; i++) specials.update(TIC, start.x, start.y, 0, NO_INPUT, new Set());
    assert.equal(art(once), 'SW2BRCOM', 'the one-shot switch is pressed for good — no P_StartButton');
    assert.equal(art(again), 'SW1BRCOM', 'the repeatable one reverts so it can be pressed again');
  });

  test('a crusher grinds at an eighth speed while it is crushing something', () => {
    // `T_MoveCeiling`'s `ceiling->speed = CEILSPEED / 8`. Without it a descent
    // spends an eighth as long over a body and deals an eighth the damage —
    // a Hell Knight survived MAP06's crusher for four cycles instead of one.
    const grid = gridMap(['####', '#..#', '####'], { heights: { '.': { floor: 0, ceil: 256 } } });
    const map = grid.map;
    const room = grid.index(1, 1);
    const crush = grid.index(2, 1);
    map.sectors[crush].tag = 1;
    const line = boundary(map, room, crush);
    map.linedefs[line].special = 49;
    map.linedefs[line].tag = 1;

    const start = grid.centre(1, 1);
    // `caught` stands in for a body under the ceiling; the controller only ever
    // learns about one through this callback.
    let caught = true;
    let damageTics = 0;
    const world = new World(map);
    const movableSectors = computeMovableSectors(map);
    const built = buildMapMesh(map, BANK, { movableSectors });
    const fog = new FogOfWar(world, built.occluders, start.x, start.y);
    const specials = new SpecialsController(
      map, world, BANK, new THREE.Group(), fog, built.polys, built, {},
      () => {}, () => {},
      (_s, dealDamage) => { if (caught && dealDamage) damageTics++; return caught; },
      () => false, () => false,
      start.x, start.y, movableSectors,
    ) as unknown as {
      trigger(i: number, keys: Set<never>): unknown;
      movers: Map<number, { state: string; slowed?: boolean }>;
      update(dt: number, x: number, y: number, a: number, input: Input, keys: Set<never>): void;
    };

    specials.trigger(line, new Set());
    const tick = () => specials.update(TIC, start.x, start.y, 0, NO_INPUT, new Set());

    // One tic at full speed, then the first crush report slows it.
    tick();
    const afterFirst = map.sectors[crush].ceilHeight;
    tick();
    const slowStep = afterFirst - map.sectors[crush].ceilHeight;
    assert.equal(specials.movers.get(crush)!.slowed, true, 'a crush report slows the descent');
    assert.ok(
      Math.abs(slowStep - 35 / 8 / 35) < 1e-6,
      `the slowed step is an eighth of CEILSPEED, got ${slowStep}`,
    );

    // Run to the bottom; the slowdown is cleared there, so the way up is full speed.
    for (let i = 0; i < 20000 && specials.movers.get(crush)!.state === 'lowering'; i++) tick();
    assert.equal(specials.movers.get(crush)!.slowed, false, 'reaching the bottom restores full speed');
    const beforeUp = map.sectors[crush].ceilHeight;
    tick();
    assert.ok(
      Math.abs(map.sectors[crush].ceilHeight - beforeUp - 1) < 1e-6,
      'the up-stroke runs at the full 1 unit per tic',
    );
    assert.ok(damageTics > 0, 'and damage was dealt on the way down');
  });

  test('a crusher frozen on its way up resumes upward, not downward', () => {
    const grid = gridMap(['####', '#..#', '####'], { heights: { '.': { floor: 0, ceil: 128 } } });
    const map = grid.map;
    const room = grid.index(1, 1);
    const crush = grid.index(2, 1);
    map.sectors[crush].tag = 1;
    const line = boundary(map, room, crush);
    map.linedefs[line].special = 49; // S1 ceiling crush and raise
    map.linedefs[line].tag = 1;

    const start = grid.centre(1, 1);
    const specials = controller(map, start.x, start.y) as unknown as {
      trigger(i: number, keys: Set<never>): unknown;
      triggerCrusherStop(s: number): boolean;
      triggerCrusher(s: number, e: unknown): boolean;
      movers: Map<number, { state: string; stoppedFrom?: string; speed: number; silent: boolean }>;
      update(dt: number, x: number, y: number, a: number, input: Input, keys: Set<never>): void;
    };

    specials.trigger(line, new Set());
    // Read through accessors, not a captured `mover`: `assert/strict`'s `equal`
    // carries an `asserts actual is T` signature, so asserting on a captured
    // field pins its type to that literal for the rest of the test.
    const state = () => specials.movers.get(crush)!.state;
    const stoppedFrom = () => specials.movers.get(crush)!.stoppedFrom;
    assert.equal(state(), 'lowering');

    // Run to the bottom and into the up-stroke.
    for (let i = 0; i < 2000 && state() !== 'raising'; i++) {
      specials.update(TIC, start.x, start.y, 0, NO_INPUT, new Set());
    }
    assert.equal(state(), 'raising', 'the crusher reversed at the bottom');
    const frozenAt = map.sectors[crush].ceilHeight;

    assert.equal(specials.triggerCrusherStop(crush), true, 'stopping a running crusher is a hit');
    assert.equal(state(), 'stopped');
    assert.equal(stoppedFrom(), 'raising', 'the direction is remembered — vanilla olddirection');

    for (let i = 0; i < 35; i++) specials.update(TIC, start.x, start.y, 0, NO_INPUT, new Set());
    assert.equal(map.sectors[crush].ceilHeight, frozenAt, 'in stasis it does not move at all');

    // A second stop is not a hit: vanilla's own `direction != 0` guard.
    assert.equal(specials.triggerCrusherStop(crush), false);

    // Restarting resumes the up-stroke, and reports rtn 0 — stasis never cleared
    // specialdata, so EV_DoCeiling's loop skips the sector.
    const restarted = specials.triggerCrusher(crush, { kind: 'crusher', speed: 35, silent: false });
    assert.equal(restarted, false, 'reactivating an in-stasis crusher is not a fresh thinker');
    assert.equal(state(), 'raising', 'it resumes upward, not back down');

    specials.update(TIC, start.x, start.y, 0, NO_INPUT, new Set());
    assert.ok(map.sectors[crush].ceilHeight > frozenAt, 'and actually moves up');
  });
});
