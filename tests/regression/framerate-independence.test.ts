import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import { type MonsterBody } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom, pRandom } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * The simulation advances only in whole `DOOM_TIC` steps, so the same elapsed
 * wall-clock time produces the same run whatever rate the display refreshes at.
 * That is the property replays, verified times and eventually demo playback all
 * rest on, and it is invisible in ordinary play — nothing else here would fail
 * if a system quietly went back to scaling by the frame delta.
 *
 * `runTics` below mirrors `game.ts`'s accumulator.
 * See docs/frameloop.md § The accumulator.
 */

const stats = MONSTER_STATS[ThingType.imp];
const CELL = 128;
const MAX_TICS_PER_FRAME = 5;

function scene(): { world: World; body: MonsterBody; target: { x: number; y: number; z: number } } {
  // Open room with pillars, so chase pathing has to re-route and actually
  // consumes the random draws `P_NewChaseDir` makes.
  const grid = gridMap(['#########', '#.......#', '#..#.#..#', '#.......#', '#..#.#..#', '#.......#', '#########'], {
    cell: CELL,
  });
  const world = new World(grid.map);
  const start = grid.centre(1, 1);
  const body: MonsterBody = {
    id: 1,
    x: start.x,
    y: start.y,
    z: 0,
    velZ: 0,
    angle: 0,
    attackPause: 0,
    burstLeft: 0,
    burstTimer: 0,
    swinging: false,
    chargeTimer: 0,
    chargeAngle: 0,
    painTimer: 0,
    inFloat: false,
    movedir: 8,
    movecount: 0,
    chaseTimer: 0,
    moveBlocked: false,
    threshold: 0,
    justHit: false,
    justAttacked: false,
    reactionTicks: 0,
    refiring: false,
    homingBias: false,
    walkSoundTimer: 0,
    walkSoundStep: 0,
  };
  const goal = grid.centre(7, 5);
  return { world, body, target: { x: goal.x, y: goal.y, z: 0 } };
}

/** What a run is compared by — position, the AI's own counters, and where the RNG cursor ended up. */
interface Outcome {
  tics: number;
  x: number;
  y: number;
  movedir: number;
  movecount: number;
  chaseTimer: number;
  rng: number;
}

function outcome(body: MonsterBody, tics: number): Outcome {
  return {
    tics,
    x: body.x,
    y: body.y,
    movedir: body.movedir,
    movecount: body.movecount,
    chaseTimer: body.chaseTimer,
    // The RNG cursor doubles as a checksum over every decision taken — vanilla
    // uses it as exactly that in its netgame `consistancy` byte.
    rng: pRandom(),
  };
}

/**
 * `game.ts: frame`'s accumulator, given a list of frame deltas: banks each one,
 * spends it in whole tics, and drops any debt past `MAX_TICS_PER_FRAME`.
 */
function runTics(deltas: readonly number[]): Outcome {
  const { world, body, target } = scene();
  clearRandom();
  let accumulator = 0;
  let tics = 0;
  for (const rawDt of deltas) {
    accumulator += Math.max(0, rawDt);
    if (accumulator > MAX_TICS_PER_FRAME * DOOM_TIC) accumulator = MAX_TICS_PER_FRAME * DOOM_TIC;
    let ran = 0;
    while (accumulator >= DOOM_TIC && ran < MAX_TICS_PER_FRAME) {
      accumulator -= DOOM_TIC;
      ran++;
      tics++;
      stepMonsterAI(body, stats, world, { dt: DOOM_TIC, target, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT });
    }
  }
  return outcome(body, tics);
}

/** The old model, for contrast: step by whatever the frame delta happened to be. */
function runDtScaled(deltas: readonly number[]): Outcome {
  const { world, body, target } = scene();
  clearRandom();
  for (const rawDt of deltas) {
    stepMonsterAI(body, stats, world, { dt: Math.min(0.05, rawDt), target, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT });
  }
  return outcome(body, deltas.length);
}

/** `hz * seconds` frames of exactly `1/hz`. */
function steady(hz: number, seconds: number): number[] {
  return Array.from({ length: Math.round(hz * seconds) }, () => 1 / hz);
}

/**
 * Deliberately **not** a whole number of tics: 5.5s is 192.5 of them. Neither
 * `1/60` nor `1/144` is exact in binary, so a duration landing on a tic boundary
 * would have the two runs disagree by one tic purely on last-bit accumulation
 * — a genuine property of any float accumulator, and nothing to do with what
 * this test is about. Half a tic of clearance makes rounding irrelevant.
 */
const SECONDS = 5.5;

describe('Regressions · the simulation is independent of framerate', () => {
  test('60 Hz and 144 Hz produce an identical run', () => {
    const slow = runTics(steady(60, SECONDS));
    const fast = runTics(steady(144, SECONDS));
    assert.deepEqual(fast, slow, 'same elapsed time, same tics, same outcome');
    assert.equal(slow.tics, Math.floor(SECONDS / DOOM_TIC), 'and ran the tics the elapsed time is worth');
    // Not a degenerate pass: the monster has to have actually gone somewhere,
    // or two frozen bodies would compare equal.
    const { body } = scene();
    assert.ok(Math.hypot(slow.x - body.x, slow.y - body.y) > CELL, 'and it really did travel');
  });

  test('an uneven frame pattern lands in the same place', () => {
    // A display that stutters: alternating long and short frames summing to the
    // same total. This is what a naive accumulator with a restamped deadline
    // (rather than one that banks the remainder) gets wrong.
    // One long frame and one short one, repeated: each pair is 1/30 + 1/120 =
    // 1/24s, so 132 pairs is the same 5.5s the steady runs cover.
    const jittery: number[] = [];
    for (let i = 0; i < 24 * SECONDS; i++) jittery.push(1 / 30, 1 / 120);
    const total = jittery.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - SECONDS) < 1e-9, 'fixture assumption: the jitter sums to the same elapsed time');
    assert.deepEqual(runTics(jittery), runTics(steady(60, SECONDS)), 'same total, same outcome');
  });

  test('the scenario is sensitive to step size at all', () => {
    // Guards the two tests above: if this scene resolved the same way under any
    // step, they would pass with the tic lock reverted and prove nothing. The
    // dt-scaled model is what the engine used to do.
    assert.notDeepEqual(
      runDtScaled(steady(60, SECONDS)),
      runDtScaled(steady(144, SECONDS)),
      'stepping by the frame delta must diverge, or these tests cannot fail',
    );
  });
});
