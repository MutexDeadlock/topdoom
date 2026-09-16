import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT } from '../../src/audio/sfx.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { MAX_STEP_UP, World } from '../../src/game/world.ts';
import { ProjectileLayer } from '../../src/game/projectiles.ts';
import { MISSILE_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { PROJECTILE_HEIGHT } from '../../src/game/spritefx/defs.ts';
import { targetOfSlot } from '../../src/game/things/defs.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { MATERIALS, ROT0_BANK, fxLayer } from '../fixtures/spritestubs.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { stepFor } from '../fixtures/tics.ts';
import type { CombatContext } from '../../src/game/combat.ts';
import type { Player } from '../../src/game/player.ts';
import type { Pos3 } from '../../src/types.ts';
import type { MonsterAttackEvent } from '../../src/game/monsters/defs.ts';

/**
 * The two planes a missile bursts against, both of them `P_ZMovement`'s.
 *
 * A fireball fired level across a window sill exactly as high as the missile's own fire height
 * used to burst on the sill: `P_MobjThinker` only calls `P_ZMovement` when `z != floorz || momz`,
 * so vanilla's `z <= floorz` explode branch is never reached by a level missile riding a floor at
 * its own height — the sill is `MISSILE_HEIGHT_OFFSET` and so is the shot. GoingDown MAP02 has the
 * case: the imps in sector 82 fire west through the sector 45/66 window (floor 32) at a player
 * standing in sector 77, both rooms' floors at 0.
 *
 * The ceiling is met by the missile's **top** (`z + height > ceilingz`), not its centre.
 * See docs/combat.md § Where an impact sits.
 */

const EAST = 0;
/** `MT_TROOPSHOT`'s own `mobjinfo` speed, the units/sec this engine holds it in. */
const FIREBALL_SPEED = 10 * 35;

/**
 * Shooter and player on floor 0 either side of a gap `floor` high and `ceil` up. `playerZ` lifts
 * the target, which is all that tilts the shot: `P_SpawnMissile` takes its slope from the target
 * and nothing else.
 */
function scene(floor: number, ceil = 90, playerZ = 0) {
  const grid = gridMap(['..w..'], { heights: { w: { floor, ceil } } });
  const world = new World(grid.map);
  const from = grid.centre(0, 0);
  const at = grid.centre(4, 0);
  const player = { x: at.x, y: at.y, z: playerZ } as Player;
  const hits: number[] = [];
  const impacts: Pos3[] = [];
  const effects = fxLayer({ fogVisible: () => true });
  effects.beginLevel(world);
  effects.spawnImpact = (_sprite: string, _frames: string[], _seconds: number, where: Pos3) => {
    impacts.push({ ...where });
  };
  const ctx = {
    world,
    things: { monstersAlongStep: () => [], monstersNear: () => [] },
    slots: [{ player, dead: false }],
    pvp: false,
    damageSlot: (_slot: number, amount: number) => {
      hits.push(amount);
      return true;
    },
    triggerShot: () => {},
    triggerShotPath: () => {},
  } as unknown as CombatContext;
  const projectiles = new ProjectileLayer(ctx, {
    effects,
    spriteBank: ROT0_BANK,
    spriteMaterials: MATERIALS,
    audio: SILENT,
  });
  projectiles.beginLevel();
  const attack: MonsterAttackEvent = {
    kind: 'ranged',
    damage: 9,
    bullets: [9],
    angleRad: EAST,
    projectiles: [{ sprite: 'BAL1', speed: FIREBALL_SPEED, angleRad: EAST }],
    x: from.x,
    y: from.y,
    z: MISSILE_HEIGHT_OFFSET,
    sourceId: 0,
    sourceType: ThingType.imp,
    sourceRadius: 20,
    targetId: targetOfSlot(0),
  };
  return {
    world,
    hits,
    /** Where each flight actually burst — the last drawn position is a tic short of it. */
    impacts,
    /** The gap's near edge: `P_TryMove` is atomic, so a line stops a missile short of it. */
    gapWest: grid.centre(2, 0).x - grid.cell / 2,
    /** The open cells' ceiling, which a climbing shot meets before it reaches the gap. */
    roof: grid.map.sectors[grid.index(0, 0)].ceilHeight,
    sill: grid.centre(2, 0).x,
    fire: () => projectiles.spawnMonsterShot(attack),
    /** Runs the flight out, answering where it ended. */
    fly: () => {
      let last = projectiles.snapshot()[0];
      stepFor(
        200 * DOOM_TIC,
        () => {
          projectiles.update(DOOM_TIC);
          last = projectiles.snapshot()[0] ?? last;
        },
        () => projectiles.snapshot().length === 0,
      );
      return last;
    },
  };
}

describe('Regressions · a missile against the floor and ceiling planes', () => {
  test('a sill at the fire height is ridden across, and the fireball reaches the player', () => {
    const { hits, fire, fly } = scene(MISSILE_HEIGHT_OFFSET);
    fire();
    const end = fly();

    assert.equal(end.drawZ, MISSILE_HEIGHT_OFFSET, 'the flight stayed level throughout');
    assert.deepEqual(hits, [9], 'the player took the fireball');
  });

  test('a sill a step above it is climbed, and the fireball bursts on top of it', () => {
    // `P_TryMove` refuses only a step over `MAX_STEP_UP`, so the shot crosses the line and
    // `P_ZMovement` puts it into the sill beyond — not into the sill's face, the way a bullet goes.
    const { hits, gapWest, impacts, fire, fly } = scene(MISSILE_HEIGHT_OFFSET + 8);
    fire();
    fly();

    assert.deepEqual(hits, [], 'nothing reached the player');
    assert.equal(impacts.length, 1);
    assert.ok(impacts[0].x > gapWest, `burst at ${impacts[0].x}, short of the line at ${gapWest}`);
  });

  test('a sill more than a step up stops the shot at the line', () => {
    const { hits, gapWest, impacts, fire, fly } = scene(MISSILE_HEIGHT_OFFSET + MAX_STEP_UP + 8);
    fire();
    fly();

    assert.deepEqual(hits, [], 'nothing reached the player');
    assert.equal(impacts.length, 1);
    assert.ok(impacts[0].x < gapWest, `burst at ${impacts[0].x}, past the line at ${gapWest}`);
  });

  test('a gap shorter than the fireball stops it even where it could step up into it', () => {
    // Four units of gap, eight of missile: `P_TryMove`'s first refusal, `tmceilingz - tmfloorz <
    // height`. The step up is inside `MAX_STEP_UP` and the top clears the shot's own centre, so
    // neither of the other two refusals sees it.
    const { hits, gapWest, impacts, fire, fly } = scene(MISSILE_HEIGHT_OFFSET + 8, MISSILE_HEIGHT_OFFSET + 12);
    fire();
    fly();

    assert.deepEqual(hits, [], 'nothing reached the player');
    assert.equal(impacts.length, 1);
    assert.ok(impacts[0].x < gapWest, `burst at ${impacts[0].x}, past the line at ${gapWest}`);
  });

  test("a slit whose top the fireball's own body does not clear stops it at the line", () => {
    // Four units of headroom over the shot's centre: the opening clears the centre, and only
    // `z + height` catches it — an 8-unit `MT_TROOPSHOT`. It must burst *short of* the line, not
    // inside the slit on the first tic that samples the low ceiling.
    const { hits, gapWest, impacts, fire, fly } = scene(0, MISSILE_HEIGHT_OFFSET + 4);
    fire();
    fly();

    assert.deepEqual(hits, [], 'nothing reached the player');
    assert.equal(impacts.length, 1);
    assert.ok(impacts[0].x < gapWest, `burst at ${impacts[0].x}, past the line at ${gapWest}`);
  });

  test('a slit the whole fireball fits through lets it by', () => {
    const { hits, fire, fly } = scene(0, MISSILE_HEIGHT_OFFSET + 8);
    fire();
    fly();

    assert.deepEqual(hits, [9], 'the player took the fireball');
  });

  test('a climbing fireball bursts where its top meets the ceiling, not its centre', () => {
    // Aimed at a target far overhead, so the shot climbs into the roof of its own sector long
    // before it reaches the gap — the one way to reach `hitGround`'s ceiling branch, since
    // entering any lower-ceilinged sector crosses that sector's own line first.
    const { roof, impacts, fire, fly } = scene(0, 90, 400);
    fire();
    fly();

    assert.equal(impacts.length, 1);
    const { z } = impacts[0];
    assert.ok(z < roof, `burst at ${z}, at or above the ${roof} ceiling`);
    assert.ok(z + PROJECTILE_HEIGHT >= roof, `burst at ${z}, short of the ceiling`);
  });
});
