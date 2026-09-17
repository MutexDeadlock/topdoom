import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { impBody, rocket, shotRig } from '../fixtures/shotrig.ts';

/**
 * A locked-on **missile** used to be bounded by the launch-time distance to its target, so a
 * cacodemon that drifted aside left the rocket to burst in mid-air on the spot it had been standing
 * — the flight ended at `maxDist` with nothing there. `P_SpawnMissile` gives a missile momentum and
 * nothing else; it flies until a wall, the floor or a body stops it. See docs/combat.md § Range.
 */

const EAST = 0;
const IMP_HALF = MONSTER_STATS[ThingType.imp].height / 2;

/** A long open corridor, so nothing but the far wall is in the way. */
const GRID = gridMap(['##########', '#........#', '##########'], { cell: 128 });
/** The far wall's face. */
const WALL_X = GRID.centre(8, 1).x + GRID.cell / 2;

describe('Combat · a locked-on missile flies past its target', () => {
  test('the flight runs to the wall, not to where the target stood', () => {
    // Locked onto an imp three cells east that has since left the line: nothing is there to strike.
    const target = impBody(1, GRID.centre(4, 1));
    const rig = shotRig(GRID, GRID.centre(1, 1), []);
    rig.launch(rocket(), target);
    rig.fly();

    assert.equal(rig.impacts.length, 1);
    const burst = rig.impacts[0].x;
    assert.ok(Math.abs(burst - (WALL_X - PROJECTILE_RADIUS.MISL)) < 1e-6, `burst at ${burst}, short of the wall`);
  });

  test('the aim wedge is still measured at the target’s own distance', () => {
    // The wedge opens on the target's silhouette, `thingtopslope`/`thingbottomslope`, which is a
    // half-height over the distance *to the thing*. Dividing by the flight's own range instead
    // collapsed it to the raw centre line the moment a missile stopped ending at its target.
    const world = new World(GRID.map);
    const from = GRID.centre(1, 1);
    const origin: Pos3 = { x: from.x, y: from.y, z: AIM_HEIGHT_OFFSET };
    const at = GRID.centre(4, 1);
    const target: Pos3 = { x: at.x, y: at.y, z: IMP_HALF };
    const lock = { halfHeight: IMP_HALF, slopeOffset: 0 };

    // Same lock, traced to the target and across the map: the slope the wedge settles on must not
    // depend on how far the shot then travels, since nothing in this corridor narrows the wedge.
    const near = world.aimSlope(origin, EAST, target, lock);
    const far = world.shotPath(origin, EAST, target, world.mapSpan, lock).slope;
    assert.ok(Math.abs(near - far) < 1e-9, `slopes disagree: ${near} vs ${far}`);
  });
});
