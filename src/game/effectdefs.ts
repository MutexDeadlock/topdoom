import type { SpriteAnimator } from '../render/sprites.ts';
import type { SfxId } from '../audio/sfx.ts';
import type { Pos3 } from '../types.ts';
import { PLAYER_RADIUS } from './player.ts';
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
  /** A bare `SpriteAnimator` drawn through `Game.effectBatch`, no `THREE.Object3D` of its own — same arrangement as `PosedThing`. */
  anim: SpriteAnimator;
  light: number;
  elapsed: number;
  lifetime: number;
  /**
   * Set only for the arch-vile's windup flame (vanilla's `MT_FIRE`/`A_Fire`):
   * position is re-derived every frame from this target's live position and
   * facing rather than staying fixed. `null` means the player; absent (the
   * common case) skips this. See docs/monsters.md § The arch-vile.
   */
  followTargetId?: number | null;
  /** The arch-vile that spawned this flame — sight from it is re-checked before repositioning (`A_Fire`'s `P_CheckSight` gate). Always set alongside `followTargetId`. */
  vileSourceId?: number;
}

/** Color of a hitscan tracer line (render/tracer.ts) — a hot yellow-white, like a vanilla muzzle flash. */
export const TRACER_COLOR = 0xfff2a8;
/** Color of a monster's ranged-attack tracer (game/monsters.ts) — a hostile red, distinct from the player's own tracer color above. */
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

/** Vanilla's own explosion states run at 4 tics/frame. */
export const IMPACT_FRAME_SECONDS = 4 * DOOM_TIC;

/**
 * A projectile's impact explosion, keyed by its flight sprite — from
 * `linuxdoom-1.10`'s `info.c` state tables. `MANF` exploding into the
 * *rocket's* `MISL` frames is a genuine vanilla oddity, not a simplification
 * here (docs/monsters.md § Hitscan vs. projectile). Purely cosmetic: this
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
 * docs/monsters.md § The revenant's homing missile.
 */
export const REVENANT_TRACER_TURN_RATE_RAD = (16.875 * Math.PI) / 180 / (4 * DOOM_TIC);

/** `A_Tracer`'s vertical aim point, `dest->z + 40*FRACUNIT` — chest height, not the target's feet. */
export const TRACER_HOMING_Z_OFFSET = 40;

/**
 * The revenant missile's trailing smoke (vanilla's `MT_SMOKE`, spawned inside
 * `A_Tracer`), which only a shot that won its `homingBias` roll trails.
 * `MT_SMOKE` reuses the `PUFF` sprite; frames B,C,B,C,D (`S_SMOKE1`-`5`) from
 * `info.c`, each held 4 tics. See docs/monsters.md § The revenant's homing
 * missile.
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

export interface Projectile {
  /** Drawn through `Game.effectBatch`, same as `OneShotEffect.anim` — see that field's doc. */
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
  /** Direct-hit damage, applied to `hitMonsterId` (if any) on arrival. */
  damage: number;
  /** Splash to apply at the impact point regardless of what was targeted, or null for a non-explosive projectile — see weapons.ts's WeaponDef.splash. */
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /** The BFG's real A_BFGSpray secondary attack, straight from weapons.ts's WeaponDef.spray — null for every projectile but the player's own BFG ball (monsters never fire one). */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
  /** The monster this shot was locked onto *and actually reached* (spawnPlayerShot resolves that), or null — a free shot, one that missed a monster it wasn't locked onto, or a locked shot a wall cut short before the target. */
  hitMonsterId: number | null;
  /**
   * The monster that fired this, or `null` for one of the player's own shots.
   * A monster's shot re-tests arrival every frame against live positions
   * instead of resolving hit-or-miss up front — docs/monsters.md § Monster
   * projectiles in flight.
   */
  sourceId: number | null;
  /** The firing monster's doomednum, for `sameSpecies` — vanilla's "don't hit same species as originator" rule on projectiles. */
  sourceType: number;
  /**
   * The wall `shotPath` found blocking this flight at launch, or null. Carried
   * through so a shoot-triggered special fires on *arrival*, not on launch.
   * Only matters for the flying-sprite case; a hitscan pellet triggers
   * immediately in `spawnPlayerShot`. See docs/combat.md § Shoot-triggered specials.
   */
  lineIndex: number | null;
  /**
   * Present only for the revenant's missile (`MT_TRACER`/`A_Tracer`), whose
   * path isn't the fixed origin+angle+distance line every other projectile
   * flies, so it carries its own live position/heading. `targetId` is `null`
   * for the player. A `homing` object existing at all means this shot won its
   * `homingBias` roll. See docs/monsters.md § The revenant's homing missile.
   */
  homing?: { targetId: number | null; x: number; y: number; z: number; headingRad: number; smokeTimer: number };
}

/** How close a monster projectile has to get to the player's live position before it's treated as a hit — see `Projectile.sourceId`'s doc. */
export const MONSTER_PROJECTILE_HIT_RADIUS = PLAYER_RADIUS + 24;
/** Vertical companion to `MONSTER_PROJECTILE_HIT_RADIUS` — the same overhead/underneath tolerance `ThingLayer.tryPickup`'s own gate already uses for picking an item up through a window onto a floor above/below. */
export const MONSTER_PROJECTILE_HIT_HEIGHT = 128;
