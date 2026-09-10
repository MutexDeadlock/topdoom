/**
 * The arch-vile — the one monster that doesn't fit the data-driven `MONSTER_STATS` model: raising
 * corpses mid-chase and the sight-checked windup blast. Both `monsters/ai.ts` and
 * `monsters/attacks.ts` call into here. See docs/monster-archvile.md.
 */
import { ThingType } from '../things/doomednums.ts';
import {
  chaseStep,
  DIR_X,
  DIR_Y,
  DI_NODIR,
  type MonsterAttack,
  type MonsterAttackEvent,
  type MonsterBody,
  type MonsterStats,
  type RaiseCandidate,
} from './defs.ts';
import { MONSTER_STATS } from './tables.ts';
import { applyRadiusDamage, fallbackPlayer, targetBody, targetMonster, type CombatContext } from '../combat.ts';
import { slotOfTarget } from '../things/defs.ts';
import type { SpriteFxLayer } from '../spritefx.ts';
import { IMPACT_FRAME_SECONDS, VILE_FIRE_FRAMES, VILE_FIRE_OFFSET } from '../spritefx/tables.ts';
import type { AudioEngine } from '../../audio/audio.ts';
import { monsterOrigin } from '../../audio/sfx.ts';
import type { Pos2, Pos3 } from '../../types.ts';
import { DOOM_TIC } from '../../constants.ts';
import { atan2, cos, sin } from '../../util/fdlibm.ts';

/**
 * The arch-vile, the one monster type whose behavior does not fit the
 * data-driven `MONSTER_STATS` model every other type is expressed in. Both
 * halves are called from elsewhere — `monsters/ai.ts` for the chase side,
 * `monsters/attacks.ts` for the resolution side. docs/monster-archvile.md, which also
 * lists the three pieces of vile-specific behavior that deliberately stay
 * outside this file.
 */

/**
 * Vanilla's S_VILE_HEAL1-3: the arch-vile holds still for 30 tics while the corpse it just found
 * rises.
 */
const VILE_HEAL_DURATION = 30 * DOOM_TIC;

/**
 * `ThingLayer`'s `findRaisableCorpse`, as `stepMonsterAI` receives it — a lookahead point and the
 * vile's own radius in, the one corpse to raise out.
 */
export type Resurrector = (x: number, y: number, vileRadius: number) => RaiseCandidate | null;

/**
 * `A_VileChase`: raises a corpse instead of taking this chase call's ordinary
 * turn, matching vanilla exactly — a tic that finds one replaces `A_Chase`
 * outright, skipping the reactiontime/threshold aging and the
 * melee/missile/walk decisions rather than merely pre-empting them. Returns
 * null (and does nothing) for every type but the vile, so `runChaseCall` can
 * call it unconditionally.
 */
export function tryRaiseCorpse(
  body: MonsterBody,
  stats: MonsterStats,
  resurrect: Resurrector | undefined,
): MonsterAttack | null {
  if (!stats.resurrects || !resurrect || body.movedir === DI_NODIR) return null;
  // One chase call's worth of travel ahead of the vile's own position —
  // vanilla's own viletryx/y, scaled from vanilla's per-tic speed to this
  // engine's units-per-second one.
  const stepDist = chaseStep(stats);
  const aheadX = body.x + DIR_X[body.movedir] * stepDist;
  const aheadY = body.y + DIR_Y[body.movedir] * stepDist;
  const found = resurrect(aheadX, aheadY, stats.radius);
  if (!found) return null;
  body.angle = atan2(found.y - body.y, found.x - body.x); // A_FaceTarget at the corpse
  body.attackPause = VILE_HEAL_DURATION;
  return { kind: 'resurrect', damage: 0, bullets: [], angleRad: body.angle, resurrectId: found.id };
}

/**
 * `A_VileAttack` (`atk.blast`): not a traced bolt at all — vanilla damages
 * `actor->target` directly (guaranteed, nothing to miss along), launches it
 * upward, then blasts a radius. No tracer or projectile sprite; the `FIRE`
 * spawned here is `MT_FIRE`'s final burst, taking over from `spawnWindupFire`'s.
 * See docs/monster-archvile.md.
 */
export function resolveVileBlast(
  ctx: CombatContext,
  effects: SpriteFxLayer,
  audio: AudioEngine,
  atk: MonsterAttackEvent,
): void {
  if (!atk.blast) return;
  const player = fallbackPlayer(ctx, atk.targetId);
  const victim = targetMonster(ctx, atk.targetId);
  const at = victim ? { x: victim.x, y: victim.y, z: victim.z } : { x: player.x, y: player.y, z: player.z };
  if (atk.targetId < 0) {
    // A no-op hit (already dead, or invulnerable) reports false — see
    // `CombatContext.damageSlot` — and skips the knockup along with it.
    if (ctx.damageSlot(slotOfTarget(atk.targetId), atk.damage, atk.x, atk.y, atk.sourceType)) {
      player.launchUpward(atk.blast.knockUpSpeed);
    }
  } else {
    ctx.things?.damage(atk.targetId, atk.damage, {
      source: { id: atk.sourceId, type: atk.sourceType },
      knockUpSpeed: atk.blast.knockUpSpeed,
      from: atk,
    });
  }
  // A_VileAttack's own sound is the barrel/rocket explosion, played on the
  // vile rather than on the flame it just placed.
  audio.play('barexp', atk, monsterOrigin(atk.sourceId));
  const offset = vileBlastOffset(atk, at);
  const fireAt = { x: at.x + offset.x, y: at.y + offset.y, z: at.z };
  applyRadiusDamage(ctx, fireAt, {
    radius: atk.blast.splashRadius,
    maxDamage: atk.blast.splashDamage,
    hitsPlayer: true,
    source: { id: atk.sourceId, type: atk.sourceType },
  });
  effects.spawnImpact('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, fireAt);
}

/**
 * The warning flame, spawned when the windup starts — vanilla's `MT_FIRE`.
 * Reuses `SpriteFxLayer.spawn` but overrides the lifetime to the windup's own
 * length, so `resolveVileBlast`'s burst (or nothing, if the shot fizzles) takes
 * over with no explicit hand-off. Positioned up front, as `A_VileTarget` calls
 * `A_Fire` immediately after spawning. See docs/monster-archvile.md.
 */
export function spawnWindupFire(
  ctx: CombatContext,
  effects: SpriteFxLayer,
  audio: AudioEngine,
  atk: MonsterAttackEvent,
): void {
  const target = targetBody(ctx, atk.targetId);
  if (!target) return;
  const front = fireFrontOf(target);
  // A_StartFire, on the flame itself (`vilatk` comes from the vile at the same
  // moment, via MonsterSounds.windup) — the two together are the warning.
  audio.play('flamst', front);
  const effect = effects.spawn('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, front);
  if (!effect) return;
  effect.lifetime = vileWindupTrackSeconds();
  effect.followTargetId = atk.targetId;
  effect.vileSourceId = atk.sourceId;
  effects.addImpact(effect);
}

/**
 * `SpriteFxLayer`'s `VileFlameResolver`: where the flame belongs this frame, or
 * null if it should stay put. Lives here rather than in the effect layer
 * because the answer depends on live monster/player state (and on `A_Fire`'s
 * sightline rule) that the batch has no reason to know.
 */
export function vileFlameFor(ctx: CombatContext, vileId: number, targetId: number): Pos3 | null {
  const vile = ctx.things?.monsterById(vileId);
  const target = targetBody(ctx, targetId);
  if (!vile || !target || !ctx.world.hasLineOfSight(vile, target)) return null;
  return fireFrontOf(target);
}

/**
 * Vanilla's `A_Fire`: 24 units in front of wherever the target is *currently
 * facing*, not toward the vile — contrast `vileBlastOffset`, which is
 * `A_VileAttack`'s genuinely different final reposition.
 */
function fireFrontOf(target: Pos3 & { angle: number }): Pos3 {
  return {
    x: target.x + cos(target.angle) * VILE_FIRE_OFFSET,
    y: target.y + sin(target.angle) * VILE_FIRE_OFFSET,
    z: target.z,
  };
}

/**
 * `resolveVileBlast`'s one-time final reposition — `A_VileAttack` moves the
 * fire 24 units from the target back toward the shooter, a genuinely different
 * formula from the windup's target-facing one, not an inconsistency here. The
 * offset also keeps the flame from spawning at the target's exact x/y/z, where
 * two anchored billboards hide each other.
 */
function vileBlastOffset(atk: MonsterAttackEvent, targetPos: Pos2): Pos2 {
  const towardVile = atan2(atk.y - targetPos.y, atk.x - targetPos.x);
  return { x: cos(towardVile) * VILE_FIRE_OFFSET, y: sin(towardVile) * VILE_FIRE_OFFSET };
}

/**
 * How long the arch-vile's windup flame tracks its target — read off the
 * vile's own `startDelaySeconds` rather than duplicated, so the flame can't
 * drift away from the moment the real shot lands or fizzles. Derived from
 * `MONSTER_STATS` rather than sitting in `spritefx/tables.ts` beside the other
 * `VILE_FIRE_*` values: that file is otherwise free of `MONSTER_STATS`, and
 * keeping it that way is what lets this file import it.
 */
function vileWindupTrackSeconds(): number {
  return MONSTER_STATS[ThingType.archVile].ranged?.startDelaySeconds ?? 0;
}
