/**
 * A `MonsterBody` for tests that drive `stepMonsterAI` directly: awake, idle, nothing in progress
 * — no attack playing out, no pain stagger, no charge, `movedir` unset so nothing walks before the
 * first chase call. Callers pass the position and only what they vary.
 * docs/testing.md § Shared helpers.
 */
import { DI_NODIR, type MonsterBody } from '../../src/game/monsters/defs.ts';
import type { Pos3 } from '../../src/types.ts';

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
    ...over,
  };
}
