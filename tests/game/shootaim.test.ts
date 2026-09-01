import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig } from '../fixtures/specialsrig.ts';
import { World } from '../../src/game/world.ts';
import { pickShootAim } from '../../src/game/specials/shootaim.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * Auto-aim's second lock: the pointer over a shoot-triggered line
 * (docs/combat.md § Auto-aim). What the pick has to get right is that it offers
 * only heights a shot is actually *stopped* at, since a line that lets the shot
 * through never fires its special.
 */
describe('Combat · shoot-line auto-aim', () => {
  /** The cursor ray through two DOOM-space points, in the three.js space `TopDownCamera.rayFor` hands over. */
  function rayThrough(from: Pos3, to: Pos3): THREE.Ray {
    const origin = new THREE.Vector3(from.x, from.z, -from.y);
    const dir = new THREE.Vector3(to.x, to.z, -to.y).sub(origin).normalize();
    return new THREE.Ray(origin, dir);
  }

  /**
   * Three cells across, the middle of the second row swapped for `glyph`: the
   * line under test is that cell's west edge, at x=128 running y 128..256, seen
   * from the open cell to its west.
   */
  function rig(glyph: string, heights?: Record<string, { floor: number; ceil: number }>) {
    const grid = gridMap(['...', `.${glyph}.`, '...'], { heights });
    return { grid, world: new World(grid.map), line: grid.westEdge(1, 1) };
  }

  /** The height a shot leaves the player at (`AIM_HEIGHT_OFFSET`-ish); this fixture's floors are at 0. */
  const FIRE_Z = 32;

  test('a solid face is aimed at flat, at the point the pointer is over', () => {
    const { world, line } = rig('#');
    const aim = pickShootAim(world, rayThrough({ x: 0, y: 192, z: 400 }, { x: 128, y: 200, z: 40 }), [line], FIRE_Z);
    assert.ok(aim, 'the wall face is picked');
    assert.equal(aim.lineIndex, line);
    assert.equal(Math.round(aim.x), 128);
    assert.equal(Math.round(aim.y), 200);
    // Floor 0 to ceiling 128 is solid over its whole height (the back cell is a
    // zero-opening wall), so the shot needs no slope at all.
    assert.equal(aim.z, FIRE_Z);
  });

  test('the pointer through an opening picks nothing', () => {
    const { world, line } = rig('h', { h: { floor: 0, ceil: 64 } });
    const through = pickShootAim(world, rayThrough({ x: 0, y: 192, z: 400 }, { x: 128, y: 192, z: 32 }), [line], FIRE_Z);
    assert.equal(through, null, 'a shot at that height flies through the gap and triggers nothing');
    // The wall *above* the opening is solid, and aim drops to its lowest
    // shootable height rather than to where the pointer happens to sit.
    const over = pickShootAim(world, rayThrough({ x: 0, y: 192, z: 400 }, { x: 128, y: 192, z: 100 }), [line], FIRE_Z);
    assert.ok(over);
    assert.equal(over.z, 68);
  });

  test('a shot aimed at the pick is stopped by that very line', () => {
    // A ledge: floor 64, so the line is solid below the opening and the aim
    // stays flat — the case DOOM2 MAP19's two shoot-switches are.
    const { grid, world, line } = rig('l', { l: { floor: 64, ceil: 128 } });
    const from = grid.centre(0, 1);
    const aim = pickShootAim(world, rayThrough({ x: 0, y: 192, z: 400 }, { x: 128, y: 192, z: 30 }), [line], FIRE_Z);
    assert.ok(aim);
    assert.equal(aim.z, FIRE_Z, 'the lower band admits a flat shot');
    const origin = { x: from.x, y: from.y, z: FIRE_Z };
    const angle = Math.atan2(aim.y - origin.y, aim.x - origin.x);
    const path = world.shotPath(origin, angle, aim, 1000);
    assert.equal(path.lineIndex, line, 'the shot stops on the shoot line, which is what fires its special');
  });

  test('a pointer past the line’s end misses, and one just inside it aims within the line', () => {
    const { world, line } = rig('#');
    const past = pickShootAim(world, rayThrough({ x: 0, y: 320, z: 400 }, { x: 128, y: 300, z: 40 }), [line], FIRE_Z);
    assert.equal(past, null);
    const edge = pickShootAim(world, rayThrough({ x: 0, y: 260, z: 400 }, { x: 128, y: 258, z: 40 }), [line], FIRE_Z);
    assert.ok(edge, 'within the pick tolerance the line is still grabbed');
    assert.ok(edge.y <= 256 && edge.y >= 128, `aim point ${edge.y} stays on the line itself`);
  });

  test('a spent one-shot line stops being a target', () => {
    // The tagged cell is kept clear of the wall glyph: `raiseFloor` to the
    // lowest neighbouring ceiling only counts as a spend if the floor moves.
    const grid = gridMap(['....', '.#..', '....']);
    const line = grid.westEdge(1, 1);
    grid.map.linedefs[line].special = 24; // G1 raise floor, one-shot
    grid.map.linedefs[line].tag = 1;
    grid.map.sectors[grid.index(3, 1)].tag = 1;
    const { specials } = specialsRig(grid.map, grid.centre(0, 1));
    const ray = rayThrough({ x: 0, y: 192, z: 400 }, { x: 128, y: 192, z: 40 });
    assert.ok(specials.pickShootTarget(ray, FIRE_Z), 'a live shoot line is a target');
    specials.triggerShot(line, new Set());
    assert.equal(specials.pickShootTarget(ray, FIRE_Z), null, 'once spent it can no longer be aimed at');
  });

  test('a generalized shoot line with no tag is no target', () => {
    const grid = gridMap(['...', '.#.', '...']);
    const line = grid.westEdge(1, 1);
    // Boom generalized floor, GunOnce — one of the numbers `requiresTag` is for.
    grid.map.linedefs[line].special = 0x6000 | 4;
    grid.map.linedefs[line].tag = 1;
    const { specials } = specialsRig(grid.map, grid.centre(0, 1));
    const ray = rayThrough({ x: 0, y: 192, z: 400 }, { x: 128, y: 192, z: 40 });
    assert.ok(specials.pickShootTarget(ray, FIRE_Z), 'tagged, it is a candidate');
    grid.map.linedefs[line].tag = 0;
    assert.equal(specials.pickShootTarget(ray, FIRE_Z), null, 'without a tag it does nothing, so aim ignores it');
  });
});
