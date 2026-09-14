/**
 * MAP30's Icon of Sin: the boss eye's spitter, the spawn cube in flight, telefrag on landing and
 * the brain's death sequence, driven by three {@link ThingType} members read straight off
 * `map.things`. See docs/monster-iconofsin.md.
 */
import type { DoomMap, Thing } from '../../wad/map.ts';
import type { SpriteBank } from '../../wad/sprites.ts';
import { SpriteAnimator, VIEWER_ANGLE_DEG, type SpriteMaterialCache } from '../../render/sprites.ts';
import { PLAYER_RADIUS, SIGHT_EYE_HEIGHT } from '../player.ts';
import { SPAWN_CUBE_MONSTERS } from '../things/tables.ts';
import { ThingType } from '../things/doomednums.ts';
import { bodiesOverlap, TELEFRAG_DAMAGE } from '../things.ts';
import { anyPlayerAlive, type CombatContext } from '../combat.ts';
import type { IconSnapshot } from '../snapshot.ts';
import type { SpriteFxLayer } from '../spritefx.ts';
import { SILENT, type SoundEmitter } from '../../audio/sfx.ts';
import type { Skill } from '../skill.ts';
import type { Pos3 } from '../../types.ts';
import { DOOM_TIC } from '../../constants.ts';
import { pRandom, triangularDraw } from '../../util/random.ts';
import { vecLength } from '../../util/geom.ts';
import { atan2, cos, sin } from '../../util/fdlibm.ts';

/**
 * Where the eye sights from, above its own floor: `MT_BOSSSPIT`'s `mobjinfo.height` of 32, less the
 * `height >> 2` `P_CheckSight` docks off its `sightzstart`. The lift `hasLineOfSight` adds,
 * {@link SIGHT_EYE_HEIGHT}, comes back off at the call. See
 * docs/monster-iconofsin.md § Waking the eye.
 */
const SHOOTER_SIGHT_Z = 32 - (32 >> 2);

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
 * once per full cycle rather than once per frame — the cube's audible whoosh as it crosses the
 * room.
 */
const CUBE_SOUND_INTERVAL = CUBE_FRAMES.length * CUBE_FRAME_SECONDS;
/**
 * Light a cube in flight is handed to the batch. Its `BOSF` frames already carry vanilla's
 * fullbright bit, so this is only what a patch clearing that bit would see — and a cube crosses
 * rooms `MF_NOCLIP`, so none is "its" room to shade by. docs/sprites.md § Fullbright frames.
 */
const FULLBRIGHT = 255;

/** `MT_SPAWNFIRE`: `S_SPAWNFIRE1`-`8`, eight fullbright `FIRE` frames at 4 tics. */
const SPAWN_FIRE_FRAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const SPAWN_FIRE_FRAME_SECONDS = 4 * DOOM_TIC;

/**
 * The radius the *player* is telefragged against when a cube lands — **tuned by feel**, mid-range
 * across {@link SPAWN_CUBE_MONSTERS}' 20-to-48 `mobjinfo.radius` spread, so a spawn spot is
 * uniformly lethal to stand on rather than lethal only when the lottery picks a fat monster. The
 * monster half of the stomp runs off each body's own `blockRadius` inside
 * `ThingLayer.spawnMonster`.
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
 * spawns. Vanilla's `A_BrainExplode` chain is unbounded and only stops because the level ends
 * underneath it. docs/monster-iconofsin.md § Dying.
 */
const EXPLODE_CHAIN_INTERVAL = 3 * EXPLODE_FRAME_SECONDS;
const EXPLODE_CHAIN_COUNT = 8;

/**
 * Where a cube is headed and how far along it is — everything {@link IconOfSin.makeCube} needs
 * beside a position.
 */
interface CubeFlight {
  angleRad: number;
  /** The `MT_BOSSTARGET` it was aimed at — where it turns into a monster. */
  target: Pos3;
  /** Distance still to cover, this engine's stand-in for vanilla's launch-time `reactiontime`. */
  remaining: number;
  soundTimer: number;
}

/** One `MT_SPAWNSHOT` in flight. */
interface SpawnCube extends Pos3, CubeFlight {
  anim: SpriteAnimator;
  /** Position at the end of the previous tic — docs/frameloop.md § Interpolation. */
  drawPrevX: number;
  drawPrevY: number;
  drawPrevZ: number;
}

/** What an {@link IconOfSin} is built with, beside the map it reads its three boss things off. */
export interface IconOfSinOptions {
  ctx: CombatContext;
  effects: SpriteFxLayer;
  spriteBank: SpriteBank;
  spriteMaterials: SpriteMaterialCache;
  skill: Skill;
  /** Vanilla's `G_ExitLevel`, the same callback `SpecialsController` is handed. */
  onExit: () => void;
  sfx?: SoundEmitter;
}

/**
 * Nothing here is gated on the map's name — vanilla's only gate is that things 87/88/89 exist, so
 * any PWAD placing them gets this behavior and every other map builds an inert instance. The brain
 * itself is an ordinary shootable `PosedThing`; this class only adds what happens *after* it dies.
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
  /**
   * `A_BrainAwake`'s `braintargets`, in map-thing order; filled on waking, exactly as vanilla does.
   */
  private targets: Pos3[] = [];
  /** `braintargeton` — the round-robin cursor into {@link IconOfSin.targets}. */
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
  /** {@link IconOfSin.draw}'s interpolated position, reused per cube so it allocates nothing. */
  private readonly drawAt: Pos3 = { x: 0, y: 0, z: 0 };
  /** Counts down from {@link BRAIN_DEATH_TO_EXIT} once the brain dies; -1 while it's alive. */
  private exitTimer = -1;
  private explodeTimer = 0;

  constructor(map: DoomMap, options: IconOfSinOptions) {
    this.map = map;
    this.ctx = options.ctx;
    this.effects = options.effects;
    this.spriteBank = options.spriteBank;
    this.spriteMaterials = options.spriteMaterials;
    this.skill = options.skill;
    this.onExit = options.onExit;
    this.sfx = options.sfx ?? SILENT;
    this.shooter = map.things.find((t) => t.type === ThingType.bossShooter) ?? null;
  }

  /**
   * Whether the brain is dead and the level is on its way out, so {@link IconOfSin.onExit} is
   * unavoidable. `game.ts` reads it to keep the death overlay and `R` off a level that is already
   * ending. docs/death.md § Dying on the way out.
   */
  get exiting(): boolean {
    return this.exitTimer >= 0;
  }

  /**
   * Everything mutable for a savegame. Cubes name their target by index into
   * {@link IconOfSin.targets}, since the live field is a reference into that array.
   *
   * @returns null on a map with no eye, which has nothing to save
   */
  snapshot(): IconSnapshot | null {
    if (!this.shooter) return null;
    return {
      targets: this.targets.map((t) => ({ ...t })),
      targetIndex: this.targetIndex,
      easy: this.easy,
      awake: this.awake,
      spitTimer: this.spitTimer,
      exitTimer: this.exitTimer,
      explodeTimer: this.explodeTimer,
      cubes: this.cubes.map((c) => ({
        x: c.x,
        y: c.y,
        z: c.z,
        angleRad: c.angleRad,
        targetIndex: Math.max(0, this.targets.indexOf(c.target)),
        remaining: c.remaining,
        soundTimer: c.soundTimer,
      })),
    };
  }

  /**
   * Restore twin of {@link IconOfSin.snapshot}; each cube goes back through
   * {@link IconOfSin.makeCube}, the same builder {@link IconOfSin.brainSpit} uses.
   * docs/savegames.md § Apply order.
   */
  restore(s: IconSnapshot | null): void {
    if (!s || !this.shooter) return;
    this.targets = s.targets.map((t) => ({ ...t }));
    this.targetIndex = s.targetIndex;
    this.easy = s.easy;
    this.awake = s.awake;
    this.spitTimer = s.spitTimer;
    this.exitTimer = s.exitTimer;
    this.explodeTimer = s.explodeTimer;
    this.cubes = [];
    for (const c of s.cubes) {
      const target = this.targets[c.targetIndex];
      if (!target) continue;
      const cube = this.makeCube(
        { x: c.x, y: c.y, z: c.z },
        { angleRad: c.angleRad, target, remaining: c.remaining, soundTimer: c.soundTimer },
      );
      if (cube) this.cubes.push(cube);
    }
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
   * {@link SpriteFxLayer.beginFrame}/{@link SpriteFxLayer.endFrame} pair**: the cubes draw through
   * that batch, exactly as `ProjectileLayer.update` does.
   */
  update(dt: number): void {
    if (this.exitTimer >= 0) {
      this.updateExit(dt);
      return;
    }
    if (!this.shooter) return;
    if (!this.awake) {
      if (!anyPlayerAlive(this.ctx.slots) || !this.eyeNotices()) return;
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
   * Draws every cube still in flight, interpolated `alpha` of the way through the last tic. Runs
   * inside the caller's {@link SpriteFxLayer.beginFrame}/{@link SpriteFxLayer.endFrame} pair, same
   * as {@link IconOfSin.update}. docs/frameloop.md § Interpolation.
   */
  draw(alpha: number): void {
    for (const c of this.cubes) {
      this.drawAt.x = c.drawPrevX + (c.x - c.drawPrevX) * alpha;
      this.drawAt.y = c.drawPrevY + (c.y - c.drawPrevY) * alpha;
      this.drawAt.z = c.drawPrevZ + (c.z - c.drawPrevZ) * alpha;
      this.effects.batchSprite(c.anim, this.drawAt, (c.angleRad * 180) / Math.PI, FULLBRIGHT);
    }
  }

  /**
   * One `MT_SPAWNSHOT` in flight, animator armed and interpolation seeded from where it stands.
   * Shared by {@link IconOfSin.brainSpit} and the savegame restore, so a restored cube can't be
   * built differently from a freshly spat one.
   *
   * @returns null when this WAD set can't draw `BOSF` — the same silent drop a missing missile
   *          sprite gets
   */
  private makeCube(at: Pos3, flight: CubeFlight): SpawnCube | null {
    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, 'BOSF', CUBE_FRAMES, CUBE_FRAME_SECONDS);
    if (!anim.resolve(0, VIEWER_ANGLE_DEG)) return null;
    return {
      anim,
      x: at.x,
      y: at.y,
      z: at.z,
      angleRad: flight.angleRad,
      target: flight.target,
      remaining: flight.remaining,
      soundTimer: flight.soundTimer,
      drawPrevX: at.x,
      drawPrevY: at.y,
      drawPrevZ: at.z,
    };
  }

  /**
   * Idle `A_Look` on the eye, which is `MF_NOBLOCKMAP|MF_NOSECTOR` and has no `PosedThing` for
   * `tryWake` to run on. Both of vanilla's wake paths are reproduced — its sector's `soundtarget`
   * and `P_LookForPlayers`' sight — but deliberately no FOV cone, though `A_Look` passes
   * `allaround == false`. docs/monster-iconofsin.md § Waking the eye.
   */
  private eyeNotices(): boolean {
    if (!this.shooter) return false;
    const { world } = this.ctx;
    const sector = world.sectorAt(this.shooter.x, this.shooter.y);
    // A noise wakes it while whoever made it lives — `A_Look`'s `MF_SHOOTABLE` test on the target.
    const heard = sector ? world.soundTargetOf(sector) : -1;
    if (heard >= 0 && this.ctx.slots[heard]?.dead === false) return true;
    const floor = world.floorAt(this.shooter.x, this.shooter.y);
    const at = { x: this.shooter.x, y: this.shooter.y, z: floor + SHOOTER_SIGHT_Z - SIGHT_EYE_HEIGHT };
    for (const slot of this.ctx.slots) if (!slot.dead && world.hasLineOfSight(at, slot.player)) return true;
    return false;
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
    const dx = target.x - this.shooter.x;
    const dy = target.y - this.shooter.y;
    const at = { x: this.shooter.x, y: this.shooter.y, z: this.ctx.world.floorAt(this.shooter.x, this.shooter.y) };
    const cube = this.makeCube(at, {
      angleRad: atan2(dy, dx),
      target,
      remaining: vecLength(dx, dy),
      soundTimer: 0,
    });
    if (!cube) return;
    this.cubes.push(cube);
    this.sfx.play('bospit', null);
  }

  /**
   * Flies every cube and lands the ones that arrive. `MT_SPAWNSHOT` is
   * `MF_NOBLOCKMAP|MF_NOCLIP|MF_NOGRAVITY`, so this tests nothing against the geometry it crosses
   * and damages nothing on the way — which is why a cube is not a `ProjectileLayer` projectile.
   * docs/monster-iconofsin.md § The spawn cube.
   */
  private updateCubes(dt: number): void {
    if (this.cubes.length === 0) return;
    const remaining: SpawnCube[] = [];
    for (const c of this.cubes) {
      const step = CUBE_SPEED * dt;
      c.drawPrevX = c.x;
      c.drawPrevY = c.y;
      c.drawPrevZ = c.z;
      c.remaining -= step;
      if (c.remaining <= 0) {
        this.spawnFly(c.target);
        continue;
      }
      c.x += cos(c.angleRad) * step;
      c.y += sin(c.angleRad) * step;
      // Eased toward the destination's own floor rather than held flat — the eye and the spawn
      // spots sit at different heights, and vanilla's cube carries a real `momz` for that reason.
      const flat = vecLength(c.target.x - c.x, c.target.y - c.y);
      c.z += (c.target.z - c.z) * Math.min(1, step / Math.max(flat, step));
      c.soundTimer -= dt;
      if (c.soundTimer <= 0) {
        c.soundTimer += CUBE_SOUND_INTERVAL;
        this.sfx.play('boscub', c);
      }
      c.anim.advance(dt, true);
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
    // Facing player 1: vanilla's newly spawned monster goes straight to its seestate with a
    // player acquired, so there is no idle facing for it to keep.
    const player = this.ctx.slots[0].player;
    const angleRad = atan2(player.y - at.y, player.x - at.x);
    const spawned = this.ctx.things?.spawnMonster(entry.type, at, angleRad);
    if (!spawned) return;
    // The player half of the telefrag — `ThingLayer.spawnMonster` already did every other body.
    for (let slot = 0; slot < this.ctx.slots.length; slot++) {
      const { player, dead } = this.ctx.slots[slot];
      if (dead || !bodiesOverlap(spawned, player, PLAYER_RADIUS + PLAYER_TELEFRAG_RADIUS)) continue;
      this.ctx.damageSlot(slot, TELEFRAG_DAMAGE, {
        from: spawned,
        cause: spawned.type,
        source: { id: spawned.id, type: spawned.type },
      });
    }
  }

  /**
   * Ticks the 120 tics between `A_BrainScream` and `A_BrainDie`, keeping the cascade going
   * meanwhile.
   */
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

  /**
   * `A_BrainScream`: `bosdth` from nowhere in particular, and a wall of explosions in front of the
   * brain.
   */
  private brainScream(): void {
    this.sfx.play('bosdth', null);
    const brain = this.brainPos();
    if (!brain) return;
    for (let dx = SCREAM_X_FROM; dx < SCREAM_X_TO; dx += SCREAM_X_STEP) {
      this.explodeAt(brain.x + dx, brain.y + SCREAM_Y_OFFSET);
    }
  }

  /**
   * `A_BrainExplode`'s follow-up: more of the same, scattered around the brain rather than in a
   * row.
   */
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
   * a corpse by the time this runs, and the mobj never moves, so its map position is what vanilla's
   * `A_BrainScream` uses too.
   */
  private brainPos(): Thing | null {
    return this.map.things.find((t) => t.type === ThingType.bossBrain) ?? null;
  }
}
