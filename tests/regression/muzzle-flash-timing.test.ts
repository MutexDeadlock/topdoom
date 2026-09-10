import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { FULLBRIGHT_FRAMES, MONSTER_ATTACK_POSE, THING_SPRITES } from '../../src/game/things/tables.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * Vanilla marks a monster's firing frame `FF_FULLBRIGHT` — `S_SPOS_ATK2` and `S_CPOS_ATK2` carry
 * the bit in stock DOOM, and freedoom2's DEHACKED adds it to the zombieman's. Once this engine
 * drew those frames bright (docs/sprites.md § Fullbright frames), two long-standing simplifications
 * became visible together: every monster fired at the *start* of its attack window, and the pose
 * spread its letters evenly instead of following vanilla's per-state tics. The muzzle flash lit up
 * four tenths of a second **after** the bullet had already landed, and then lingered.
 *
 * The rule this pins: **the frame showing when a shot fires is the frame vanilla fires on.** It
 * takes both halves — `AttackStats.startDelaySeconds` (docs/monster-ai.md § The windup) and
 * `MONSTER_ATTACK_POSE`'s per-state tics — and either one regressing alone puts the flash back off
 * the bullet.
 */

/** Ticks an alerted monster in an open room until it attacks, recording the frame drawn each tic. */
function fireOnce(type: number): { pose: string[]; shotTic: number; poseStart: number } {
  clearRandom();
  const grid = gridMap(['######', '#....#', '#....#', '######'], { cell: 128 });
  const map = grid.map;
  map.things.push(thingAt(grid, 1, 1, 1), thingAt(grid, 3, 2, type));
  const player = { x: map.things[0].x, y: map.things[0].y, z: 0 };
  const layer = buildThingSprites(new World(map), {
    bank: BANK,
    materials: MATERIALS,
    skill: 3,
    restore: {
      clock: 0,
      stats: { totalKills: 1, kills: 0, totalItems: 0, items: 0 },
      // Over the map's own spawn: thing 0 is the monster it places, awake from the first tic.
      changed: [[0, { type, x: map.things[1].x, y: map.things[1].y, z: 0, facingDeg: 180, monster: { alerted: true } }]],
    },
  });

  const walk = new Set(['A', 'B', 'C', 'D']);
  const pose: string[] = [];
  let shotTic = -1;
  let poseStart = -1;
  for (let tic = 0; tic < 400; tic++) {
    const fired = layer.update(DOOM_TIC, [player]).attacks.length > 0;
    layer.draw(1, 0);
    const letter = layer.drawnFrameKey(0).slice(4);
    if (poseStart < 0 && !walk.has(letter)) {
      poseStart = tic;
    }
    if (poseStart >= 0) pose.push(letter);
    if (fired && shotTic < 0) {
      shotTic = tic;
    }
    if (shotTic >= 0 && tic > shotTic) break;
  }
  assert.ok(shotTic >= 0, 'the monster never fired');
  assert.ok(poseStart >= 0 && poseStart <= shotTic, 'the pose starts no later than the shot');
  return { pose, shotTic, poseStart };
}

describe('Regressions · the muzzle flash fires with the bullet', () => {
  // `firesAt` is the windup, except where that is zero: the burst timer is decremented *before*
  // the chase call that starts the attack sets it, so a windup-less attack still lands on the tic
  // after — the same one-tic slack `vile-attack-pose.test.ts` allows for.
  for (const [label, type, windupTics, firesAt] of [
    ['shotgun guy', ThingType.shotgunGuy, 10, 10],
    ['chaingunner', ThingType.heavyWeaponDude, 0, 1],
  ] as const) {
    test(`${label}: the frame drawn as the shot lands is vanilla's own firing frame`, () => {
      const { pose, shotTic, poseStart } = fireOnce(type);
      const at = shotTic - poseStart;
      const letter = pose[at];
      const sprite = THING_SPRITES[type];
      assert.ok(
        FULLBRIGHT_FRAMES.has(sprite + letter),
        `${sprite}${letter} is drawn as the shot fires but is not a fullbright frame`,
      );
      // And it is that type's own windup, not an accident of where the pose happened to be.
      assert.equal(at, firesAt, `the shot landed ${at} tics into the pose, not ${firesAt}`);
      assert.equal(
        Math.round((MONSTER_STATS[type].ranged!.startDelaySeconds ?? 0) / DOOM_TIC),
        windupTics,
      );
    });
  }

  test('the pose keeps vanilla’s proportions rather than an even spread', () => {
    // The even spread is what put the zombieman's flash 14 tics in instead of 10: its chain is
    // 10/8/8, so an equal split of two letters lands the firing frame at 13.
    const pose = MONSTER_ATTACK_POSE[ThingType.zombieman].ranged!;
    assert.deepEqual(pose, { frames: ['E', 'F', 'E'], tics: [10, 8, 8] });
    assert.notEqual(pose.tics[0], pose.tics[1], 'an even split would hide the regression this pins');
  });

  test('a volley’s later shots stay inside the pose they are already in', () => {
    // Re-entering on every shot would restart the mancubus's chain three times, and each later
    // A_FatAttack would land on its first (wind-up) frame instead of an `H`.
    const { pose, shotTic, poseStart } = fireOnce(ThingType.mancubus);
    assert.equal(pose[shotTic - poseStart], 'H', 'the first volley fires on the H frame');
    assert.equal(shotTic - poseStart, 20, "20 tics in, where A_FatAttack1 sits after A_FatRaise's own 20");
  });
});
