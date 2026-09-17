/**
 * What a test that drives `stepMonsterAI` by hand takes: the body to step, and the two runners that
 * step it. docs/testing.md § Shared helpers.
 */
import { DOOM_TIC } from '../../src/constants.ts';
import { DI_NODIR, type MonsterAttack, type MonsterBody, type MonsterStats } from '../../src/game/monsters/defs.ts';
import { stepMonsterAI, type MonsterStep } from '../../src/game/monsters/ai.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import type { World } from '../../src/game/world.ts';
import { vecLength } from '../../src/util/geom.ts';
import type { Pos3 } from '../../src/types.ts';
import { stepFor } from './tics.ts';

/**
 * A `MonsterBody` at rest: awake, idle, nothing in progress — no attack playing out, no pain
 * stagger, no charge, `movedir` unset so nothing walks before the first chase call. Callers pass
 * the position and only what they vary.
 */
export function monsterBody(at: Pos3, over: Partial<MonsterBody> = {}): MonsterBody {
  return {
    id: 0,
    x: at.x,
    y: at.y,
    z: at.z,
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
    movedir: DI_NODIR,
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
    subsector: -1,
    sectorX: NaN,
    sectorY: NaN,
    ...over,
  };
}

/**
 * One tic of `stepMonsterAI` against a target the size of a player — the four fields every chase
 * test passes identically. `over` carries whatever that test varies: a sound log, the blockers a
 * step may bump into, a dead target. docs/monster-ai.md § Movement.
 */
export function chaseStep(
  body: MonsterBody,
  stats: MonsterStats,
  world: World,
  target: Pos3,
  over: Partial<MonsterStep> = {},
): MonsterAttack | null {
  return stepMonsterAI(body, stats, world, {
    dt: DOOM_TIC,
    target,
    targetRadius: PLAYER_RADIUS,
    targetHeight: PLAYER_HEIGHT,
    ...over,
  });
}

/**
 * {@link chaseStep} for `seconds` of whole tics, `each` run after every one.
 *
 * @returns how far from its starting point the body ended up
 */
export function chaseFor(
  body: MonsterBody,
  stats: MonsterStats,
  world: World,
  target: Pos3,
  seconds: number,
  options: Partial<MonsterStep> & { each?: (tic: number) => void } = {},
): number {
  const { each, ...over } = options;
  const startX = body.x;
  const startY = body.y;
  let tic = 0;
  stepFor(seconds, () => {
    chaseStep(body, stats, world, target, over);
    each?.(tic++);
  });
  return vecLength(body.x - startX, body.y - startY);
}
