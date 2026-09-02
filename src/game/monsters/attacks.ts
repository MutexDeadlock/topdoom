/**
 * Attack resolution. `monsters/ai.ts` decides *that* a monster attacks and
 * reports a `MonsterAttackEvent`; this works out what that attack actually does
 * to the world. The two halves are kept apart by their dependencies: the AI
 * touches nothing but a `MonsterBody`, while this needs the thing list, the
 * effect and projectile layers, and the audio engine.
 * docs/monster-attacks.md § Resolving an attack.
 */
import { WEAPON_RANGE } from '../world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../player.ts';
import { traceHitsBox, vecLength } from '../../util/geom.ts';
import { triangularSpread } from '../../util/random.ts';
import type { CombatContext } from '../combat.ts';
import type { SpriteFxLayer } from '../spritefx.ts';
import type { ProjectileLayer } from '../projectiles.ts';
import { MONSTER_TRACER_COLOR } from '../spritefx/tables.ts';
import type { MonsterAttackEvent } from './defs.ts';
import { resolveVileBlast, spawnWindupFire, vileFlameFor } from './vile.ts';
import type { AudioEngine } from '../../audio/audio.ts';
import type { Pos3 } from '../../types.ts';

/**
 * How far off-aim each monster bullet is thrown — `p_enemy.c`'s
 * `(P_Random()-P_Random())<<20` BAM, ±255/4096 of a full turn, triangular.
 * Why it is the difference between a survivable gunner and a lethal one:
 * docs/monster-attacks.md § Hitscan vs. projectile.
 */
const MONSTER_BULLET_SPREAD_DEG = (255 / 4096) * 360;

/**
 * Vanilla's `A_FaceTarget`: aiming at an `MF_SHADOW` thing (here only ever the
 * player under partial invisibility) throws the facing off by
 * `(P_Random()-P_Random())<<21` BAM, ±255/2048 of a full turn. That is the
 * entire blur-sphere mechanic — it never touches sight or waking.
 */
const SHADOW_AIM_SPREAD_DEG = (255 / 2048) * 360;

/**
 * Realizes the attacks `ThingLayer.update` reported this frame: a melee swing
 * lands, a hitscan volley traces bolt by bolt, a projectile is launched, the
 * arch-vile's blast and warning flame are applied. Nothing here decides to
 * attack — that already happened in `stepMonsterAI`.
 *
 * The counterpart for shots that take time to arrive is `ProjectileLayer`
 * (game/projectiles.ts), which this hands the flying ones to. Both read the
 * live level through the same `CombatContext`.
 */
export class MonsterAttacks {
  private ctx: CombatContext;
  private effects: SpriteFxLayer;
  private projectiles: ProjectileLayer;
  private audio: AudioEngine;
  private isPlayerShadowed: () => boolean;

  /**
   * `isPlayerShadowed` is a callback rather than an `Inventory` reference:
   * whether the player currently holds partial invisibility is inventory
   * state, and nothing else in this file has any reason to reach that far.
   */
  constructor(
    ctx: CombatContext,
    effects: SpriteFxLayer,
    projectiles: ProjectileLayer,
    audio: AudioEngine,
    isPlayerShadowed: () => boolean,
  ) {
    this.ctx = ctx;
    this.effects = effects;
    this.projectiles = projectiles;
    this.audio = audio;
    this.isPlayerShadowed = isPlayerShadowed;
  }

  /** Applies every attack fired this frame, in the order they were reported. */
  resolve(attacks: readonly MonsterAttackEvent[]): void {
    for (const atk of attacks) {
      this.applyShadowAim(atk);
      // The arch-vile's windup warning — see `monsters/vile.ts`. Purely
      // cosmetic (no damage, no trace), so it's handled before every other
      // kind below and separately from them.
      if (atk.kind === 'vileWindup') {
        spawnWindupFire(this.ctx, this.effects, this.audio, atk);
        continue;
      }
      // A monster with a real flying projectile (`MONSTER_STATS`, e.g. the
      // imp's fireball) launches one instead of resolving as an instant hit —
      // damage lands later, on arrival (`ProjectileLayer.update`), not here.
      if (atk.kind === 'ranged' && atk.projectiles) {
        this.projectiles.spawnMonsterShot(atk);
      } else if (atk.kind === 'ranged' && atk.blast) {
        resolveVileBlast(this.ctx, this.effects, this.audio, atk);
      } else if (atk.kind === 'ranged') {
        this.resolveHitscan(atk);
      } else {
        // Melee lands on whatever it swung at, no trace involved.
        this.applyDirectDamage(atk);
      }
    }
  }

  /** `SpriteFxLayer`'s `VileFlameResolver` — see `monsters/vile.ts: vileFlameFor`. */
  vileFlameFor(vileId: number, targetId: number | null): Pos3 | null {
    return vileFlameFor(this.ctx, vileId, targetId);
  }

  /**
   * Applies a monster's damage to whatever it landed on — the player when `atk.targetId` is null,
   * otherwise another monster, tagged with who did it so `ThingLayer.damage` can run vanilla's
   * retaliation rule and start an infight. The knockback thrust both sides derive comes off the
   * attacking monster's own position, which is what `atk` carries.
   */
  private applyDirectDamage(atk: MonsterAttackEvent): void {
    const { targetId, damage, sourceId, sourceType } = atk;
    if (targetId === null) this.ctx.damagePlayer(damage, atk.x, atk.y, sourceType);
    else this.ctx.things?.damage(targetId, damage, { source: { id: sourceId, type: sourceType }, from: atk });
  }

  /**
   * Throws a monster's ranged shot off-aim while the player holds partial
   * invisibility — `A_FaceTarget`'s fuzz, applied once per fired shot so each
   * shot of a burst goes its own way. It fuzzes the *aim* the volley is built
   * on, which is why it lands here rather than per bullet: vanilla fuzzes
   * `actor->angle`, and `A_SPosAttack`'s pellets all spread off that one fuzzed
   * `bangle`. Player-aimed shots only (nothing else carries `MF_SHADOW`), and
   * ranged only: a melee swing lands on `P_CheckMeleeRange`, never on the
   * fuzzed angle. See docs/items.md § Powerups and the backpack.
   */
  private applyShadowAim(atk: MonsterAttackEvent): void {
    if (atk.kind !== 'ranged' || atk.targetId !== null || !this.isPlayerShadowed()) return;
    const off = triangularSpread(SHADOW_AIM_SPREAD_DEG);
    atk.angleRad += off;
    if (atk.projectiles) for (const proj of atk.projectiles) proj.angleRad += off;
  }

  /**
   * Fires every bullet of a monster's hitscan attack: one traced bolt per
   * `MonsterAttack.bullets` entry, each thrown off by its own
   * `MONSTER_BULLET_SPREAD_DEG` draw and carrying its own damage roll, so a
   * shotgun guy's three pellets land independently. All of them share the one
   * aim slope, matching `A_SPosAttack` computing `slope` once before its loop,
   * and that slope is `P_AimLineAttack`'s wedge — docs/monster-attacks.md
   * § Hitscan vs. projectile.
   */
  private resolveHitscan(atk: MonsterAttackEvent): void {
    const { world, things, player } = this.ctx;
    const victim = atk.targetId === null ? null : things?.monsterById(atk.targetId);
    const halfHeight = (victim ? victim.height : PLAYER_HEIGHT) / 2;
    const body = victim ?? player;
    const aim = { x: body.x, y: body.y, z: body.z + halfHeight };
    const aimed = world.shotPath(atk, atk.angleRad, aim, undefined, { halfHeight, slopeOffset: 0 });
    const slope = aimed.dist > 0 ? (aimed.z - atk.z) / aimed.dist : 0;
    // `resolveBullet` takes a point to slope toward, so the volley's shared slope
    // reaches it as the aim point lifted onto that slope.
    const toAim = vecLength(aim.x - atk.x, aim.y - atk.y);
    const sloped = { x: aim.x, y: aim.y, z: atk.z + slope * toAim };
    for (const damage of atk.bullets)
      this.resolveBullet(atk, atk.angleRad + triangularSpread(MONSTER_BULLET_SPREAD_DEG), damage, sloped);
  }

  /**
   * One bullet of that volley: it damages the first thing it reaches — nearest
   * of a wall, another monster in the line of fire, or the player wins.
   * `P_LineAttack` has no notion of an intended target and no species check,
   * which is why one zombieman firing past another starts a fight. The tracer
   * is drawn to where the bolt stopped, not to the target.
   */
  private resolveBullet(atk: MonsterAttackEvent, angleRad: number, damage: number, aim: Pos3): void {
    const { world, things, player } = this.ctx;
    // `WEAPON_RANGE` rather than the distance to `aim`: a bullet the spread
    // threw wide keeps flying, and can still find a wall or another monster
    // behind whoever it was fired at. `P_LineAttack(..., MISSILERANGE, ...)`.
    const path = world.shotPath(atk, angleRad, aim, WEAPON_RANGE, null);

    // The trace damages the first body it reaches, whatever it was aimed at.
    // Vertically it is `PTR_ShootTraverse`, not an aim: this bolt already has a
    // slope (`shotPath` sloped it toward `aim`), so a body only blocks it where
    // the bolt actually passes through that body's own height.
    const slope = path.dist > 0 ? (path.z - atk.z) / path.dist : 0;
    const blocker = things?.raycastMonster(atk, angleRad, path.dist, {
      ignoreId: atk.sourceId,
      includeHidden: true,
      slope,
    });
    const dirX = Math.cos(angleRad);
    const dirY = Math.sin(angleRad);
    // The player's own box, on `PIT_AddThingIntercepts`' diagonal test — the
    // same rule `ThingLayer.raycastMonster` puts every monster on.
    const playerHit = traceHitsBox(atk.x, atk.y, dirX, dirY, player.x, player.y, PLAYER_RADIUS);
    const playerAlong = playerHit ?? 0;
    const playerInPath = !this.ctx.playerDead && playerHit !== null && playerHit <= path.dist;

    let endX = atk.x + dirX * path.dist;
    let endY = atk.y + dirY * path.dist;
    let endZ = path.z;
    // Set in the wall branch rather than recomputed from its condition, so the
    // two can't drift — and so the tie-break that branch encodes stays in one place.
    let stopped: number | null = null;
    if (blocker && (!playerInPath || blocker.dist <= playerAlong)) {
      things?.damage(blocker.id, damage, { source: { id: atk.sourceId, type: atk.sourceType }, from: atk });
      endX = blocker.x;
      endY = blocker.y;
      // Puff and blood go where the bolt was when it landed, the height
      // `PTR_ShootTraverse` spawns them at.
      endZ = atk.z + slope * blocker.dist;
      const hitAt = { x: endX, y: endY, z: endZ };
      if (things?.bleeds(blocker.id)) this.effects.spawnBlood(hitAt, damage);
      else this.effects.spawnPuff(hitAt);
    } else if (playerInPath) {
      this.ctx.damagePlayer(damage, atk.x, atk.y, atk.sourceType);
      endX = player.x;
      endY = player.y;
      endZ = atk.z + slope * playerAlong;
      // The player carries no MF_NOBLOOD either, so a bolt that reaches them
      // splashes exactly as one landing on a monster does — and unlike the
      // pain flash this isn't gated on the damage actually landing, matching
      // `PTR_ShootTraverse` spawning blood before it calls `P_DamageMobj`.
      this.effects.spawnBlood({ x: endX, y: endY, z: endZ }, damage);
    } else {
      // Nothing living stopped it — whatever's left is a wall, the only thing
      // `shotPath` itself could have blocked it on.
      this.effects.spawnWallPuff(path, angleRad);
      stopped = path.lineIndex;
    }
    // Every shoot line the bolt crossed, and the wall it ended on if it reached
    // one. `byMonster` reproduces vanilla's own hardcoded exception: this can
    // only actually do anything for a 46 line, never 24/47.
    this.ctx.triggerShotPath(atk, { x: endX, y: endY }, stopped, true);
    this.effects.addTracer(atk, { x: endX, y: endY, z: endZ }, MONSTER_TRACER_COLOR, atk.sourceRadius);
  }
}
