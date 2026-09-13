/**
 * The sprite, sound and timing tables behind everything drawn that isn't a map
 * `Thing`: projectiles in flight, their impact explosions, blood splashes,
 * bullet puffs, the teleport and item fogs, the revenant's smoke trail and the
 * arch-vile's flame. Data and pure helpers only, confirmed against `info.c`
 * and the WADs' own lump names; the record shapes it all hangs off are
 * `spritefx/defs.ts`. See docs/combat.md § Effects and their batching.
 */
import type { SfxId } from '../../audio/sfx.ts';
import { DOOM_TIC } from '../../constants.ts';
import { pristineFrameTables, type OneShotFrames } from '../dehacked/frames.ts';

/**
 * The teleport fog (`MT_TFOG`): a one-shot animation, not a real thing, so it lives outside
 * `ThingLayer`. **Walked out of vanilla's own state table** rather than transcribed — `S_TFOG`'s
 * `A,B,A,B,C`…`J` at 6 tics each — and mutable for the same reason `CORPSE_GIB` is: a DEHACKED
 * patch re-derives it and `dehacked/apply.ts` restores it (docs/dehacked.md § Frames). `frames` is
 * empty only where a patch left the chain drawing nothing.
 */
export const TELEPORT_FOG: OneShotFrames = structuredClone(pristineFrameTables().teleportFog!);
/**
 * Vanilla spawns the destination fog 20 units ahead of the landing spot, along the direction it
 * faces.
 */
export const TFOG_SPAWN_OFFSET = 20;

/**
 * The fog an item respawns in (`MT_IFOG`) — `S_IFOG`'s `A,B,A,B,C,D,E` at 6 tics each, walked and
 * patched as {@link TELEPORT_FOG} is. docs/multiplayer-deathmatch.md § Item respawn.
 */
export const ITEM_FOG: OneShotFrames = structuredClone(pristineFrameTables().itemFog!);

/**
 * Color of a hitscan tracer line (render/tracer.ts) — a hot yellow-white, like a vanilla muzzle
 * flash.
 */
export const TRACER_COLOR = 0xfff2a8;
/**
 * Color of a monster's ranged-attack tracer (game/monsters/attacks.ts) — a hostile red, distinct
 * from the player's own tracer color above.
 */
export const MONSTER_TRACER_COLOR = 0xff4433;

/**
 * Frame letters an in-flight projectile sprite cycles through — each missile's `mobjinfo` spawn
 * loop, walked out of vanilla's state table (docs/dehacked.md § Frames). `MISL` (rocket) ends up
 * absent because only its frame A is flight art: B-D are the explosion, and a one-frame loop needs
 * no entry. Anything unlisted holds a single frame.
 */
export const PROJECTILE_FRAMES: Record<string, string[]> = {};
/**
 * Each missile's own `mobjinfo.radius`, keyed by flight sprite the same way
 * {@link IMPACT_EFFECTS} is. Half of `PIT_CheckThing`'s `blockdist = thing->radius +
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

/** Fallback for a sprite {@link PROJECTILE_RADIUS} doesn't list — vanilla's smallest missile. */
export const PROJECTILE_RADIUS_DEFAULT = 6;

/** Vanilla's own explosion states run at 4 tics/frame. */
export const IMPACT_FRAME_SECONDS = 4 * DOOM_TIC;

/**
 * A projectile's impact explosion, keyed by its flight sprite — each missile's `mobjinfo` death
 * chain, walked out of vanilla's state table (docs/dehacked.md § Frames). `MANF` exploding into the
 * *rocket's* `MISL` frames is a genuine vanilla oddity, not a simplification here
 * (docs/monster-attacks.md § Hitscan vs. projectile). Purely cosmetic: this plays where a shot
 * reached `shotPath`'s distance; what it actually damaged is resolved separately.
 */
export const IMPACT_EFFECTS: Record<string, { sprite: string; frames: string[] }> = {};

/**
 * Fills the two tables above from the walker's reading of vanilla's own missile chains. Runs at
 * import, before `dehacked/apply.ts` snapshots them for `resetDehacked`; a patch that retimes a
 * missile re-derives the same way (docs/dehacked.md § Frames).
 */
for (const [sprite, missile] of Object.entries(pristineFrameTables().missiles)) {
  if (missile.flight) PROJECTILE_FRAMES[sprite] = missile.flight;
  if (missile.impact) IMPACT_EFFECTS[sprite] = missile.impact;
}
/**
 * Each projectile's launch and impact sound, keyed by flight sprite the same
 * way {@link IMPACT_EFFECTS} is, and from the same source: the missile type's own
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
 * `MT_BLOOD`'s whole chain from `S_BLOOD1` on — what a spawn that goes through `P_SpawnMobj`
 * directly rather than through `P_SpawnBlood` gets, since only the latter skips states by damage.
 * The crusher's spray (`SpriteFxLayer.spawnCrushBlood`) is the one such caller.
 */
export const BLOOD_FRAMES = ['C', 'B', 'A'];

/**
 * How fast a crusher's spray flies out of the body it came from, map units a second at the extreme
 * of its triangular draw — `PIT_ChangeSector`'s own `(P_Random()-P_Random())<<12`, which is 15.9
 * units a *tic*. It falls from there under `GRAVITY`, `MT_BLOOD` carrying no `MF_NOGRAVITY`.
 * See docs/specials-crushers.md § Crushers.
 */
export const CRUSH_BLOOD_SPEED = (255 * 0x1000) / 0x10000 / DOOM_TIC;

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
 * carries `FF_FULLBRIGHT` (`info.c`'s `32768`), so `PUFFA` is in
 * `FULLBRIGHT_FRAMES` and `spritefx.ts` draws that first frame at full light
 * whatever the sector — docs/sprites.md § Fullbright frames.
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

/**
 * Vanilla's own 24-unit offset (`A_VileAttack`'s `FixedMul(24*FRACUNIT, ...)`) — see
 * `resolveVileBlast`'s doc.
 */
export const VILE_FIRE_OFFSET = 24;

/**
 * The revenant missile's turn rate — vanilla's `A_Tracer` turns by `TRACEANGLE`
 * (`0xc000000`, 16.875°) every 4th tic, converted to a continuous rate. See
 * docs/monster-attacks.md § The revenant's homing missile.
 */
export const REVENANT_TRACER_TURN_RATE_RAD = (16.875 * Math.PI) / 180 / (4 * DOOM_TIC);

/**
 * `A_Tracer`'s vertical aim point, `dest->z + 40*FRACUNIT` — chest height, not the target's feet.
 */
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
 * The puff left where a collected item stood — this engine's own effect rather than a vanilla one,
 * played off {@link ITEM_FOG} so a patch that redraws or retimes the fog moves the puff with it.
 * `PICKUP_FOG_SPEEDUP` is how many times faster than the fog it runs. What each of the three is
 * for: docs/items.md § The pickup puff. All three tuned by feel.
 */
export const PICKUP_FOG_SPEEDUP = 2;
export const PICKUP_FOG_SCALE = 0.5;
export const PICKUP_FOG_OPACITY = 0.3;

/**
 * The frames a pickup puff plays off a fog's chain: each letter once, and the closing one dropped
 * where more than one is left — vanilla's `IFOG` `A,B,A,B,C,D,E` gives `A`-`D`, the frames that
 * shrink. docs/items.md § The pickup puff.
 *
 * @returns empty where the fog draws nothing, which spawns no puff
 */
export function pickupFogFrames(fog: OneShotFrames): string[] {
  const letters = [...new Set(fog.frames)];
  return letters.length > 1 ? letters.slice(0, -1) : letters;
}
