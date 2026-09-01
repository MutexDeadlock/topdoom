import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { soundLog } from '../fixtures/specialsrig.ts';
import { World } from '../../src/game/world.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { MELEE_RANGE, meleeThreshold, type MonsterBody, type MonsterStats } from '../../src/game/monsters/defs.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Pos3 } from '../../src/types.ts';
import { monsterBody } from '../fixtures/monsterbody.ts';

/**
 * A monster's claw used to land on the chase call that chose it, so touching a
 * demon cost you 4-40 damage in that same frame and nothing you did over the
 * next half second could avoid it. Vanilla's melee chains open with two
 * `A_FaceTarget` states — `A_SargAttack` is 16 tics in — and the action itself
 * re-runs `P_CheckMeleeRange` there, which is what makes backing out of reach a
 * real answer. See docs/monster-ai.md § The windup.
 */

/** Big enough that a whole chase step plus the monster's radius stays inside one cell. */
const CELL = 256;

/** Reach against the player: vanilla's `MELEERANGE - 20 + 16`, exclusive. */
const REACH = meleeThreshold(MELEE_RANGE, PLAYER_RADIUS);

/** How far past `REACH` the target steps during a windup — enough to be out, small enough to stay obviously "right there". */
const STEP_BACK = 4;

interface Scene {
  body: MonsterBody;
  stats: MonsterStats;
  target: Pos3;
  played: string[];
  /** Steps the AI a tic at a time until the swing is committed, and reports the tic it was. */
  commitSwing(): number;
  /** Runs `tics` more and returns every attack fired inside them, with the tic each landed on. */
  run(tics: number): { tic: number; kind: string }[];
}

/**
 * One open cell, the monster at its centre and the player just inside its
 * reach, due east. `movedir` starts at `DI_NODIR` so nothing walks before the
 * first chase call — a step taken while the swing is still being decided would
 * silently shorten the distance the strike is judged on.
 */
function scene(type: number): Scene {
  const grid = gridMap(['#...#'], { cell: CELL });
  const world = new World(grid.map);
  const stats = MONSTER_STATS[type];
  const at = grid.centre(2, 0);
  const body = monsterBody({ ...at, z: 0 }, { movecount: 8 });
  const target: Pos3 = { x: at.x + REACH - 2, y: at.y, z: 0 };
  const log = soundLog();
  let tic = 0;

  const step = (): string | null => {
    const attack = stepMonsterAI(body, stats, world, { dt: DOOM_TIC, target, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT, sfx: log.sfx });
    tic++;
    return attack?.kind ?? null;
  };
  return {
    body,
    stats,
    target,
    played: log.played,
    commitSwing() {
      for (let i = 0; i < 20 && !body.swinging; i++) step();
      assert.ok(body.swinging, 'the monster committed to a swing');
      return tic;
    },
    run(tics) {
      const fired: { tic: number; kind: string }[] = [];
      for (let i = 0; i < tics; i++) {
        const kind = step();
        if (kind) fired.push({ tic, kind });
      }
      return fired;
    },
  };
}

/** `startDelaySeconds` in tics — what the assertions below are stated against. */
const windupTics = (stats: MonsterStats): number => Math.round((stats.melee!.startDelaySeconds ?? 0) / DOOM_TIC);

/**
 * Tics to run past the swing's decision: past the strike, but inside the
 * attack's own hold, so a monster whose swing missed can't chase the target
 * down and commit a *second* one inside the window under test.
 */
const strikeWindow = (stats: MonsterStats): number => windupTics(stats) + 4;

describe('Regressions · the melee windup', () => {
  test('the claw lands a windup after the chase call that chose it, not on it', () => {
    const s = scene(ThingType.demon);
    assert.equal(windupTics(s.stats), 16, "A_SargAttack's own offset into S_SARG_ATK1");
    const decided = s.commitSwing();
    const fired = s.run(strikeWindow(s.stats));
    assert.deepEqual(fired.map((f) => f.kind), ['melee'], 'exactly one bite');
    assert.equal(fired[0].tic, decided + windupTics(s.stats), 'a full windup after the decision');
  });

  test('a target that leaves reach during the windup is missed outright', () => {
    const s = scene(ThingType.demon);
    s.commitSwing();
    // Two units past the reach the swing was chosen at — nothing else changes.
    s.target.x += STEP_BACK;
    assert.deepEqual(s.run(strikeWindow(s.stats)), [], 'the bite finds nobody and deals nothing');
    assert.equal(s.body.swinging, false, 'and the swing is spent, not left pending');
  });

  test('an imp throws its fireball at the target that got away instead', () => {
    const s = scene(ThingType.imp);
    assert.equal(windupTics(s.stats), 16, "A_TroopAttack's own offset into S_TROO_ATK1");
    const decided = s.commitSwing();
    s.target.x += STEP_BACK;
    const fired = s.run(strikeWindow(s.stats));
    // `A_TroopAttack` falls through to `P_SpawnMissile`; the demon above has no
    // missile to fall through to. `AttackStats.missileOnMiss` is which is which.
    assert.deepEqual(fired.map((f) => f.kind), ['ranged'], 'the swing becomes a fireball, not a miss');
    assert.equal(fired[0].tic, decided + windupTics(s.stats), 'thrown when the claw would have connected');
  });

  test('the demon growls as it swings; the imp claws only on connecting', () => {
    // `mobjinfo.attacksound`, which `A_Chase` plays on *entering* meleestate, so
    // it leads the bite — and a bite that misses has still growled.
    const miss = scene(ThingType.demon);
    miss.commitSwing();
    assert.deepEqual(miss.played, ['sgtatk'], 'the growl is out as the swing starts');
    miss.target.x += STEP_BACK;
    miss.run(strikeWindow(miss.stats));
    assert.deepEqual(miss.played, ['sgtatk'], 'and nothing follows it on a miss');

    // The imp's `claw` sits inside `A_TroopAttack`'s own P_CheckMeleeRange branch.
    const hit = scene(ThingType.imp);
    hit.commitSwing();
    assert.deepEqual(hit.played, [], 'no attacksound of its own to lead with');
    hit.run(strikeWindow(hit.stats));
    assert.deepEqual(hit.played, ['claw'], 'only the connecting claw');
  });
});
