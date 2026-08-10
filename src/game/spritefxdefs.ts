import type { SpriteAnimator } from '../render/sprites.ts';
import type { SfxId } from '../audio/sfx.ts';
import type { Pos3 } from '../types.ts';
import { boxToCircleRadius, closestTOnSegment } from '../util/geom.ts';
import { DOOM_TIC } from '../constants.ts';

/**
 * The sprite/sound/timing tables and the two record shapes behind everything
 * `game.ts` draws that isn't a map `Thing`: projectiles in flight, their impact
 * explosions, blood splashes, bullet puffs, teleport-fog puffs, the revenant's
 * smoke trail and the arch-vile's flame. Data and pure helpers only — the simulation that reads
 * them lives in `game.ts`. See docs/combat.md § Effects and their batching.
 */

/**
 * Teleport-fog puff (vanilla's `MT_TFOG`): a one-shot animation, not a real
 * thing, so it lives outside `ThingLayer`. Rotation-0 only, confirmed against
 * DOOM2.WAD's lump names (TFOGA0..TFOGJ0).
 */
export const TFOG_FRAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
export const TFOG_FRAME_SECONDS = 6 * DOOM_TIC; // vanilla's S_TFOG* states hold each frame 6 tics
/** Vanilla spawns the destination fog 20 units ahead of the landing spot, along the direction it faces. */
export const TFOG_SPAWN_OFFSET = 20;

/**
 * A transient, one-shot sprite animation: plays through `frames` once at a
 * fixed spot and then removes itself. Used for the teleport-fog puff, a
 * projectile's impact explosion, the smoke trail and the vile's flame —
 * none of which is a real map `Thing`, so none goes through `ThingLayer`.
 */
export interface OneShotEffect extends Pos3 {
  /** A bare `SpriteAnimator` drawn through `SpriteFxLayer`'s own batch, no `THREE.Object3D` of its own — same arrangement as `PosedThing`. */
  anim: SpriteAnimator;
  light: number;
  elapsed: number;
  lifetime: number;
  /**
   * Set only for the arch-vile's windup flame (vanilla's `MT_FIRE`/`A_Fire`):
   * position is re-derived every frame from this target's live position and
   * facing rather than staying fixed. `null` means the player; absent (the
   * common case) skips this. See docs/monster-archvile.md.
   */
  followTargetId?: number | null;
  /** The arch-vile that spawned this flame — sight from it is re-checked before repositioning (`A_Fire`'s `P_CheckSight` gate). Always set alongside `followTargetId`. */
  vileSourceId?: number;
  /**
   * Position at the end of the previous tic, for the render layer to interpolate
   * from. Every effect carries it although only the arch-vile's following flame
   * ever moves — a stationary explosion's `prev` simply equals its current
   * position, which costs one branch-free lerp rather than a special case.
   * docs/frameloop.md § Interpolation.
   */
  drawPrevX: number;
  drawPrevY: number;
  drawPrevZ: number;
}

/** Color of a hitscan tracer line (render/tracer.ts) — a hot yellow-white, like a vanilla muzzle flash. */
export const TRACER_COLOR = 0xfff2a8;
/** Color of a monster's ranged-attack tracer (game/monsters/attacks.ts) — a hostile red, distinct from the player's own tracer color above. */
export const MONSTER_TRACER_COLOR = 0xff4433;

/**
 * Frame letters an in-flight projectile sprite cycles through. Confirmed
 * against `DOOM2.WAD`'s actual lump names and frame/rotation counts. `MISL`
 * (rocket) is absent deliberately: only its frame A is flight art, B-D are the
 * explosion (see `IMPACT_EFFECTS`). Anything unlisted holds a single frame.
 */
export const PROJECTILE_FRAMES: Record<string, string[]> = {
  PLSS: ['A', 'B'],
  BFS1: ['A', 'B'],
  BAL1: ['A', 'B'], // imp fireball
  BAL2: ['A', 'B'], // cacodemon fireball
  BAL7: ['A', 'B'], // baron/hell knight fireball
  MANF: ['A', 'B'], // mancubus fireball
  APLS: ['A', 'B'], // arachnotron plasma ball
  FATB: ['A', 'B'], // revenant missile
};

/**
 * Each missile's own `mobjinfo.radius`, keyed by flight sprite the same way
 * `IMPACT_EFFECTS` is. Half of `PIT_CheckThing`'s `blockdist = thing->radius +
 * tmthing->radius` — the other half is the body it's testing against
 * (`MonsterRef.radius`) — so this is what makes an arachnotron's fat plasma
 * ball a wider threat than an imp's fireball. From `info.c`: `MT_TROOPSHOT`,
 * `MT_HEADSHOT`, `MT_BRUISERSHOT` and `MT_FATSHOT` 6; `MT_TRACER` and
 * `MT_ROCKET` 11; `MT_PLASMA`, `MT_BFG` and `MT_ARACHPLAZ` 13.
 */
export const PROJECTILE_RADIUS: Record<string, number> = {
  MISL: 11, // MT_ROCKET — the player's rocket and the cyberdemon's alike
  PLSS: 13, // MT_PLASMA
  BFS1: 13, // MT_BFG
  BAL1: 6, // MT_TROOPSHOT
  BAL2: 6, // MT_HEADSHOT
  BAL7: 6, // MT_BRUISERSHOT
  MANF: 6, // MT_FATSHOT
  APLS: 13, // MT_ARACHPLAZ
  FATB: 11, // MT_TRACER
};

/** Fallback for a sprite `PROJECTILE_RADIUS` doesn't list — vanilla's smallest missile. */
export const PROJECTILE_RADIUS_DEFAULT = 6;

/**
 * Every missile in `info.c` is 8 units tall, so one constant covers the lower
 * half of `PIT_CheckThing`'s over/under test: a shot passes *underneath* when
 * `missile.z + height < target.z` and *overhead* when `missile.z > target.z +
 * target.height`. That band is deliberately asymmetric about the target's feet
 * — see docs/monster-attacks.md § Monster projectiles in flight.
 */
export const PROJECTILE_HEIGHT = 8;

/** Vanilla's own explosion states run at 4 tics/frame. */
export const IMPACT_FRAME_SECONDS = 4 * DOOM_TIC;

/**
 * A projectile's impact explosion, keyed by its flight sprite — from
 * `linuxdoom-1.10`'s `info.c` state tables. `MANF` exploding into the
 * *rocket's* `MISL` frames is a genuine vanilla oddity, not a simplification
 * here (docs/monster-attacks.md § Hitscan vs. projectile). Purely cosmetic: this
 * plays where a shot reached `shotPath`'s distance; what it actually damaged
 * is resolved separately.
 */
export const IMPACT_EFFECTS: Record<string, { sprite: string; frames: string[] }> = {
  MISL: { sprite: 'MISL', frames: ['B', 'C', 'D'] },
  PLSS: { sprite: 'PLSE', frames: ['A', 'B', 'C', 'D', 'E'] },
  // BFE1 is the ball's own impact (above); BFE2 is a *separate* sprite for
  // `resolveBfgSpray` — vanilla's MT_EXTRABFG, spawned on every monster a
  // spray ray actually hits, not on the ball's own landing spot.
  BFS1: { sprite: 'BFE1', frames: ['A', 'B', 'C', 'D', 'E', 'F'] },
  BAL1: { sprite: 'BAL1', frames: ['C', 'D', 'E'] },
  BAL2: { sprite: 'BAL2', frames: ['C', 'D', 'E'] },
  BAL7: { sprite: 'BAL7', frames: ['C', 'D', 'E'] },
  MANF: { sprite: 'MISL', frames: ['B', 'C', 'D'] },
  APLS: { sprite: 'APBX', frames: ['A', 'B', 'C', 'D', 'E'] },
  FATB: { sprite: 'FBXP', frames: ['A', 'B', 'C'] },
};

/**
 * Each projectile's launch and impact sound, keyed by flight sprite the same
 * way `IMPACT_EFFECTS` is, and from the same source: the missile type's own
 * `mobjinfo.seesound` and `deathsound`. This is why the rocket launcher and
 * plasma rifle have no `WeaponDef.fireSound` of their own — what you hear is
 * the missile. See docs/audio.md § Weapons and projectiles for the `BFS1` launch
 * exception and the two vanilla oddities deliberately kept here.
 */
export const PROJECTILE_SOUNDS: Record<string, { launch: SfxId | null; explode: SfxId | null }> = {
  MISL: { launch: 'rlaunc', explode: 'barexp' },
  PLSS: { launch: 'plasma', explode: 'firxpl' },
  BFS1: { launch: null, explode: 'rxplod' },
  BAL1: { launch: 'firsht', explode: 'firxpl' }, // imp
  BAL2: { launch: 'firsht', explode: 'firxpl' }, // cacodemon
  BAL7: { launch: 'firsht', explode: 'firxpl' }, // baron/hell knight
  MANF: { launch: 'firsht', explode: 'firxpl' }, // mancubus
  APLS: { launch: 'plasma', explode: 'firxpl' }, // arachnotron
  FATB: { launch: 'skeatk', explode: 'barexp' }, // revenant
};

/**
 * Blood splashed by a shot that hits a body — vanilla's `MT_BLOOD`
 * (`P_SpawnBlood`). `BLUDA0`-`C0` confirmed against `DOOM.WAD`/`DOOM2.WAD`;
 * rotation-0 only, like every other one-shot here. `S_BLOOD1`-`3` hold 8 tics
 * each and run *backwards* through the frame letters (C→B→A).
 * See docs/combat.md § Blood.
 */
export const BLOOD_FRAME_SECONDS = 8 * DOOM_TIC;

/**
 * Vanilla's own `z += (P_Random()-P_Random())<<10`, the identical first line of
 * both `P_SpawnBlood` and `P_SpawnPuff` — ±4 map units of scatter on where an
 * impact appears, so several pellets landing together don't stack into a
 * single sprite.
 */
export const HIT_Z_JITTER = 4;

/**
 * Which of `MT_BLOOD`'s three states the splash starts in, from the damage the
 * hit dealt: `P_SpawnBlood` skips straight to `S_BLOOD2`/`S_BLOOD3` for a
 * weaker hit, so a pistol shot shows one frame of blood and a shotgun blast at
 * point-blank range the full three.
 */
export function bloodFrames(damage: number): string[] {
  if (damage < 9) return ['A'];
  if (damage <= 12) return ['B', 'A'];
  return ['C', 'B', 'A'];
}

/**
 * The bullet puff a shot leaves on a wall, or on a body that doesn't bleed —
 * vanilla's `MT_PUFF` (`P_SpawnPuff`). `PUFFA0`-`D0` confirmed against
 * `DOOM.WAD`/`DOOM2.WAD`; `S_PUFF1`-`4` hold 4 tics each. `S_PUFF1`'s frame
 * carries `FF_FULLBRIGHT` (`info.c`'s `32768`), which this engine has no
 * per-frame equivalent for — every effect here takes its sector's light.
 */
export const PUFF_FRAMES = ['A', 'B', 'C', 'D'];
export const PUFF_FRAME_SECONDS = 4 * DOOM_TIC;

/**
 * `P_SpawnPuff`'s own "don't make punches spark on the wall": a trace of
 * exactly `MELEERANGE` skips to `S_PUFF3`, dropping the muzzle spark. Which
 * is why vanilla's `A_Saw` traces `MELEERANGE+1` (`WEAPONS.chainsaw`'s
 * `meleeRange`) — with its own comment saying so — and sparks where the fist
 * doesn't.
 */
export const PUFF_MELEE_FRAMES = ['C', 'D'];

/**
 * How far back along the shot a wall puff sits (`PTR_ShootTraverse`'s
 * "position a bit closer", `frac - 4/attackrange`) — without it the sprite
 * straddles the wall plane it's marking.
 */
export const PUFF_WALL_OFFSET = 4;

/**
 * Vanilla's `MT_EXTRABFG` (`S_BFGEXP1`-`4`) — the green burst `A_BFGSpray`
 * spawns on every monster a spray ray connects with, distinct from `BFE1`
 * above (the ball's own impact). `BFE2A0`-`D0` confirmed against `DOOM2.WAD`.
 */
export const BFG_SPRAY_HIT_FRAMES = ['A', 'B', 'C', 'D'];

/**
 * The arch-vile's flame, vanilla's `MT_FIRE` (`S_FIRE1`-`S_FIRE30`) — its own
 * sprite rather than an impact effect, since `resolveVileBlast` has no flying
 * projectile to key off. `FIREA0`-`FIREH0` confirmed against `DOOM2.WAD`;
 * vanilla's 30-state loop revisits letters to flicker (`A,B,A,B,C,B,C,…`),
 * not worth reproducing exactly for a cosmetic one-shot.
 */
export const VILE_FIRE_FRAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Vanilla's own 24-unit offset (`A_VileAttack`'s `FixedMul(24*FRACUNIT, ...)`) — see `resolveVileBlast`'s doc. */
export const VILE_FIRE_OFFSET = 24;


/**
 * The revenant missile's turn rate — vanilla's `A_Tracer` turns by `TRACEANGLE`
 * (`0xc000000`, 16.875°) every 4th tic, converted to a continuous rate. See
 * docs/monster-attacks.md § The revenant's homing missile.
 */
export const REVENANT_TRACER_TURN_RATE_RAD = (16.875 * Math.PI) / 180 / (4 * DOOM_TIC);

/** `A_Tracer`'s vertical aim point, `dest->z + 40*FRACUNIT` — chest height, not the target's feet. */
export const TRACER_HOMING_Z_OFFSET = 40;

/**
 * The revenant missile's trailing smoke (vanilla's `MT_SMOKE`, spawned inside
 * `A_Tracer`), which only a shot that won its `homingBias` roll trails.
 * `MT_SMOKE` reuses the `PUFF` sprite; frames B,C,B,C,D (`S_SMOKE1`-`5`) from
 * `info.c`, each held 4 tics. See docs/monster-attacks.md § The revenant's
 * homing missile.
 */
export const SMOKE_TRAIL_FRAMES = ['B', 'C', 'B', 'C', 'D'];
export const SMOKE_TRAIL_FRAME_SECONDS = 4 * DOOM_TIC;
export const SMOKE_TRAIL_INTERVAL = 4 * DOOM_TIC;

/**
 * Turns `from` toward `to` (radians) by at most `maxDelta`, the short way
 * around — the continuous equivalent of `A_Tracer`'s own clamped per-call
 * turn (see `REVENANT_TRACER_TURN_RATE_RAD`).
 */
export function turnToward(from: number, to: number, maxDelta: number): number {
  const diff = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + Math.max(-maxDelta, Math.min(maxDelta, diff));
}

/**
 * Vanilla's `PIT_CheckThing` for a missile, as one frame's worth of flight:
 * where along the step `from`→`to` the projectile touched `body`, or null if it
 * passed it. Both halves are the real vanilla test rather than a tolerance —
 * laterally `thing->radius + tmthing->radius` (as the circle
 * `boxToCircleRadius` converts that box to), vertically the asymmetric
 * overhead/underneath pair, evaluated where the step passes closest to the
 * body. `bodyHeight` stays the shared `MONSTER_HIT_HEIGHT`/`PLAYER_HEIGHT`
 * approximation; only the radius is per-species.
 *
 * **Swept, not sampled at the step's end**: `game.ts` clamps `dt` at 0.05s, so
 * the fastest missiles cover 43 units in one frame — further than the widest
 * contact circle a small body presents, i.e. a point test could step straight
 * through the player. See docs/monster-attacks.md § Monster projectiles in flight.
 */
export function stepTouchesBody(
  from: Pos3,
  to: Pos3,
  body: Pos3,
  bodyRadius: number,
  bodyHeight: number,
  missileRadius: number,
): number | null {
  const reach = boxToCircleRadius(bodyRadius + missileRadius);
  const t = closestTOnSegment(body.x, body.y, from.x, from.y, to.x, to.y);
  const dx = from.x + (to.x - from.x) * t - body.x;
  const dy = from.y + (to.y - from.y) * t - body.y;
  // `>=`, matching `PIT_CheckThing`'s own `abs(...) >= blockdist` miss.
  if (dx * dx + dy * dy >= reach * reach) return null;
  const z = from.z + (to.z - from.z) * t;
  if (z + PROJECTILE_HEIGHT < body.z || z > body.z + bodyHeight) return null;
  return t;
}

export interface Projectile {
  /** Drawn through `SpriteFxLayer`'s own batch, same as `OneShotEffect.anim` — see that field's doc. */
  anim: SpriteAnimator;
  originX: number;
  originY: number;
  /** Fire height at launch (the player's) — see spawnPlayerShot's doc for why this is never the target's own height. */
  startZ: number;
  /** shotPath's actual stopping height — the target's height if unobstructed, or wherever it got blocked short of that. */
  endZ: number;
  angleRad: number;
  speed: number;
  /** Distance (map units) to where shotPath says this shot's flight ends. */
  maxDist: number;
  traveled: number;
  /** SpriteBank name (PROJECTILE_FRAMES's key), so the impact explosion can look it up in IMPACT_EFFECTS. */
  sprite: string;
  /** This missile's own `mobjinfo.radius`, from `PROJECTILE_RADIUS` — half of the contact distance to any body it passes. */
  radius: number;
  /** Direct-hit damage, applied to whatever body this strikes in flight. */
  damage: number;
  /** Splash to apply at the impact point regardless of what was targeted, or null for a non-explosive projectile — see weapons.ts's WeaponDef.splash. */
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /** The BFG's real A_BFGSpray secondary attack, straight from weapons.ts's WeaponDef.spray — null for every projectile but the player's own BFG ball (monsters never fire one). */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
  /**
   * The monster that fired this, or `null` for one of the player's own shots.
   * Only the *player*'s own missiles are told apart by this now — every
   * projectile, whoever fired it, re-tests what it has run into every frame
   * against live positions rather than resolving hit-or-miss up front. See
   * docs/monster-attacks.md § Monster projectiles in flight.
   */
  sourceId: number | null;
  /** The firing monster's doomednum, for `sameSpecies` — vanilla's "don't hit same species as originator" rule on projectiles. */
  sourceType: number;
  /**
   * The wall `shotPath` found blocking this flight at launch, or null. Carried
   * through so a shoot-triggered special fires on *arrival*, and only if the
   * flight really got to that wall — a missile stopped by a body or by the
   * floor never reached it. A hitscan pellet triggers immediately in
   * `spawnPlayerShot` instead. See docs/combat.md § Shoot-triggered specials.
   */
  lineIndex: number | null;
  /**
   * Present only for the revenant's missile (`MT_TRACER`/`A_Tracer`), whose
   * path isn't the fixed origin+angle+distance line every other projectile
   * flies, so it carries its own live position/heading. `targetId` is `null`
   * for the player. A `homing` object existing at all means this shot won its
   * `homingBias` roll. See docs/monster-attacks.md § The revenant's homing missile.
   */
  homing?: { targetId: number | null; x: number; y: number; z: number; headingRad: number; smokeTimer: number };
  /**
   * Where this missile is now and where it was one tic ago, written by
   * `ProjectileLayer.update` so `draw` can interpolate between them. Held as
   * plain coordinates rather than recomputed from `traveled`, because a homing
   * missile has no scalar to recompute from — it carries its own position.
   * A missile is the fastest thing on screen, so this is the interpolation that
   * matters most. docs/frameloop.md § Interpolation.
   */
  drawX: number;
  drawY: number;
  drawZ: number;
  drawPrevX: number;
  drawPrevY: number;
  drawPrevZ: number;
  /** The heading its sprite is posed at, which for a homing missile turns in flight. */
  drawAngleRad: number;
  /** Sector light at its current position, re-read every tic — see `update`. */
  drawLight: number;
}

