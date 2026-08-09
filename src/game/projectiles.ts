import { SpriteAnimator, VIEWER_ANGLE_DEG, type SpriteMaterialCache } from '../render/sprites.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { AudioEngine } from '../audio/audio.ts';
import { PLAYER_ORIGIN } from '../audio/sfx.ts';
import { hasLineOfSight, playerShotRange, projectileStepBlocker, shotPath } from './world.ts';
import { AIM_HEIGHT_OFFSET, PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
import {
  MONSTER_FIRE_HEIGHT,
  MONSTER_HIT_HEIGHT,
  MONSTER_HIT_RADIUS,
  sameSpecies,
  type MonsterAttackEvent,
} from './monsters/defs.ts';
import { PLAYER_MELEE_RANGE, rollDamage, type Shot } from './weapons.ts';
import { applyRadiusDamage, type CombatContext } from './combat.ts';
import type { SpriteFxLayer } from './spritefx.ts';
import {
  BFG_SPRAY_HIT_FRAMES,
  IMPACT_EFFECTS,
  IMPACT_FRAME_SECONDS,
  PROJECTILE_FRAMES,
  PROJECTILE_RADIUS,
  PROJECTILE_RADIUS_DEFAULT,
  PROJECTILE_SOUNDS,
  REVENANT_TRACER_TURN_RATE_RAD,
  SMOKE_TRAIL_FRAMES,
  SMOKE_TRAIL_FRAME_SECONDS,
  SMOKE_TRAIL_INTERVAL,
  stepTouchesBody,
  TRACER_COLOR,
  TRACER_HOMING_Z_OFFSET,
  turnToward,
  type Projectile,
} from './spritefxdefs.ts';
import type { Pos3 } from '../types.ts';

/**
 * Every shot in flight, from launch to whatever it lands on: the player's own
 * hitscan tracers and missiles (`spawnPlayerShot`), a monster's missiles
 * (`spawnMonsterShot`), and the per-frame advance that resolves arrival,
 * damage, splash and the BFG spray.
 *
 * Who *decides* to fire is somebody else's business — `game/weapons.ts`
 * returns a `Shot` per trigger pull and `game/monsters/ai.ts` a
 * `MonsterAttack` per attack, neither knowing what it will hit. This is the
 * other half of that split: it knows nothing about ammo, cooldowns or AI, only
 * about geometry and bodies. See docs/combat.md § How a shot deals damage and
 * docs/monsterattacks.md § Monster projectiles in flight.
 */
export class ProjectileLayer {
  private ctx: CombatContext;
  private effects: SpriteFxLayer;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  private audio: AudioEngine;
  private projectiles: Projectile[] = [];
  /**
   * Where the projectile being advanced stood before this frame's step — a
   * single reused object, deliberately: it is read and discarded inside one
   * iteration of `update`'s loop, which runs for every shot in the air and can
   * be four figures of them on a crowded map.
   */
  private readonly stepFrom: Pos3 = { x: 0, y: 0, z: 0 };

  constructor(
    ctx: CombatContext,
    effects: SpriteFxLayer,
    spriteBank: SpriteBank,
    spriteMaterials: SpriteMaterialCache,
    audio: AudioEngine,
  ) {
    this.ctx = ctx;
    this.effects = effects;
    this.spriteBank = spriteBank;
    this.spriteMaterials = spriteMaterials;
    this.audio = audio;
  }

  /** Drops everything still in flight — a missile that outlives its level would otherwise arrive in the next one. */
  beginLevel(): void {
    this.projectiles = [];
  }

  /**
   * Turns one fired `Shot` (game/weapons.ts) into a tracer line or a flying
   * projectile sprite. Always starts at the player's own fire height and
   * slopes toward a locked-on monster's height; `shotPath` resolves where it
   * actually gets to.
   *
   * **Hit-or-miss is settled here only for a hitscan pellet** — an instant line
   * has no travel time to change its mind about. A projectile leaves with no
   * target at all and re-tests what it has run into every frame
   * (`ProjectileLayer.update`), exactly as a monster's missile does; the lock
   * gives it a slope and nothing else. See docs/combat.md § How a shot deals
   * damage.
   */
  spawnPlayerShot(shot: Shot, startZ: number, target: Pos3 | null, targetId: number | null): void {
    const { world, things } = this.ctx;
    const origin: Pos3 = { x: this.ctx.player.x, y: this.ctx.player.y, z: startZ };

    // A swing never travels, so it skips shotPath entirely — vanilla's
    // A_Punch/A_Saw just trace MELEERANGE along the facing. Aim already points
    // at a hovered monster, so the ray finds a locked-on target with no
    // separate case, and can't reach one past the swing's own range.
    if (shot.kind === 'melee') {
      const swung = things?.raycastMonster(origin, shot.angleRad, shot.range) ?? null;
      if (swung) {
        // At the swing's own flat height, not the target's feet: a melee trace
        // never slopes, so the fire height *is* where it crossed the body.
        const hitAt = { x: swung.x, y: swung.y, z: origin.z };
        if (things?.bleeds(swung.id)) this.effects.spawnBlood(hitAt, shot.damage);
        // A fist swing traces exactly MELEERANGE and so takes the sparkless
        // puff; the chainsaw's own +1 is what buys it the spark back.
        else this.effects.spawnPuff(hitAt, shot.range === PLAYER_MELEE_RANGE);
        things?.damage(swung.id, shot.damage, undefined, undefined, origin.x, origin.y);
      }
      // A_Punch/A_Saw both key their sound off whether they found a target: the
      // chainsaw revs on air and bites on contact, the fist is silent on a miss.
      const sound = swung ? shot.hitSound : shot.missSound;
      if (sound) this.audio.play(sound, origin, PLAYER_ORIGIN);
      return;
    }

    const range = playerShotRange(shot.kind, target, world.mapSpan);
    // The super shotgun's per-pellet slope jitter (`HitscanShot.slopeOffset`)
    // rides on the aim point rather than on the trace: `shotPath` takes its
    // slope from the target, so raising or lowering that point by the jitter
    // over the target's own distance *is* `bulletslope + ((P_Random()-P_Random())<<5)`.
    // Zero for every other weapon, which then aims exactly at `target`.
    const toTarget = target === null ? 0 : Math.hypot(target.x - origin.x, target.y - origin.y);
    const slopeOffset = shot.kind === 'hitscan' ? shot.slopeOffset : 0;
    const aimPoint =
      target !== null && slopeOffset !== 0
        ? { x: target.x, y: target.y, z: target.z + slopeOffset * toTarget }
        : target;
    const path = shotPath(world, origin, shot.angleRad, aimPoint, range);

    if (shot.kind === 'hitscan') {
      const dirX = Math.cos(shot.angleRad);
      const dirY = Math.sin(shot.angleRad);
      // A locked pellet connects only if nothing stopped it short of the target
      // *and* this pellet's own line actually crosses the target's body —
      // sideways (`MONSTER_HIT_RADIUS`) and, for the one weapon that scatters
      // vertically, in height too. The lock supplies the slope, not a
      // guaranteed hit, so a shotgun's pellets still spread. The shared hitbox
      // is what keeps the *lock* honest, and costs nothing on a wide monster:
      // a pellet that fails here falls through to `raycastMonster` below, which
      // tests that same body at its real width. docs/combat.md § How a shot
      // deals damage.
      let lockDist: number | null = null;
      if (target !== null && targetId !== null) {
        const relX = target.x - origin.x;
        const relY = target.y - origin.y;
        const along = relX * dirX + relY * dirY;
        const perp = Math.abs(relX * dirY - relY * dirX);
        const missZ = Math.abs(slopeOffset) * along;
        const onBody = perp <= MONSTER_HIT_RADIUS && missZ <= MONSTER_HIT_HEIGHT / 2;
        if (onBody && along >= 0 && path.dist >= along - 1) lockDist = along;
      }

      let hitMonsterId: number | null = null;
      let endX = path.x;
      let endY = path.y;
      if (lockDist !== null) {
        hitMonsterId = targetId;
        endX = origin.x + dirX * lockDist;
        endY = origin.y + dirY * lockDist;
      } else {
        // No lock, or a pellet the spread threw off it: test the path against
        // every monster's body, so one standing between the player and the wall
        // they're shooting at isn't invisible to the shot — and a wide pellet can
        // still find whatever it *did* fly through. Only ever shortens the shot,
        // never past `path.dist`.
        const monsterHit = things?.raycastMonster(origin, shot.angleRad, path.dist) ?? null;
        if (monsterHit) {
          hitMonsterId = monsterHit.id;
          endX = monsterHit.x;
          endY = monsterHit.y;
        }
      }

      // A shoot-triggered special only fires if the bolt reached the wall
      // rather than being absorbed by a monster first. A hitscan pellet
      // resolves this frame so it fires here; a projectile's is deferred to
      // arrival (see `Projectile.lineIndex`).
      if (hitMonsterId !== null) {
        // Where the tracer stops is where the bolt met the body, so the same
        // point is the splash's — `PTR_ShootTraverse` spawns blood on the
        // trace, a touch short of the thing it hit.
        const hitAt = { x: endX, y: endY, z: path.z };
        if (things?.bleeds(hitMonsterId)) this.effects.spawnBlood(hitAt, shot.damage);
        else this.effects.spawnPuff(hitAt);
        things?.damage(hitMonsterId, shot.damage, undefined, undefined, origin.x, origin.y);
      } else {
        this.ctx.triggerShot(path.lineIndex);
        this.effects.spawnWallPuff(path, shot.angleRad);
      }
      this.effects.addTracer(origin, { x: endX, y: endY, z: path.z }, TRACER_COLOR);
      return;
    }

    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, shot.sprite, PROJECTILE_FRAMES[shot.sprite]);
    if (!anim.resolve((shot.angleRad * 180) / Math.PI, VIEWER_ANGLE_DEG)) return;
    // The missile's own seesound, with no origin: every shot is its own mobj in
    // vanilla, so a burst of plasma layers rather than cutting itself off.
    const launch = PROJECTILE_SOUNDS[shot.sprite]?.launch;
    if (launch) this.audio.play(launch, origin);
    this.projectiles.push({
      anim,
      originX: origin.x,
      originY: origin.y,
      startZ,
      endZ: path.z,
      angleRad: shot.angleRad,
      speed: shot.speed,
      // The wall, never the target: like `P_SpawnMissile`, the lock fixed this
      // shot's slope at launch and the thing then flies on under its own
      // momentum. Ending it at the launch-time distance to the target is what
      // made a BFG ball detonate in mid-air wherever a monster had been
      // standing half a second earlier.
      maxDist: path.dist,
      traveled: 0,
      sprite: shot.sprite,
      radius: PROJECTILE_RADIUS[shot.sprite] ?? PROJECTILE_RADIUS_DEFAULT,
      damage: shot.damage,
      splash: shot.splash,
      spray: shot.spray,
      sourceId: null,
      sourceType: 0,
      lineIndex: path.lineIndex,
    });
  }

  /**
   * Turns a monster's fired ranged `MonsterAttackEvent` into a flying
   * `Projectile`. The target (`atk.targetId`, resolved live) sets the missile's
   * *slope* and nothing else — `P_SpawnMissile` fixes `momx`/`momy`/`momz` at
   * launch and the thing flies on until something stops it, so the flight ends
   * at a wall, never at where the target happened to be standing. See
   * docs/monsterattacks.md § Monster projectiles in flight.
   */
  spawnMonsterShot(atk: MonsterAttackEvent): void {
    if (!atk.projectiles) return;
    const { world, things, player } = this.ctx;
    const victim = atk.targetId === null ? null : things?.monsterById(atk.targetId);
    const target = victim
      ? { x: victim.x, y: victim.y, z: victim.z + MONSTER_FIRE_HEIGHT }
      : { x: player.x, y: player.y, z: player.z + AIM_HEIGHT_OFFSET };
    // Almost always one entry; the mancubus fires two per volley (see
    // MonsterAttack.projectiles's doc) — each resolved and spawned
    // independently, since a fanned-out fireball flies its own path and can
    // miss on its own. `target` is loop-invariant, so the pair shares one
    // slope while only its heading is deflected, exactly as `A_FatAttack1/2/3`
    // rewrite momx/momy from the new angle and leave momz alone.
    for (const proj of atk.projectiles) {
      const path = shotPath(world, atk, proj.angleRad, target, world.mapSpan, false);
      const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, proj.sprite, PROJECTILE_FRAMES[proj.sprite]);
      if (!anim.resolve((proj.angleRad * 180) / Math.PI, VIEWER_ANGLE_DEG)) continue;
      const launch = PROJECTILE_SOUNDS[proj.sprite]?.launch;
      if (launch) this.audio.play(launch, atk);
      this.projectiles.push({
        anim,
        originX: atk.x,
        originY: atk.y,
        startZ: atk.z,
        endZ: path.z,
        angleRad: proj.angleRad,
        speed: proj.speed,
        maxDist: path.dist,
        traveled: 0,
        sprite: proj.sprite,
        radius: PROJECTILE_RADIUS[proj.sprite] ?? PROJECTILE_RADIUS_DEFAULT,
        damage: atk.damage,
        splash: proj.splash ? { radius: proj.splash.radius, damage: proj.splash.damage, hitsPlayer: true } : null,
        spray: null,
        sourceId: atk.sourceId,
        sourceType: atk.sourceType,
        lineIndex: path.lineIndex,
        homing: proj.homing
          ? { targetId: atk.targetId, x: atk.x, y: atk.y, z: atk.z, headingRad: proj.angleRad, smokeTimer: 0 }
          : undefined,
      });
    }
  }

  /**
   * Advances every in-flight projectile — along the fixed straight line
   * `shotPath` resolved for it, sloped from `startZ` to `endZ`, or along the
   * revenant tracer's own curve — and resolves what it ran into on the way.
   * On arrival it removes the shot and plays its `IMPACT_EFFECTS` explosion in
   * place; the impact point applies `p.splash` whether or not a body was hit.
   *
   * **Every projectile, the player's own included, re-tests live bodies each
   * frame** (`P_XYMovement` re-running `PIT_CheckThing` per move), and each
   * test is swept across the frame's whole step rather than sampled at its end.
   * See docs/monsterattacks.md § Monster projectiles in flight.
   *
   * Must run inside the caller's `SpriteFxLayer.beginFrame`/`endFrame` pair: it
   * both draws through the batch and pushes this frame's new explosions and
   * smoke puffs on for `updateImpacts` to draw.
   */
  update(dt: number): void {
    if (this.projectiles.length === 0) return;
    const { world, things } = this.ctx;
    const remaining: Projectile[] = [];
    const from = this.stepFrom;
    for (const p of this.projectiles) {
      let at: Pos3;
      if (p.homing) {
        from.x = p.homing.x;
        from.y = p.homing.y;
        from.z = p.homing.z;
        at = this.advanceHoming(p, dt);
      } else {
        const dirX = Math.cos(p.angleRad);
        const dirY = Math.sin(p.angleRad);
        const before = Math.min(p.traveled, p.maxDist);
        from.x = p.originX + dirX * before;
        from.y = p.originY + dirY * before;
        from.z = p.startZ + (p.endZ - p.startZ) * (p.maxDist > 0 ? before / p.maxDist : 1);
        p.traveled += p.speed * dt;
        const clamped = Math.min(p.traveled, p.maxDist);
        const frac = p.maxDist > 0 ? clamped / p.maxDist : 1;
        at = {
          x: p.originX + dirX * clamped,
          y: p.originY + dirY * clamped,
          z: p.startZ + (p.endZ - p.startZ) * frac,
        };
      }

      const fromMonster = p.sourceId !== null;
      // One lookup, shared with the sprite light below — `floorAt`/`ceilingAt`
      // are two wrappers around the same BSP walk, and this runs per missile
      // per frame with a crowded map holding thousands in the air.
      const sector = world.sectorAt(at.x, at.y);
      // Vanilla's `P_ZMovement`: a missile meeting the floor or ceiling
      // explodes against it. Reachable because a monster's shot holds its
      // launch slope past the target that set it (`spawnMonsterShot`), so a
      // cyberdemon firing down from a ledge and missing puts its rocket in the
      // ground. Still gated to a monster's shot: the player's own already stops
      // where `shotPath` says the geometry stops it, and re-deciding that
      // mid-flight is a separate question from who it hit.
      const hitGround = fromMonster && !!sector && (at.z <= sector.floorHeight || at.z >= sector.ceilHeight);
      const reachedPlayer = fromMonster && !this.ctx.playerDead && this.playerStruckBy(p, from, at);
      const struck = reachedPlayer ? null : this.bodyStruckBy(p, from, at);

      if (reachedPlayer || struck || hitGround || p.traveled >= p.maxDist) {
        if (reachedPlayer) {
          this.ctx.damagePlayer(p.damage, at.x, at.y);
        } else if (struck) {
          // `struck.id === null` is the same-species fizzle: the body stopped
          // the missile but takes no damage from it (see bodyStruckBy).
          if (struck.id !== null) {
            const source = fromMonster ? { id: p.sourceId!, type: p.sourceType } : undefined;
            things?.damage(struck.id, p.damage, source, undefined, at.x, at.y);
          }
        }
        // A clean miss (reached maxDist without hitting a body) means it
        // arrived at whatever wall shotPath found at launch — fire its
        // shoot special now, at actual arrival, not back when it launched.
        // One stopped by the floor never got there, so it triggers nothing.
        else if (!hitGround) this.ctx.triggerShot(p.lineIndex, fromMonster);
        if (p.splash) {
          // Attributed to the firing monster (if any), the same as a direct
          // hit already is — a cyberdemon's own rocket splash should start
          // an infight exactly like one of its direct hits would.
          applyRadiusDamage(
            this.ctx,
            at,
            p.splash.radius,
            p.splash.damage,
            p.splash.hitsPlayer,
            fromMonster ? { id: p.sourceId!, type: p.sourceType } : undefined,
          );
        }
        // Only ever set for the player's own BFG ball (spawnMonsterShot
        // always passes spray: null) — see resolveBfgSpray's doc.
        if (p.spray) this.resolveBfgSpray(p.angleRad, p.spray);
        // P_ExplodeMissile's own deathsound, wherever the flight actually ended.
        const explode = PROJECTILE_SOUNDS[p.sprite]?.explode;
        if (explode) this.audio.play(explode, at);
        const impact = IMPACT_EFFECTS[p.sprite];
        if (impact) this.effects.spawnImpact(impact.sprite, impact.frames, IMPACT_FRAME_SECONDS, at);
        continue;
      }
      // A homing missile's sprite tracks its live, turning heading rather
      // than the fixed launch angle every other projectile keeps.
      const poseAngleRad = p.homing?.headingRad ?? p.angleRad;
      p.anim.advance(dt, true);
      // Re-read every frame, not just at launch — a missile flying between
      // differently-lit sectors should shade like everything else does.
      const light = sector?.light ?? 128;
      this.effects.batchSprite(p.anim, at, (poseAngleRad * 180) / Math.PI, light);
      remaining.push(p);
    }
    this.projectiles = remaining;
  }

  /**
   * Whether this frame's step carried a *monster's* missile into the player —
   * vanilla's `PIT_CheckThing` against `MT_PLAYER`, swept over the step rather
   * than sampled at its end. Contact is the player's own 16-unit box widened by
   * the missile's `mobjinfo.radius`, and the height band is `PIT_CheckThing`'s
   * asymmetric over/under pair, not a tolerance either side of the feet.
   */
  private playerStruckBy(p: Projectile, from: Pos3, at: Pos3): boolean {
    const { world, player } = this.ctx;
    if (stepTouchesBody(from, at, player, PLAYER_RADIUS, PLAYER_HEIGHT, p.radius) === null) return false;
    // Proximity alone isn't arrival, and the trace runs player→projectile, not
    // the other way round — docs/monsterattacks.md § Monster projectiles in
    // flight. Last in the chain so it only runs once the cheap tests passed.
    return hasLineOfSight(world, player, at);
  }

  /**
   * What this frame's step carried the projectile into, or null if it hit
   * nothing. A non-null result always ends the flight; `id` is who takes the
   * direct damage, or **null for a same-species body that stops the missile
   * without being hurt by it** (a monster's shot only — the player is nobody's
   * species). Candidates resolve first-along-the-step, the swept equivalent of
   * vanilla's blockmap order. See docs/monsters.md § Infighting.
   */
  private bodyStruckBy(p: Projectile, from: Pos3, at: Pos3): { id: number | null } | null {
    let nearest: { id: number | null } | null = null;
    let nearestT = Infinity;
    for (const m of this.ctx.things?.monstersAlongStep(from, at, p.radius) ?? []) {
      // Vanilla's `thing == tmthing->target`: a missile never collides with
      // whoever fired it, so it can leave its own shooter's body. `sourceId` is
      // null for the player's, who is not in this list to begin with.
      if (m.id === p.sourceId) continue;
      const t = stepTouchesBody(from, at, m, m.radius, MONSTER_HIT_HEIGHT, p.radius);
      if (t === null || t >= nearestT) continue;
      // Same wall check `playerStruckBy` needs, and for the same reason — see
      // its comment. Traced from the monster for the same `SELF_HIT_MARGIN`
      // reason, and last so it only runs on an already-close candidate.
      if (!hasLineOfSight(this.ctx.world, m, at)) continue;
      nearestT = t;
      nearest = { id: p.sourceId !== null && sameSpecies(p.sourceType, m.type) ? null : m.id };
    }
    return nearest;
  }

  /**
   * One frame of the revenant's `A_Tracer` homing (`Projectile.homing`): turns
   * `headingRad` toward the target's current bearing, integrates position from
   * it, eases height toward the target and spawns the smoke trail. **A homing
   * missile has no flight-distance budget** — each step is checked against the
   * geometry it actually crossed (`projectileStepBlocker`), and forcing
   * `p.traveled` to `p.maxDist` is how arrival is signalled to `update`. See
   * docs/monsterattacks.md § The revenant's homing missile.
   */
  private advanceHoming(p: Projectile, dt: number): Pos3 {
    const { world, things } = this.ctx;
    const homing = p.homing!;
    const step = p.speed * dt;
    const target: Pos3 | null =
      homing.targetId === null
        ? this.ctx.playerDead
          ? null
          : this.ctx.player
        : things?.monsterById(homing.targetId) ?? null;
    if (target) {
      const bearing = Math.atan2(target.y - homing.y, target.x - homing.x);
      homing.headingRad = turnToward(homing.headingRad, bearing, REVENANT_TRACER_TURN_RATE_RAD * dt);
      // Paced by the live distance still to cover, as vanilla's own momz spring
      // is (`P_AproxDistance(dest - actor) / speed`) — not by a launch-time
      // budget this flight no longer has.
      const remaining = Math.max(Math.hypot(target.x - homing.x, target.y - homing.y), step);
      homing.z += (target.z + TRACER_HOMING_Z_OFFSET - homing.z) * Math.min(1, step / remaining);
    }
    const fromX = homing.x;
    const fromY = homing.y;
    const fromZ = homing.z;
    homing.x += Math.cos(homing.headingRad) * step;
    homing.y += Math.sin(homing.headingRad) * step;
    const wall = projectileStepBlocker(world, { x: fromX, y: fromY, z: fromZ }, { x: homing.x, y: homing.y, z: homing.z });
    if (wall) {
      homing.x = wall.x;
      homing.y = wall.y;
      homing.z = wall.z;
      p.lineIndex = wall.lineIndex;
      p.traveled = p.maxDist;
      return { x: homing.x, y: homing.y, z: homing.z };
    }
    // Meeting the floor or ceiling is deliberately *not* decided here — it is
    // `update`'s `hitGround`, on the sector lookup it already makes. See
    // docs/monsterattacks.md § Monster projectiles in flight.

    // The smoke trail — see SMOKE_TRAIL_INTERVAL's doc for why this only
    // ever runs for a shot that already won the homingBias roll.
    homing.smokeTimer += dt;
    if (homing.smokeTimer >= SMOKE_TRAIL_INTERVAL) {
      homing.smokeTimer -= SMOKE_TRAIL_INTERVAL;
      this.effects.spawnImpact('PUFF', SMOKE_TRAIL_FRAMES, SMOKE_TRAIL_FRAME_SECONDS, {
        x: homing.x,
        y: homing.y,
        z: homing.z,
      });
    }
    return { x: homing.x, y: homing.y, z: homing.z };
  }

  /**
   * Vanilla's `A_BFGSpray`, fired once when the player's BFG ball arrives.
   * `travelAngleRad` is the ball's fixed flight angle, and the rays trace from
   * the player's **current** position rather than the impact point. Each ray
   * is an independent, undiminished hit with no dedupe against a body several
   * rays already caught, and each spawns an `MT_EXTRABFG` burst. No-op once
   * the player is dead. See docs/combat.md § Splash and the BFG.
   */
  private resolveBfgSpray(
    travelAngleRad: number,
    spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number },
  ): void {
    if (this.ctx.playerDead) return;
    const { things, player } = this.ctx;
    const origin: Pos3 = { x: player.x, y: player.y, z: player.z + AIM_HEIGHT_OFFSET };
    const arcRad = (spray.arcDeg * Math.PI) / 180;
    const startRad = travelAngleRad - arcRad / 2;
    const stepRad = spray.rays > 1 ? arcRad / spray.rays : 0;
    for (let i = 0; i < spray.rays; i++) {
      const hit = things?.raycastMonster(origin, startRad + stepRad * i, spray.range) ?? null;
      if (!hit) continue;
      let damage = 0;
      for (let j = 0; j < spray.diceRolls; j++) damage += rollDamage(spray.diceSides, 1);
      // Vanilla's inflictor is the ball itself, by then far from the player;
      // this engine doesn't track where it stopped, so `origin` stands in.
      things?.damage(hit.id, damage, undefined, undefined, origin.x, origin.y);
      // MT_EXTRABFG spawns at `linetarget->height>>2`; with no per-species
      // height table, `MONSTER_FIRE_HEIGHT` is the same stand-in used elsewhere.
      this.effects.spawnImpact('BFE2', BFG_SPRAY_HIT_FRAMES, IMPACT_FRAME_SECONDS, {
        x: hit.x,
        y: hit.y,
        z: hit.z + MONSTER_FIRE_HEIGHT,
      });
    }
  }
}
