/**
 * `ProjectileLayer`: player and monster missiles in flight — stepping, homing, collision against
 * things and geometry, and handing impacts to combat. See docs/combat.md § How a projectile finds
 * its target and docs/monster-attacks.md.
 */
import { SpriteAnimator, VIEWER_ANGLE_DEG, type SpriteMaterialCache } from '../render/sprites.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import { playerOrigin, type SoundEmitter } from '../audio/sfx.ts';
import { playerShotRange, type ShotPath } from './world.ts';
import { transfersOf } from './specials/transfers.ts';
import { AIM_HEIGHT_OFFSET, MISSILE_HEIGHT_OFFSET, PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
import {
  MONSTER_LOCK_HEIGHT,
  MONSTER_HIT_RADIUS,
  sameSpecies,
  type MonsterAttackEvent,
} from './monsters/defs.ts';
import { PLAYER_MELEE_RANGE, type Shot } from './weapons.ts';
import { DOOM_TIC } from '../constants.ts';
import { rollDamage } from '../util/random.ts';
import { applyRadiusDamage, fallbackPlayer, livingPlayer, targetMonster, type CombatContext } from './combat.ts';
import type { ProjectileSnapshot } from './snapshot.ts';
import type { SpriteFxLayer } from './spritefx.ts';
import { stepTouchesBody, turnToward, type Projectile } from './spritefx/defs.ts';
import { BFG_SPRAY_HIT_FRAMES, IMPACT_EFFECTS, IMPACT_FRAME_SECONDS, PROJECTILE_FRAMES, PROJECTILE_RADIUS, PROJECTILE_RADIUS_DEFAULT, PROJECTILE_SOUNDS, REVENANT_TRACER_TURN_RATE_RAD, SMOKE_TRAIL_FRAME_SECONDS, SMOKE_TRAIL_FRAMES, SMOKE_TRAIL_INTERVAL, TRACER_COLOR, TRACER_HOMING_Z_OFFSET } from './spritefx/tables.ts';
import type { Pos3 } from '../types.ts';
import { slotOfTarget, targetOfSlot, type MonsterRef } from './things/defs.ts';
import { vecLength } from '../util/geom.ts';
import { atan2, cos, sin } from '../util/fdlibm.ts';

/**
 * The banks a `ProjectileLayer` draws and sounds a missile through, beside the world it flies in.
 */
export interface ProjectileLayerOptions {
  effects: SpriteFxLayer;
  spriteBank: SpriteBank;
  spriteMaterials: SpriteMaterialCache;
  audio: SoundEmitter;
}

/**
 * Every shot in flight, from launch to whatever it lands on. Who *decides* to fire is somebody
 * else's business (`weapons.ts`, `monsters/ai.ts`); this half knows nothing about ammo, cooldowns
 * or AI, only geometry and bodies. See docs/weapons.md § WeaponSystem for the split.
 */
export class ProjectileLayer {
  private ctx: CombatContext;
  private effects: SpriteFxLayer;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  private audio: SoundEmitter;
  private projectiles: Projectile[] = [];
  /**
   * Where the projectile being advanced stood before this frame's step — a
   * single reused object, deliberately: it is read and discarded inside one
   * iteration of `update`'s loop, which runs for every shot in the air and can
   * be four figures of them on a crowded map.
   */
  private readonly stepFrom: Pos3 = { x: 0, y: 0, z: 0 };
  /** `draw`'s interpolated position, reused per missile for the same reason `stepFrom` is. */
  private readonly drawAt: Pos3 = { x: 0, y: 0, z: 0 };

  constructor(ctx: CombatContext, options: ProjectileLayerOptions) {
    this.ctx = ctx;
    this.effects = options.effects;
    this.spriteBank = options.spriteBank;
    this.spriteMaterials = options.spriteMaterials;
    this.audio = options.audio;
  }

  /**
   * Drops everything still in flight — a missile that outlives its level would otherwise arrive in
   * the next one.
   */
  beginLevel(): void {
    this.projectiles = [];
  }

  /**
   * Every shot still in flight, minus its animator (rebuilt from `sprite` on restore) — for a
   * savegame.
   */
  snapshot(): ProjectileSnapshot[] {
    return this.projectiles.map(({ anim: _anim, ...rest }) => structuredClone(rest));
  }

  /**
   * Rebuilds the in-flight list from a save, re-arming each missile's animator
   * the same way `spawnPlayerShot`/`spawnMonsterShot` do. A sprite this WAD
   * set can't draw is dropped silently — unlike a thing, a missile owns no ID
   * anything else references. docs/savegames.md § Apply order.
   */
  restore(saved: ProjectileSnapshot[]): void {
    this.projectiles = [];
    for (const s of saved) {
      const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, s.sprite, PROJECTILE_FRAMES[s.sprite]);
      if (!anim.resolve(0, VIEWER_ANGLE_DEG)) continue;
      this.projectiles.push({ ...structuredClone(s), anim });
    }
  }

  /**
   * Turns one fired `Shot` (game/weapons.ts) into a tracer line or a flying projectile sprite. It
   * starts at the player's own fire height, never the target's, and slopes toward the locked-on
   * monster's mid-body; `shotPath` resolves both the slope and where the shot gets to. A missile
   * leaves four units lower than a bullet.
   *
   * **Hit-or-miss is settled here only for a hitscan pellet** — a projectile leaves with no target
   * and re-tests what it has run into every frame (`ProjectileLayer.update`). `lineAim` is the
   * other thing aim can lock onto, a point on a shoot-triggered wall
   * (`SpecialsController.pickShootTarget`): it supplies the slope the way a body does but no
   * `ShotLock`, there being no silhouette to open a wedge around.
   * docs/combat.md § Where a missile starts, § How a shot deals damage.
   */
  spawnPlayerShot(shot: Shot, target: MonsterRef | null, lineAim: Pos3 | null, shooter: number): void {
    const { world, things } = this.ctx;
    const player = this.ctx.slots[shooter].player;
    const fireHeight = shot.kind === 'projectile' ? MISSILE_HEIGHT_OFFSET : AIM_HEIGHT_OFFSET;
    const origin: Pos3 = { x: player.x, y: player.y, z: player.z + fireHeight };

    // A swing never travels, so it skips `shotPath`: `A_Punch`/`A_Saw` just trace MELEERANGE
    // along the facing. Aim already points at a hovered monster, so the ray needs no lock case.
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
        things?.damage(swung.id, shot.damage, { from: origin, slot: shooter });
      }
      // A_Punch/A_Saw both key their sound off whether they found a target: the
      // chainsaw revs on air and bites on contact, the fist is silent on a miss.
      const sound = swung ? shot.hitSound : shot.missSound;
      if (sound) this.audio.play(sound, origin, playerOrigin(shooter));
      return;
    }

    const range = playerShotRange(shot.kind, target, world.mapSpan);
    // Zero for every other weapon; `shotPath` adds it after the wedge has
    // clamped the aim, as `A_FireShotgun2` adds it to the finished
    // `bulletslope` (docs/combat.md § shotPath).
    const slopeOffset = shot.kind === 'hitscan' ? shot.slopeOffset : 0;
    // The body's centre and half-height, which is where vanilla's `aimslope`
    // points on a clear target — see docs/combat.md § Auto-aim.
    const half = target === null ? 0 : target.height / 2;
    const aimAt = target === null ? lineAim : { x: target.x, y: target.y, z: target.z + half };
    const lock = target === null ? null : { halfHeight: half, slopeOffset };
    const path = world.shotPath(origin, shot.angleRad, aimAt, range, lock);

    if (shot.kind === 'hitscan') {
      const dirX = cos(shot.angleRad);
      const dirY = sin(shot.angleRad);
      // A locked pellet connects only if nothing stopped it short of the target *and* this
      // pellet's own line crosses the target's body, sideways and in height: the lock supplies the
      // slope, not a guaranteed hit. One that fails falls through to `raycastMonster` below, which
      // tests that same body at its real width. docs/combat.md § How a shot deals damage.
      let hitMonsterId: number | null = null;
      let endX = path.x;
      let endY = path.y;
      if (target !== null) {
        const relX = target.x - origin.x;
        const relY = target.y - origin.y;
        const along = relX * dirX + relY * dirY;
        const perp = Math.abs(relX * dirY - relY * dirX);
        const missZ = Math.abs(slopeOffset) * along;
        const onBody = perp <= MONSTER_HIT_RADIUS && missZ <= MONSTER_LOCK_HEIGHT / 2;
        if (onBody && along >= 0 && path.dist >= along - 1) {
          hitMonsterId = target.id;
          endX = origin.x + dirX * along;
          endY = origin.y + dirY * along;
        }
      }
      if (hitMonsterId === null) {
        // No lock, or a pellet the spread threw off it: test the path against every monster's
        // body, so one standing between the player and the wall they're shooting at isn't
        // invisible to the shot. Only ever shortens the shot, never past `path.dist`.
        // A pellet thrown off a *locked* target carries the slope the lock resolved, so a body
        // blocks it only where the line genuinely crosses one — which is what lets the super
        // shotgun's vertical spread miss; a shot with no lock keeps the aim cone.
        // docs/combat.md § The vertical test.
        const slope = target !== null && path.dist > 0 ? path.slope : undefined;
        const monsterHit = things?.raycastMonster(origin, shot.angleRad, path.dist, { slope }) ?? null;
        if (monsterHit) {
          hitMonsterId = monsterHit.id;
          endX = monsterHit.x;
          endY = monsterHit.y;
        }
      }

      // Every shoot line the pellet crossed, and the wall it stopped at when it
      // got that far — a body absorbing the bolt shortens the trace, it does not
      // spare the lines in front of that body. A hitscan pellet resolves this
      // frame so it fires here; a projectile's is deferred to arrival (see
      // `Projectile.lineIndex`).
      this.ctx.triggerShotPath(origin, { x: endX, y: endY }, hitMonsterId === null ? path.lineIndex : null, shooter);
      if (hitMonsterId !== null) {
        // Where the tracer stops is where the bolt met the body, so the same
        // point is the splash's — `PTR_ShootTraverse` spawns blood on the
        // trace, a touch short of the thing it hit.
        const hitAt = { x: endX, y: endY, z: path.z };
        if (things?.bleeds(hitMonsterId)) this.effects.spawnBlood(hitAt, shot.damage);
        else this.effects.spawnPuff(hitAt);
        things?.damage(hitMonsterId, shot.damage, { from: origin, slot: shooter });
      } else {
        this.effects.spawnWallPuff(path, shot.angleRad);
      }
      this.effects.addTracer(origin, { x: endX, y: endY, z: path.z }, TRACER_COLOR, PLAYER_RADIUS);
      return;
    }

    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, shot.sprite, PROJECTILE_FRAMES[shot.sprite]);
    if (!anim.resolve((shot.angleRad * 180) / Math.PI, VIEWER_ANGLE_DEG)) return;
    // The missile's own seesound, with no origin: every shot is its own mobj in
    // vanilla, so a burst of plasma layers rather than cutting itself off.
    const launch = PROJECTILE_SOUNDS[shot.sprite]?.launch;
    if (launch) this.audio.play(launch, origin);
    const radius = PROJECTILE_RADIUS[shot.sprite] ?? PROJECTILE_RADIUS_DEFAULT;
    // The wall, never the target: like `P_SpawnMissile`, the lock fixed this shot's slope at
    // launch and it flies on under its own momentum.
    // docs/monster-attacks.md § Monster projectiles in flight.
    const flight = missileFlight(path, origin.z, radius);
    const missile: Projectile = {
      anim,
      originX: origin.x,
      originY: origin.y,
      startZ: origin.z,
      endZ: flight.endZ,
      angleRad: shot.angleRad,
      speed: shot.speed,
      maxDist: flight.maxDist,
      traveled: 0,
      sprite: shot.sprite,
      radius,
      damage: shot.damage,
      splash: shot.splash,
      spray: shot.spray,
      sourceId: targetOfSlot(shooter),
      sourceType: 0,
      lineIndex: path.lineIndex,
      // The first drawn frame sits at the launch point rather than interpolating in from the
      // world origin; `checkMissileSpawn` then moves that point half a tic forward.
      drawX: origin.x,
      drawY: origin.y,
      drawZ: origin.z,
      drawPrevX: origin.x,
      drawPrevY: origin.y,
      drawPrevZ: origin.z,
      drawAngleRad: shot.angleRad,
      drawLight: 128,
    };
    this.checkMissileSpawn(missile);
    this.projectiles.push(missile);
  }

  /**
   * Turns a monster's fired ranged `MonsterAttackEvent` into a flying `Projectile`. The target
   * (`atk.targetId`, resolved live) sets the missile's *slope* and nothing else, so the flight ends
   * at a wall rather than where the target was standing — `P_SpawnMissile`.
   * See docs/monster-attacks.md § Monster projectiles in flight.
   */
  spawnMonsterShot(atk: MonsterAttackEvent): void {
    if (!atk.projectiles) return;
    const { world } = this.ctx;
    const victim = targetMonster(this.ctx, atk.targetId);
    // The aim point rides `MISSILE_HEIGHT_OFFSET` above the target's feet, which is
    // the launch's own height above the shooter's — so the flight is parallel to
    // `P_SpawnMissile`'s feet-to-feet slope and passes the target that same height
    // up. docs/monster-attacks.md § Monster projectiles in flight.
    const body = victim ?? fallbackPlayer(this.ctx, atk.targetId);
    const target = { x: body.x, y: body.y, z: body.z + MISSILE_HEIGHT_OFFSET };
    // Almost always one entry; the mancubus fires two per volley (see `MonsterAttack.projectiles`),
    // each spawned independently. `target` is loop-invariant, so the pair shares one slope and only
    // its heading is deflected. docs/monster-attacks.md § Monster projectiles in flight.
    for (const proj of atk.projectiles) {
      const path = world.shotPath(atk, proj.angleRad, target, world.mapSpan, null);
      const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, proj.sprite, PROJECTILE_FRAMES[proj.sprite]);
      if (!anim.resolve((proj.angleRad * 180) / Math.PI, VIEWER_ANGLE_DEG)) continue;
      const launch = PROJECTILE_SOUNDS[proj.sprite]?.launch;
      if (launch) this.audio.play(launch, atk);
      const radius = PROJECTILE_RADIUS[proj.sprite] ?? PROJECTILE_RADIUS_DEFAULT;
      const flight = missileFlight(path, atk.z, radius);
      const missile: Projectile = {
        anim,
        originX: atk.x,
        originY: atk.y,
        startZ: atk.z,
        endZ: flight.endZ,
        angleRad: proj.angleRad,
        speed: proj.speed,
        maxDist: flight.maxDist,
        traveled: 0,
        sprite: proj.sprite,
        radius,
        damage: atk.damage,
        splash: proj.splash ? { radius: proj.splash.radius, damage: proj.splash.damage, hitsPlayer: true } : null,
        spray: null,
        sourceId: atk.sourceId,
        sourceType: atk.sourceType,
        lineIndex: path.lineIndex,
        drawX: atk.x,
        drawY: atk.y,
        drawZ: atk.z,
        drawPrevX: atk.x,
        drawPrevY: atk.y,
        drawPrevZ: atk.z,
        drawAngleRad: proj.angleRad,
        drawLight: 128,
        homing: proj.homing
          ? { targetId: atk.targetId, x: atk.x, y: atk.y, z: atk.z, headingRad: proj.angleRad, smokeTimer: 0 }
          : undefined,
      };
      this.checkMissileSpawn(missile);
      this.projectiles.push(missile);
    }
  }

  /**
   * Vanilla's `P_CheckMissileSpawn` (`p_mobj.c`): a missile is moved half a tic of its own momentum
   * forward the instant it is spawned, before anything draws or tests it, so it leaves the
   * shooter's body instead of appearing inside it. Clamped to the flight `shotPath` resolved, which
   * stands in for vanilla's `P_TryMove` failing there. docs/combat.md § Where a missile starts.
   */
  private checkMissileSpawn(p: Projectile): void {
    const nudge = Math.min((p.speed * DOOM_TIC) / 2, p.maxDist);
    if (nudge <= 0) return;
    p.traveled = nudge;
    const at = pointAlong(p, nudge, cos(p.angleRad), sin(p.angleRad), { x: 0, y: 0, z: 0 });
    p.drawX = at.x;
    p.drawY = at.y;
    p.drawZ = at.z;
    p.drawPrevX = p.drawX;
    p.drawPrevY = p.drawY;
    p.drawPrevZ = p.drawZ;
    // A revenant's tracer curves from its own live position rather than along `angleRad`, so its
    // start has to move with the rest.
    if (p.homing) {
      p.homing.x = p.drawX;
      p.homing.y = p.drawY;
      p.homing.z = p.drawZ;
    }
  }

  /**
   * Advances every in-flight projectile — along the fixed straight line `shotPath` resolved for it,
   * sloped from `startZ` to `endZ`, or along the revenant tracer's own curve — and resolves what it
   * ran into on the way. On arrival it removes the shot, plays its `IMPACT_EFFECTS` explosion in
   * place and applies `p.splash` whether or not a body was hit. **Every projectile, the player's
   * own included, re-tests live bodies each frame**, swept across the whole step rather than
   * sampled at its end (docs/monster-attacks.md § Monster projectiles in flight).
   *
   * Must run inside the caller's `SpriteFxLayer.beginFrame`/`endFrame` pair: it both draws through
   * the batch and pushes this frame's new explosions and smoke puffs on for `draw`.
   */
  update(dt: number): void {
    if (this.projectiles.length === 0) return;
    const { world, things } = this.ctx;
    const remaining: Projectile[] = [];
    const from = this.stepFrom;
    // Hoisted: the sprite light of every missile in the air is looked up here
    // each frame, and the table is per level (docs/specials-transfers.md § Transferred lighting).
    const transfers = transfersOf(world.map);
    for (const p of this.projectiles) {
      let at: Pos3;
      if (p.homing) {
        from.x = p.homing.x;
        from.y = p.homing.y;
        from.z = p.homing.z;
        at = this.advanceHoming(p, dt);
      } else {
        const dirX = cos(p.angleRad);
        const dirY = sin(p.angleRad);
        pointAlong(p, Math.min(p.traveled, p.maxDist), dirX, dirY, from);
        p.traveled += p.speed * dt;
        at = pointAlong(p, Math.min(p.traveled, p.maxDist), dirX, dirY, { x: 0, y: 0, z: 0 });
      }

      const fromMonster = p.sourceId >= 0;
      // One lookup, shared with the sprite light below — `floorAt`/`ceilingAt`
      // are two wrappers around the same BSP walk, and this runs per missile
      // per frame with a crowded map holding thousands in the air.
      const sectorIndex = world.sectorIndexAt(at.x, at.y);
      const sector = world.map.sectors[sectorIndex];
      const arrived = p.traveled >= p.maxDist;
      // Reaching the wall `shotPath` found. Range simply running out is not that — nothing stopped
      // such a missile, so it does not suppress the floor test below.
      const hitWall = arrived && p.lineIndex !== null;
      // A missile meeting the floor or ceiling explodes against it, every missile including the
      // player's own; a wall beats the floor on the tic both would answer to.
      // docs/combat.md § Where an impact sits, docs/monster-attacks.md § Monster projectiles in
      // flight.
      const hitGround = !hitWall && !!sector && (at.z <= sector.floorHeight || at.z >= sector.ceilHeight);
      const struckSlot = fromMonster ? this.playerStruckBy(p, from, at) : -1;
      const reachedPlayer = struckSlot >= 0;
      const struck = reachedPlayer ? null : this.bodyStruckBy(p, from, at);

      if (reachedPlayer || struck || hitGround || arrived) {
        if (reachedPlayer) {
          this.ctx.damageSlot(struckSlot, p.damage, at.x, at.y, p.sourceType);
        } else if (struck) {
          // `struck.id === null` is the same-species fizzle: the body stopped
          // the missile but takes no damage from it (see bodyStruckBy).
          if (struck.id !== null) {
            const source = fromMonster ? { id: p.sourceId, type: p.sourceType } : undefined;
            const slot = fromMonster ? undefined : slotOfTarget(p.sourceId);
            things?.damage(struck.id, p.damage, { source, slot, from: at });
          }
        }
        // A clean miss arrived at the wall `shotPath` found at launch, so its shoot special fires
        // now rather than back then; one stopped by the floor never got there.
        // docs/combat.md § Shoot-triggered specials.
        else if (!hitGround) this.ctx.triggerShot(p.lineIndex, fromMonster ? null : slotOfTarget(p.sourceId));
        if (p.splash) {
          // Attributed to the firing monster (if any), the same as a direct
          // hit already is — a cyberdemon's own rocket splash should start
          // an infight exactly like one of its direct hits would.
          applyRadiusDamage(this.ctx, at, {
            radius: p.splash.radius,
            maxDamage: p.splash.damage,
            hitsPlayer: p.splash.hitsPlayer,
            source: fromMonster ? { id: p.sourceId, type: p.sourceType } : undefined,
            slot: fromMonster ? undefined : slotOfTarget(p.sourceId),
            // No `source` means the shot is the player's own, which is the one
            // splash that can kill them without anyone else being involved.
            cause: fromMonster ? p.sourceType : 'self',
          });
        }
        // Only ever set for the player's own BFG ball (spawnMonsterShot
        // always passes spray: null) — see resolveBfgSpray's doc.
        if (p.spray) this.resolveBfgSpray(p.angleRad, p.spray, slotOfTarget(p.sourceId));
        // P_ExplodeMissile's own deathsound, wherever the flight actually ended.
        const explode = PROJECTILE_SOUNDS[p.sprite]?.explode;
        if (explode) this.audio.play(explode, at);
        const impact = IMPACT_EFFECTS[p.sprite];
        if (impact) this.effects.spawnImpact(impact.sprite, impact.frames, IMPACT_FRAME_SECONDS, at);
        continue;
      }
      // A homing missile's sprite tracks its live, turning heading rather
      // than the fixed launch angle every other projectile keeps.
      p.drawAngleRad = p.homing?.headingRad ?? p.angleRad;
      p.anim.advance(dt, true);
      // Re-read every tic, not just at launch — a missile flying between
      // differently-lit sectors should shade like everything else does.
      p.drawLight = sector ? transfers.spriteLight(sectorIndex) : 128;
      // `from` is shared scratch reused across projectiles, so the previous
      // position has to be copied out per missile rather than referenced.
      p.drawPrevX = from.x;
      p.drawPrevY = from.y;
      p.drawPrevZ = from.z;
      p.drawX = at.x;
      p.drawY = at.y;
      p.drawZ = at.z;
      remaining.push(p);
    }
    this.projectiles = remaining;
  }

  /**
   * Draws every missile still in flight, `alpha` of the way along the step its
   * last `update` took. Must run inside the caller's
   * `SpriteFxLayer.beginFrame`/`endFrame` pair, same as `update`.
   * docs/frameloop.md § Interpolation.
   */
  draw(alpha: number): void {
    for (const p of this.projectiles) {
      this.drawAt.x = p.drawPrevX + (p.drawX - p.drawPrevX) * alpha;
      this.drawAt.y = p.drawPrevY + (p.drawY - p.drawPrevY) * alpha;
      this.drawAt.z = p.drawPrevZ + (p.drawZ - p.drawPrevZ) * alpha;
      this.effects.batchSprite(p.anim, this.drawAt, (p.drawAngleRad * 180) / Math.PI, p.drawLight);
    }
  }

  /**
   * Whether this frame's step carried a *monster's* missile into the player —
   * vanilla's `PIT_CheckThing` against `MT_PLAYER`, swept over the step rather
   * than sampled at its end. Contact is the player's own 16-unit box widened by
   * the missile's `mobjinfo.radius`, and the height band is `PIT_CheckThing`'s
   * asymmetric over/under pair, not a tolerance either side of the feet.
   */
  private playerStruckBy(p: Projectile, from: Pos3, at: Pos3): number {
    const { world, slots } = this.ctx;
    for (let slot = 0; slot < slots.length; slot++) {
      const { player, dead } = slots[slot];
      if (dead || stepTouchesBody(from, at, player, PLAYER_RADIUS, PLAYER_HEIGHT, p.radius) === null) continue;
      // Proximity alone isn't arrival, and the trace runs player→projectile, not
      // the other way round — docs/monster-attacks.md § Monster projectiles in
      // flight. Last in the chain so it only runs once the cheap tests passed.
      if (world.hasLineOfSight(player, at)) return slot;
    }
    return -1;
  }

  /**
   * What this frame's step carried the projectile into, or null if it hit
   * nothing. A non-null result always ends the flight; `id` is who takes the
   * direct damage, or **null for a same-species body that stops the missile
   * without being hurt by it** (a monster's shot only — the player is nobody's
   * species). Candidates resolve first-along-the-step, the swept equivalent of
   * vanilla's blockmap order. See docs/monster-ai.md § Infighting.
   */
  private bodyStruckBy(p: Projectile, from: Pos3, at: Pos3): { id: number | null } | null {
    let nearest: { id: number | null } | null = null;
    let nearestT = Infinity;
    for (const m of this.ctx.things?.monstersAlongStep(from, at, p.radius) ?? []) {
      // Vanilla's `thing == tmthing->target`: a missile never collides with
      // whoever fired it, so it can leave its own shooter's body. `sourceId` is
      // null for the player's, who is not in this list to begin with.
      if (m.id === p.sourceId) continue;
      const t = stepTouchesBody(from, at, m, m.radius, m.height, p.radius);
      if (t === null || t >= nearestT) continue;
      // Same wall check `playerStruckBy` needs, and for the same reason — see
      // its comment. Traced from the monster for the same `SELF_HIT_MARGIN`
      // reason, and last so it only runs on an already-close candidate.
      if (!this.ctx.world.hasLineOfSight(m, at)) continue;
      nearestT = t;
      nearest = { id: p.sourceId >= 0 && sameSpecies(p.sourceType, m.type) ? null : m.id };
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
   * docs/monster-attacks.md § The revenant's homing missile.
   */
  private advanceHoming(p: Projectile, dt: number): Pos3 {
    const { world, slots } = this.ctx;
    const homing = p.homing!;
    const step = p.speed * dt;
    const target: Pos3 | null =
      homing.targetId < 0 ? livingPlayer(slots[slotOfTarget(homing.targetId)]) : targetMonster(this.ctx, homing.targetId);
    if (target) {
      const bearing = atan2(target.y - homing.y, target.x - homing.x);
      homing.headingRad = turnToward(homing.headingRad, bearing, REVENANT_TRACER_TURN_RATE_RAD * dt);
      // Paced by the live distance still to cover, as vanilla's own momz spring
      // is (`P_AproxDistance(dest - actor) / speed`) — not by a launch-time
      // budget this flight no longer has.
      const remaining = Math.max(vecLength(target.x - homing.x, target.y - homing.y), step);
      homing.z += (target.z + TRACER_HOMING_Z_OFFSET - homing.z) * Math.min(1, step / remaining);
    }
    const fromX = homing.x;
    const fromY = homing.y;
    const fromZ = homing.z;
    homing.x += cos(homing.headingRad) * step;
    homing.y += sin(homing.headingRad) * step;
    const wall = world.projectileStepBlocker({ x: fromX, y: fromY, z: fromZ }, { x: homing.x, y: homing.y, z: homing.z });
    if (wall) {
      // `missileFlight`'s standoff, applied where this flight meets its own wall instead:
      // `projectileStepBlocker` reports the plane. Never back past where this step began. Height is
      // left alone — a homing missile eases its z per step and has no launch slope to walk back.
      const back = Math.min(p.radius, vecLength(wall.x - fromX, wall.y - fromY));
      homing.x = wall.x - cos(homing.headingRad) * back;
      homing.y = wall.y - sin(homing.headingRad) * back;
      homing.z = wall.z;
      p.lineIndex = wall.lineIndex;
      p.traveled = p.maxDist;
      return { x: homing.x, y: homing.y, z: homing.z };
    }
    // Meeting the floor or ceiling is deliberately *not* decided here — it is
    // `update`'s `hitGround`, on the sector lookup it already makes. See
    // docs/monster-attacks.md § Monster projectiles in flight.

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
    shooter: number,
  ): void {
    const player = livingPlayer(this.ctx.slots[shooter]);
    if (!player) return;
    const { things } = this.ctx;
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
      things?.damage(hit.id, damage, { from: origin, slot: shooter });
      // `A_BFGSpray` spawns MT_EXTRABFG at `linetarget->height>>2`, which the
      // body's own `mobjinfo.height` gives exactly.
      this.effects.spawnImpact('BFE2', BFG_SPRAY_HIT_FRAMES, IMPACT_FRAME_SECONDS, {
        x: hit.x,
        y: hit.y,
        z: hit.z + hit.height / 4,
      });
    }
  }
}

/**
 * The point `dist` along a straight flight, written into `out`: the origin plus the heading, with
 * the height lerped over the whole flight. `dirX`/`dirY` are `angleRad`'s own cosine and sine,
 * passed in because `update` resolves them once for the two ends of a step.
 */
function pointAlong(p: Projectile, dist: number, dirX: number, dirY: number, out: Pos3): Pos3 {
  out.x = p.originX + dirX * dist;
  out.y = p.originY + dirY * dist;
  out.z = p.startZ + (p.endZ - p.startZ) * (p.maxDist > 0 ? dist / p.maxDist : 1);
  return out;
}

/**
 * Where a straight missile's flight ends: `shotPath`'s distance, less the missile's radius when a
 * wall is what stopped it. The standoff belongs to the flight, not to a correction applied where
 * the flight is read. Height comes from `ShotPath.slope`, since shortening the distance alone would
 * steepen the flight — `pointAlong` lerps `startZ`→`endZ` over `maxDist`.
 * docs/combat.md § Where an impact sits.
 */
function missileFlight(path: ShotPath, startZ: number, radius: number): { maxDist: number; endZ: number } {
  const maxDist = path.lineIndex === null ? path.dist : Math.max(0, path.dist - radius);
  return { maxDist, endZ: startZ + path.slope * maxDist };
}
