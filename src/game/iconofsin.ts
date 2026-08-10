import type { DoomMap, Thing } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import { SpriteAnimator, VIEWER_ANGLE_DEG, type SpriteMaterialCache } from '../render/sprites.ts';
import { hasLineOfSight } from './world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
import { SPAWN_CUBE_MONSTERS } from './thingdefs.ts';
import { ThingType } from './thingtypes.ts';
import { TELEFRAG_DAMAGE } from './things.ts';
import { triangularDraw } from './weapons.ts';
import type { CombatContext } from './combat.ts';
import type { SpriteFxLayer } from './spritefx.ts';
import { SILENT, type SoundEmitter } from '../audio/sfx.ts';
import type { Skill } from './skill.ts';
import type { Pos3 } from '../types.ts';
import { DOOM_TIC } from '../constants.ts';
import { pRandom } from '../util/random.ts';

/**
 * Three `ThingType` members drive this file. `bossShooter` (`MT_BOSSSPIT`) is the invisible eye that
 * does the spitting, and the *only* thing that makes a map an Icon of Sin map; `bossTarget` is where
 * a cube is aimed, `bossBrain` the shootable target itself. The first two are
 * `MF_NOBLOCKMAP|MF_NOSECTOR` in `info.c` and neither has a sprite of its own, which is why both
 * stay out of `THING_SPRITES` and are read straight off `map.things` here — the same treatment
 * `SpecialsController.findTeleportDestination` gives the teleport-landing marker.
 */

/**
 * Where the eye sights from, above its own floor: `MT_BOSSSPIT`'s `mobjinfo.height` of 32, less the
 * `height >> 2` `P_CheckSight` docks off its `sightzstart`.
 *
 * `hasLineOfSight` always lifts the origin it is handed by a player-sized eye height, which is the
 * right approximation for everything else in the game and wrong for a 32-tall thing sitting in a
 * 32-tall ceiling slot — it would sight from *above* its own ceiling. `PLAYER_EYE_LIFT` cancels that
 * lift back out so the wedge really starts inside the slot. See docs/monster-iconofsin.md § Waking the eye.
 */
const SHOOTER_SIGHT_Z = 32 - (32 >> 2);
const PLAYER_EYE_LIFT = PLAYER_HEIGHT * 0.75;

/** `S_BRAINEYESEE`'s own 181 tics: how long after waking the eye takes to spit the first cube. */
const FIRST_SPIT_DELAY = 181 * DOOM_TIC;
/** `S_BRAINEYE1` loops on itself every 150 tics, one `A_BrainSpit` per pass. */
const SPIT_INTERVAL = 150 * DOOM_TIC;

/** `MT_SPAWNSHOT`'s `mobjinfo.speed` of 10 map units per tic. */
const CUBE_SPEED = 10 * 35;
/** `S_SPAWN1`-`S_SPAWN4` — four fullbright `BOSF` frames, 3 tics each. */
const CUBE_FRAMES = ['A', 'B', 'C', 'D'];
const CUBE_FRAME_SECONDS = 3 * DOOM_TIC;
/**
 * `A_SpawnSound` sits on `S_SPAWN1` alone and that four-state chain loops, so `boscub` restarts
 * once per full cycle rather than once per frame — the cube's audible whoosh as it crosses the room.
 */
const CUBE_SOUND_INTERVAL = CUBE_FRAMES.length * CUBE_FRAME_SECONDS;
/**
 * Sector light a cube and its landing fire draw at. Both carry vanilla's fullbright frame bit
 * (`32768 | frame` in `states[]`), so neither shades with the room it happens to be crossing.
 */
const FULLBRIGHT = 255;

/** `MT_SPAWNFIRE`: `S_SPAWNFIRE1`-`8`, eight fullbright `FIRE` frames at 4 tics. */
const SPAWN_FIRE_FRAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const SPAWN_FIRE_FRAME_SECONDS = 4 * DOOM_TIC;

/**
 * The radius the *player* is telefragged against when a cube lands. Every type in
 * `SPAWN_CUBE_MONSTERS` has a `mobjinfo.radius` between 20 and 48, and the spawned body's own
 * `blockRadius` is what covers the monster half inside `ThingLayer.spawnMonster`; one mid-range
 * value for the player half keeps a spawn spot uniformly lethal to stand on, rather than lethal
 * only when the lottery happens to pick a fat monster.
 */
const PLAYER_TELEFRAG_RADIUS = 32;

/**
 * `S_BRAIN_DIE1`-`4` add up to 120 tics between the brain dying and `A_BrainDie` calling
 * `G_ExitLevel` — the pause the explosion cascade fills.
 */
const BRAIN_DEATH_TO_EXIT = (100 + 10 + 10) * DOOM_TIC;
/**
 * `A_BrainScream`'s literals: a row of explosions from `x - 196` to `x + 320` in steps of 8, all at
 * `y - 320`, each at a height of `128 + rnd(0..255) * 2`.
 */
const SCREAM_X_FROM = -196;
const SCREAM_X_TO = 320;
const SCREAM_X_STEP = 8;
const SCREAM_Y_OFFSET = -320;
const SCREAM_Z_BASE = 128;
/** `A_BrainScream`'s `z = 128 + P_Random()*2`, so 128-638 map units over the floor. */
const SCREAM_Z_STEP = 2;
/** `A_BrainExplode`'s own follow-up burst: `(P_Random() - P_Random()) * 2048` is ±510 map units. */
const EXPLODE_X_SPREAD = 510;
/**
 * `S_BRAINEXPLODE1`-`3`: the rocket's own explosion frames at 10 tics, slower than the 4-tic
 * `IMPACT_FRAME_SECONDS` every other explosion in the game runs at.
 */
const EXPLODE_FRAMES = ['B', 'C', 'D'];
const EXPLODE_FRAME_SECONDS = 10 * DOOM_TIC;
/**
 * How often the death cascade re-fires while the exit is pending, and how many bursts each pass
 * spawns. Vanilla's chain is genuinely unbounded — every `A_BrainExplode` spawns another rocket
 * whose own chain ends in `A_BrainExplode` again — and only stops because the level ends underneath
 * it. Bounding it on the same exit timer reproduces what that looks like without an ever-growing
 * effect list.
 */
const EXPLODE_CHAIN_INTERVAL = 3 * EXPLODE_FRAME_SECONDS;
const EXPLODE_CHAIN_COUNT = 8;

/** One `MT_SPAWNSHOT` in flight. */
interface SpawnCube extends Pos3 {
  anim: SpriteAnimator;
  angleRad: number;
  /** The `MT_BOSSTARGET` it was aimed at — where it turns into a monster. */
  target: Pos3;
  /** Distance still to cover, this engine's stand-in for vanilla's launch-time `reactiontime`. */
  remaining: number;
  soundTimer: number;
}

/**
 * The Icon of Sin: the eye that spits cubes (`MT_BOSSSPIT`, doomednum 89), the cubes themselves
 * (`MT_SPAWNSHOT`), the monsters they turn into at a spawn spot (`MT_BOSSTARGET`, 87), and the
 * brain's own death cascade and the level exit it ends in.
 *
 * **Nothing here is gated on the map's name.** Vanilla's only gate is that the things exist, so a
 * PWAD that places 87/88/89 gets exactly this behavior, and every other map builds an instance
 * whose `update` returns immediately — no shooter, nothing to do.
 *
 * The brain itself is an ordinary `PosedThing`: `MONSTER_TYPES` member 88, shootable, with its pain
 * and death handled by `ThingLayer`'s `INERT_SHOOTABLE` branch. All this class adds is what happens
 * *after* it dies, which arrives through the same `onBossDeath` callback `A_BossDeath` uses.
 *
 * See docs/monster-iconofsin.md.
 */
export class IconOfSin {
  private map: DoomMap;
  private ctx: CombatContext;
  private effects: SpriteFxLayer;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  private sfx: SoundEmitter;
  private skill: Skill;
  private onExit: () => void;

  /** The eye, or null on a map with no `MT_BOSSSPIT` — which makes the whole class inert. */
  private shooter: Thing | null;
  /** `A_BrainAwake`'s `braintargets`, in map-thing order; filled on waking, exactly as vanilla does. */
  private targets: Pos3[] = [];
  /** `braintargeton` — the round-robin cursor into `targets`. */
  private targetIndex = 0;
  /**
   * `A_BrainSpit`'s file-scope `easy`, flipped on every call and used to skip every other spit on
   * the two lowest skills. Static in vanilla, so it also survives across levels there; per-instance
   * here, which can only differ on the very first spit of a freshly loaded map.
   */
  private easy = false;
  private awake = false;
  private spitTimer = 0;
  private cubes: SpawnCube[] = [];
  /** Counts down from `BRAIN_DEATH_TO_EXIT` once the brain dies; -1 while it's still alive. */
  private exitTimer = -1;
  private explodeTimer = 0;

  constructor(
    map: DoomMap,
    ctx: CombatContext,
    effects: SpriteFxLayer,
    spriteBank: SpriteBank,
    spriteMaterials: SpriteMaterialCache,
    skill: Skill,
    /** Vanilla's `G_ExitLevel`, the same callback `SpecialsController` is handed. */
    onExit: () => void,
    sfx: SoundEmitter = SILENT,
  ) {
    this.map = map;
    this.ctx = ctx;
    this.effects = effects;
    this.spriteBank = spriteBank;
    this.spriteMaterials = spriteMaterials;
    this.skill = skill;
    this.onExit = onExit;
    this.sfx = sfx;
    this.shooter = map.things.find((t) => t.type === ThingType.bossShooter) ?? null;
  }

  /**
   * `A_BrainDie` — routed in from `game.ts`'s `onBossDeath` fan-out once the last boss brain on the
   * level dies. Ignores every other doomednum; `SpecialsController` handles those.
   */
  notifyBossDeath(type: number): void {
    if (type !== ThingType.bossBrain || this.exitTimer >= 0) return;
    this.exitTimer = BRAIN_DEATH_TO_EXIT;
    this.explodeTimer = 0;
    this.brainScream();
  }

  /**
   * One frame of the whole sequence. **Must run inside the caller's
   * `SpriteFxLayer.beginFrame`/`endFrame` pair**: the cubes draw through that batch, exactly as
   * `ProjectileLayer.update` does.
   */
  update(dt: number): void {
    if (this.exitTimer >= 0) {
      this.updateExit(dt);
      return;
    }
    if (!this.shooter) return;
    if (!this.awake) {
      if (this.ctx.playerDead || !this.eyeNotices()) return;
      this.brainAwake();
      return;
    }
    this.spitTimer -= dt;
    if (this.spitTimer <= 0) {
      this.spitTimer += SPIT_INTERVAL;
      this.brainSpit();
    }
    this.updateCubes(dt);
  }

  /**
   * Idle `A_Look` on the eye, which is `MF_NOBLOCKMAP|MF_NOSECTOR` and has no `PosedThing` for
   * `tryWake` to run on. Both of vanilla's wake paths are reproduced: its sector's `soundtarget`,
   * and `P_LookForPlayers`' sight. No FOV cone, though `A_Look` passes `allaround == false` —
   * gating the whole boss on the facing a mapper gave a thing that draws nothing is not worth
   * reproducing. See docs/monster-iconofsin.md § Waking the eye.
   */
  private eyeNotices(): boolean {
    if (!this.shooter) return false;
    const { world } = this.ctx;
    const sector = world.sectorAt(this.shooter.x, this.shooter.y);
    if (sector && world.isSoundAlerted(sector)) return true;
    const floor = world.floorAt(this.shooter.x, this.shooter.y);
    const at = { x: this.shooter.x, y: this.shooter.y, z: floor + SHOOTER_SIGHT_Z - PLAYER_EYE_LIFT };
    return hasLineOfSight(world, at, this.ctx.player);
  }

  /** `A_BrainAwake`: collect every `MT_BOSSTARGET` on the level, reset the cursor, shout once. */
  private brainAwake(): void {
    this.awake = true;
    this.spitTimer = FIRST_SPIT_DELAY;
    this.targetIndex = 0;
    this.targets = this.map.things
      .filter((t) => t.type === ThingType.bossTarget)
      .map((t) => ({ x: t.x, y: t.y, z: this.ctx.world.floorAt(t.x, t.y) }));
    // S_StartSound(NULL, …) — heard from anywhere on the map, like the cyberdemon's own wake.
    this.sfx.play('bossit', null);
  }

  /** `A_BrainSpit`: one cube at the next spawn spot in the rotation. */
  private brainSpit(): void {
    if (!this.shooter || this.targets.length === 0) return;
    // `easy ^= 1; if (gameskill <= sk_easy && !easy) return;` — half rate on ITYTD and HNTR
    // (vanilla's sk_baby and sk_easy), full rate from Hurt Me Plenty up.
    this.easy = !this.easy;
    if (this.skill <= 2 && !this.easy) return;
    const target = this.targets[this.targetIndex];
    this.targetIndex = (this.targetIndex + 1) % this.targets.length;
    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, 'BOSF', CUBE_FRAMES, CUBE_FRAME_SECONDS);
    if (!anim.resolve(0, VIEWER_ANGLE_DEG)) return;
    const dx = target.x - this.shooter.x;
    const dy = target.y - this.shooter.y;
    this.cubes.push({
      anim,
      x: this.shooter.x,
      y: this.shooter.y,
      z: this.ctx.world.floorAt(this.shooter.x, this.shooter.y),
      angleRad: Math.atan2(dy, dx),
      target,
      remaining: Math.hypot(dx, dy),
      soundTimer: 0,
    });
    this.sfx.play('bospit', null);
  }

  /**
   * Flies every cube and lands the ones that arrive. `MT_SPAWNSHOT` is
   * `MF_NOBLOCKMAP|MF_NOCLIP|MF_NOGRAVITY`, so this deliberately tests nothing against the geometry
   * it crosses and damages nothing on the way — which is exactly why a cube is not a
   * `ProjectileLayer` projectile. See docs/monster-iconofsin.md § The spawn cube.
   */
  private updateCubes(dt: number): void {
    if (this.cubes.length === 0) return;
    const remaining: SpawnCube[] = [];
    for (const c of this.cubes) {
      const step = CUBE_SPEED * dt;
      c.remaining -= step;
      if (c.remaining <= 0) {
        this.spawnFly(c.target);
        continue;
      }
      c.x += Math.cos(c.angleRad) * step;
      c.y += Math.sin(c.angleRad) * step;
      // Eased toward the destination's own floor height rather than held flat: the eye and the
      // spawn spots sit at different heights, and vanilla's cube carries a real `momz` out of
      // `P_SpawnMissile`'s slope for the same reason.
      const flat = Math.hypot(c.target.x - c.x, c.target.y - c.y);
      c.z += (c.target.z - c.z) * Math.min(1, step / Math.max(flat, step));
      c.soundTimer -= dt;
      if (c.soundTimer <= 0) {
        c.soundTimer += CUBE_SOUND_INTERVAL;
        this.sfx.play('boscub', c);
      }
      c.anim.advance(dt, true);
      this.effects.batchSprite(c.anim, c, (c.angleRad * 180) / Math.PI, FULLBRIGHT);
      remaining.push(c);
    }
    this.cubes = remaining;
  }

  /**
   * `A_SpawnFly`: the fire puff, the teleport sound, one monster off the weighted table, and the
   * telefrag that comes with `P_TeleportMove`.
   */
  private spawnFly(at: Pos3): void {
    this.effects.spawnImpact('FIRE', SPAWN_FIRE_FRAMES, SPAWN_FIRE_FRAME_SECONDS, at);
    this.sfx.play('telept', at);
    const roll = pRandom();
    const last = SPAWN_CUBE_MONSTERS[SPAWN_CUBE_MONSTERS.length - 1];
    const entry = SPAWN_CUBE_MONSTERS.find((e) => roll < e.below) ?? last;
    // Facing the player: vanilla's newly spawned monster goes straight to its seestate with the
    // player already acquired, so there is no idle facing for it to keep.
    const angleRad = Math.atan2(this.ctx.player.y - at.y, this.ctx.player.x - at.x);
    const spawned = this.ctx.things?.spawnMonster(entry.type, at, angleRad);
    if (!spawned || this.ctx.playerDead) return;
    // The player half of the telefrag — `ThingLayer.spawnMonster` already did every other body.
    const reach = PLAYER_RADIUS + PLAYER_TELEFRAG_RADIUS;
    const { player } = this.ctx;
    if ((player.x - spawned.x) ** 2 + (player.y - spawned.y) ** 2 <= reach * reach) {
      this.ctx.damagePlayer(TELEFRAG_DAMAGE, spawned.x, spawned.y);
    }
  }

  /** Ticks the 120 tics between `A_BrainScream` and `A_BrainDie`, keeping the cascade going meanwhile. */
  private updateExit(dt: number): void {
    this.explodeTimer -= dt;
    if (this.explodeTimer <= 0) {
      this.explodeTimer += EXPLODE_CHAIN_INTERVAL;
      this.brainExplode();
    }
    this.exitTimer -= dt;
    if (this.exitTimer <= 0) {
      this.exitTimer = -1;
      this.awake = false;
      this.cubes = [];
      this.onExit();
    }
  }

  /** `A_BrainScream`: `bosdth` from nowhere in particular, and a wall of explosions in front of the brain. */
  private brainScream(): void {
    this.sfx.play('bosdth', null);
    const brain = this.brainPos();
    if (!brain) return;
    for (let dx = SCREAM_X_FROM; dx < SCREAM_X_TO; dx += SCREAM_X_STEP) {
      this.explodeAt(brain.x + dx, brain.y + SCREAM_Y_OFFSET);
    }
  }

  /** `A_BrainExplode`'s follow-up: more of the same, scattered around the brain rather than in a row. */
  private brainExplode(): void {
    const brain = this.brainPos();
    if (!brain) return;
    for (let i = 0; i < EXPLODE_CHAIN_COUNT; i++) {
      this.explodeAt(brain.x + triangularDraw(EXPLODE_X_SPREAD), brain.y + SCREAM_Y_OFFSET);
    }
  }

  private explodeAt(x: number, y: number): void {
    const z = this.ctx.world.floorAt(x, y) + SCREAM_Z_BASE + pRandom() * SCREAM_Z_STEP;
    this.effects.spawnImpact('MISL', EXPLODE_FRAMES, EXPLODE_FRAME_SECONDS, { x, y, z });
  }

  /**
   * Where the cascade is centred. Read off `map.things` rather than the `PosedThing`: the brain is
   * already a corpse by the time this runs, and its map position is what vanilla's own
   * `A_BrainScream` uses anyway — the mobj never moves.
   */
  private brainPos(): Thing | null {
    return this.map.things.find((t) => t.type === ThingType.bossBrain) ?? null;
  }
}
