import { hasPower, type AmmoType, type Inventory, type WeaponId } from './inventory.ts';
import type { Input } from './input.ts';
import type { AudioEngine } from '../audio/audio.ts';
import { PLAYER_ORIGIN, type SfxId } from '../audio/sfx.ts';
import type { Pos3 } from '../types.ts';
import { DOOM_TIC } from '../constants.ts';
import { pRandom } from '../util/random.ts';

/**
 * How often the chainsaw's idle rattle restarts while it's the ready weapon:
 * vanilla's `S_SAW` state holds 4 tics and `A_WeaponReady` plays `sawidl` every
 * time it loops, each start cutting off the last (they share the player's
 * origin). That restart *is* the engine note — the lump is longer than the
 * interval, so only its first fraction is ever heard.
 */
const SAW_IDLE_INTERVAL = 4 * DOOM_TIC;

/**
 * Vanilla's `MELEERANGE`: how far `A_Punch`/`A_Saw` trace out from the
 * player's own centre. `game/monsters/defs.ts` keeps its own, slightly longer
 * `MELEE_RANGE` for the *monster* side of the same idea — that one is a
 * body-to-body distance sampled per frame rather than per tic and carries
 * slack for it; this is a plain trace length, so it's vanilla's number as-is.
 */
export const PLAYER_MELEE_RANGE = 64;

/**
 * What berserk multiplies a **fist** punch by — vanilla's `A_Punch`, which
 * scales its own `(P_Random()%10+1)*2` roll by 10 while `pw_strength` is
 * held, turning a 2-20 tickle into 20-200. `A_Saw` deliberately does not read
 * the power at all, so the chainsaw is unaffected in vanilla and here.
 */
const BERSERK_FIST_MULTIPLIER = 10;

/**
 * The super shotgun's per-pellet slope jitter (`WeaponDef.slopeSpread`), out
 * of vanilla's 16.16 fixed point: `A_FireShotgun2` traces each pellet at
 * `bulletslope + ((P_Random()-P_Random())<<5)`, so the extremes are
 * ±(255<<5)/FRACUNIT of rise per unit travelled — about ±7°, or ±32 units of
 * height at 256 units out.
 */
const SSG_SLOPE_SPREAD = (255 * 32) / 65536;

export type WeaponKind = 'melee' | 'hitscan' | 'projectile';

export interface WeaponDef {
  /** Ammo class this weapon spends, or null for the ammo-less melee weapons. */
  ammoType: AmmoType | null;
  ammoPerShot: number;
  /**
   * Seconds between shots while the trigger is held — **vanilla's own state
   * chain, not tuned by feel**, and notably excluding the `A_ReFire` state's
   * own tics. docs/weapons.md § Fire rates.
   */
  cooldown: number;
  kind: WeaponKind;
  /** Hitscan only: bullets/pellets fired per trigger pull. */
  pellets: number;
  /** Each pellet's (or melee swing's) random spread off the aim line, in degrees. */
  spreadDeg: number;
  /**
   * Per-pellet random jitter of the *aim slope*, in vanilla's own slope units
   * (dz per unit travelled) — only the super shotgun has one, and it is the
   * one weapon in the game whose pellets scatter vertically as well as
   * horizontally. 0 everywhere else, which keeps every other weapon's pellets
   * exactly on the slope auto-aim resolved.
   */
  slopeSpread: number;
  /**
   * Whether the **first** shot of a held trigger ignores `spreadDeg` entirely
   * — `P_GunShot(mo, !player->refire)`, passed by `A_FirePistol` and
   * `A_FireCGun` and by nothing else (`A_FireShotgun` hardcodes `false`). It
   * is what makes a tapped pistol/chaingun shot dead accurate at any range
   * while a held burst walks off target.
   */
  accurateFirstShot: boolean;
  /** Melee only: how far in front of the player the swing reaches (`PLAYER_MELEE_RANGE`); 0 for everything else. */
  meleeRange: number;
  /** Projectile only: travel speed, map units/sec — the spawned missile's own `mobjinfo.speed` (units per tic) × 35, the same conversion `game/monsters/defs.ts` applies to theirs. */
  projectileSpeed: number;
  /** Projectile only: SpriteBank name the flying shot is drawn as. */
  projectileSprite: string;
  /**
   * Status-bar icon lump. Reuses the ground pickup's own sprite frame (the
   * same convention ui/hud/hud.ts already uses for ammo/keys/health) for every
   * weapon that has one; fist and pistol have no map pickup, so their own
   * first-person "ready" frame stands in instead.
   */
  iconLump: string;
  /**
   * A direct/pellet hit's damage roll is `((rand % damageDiceSides) + 1) *
   * damageDiceMultiplier` — vanilla's own P_Random-based per-weapon formula,
   * lifted rather than tuned by feel since it decides how tough a fight
   * actually is, the same reasoning ammo-per-shot already used. Two different
   * vanilla formulas land in this one shape: a *bullet's* is written out in
   * `P_GunShot`/`A_FireShotgun2` (`5*(P_Random()%3+1)`, i.e. 5/10/15 per
   * pellet), while a *missile's* is `PIT_CheckThing`'s single
   * `((P_Random()%8)+1) * mobjinfo.damage` applied to whatever it hit — so
   * every projectile has 8 sides and its multiplier is its `info.c` damage
   * field (rocket 20, plasma 5, BFG ball 100). Fist and chainsaw roll
   * `(P_Random()%10+1)<<1`, 2-20; the fist's is additionally scaled while
   * berserk is held — see `BERSERK_FIST_MULTIPLIER`.
   */
  damageDiceSides: number;
  damageDiceMultiplier: number;
  /**
   * The sound one trigger pull makes — **once per pull, not per pellet**
   * (`A_FireShotgun` plays `shotgn` once for all seven). `null` where the shot's
   * sound comes from somewhere else: the rocket launcher and plasma rifle have
   * no weapon sound of their own in vanilla, the missile they spawn brings its
   * `mobjinfo.seesound` with it (`game.ts`'s `PROJECTILE_SOUNDS`), and a melee
   * swing's sound depends on whether it connected.
   */
  fireSound: SfxId | null;
  /**
   * Melee only: the swing's sound on connecting and on missing — `A_Punch`'s
   * `punch` (silent on a miss, hence a null `missSound`), `A_Saw`'s
   * `sawhit`/`sawful`. Both null for everything else.
   */
  hitSound: SfxId | null;
  missSound: SfxId | null;
  /**
   * Splash a projectile's impact also applies, independent of its own
   * randomized direct-hit roll above — vanilla's rocket explosion
   * (`A_Explode`) passes a **fixed** radius/damage of 128 to `P_RadiusAttack`,
   * not the missile's own random contact-damage roll; those are two separate
   * numbers that only look related because this file happens to reuse the
   * same dice for the rocket's direct hit. `hitsPlayer` is true for the
   * rocket — vanilla really does let a rocket's own blast hurt whoever fired
   * it (the classic "rocket jump" self-damage). `null` means no splash at all
   * (plasma and the BFG, both direct-hit-only bolts as far as `A_Explode` is
   * concerned — the BFG's own devastating secondary damage is `spray`
   * below, a completely different mechanism from a radius blast).
   */
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /**
   * The BFG ball's real secondary attack, vanilla's `A_BFGSpray` — confirmed
   * against `linuxdoom-1.10/p_enemy.c` rather than approximated. It is
   * nothing like a radius splash: `rays` shots fan out across `arcDeg`
   * (vanilla: 40 rays over 90°, i.e. every 2.25°) centered on the ball's own
   * flight angle, each one an independent `raycastMonster`-style trace out to
   * `range` (vanilla: 16*64 = 1024 units) that deals a full, undiminished
   * direct hit — the sum of `diceRolls` rolls of a d`diceSides` (vanilla: 15
   * rolls of 1-8, so 15-120 per ray that connects, no distance falloff at
   * all) — to whatever it lands on, not a shared pool split by distance from
   * the impact point. Traced from the **player's own current position**, not
   * the explosion point: vanilla's `A_BFGSpray` reads `mo->target` (the
   * shooter, still a live pointer) at the moment the ball's death state
   * fires, which after ~1.5s of a slow 700u/s flight can be well behind
   * where the ball actually detonated. A monster standing directly in front
   * of the player can catch several of the 40 rays at once — genuinely more
   * devastating against one big target than an even radius falloff, which is
   * the actual source of the BFG's reputation. `null` for every weapon but
   * the BFG.
   */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
}

/** `((P_Random() % sides) + 1) * multiplier` — vanilla's own damage-roll shape. 0 sides means "always 0". */
export function rollDamage(sides: number, multiplier: number): number {
  return sides > 0 ? ((pRandom() % sides) + 1) * multiplier : 0;
}

/**
 * Vanilla's `P_Random()-P_Random()` shape: a triangular draw centred on 0 and
 * `width` wide at its extremes, in whatever unit the caller counts in. Every
 * random fuzz in the game is this one distribution.
 *
 * The `/255` is what makes `width` mean what every caller's constant already
 * says it means — the value at vanilla's `255 << shift` extreme — while keeping
 * the draw on the table's own integer grid. Two separate `pRandom()` calls, and
 * subtracting *adjacent* table entries is the point: see docs/random.md
 * § The triangular draw.
 */
export function triangularDraw(width: number): number {
  return ((pRandom() - pRandom()) / 255) * width;
}

/**
 * `triangularDraw` in degrees, returned as radians off-aim — the angular half
 * of it: the player's pellet spread and melee swing, a monster bullet's
 * `<<20`, `A_FaceTarget`'s `MF_SHADOW` `<<21`. The super shotgun's *slope*
 * jitter (`WeaponDef.slopeSpread`) is the one that isn't an angle.
 */
export function triangularSpread(deg: number): number {
  return (triangularDraw(deg) * Math.PI) / 180;
}

/**
 * Keyboard slot 1-7 → the weapons in it, best (most upgraded) first. A digit
 * key not already selecting a weapon from this slot jumps to the best one
 * owned; pressed again (matching vanilla's own slot-sharing for fist/chainsaw
 * and shotgun/supershotgun) it steps to the *next* owned weapon in the slot
 * instead, so repeated presses toggle between the two rather than always
 * landing back on the same "best" pick — otherwise a slot's weaker weapon
 * would be permanently unreachable once its upgrade is owned.
 */
export const WEAPON_SLOTS: WeaponId[][] = [
  ['chainsaw', 'fist'],
  ['pistol'],
  ['supershotgun', 'shotgun'],
  ['chaingun'],
  ['rocketLauncher'],
  ['plasmaRifle'],
  ['bfg'],
];

/** Mouse-wheel cycling order, weakest to strongest; also the HUD's weapon-icon order. */
export const WEAPON_CYCLE: WeaponId[] = [
  'fist',
  'chainsaw',
  'pistol',
  'shotgun',
  'supershotgun',
  'chaingun',
  'rocketLauncher',
  'plasmaRifle',
  'bfg',
];

/**
 * **Every number in this table is vanilla's** — fire rates from `info.c`'s
 * weapon state chains (`WeaponDef.cooldown`), spread from the `<<18`/`<<19`
 * shifts in `p_pspr.c`, damage from `P_GunShot`/`PIT_CheckThing`, ammo cost
 * from `P_FireWeapon`, projectile speed from `mobjinfo`. Nothing here is tuned
 * by feel; a top-down camera changes how a weapon is *aimed*, not how fast it
 * shoots or how hard it hits. See docs/weapons.md § Fire rates.
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fist: {
    ammoType: null,
    ammoPerShot: 0,
    // S_PUNCH1-4 (4+4+5+4); S_PUNCH5 carries A_ReFire.
    cooldown: 17 * DOOM_TIC,
    kind: 'melee',
    pellets: 0,
    // A_Punch throws the *swing* off by the same <<18 draw a bullet gets. It
    // matters far less than a bullet's: at MELEERANGE that is ~6 units of arc
    // against `MONSTER_HIT_RADIUS`.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: PLAYER_MELEE_RANGE,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'PUNGA0',
    fireSound: null,
    hitSound: 'punch',
    missSound: null,
    // Vanilla A_Punch: (P_Random()%10+1)<<1, i.e. 2-20, times 10 with berserk.
    damageDiceSides: 10,
    damageDiceMultiplier: 2,
    splash: null,
    spray: null,
  },
  chainsaw: {
    ammoType: null,
    ammoPerShot: 0,
    // S_SAW1 and S_SAW2 *both* call A_Saw, 4 tics each, and S_SAW3's A_ReFire
    // costs nothing — so one bite per 4 tics, not per pass through the chain.
    cooldown: 4 * DOOM_TIC,
    kind: 'melee',
    pellets: 0,
    // A_Saw's own <<18 swing spread, identical to A_Punch's.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: false,
    // `A_Saw` really traces MELEERANGE+1, with vanilla's own comment saying
    // why: "use meleerange + 1 se the puff doesn't skip the flash". The extra
    // unit of reach is incidental; the puff is what it's for (spritefxdefs.ts's
    // PUFF_MELEE_FRAMES).
    meleeRange: PLAYER_MELEE_RANGE + 1,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'CSAWA0',
    fireSound: null,
    hitSound: 'sawhit',
    missSound: 'sawful',
    // Vanilla A_Saw rolls the same 2-20 as the punch — the chainsaw's advantage
    // is its fire rate (`cooldown`), not a bigger bite, and berserk never
    // touches it (see BERSERK_FIST_MULTIPLIER).
    damageDiceSides: 10,
    damageDiceMultiplier: 2,
    splash: null,
    spray: null,
  },
  pistol: {
    ammoType: 'bullets',
    ammoPerShot: 1,
    // S_PISTOL1-3 (4+6+4); S_PISTOL4 carries A_ReFire.
    cooldown: 14 * DOOM_TIC,
    kind: 'hitscan',
    pellets: 1,
    // P_GunShot's `(P_Random()-P_Random())<<18` — 255<<18 of a 2^32 turn.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: true,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'PISGA0',
    fireSound: 'pistol',
    hitSound: null,
    missSound: null,
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  shotgun: {
    ammoType: 'shells',
    ammoPerShot: 1,
    // S_SGUN1-8 (3+7+5+5+4+5+5+3); S_SGUN9 carries A_ReFire.
    cooldown: 37 * DOOM_TIC,
    kind: 'hitscan',
    pellets: 7,
    // A_FireShotgun calls P_GunShot(mo, false) seven times: the same <<18 as
    // the pistol, and never the accurate first shot.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'SHOTA0',
    fireSound: 'shotgn',
    hitSound: null,
    missSound: null,
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  supershotgun: {
    ammoType: 'shells',
    ammoPerShot: 2,
    // S_DSGUN1-9 (3+7+7+7+7+7+7+6+6); S_DSGUN10 carries A_ReFire.
    cooldown: 57 * DOOM_TIC,
    kind: 'hitscan',
    pellets: 20,
    // A_FireShotgun2 doesn't go through P_GunShot at all: its own loop uses
    // `<<19`, twice the shotgun's cone, and is the only spread in the game
    // that also jitters the slope.
    spreadDeg: 11.2,
    slopeSpread: SSG_SLOPE_SPREAD,
    accurateFirstShot: false,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'SGN2A0',
    fireSound: 'dshtgn',
    hitSound: null,
    missSound: null,
    // Vanilla's own per-pellet roll, not an approximation: `A_FireShotgun2`
    // inlines the identical `5*(P_Random()%3+1)` `P_GunShot` uses, so the
    // 20-vs-7 pellet count is the SSG's whole advantage.
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  chaingun: {
    ammoType: 'bullets',
    ammoPerShot: 1,
    // S_CHAIN1 and S_CHAIN2 both call A_FireCGun, 4 tics each, and S_CHAIN3's
    // A_ReFire holds 0 — one bullet per 4 tics, the chainsaw's own structure.
    cooldown: 4 * DOOM_TIC,
    kind: 'hitscan',
    pellets: 1,
    spreadDeg: 5.6,
    slopeSpread: 0,
    // A_FireCGun passes !player->refire exactly as A_FirePistol does, so a
    // tapped chaingun shot is dead accurate and a held burst is not.
    accurateFirstShot: true,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'MGUNA0',
    // A_FireCGun plays the *pistol* shot, not the `chgun` lump that shares its
    // name with the weapon — `chgun` is in vanilla's sound table and reached by
    // nothing at all.
    fireSound: 'pistol',
    hitSound: null,
    missSound: null,
    // Vanilla's chaingun reuses the pistol's own damage roll.
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  rocketLauncher: {
    ammoType: 'rockets',
    ammoPerShot: 1,
    // S_MISSILE2 (12, A_FireMissile) + S_MISSILE1 (8, the flash); S_MISSILE3
    // carries A_ReFire. The 8-tic lead-in is vanilla's own launch delay.
    cooldown: 20 * DOOM_TIC,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    // MT_ROCKET's mobjinfo speed, 20 units/tic.
    projectileSpeed: 20 * 35,
    projectileSprite: 'MISL',
    iconLump: 'LAUNA0',
    // `rlaunc` comes from MT_ROCKET itself — see fireSound's doc.
    fireSound: null,
    hitSound: null,
    missSound: null,
    damageDiceSides: 8,
    damageDiceMultiplier: 20,
    // Vanilla's A_Explode: a fixed 128/128 radius attack, independent of the
    // direct-hit roll above.
    splash: { radius: 128, damage: 128, hitsPlayer: true },
    spray: null,
  },
  plasmaRifle: {
    ammoType: 'cells',
    ammoPerShot: 1,
    // S_PLASMA1 alone (3, A_FirePlasma) — S_PLASMA2's 20 tics carry A_ReFire
    // and are only ever spent on *releasing* the trigger, which is what makes
    // the plasma rifle the fastest weapon in the game rather than a slow one.
    cooldown: 3 * DOOM_TIC,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    // MT_PLASMA's mobjinfo speed, 25 units/tic.
    projectileSpeed: 25 * 35,
    projectileSprite: 'PLSS',
    iconLump: 'PLASA0',
    // As with the rocket: `plasma` is MT_PLASMA's own seesound.
    fireSound: null,
    hitSound: null,
    missSound: null,
    // MT_PLASMA's mobjinfo damage is 5, rolled by PIT_CheckThing's shared
    // ((P_Random()%8)+1) — 5-40, not the 5-20 an earlier 4-sided roll gave.
    damageDiceSides: 8,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  bfg: {
    ammoType: 'cells',
    ammoPerShot: 40,
    // S_BFG3 (10, A_FireBFG) + S_BFG1 (20) + S_BFG2 (10); S_BFG4 carries
    // A_ReFire. Those first two states are also vanilla's charge-up *before*
    // the ball leaves, which this engine doesn't reproduce — see
    // docs/weapons.md § Fire rates.
    cooldown: 40 * DOOM_TIC,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    // MT_BFG's mobjinfo speed, 25 units/tic — the same as a plasma bolt's.
    projectileSpeed: 25 * 35,
    projectileSprite: 'BFS1',
    iconLump: 'BFUGA0',
    // The one projectile weapon with a sound of its own: MT_BFG's seesound is 0
    // and `A_BFGsound` is a separate state action that plays this.
    fireSound: 'bfg',
    hitSound: null,
    missSound: null,
    // MT_BFG's own mobjinfo damage is 100, so the ball's *contact* hit alone
    // is 100-800 before `spray` adds anything.
    damageDiceSides: 8,
    damageDiceMultiplier: 100,
    // A_Explode is never called on the BFG ball in vanilla — see
    // WeaponDef.splash's doc — its real secondary damage is `spray` below.
    splash: null,
    // See WeaponDef.spray's doc — vanilla's real A_BFGSpray numbers.
    spray: { rays: 40, arcDeg: 90, range: 16 * 64, diceRolls: 15, diceSides: 8 },
  },
};

export interface HitscanShot {
  kind: 'hitscan';
  angleRad: number;
  /**
   * This pellet's own jitter off the shot's aim *slope* (`WeaponDef.slopeSpread`),
   * as rise per unit travelled — non-zero only for the super shotgun. Applied
   * by moving the aim point up or down at the target's distance, since that is
   * what `shotPath` derives its slope from.
   */
  slopeOffset: number;
  /** This pellet's own damage roll (WeaponDef.damageDiceSides/Multiplier) — applied only if this pellet's own `angleRad`, spread included, lands on a body (game/projectiles.ts: spawnPlayerShot). */
  damage: number;
}

export interface ProjectileShot {
  kind: 'projectile';
  angleRad: number;
  speed: number;
  sprite: string;
  /** Direct-hit damage roll, applied on arrival if this shot was locked onto a monster that it actually reached. */
  damage: number;
  /** Splash to apply at the impact point regardless of what (if anything) was targeted, straight from WeaponDef.splash — null for a non-explosive projectile (plasma, BFG). */
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /** The BFG's real secondary attack on arrival, straight from WeaponDef.spray — null for every other projectile. */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
}

export interface MeleeShot {
  kind: 'melee';
  angleRad: number;
  /** How far in front of the player this swing reaches (`WeaponDef.meleeRange`). */
  range: number;
  /** This swing's damage roll, already scaled by berserk where it applies. */
  damage: number;
  /**
   * Carried from `WeaponDef.hitSound`/`missSound` so whoever resolves the
   * swing doesn't have to look the weapon back up to know what it sounds like
   * — the same reason a `ProjectileShot` carries its own sprite and splash.
   */
  hitSound: SfxId | null;
  missSound: SfxId | null;
}

export type Shot = HitscanShot | ProjectileShot | MeleeShot;

/**
 * Owns weapon selection (number keys, mouse wheel) and fire timing/ammo.
 * Deliberately knows nothing about THREE.js: `update` only returns *what*
 * was fired this frame (one `Shot` per hitscan pellet or per projectile
 * launched), and `game.ts` turns those into tracer lines / flying projectile
 * sprites — the same split as `game/specials.ts`'s line triggers vs.
 * `game.ts`'s teleport-fog puffs, and `game/monsters/defs.ts`'s own `MonsterAttack`
 * return value for a monster's fired shot.
 *
 * A `Shot` doesn't know *what* it's aimed at beyond the angle/damage numbers
 * here — whether it actually lands on anything (a locked-on target within
 * range, a monster caught in a free shot's path, or one caught in a
 * projectile's splash) is resolved entirely in `game.ts`, which is also
 * where the damage this class rolls per shot actually gets applied.
 */
export class WeaponSystem {
  /**
   * Tics until the trigger may fire again, counted as a **whole number** rather
   * than as seconds remaining. The simulation steps one tic at a time and every
   * `WeaponDef.cooldown` is a whole number of tics, so an integer countdown is
   * both exact and the same model vanilla has — a psprite sitting in a state
   * with that many tics left. Seconds invited a float residue to decide whether
   * a shot landed on tic N or N+1, which is a whole 33% of the plasma rifle's
   * rate. docs/weapons.md § Fire rates.
   */
  private cooldownTics = 0;
  /**
   * Which weapon was selected as of the previous frame, so bringing the
   * chainsaw up can play `sawup` — a switch can come from a key, the wheel
   * *or* a pickup, so this is compared once a frame rather than at each of
   * those. See `updateSounds`.
   */
  private lastWeapon: WeaponId = 'pistol';
  /**
   * The weapon selected before the current one, for the right button's
   * "switch to previous weapon" binding. Maintained off `lastWeapon`'s once-a-frame
   * comparison so a pickup- or berserk-driven switch counts too, exactly as
   * that field's own doc describes. Null until the first switch of the level.
   */
  private previousWeapon: WeaponId | null = null;
  /** Counts down to the chainsaw's next idle rattle — see `SAW_IDLE_INTERVAL`. */
  private sawIdleTimer = 0;
  /**
   * Vanilla's `player->refire`: how many shots the trigger has already fired
   * without coming up. Only `WeaponDef.accurateFirstShot` reads it, and only
   * for "is this shot the first of the burst" — `A_ReFire` zeroes it the
   * moment the button is released or a weapon switch is pending, which
   * `update` reproduces by comparing against `refireWeapon`.
   */
  private refire = 0;
  private refireWeapon: WeaponId | null = null;

  /**
   * Resyncs the switch tracking to whatever is selected as a level starts, so
   * carrying the chainsaw through a level transition doesn't announce it as if
   * it had just been brought up.
   */
  beginLevel(inv: Inventory): void {
    // A fresh level starts ready to fire, rather than inheriting whatever was
    // left on the clock when the last one ended.
    this.cooldownTics = 0;
    this.lastWeapon = inv.currentWeapon;
    this.previousWeapon = null;
    this.sawIdleTimer = 0;
    this.refire = 0;
    this.refireWeapon = null;
  }

  /**
   * The two weapon sounds that aren't tied to firing: the chainsaw announcing
   * itself as it comes up (`P_BringUpWeapon`, which does this for no other
   * weapon) and its idle rattle while it's the ready weapon and the trigger is
   * released (`A_WeaponReady`, see `SAW_IDLE_INTERVAL`). `at` is the player's
   * own position, which both are attenuated from.
   */
  updateSounds(dt: number, firing: boolean, inv: Inventory, audio: AudioEngine, at: Pos3): void {
    const weapon = inv.currentWeapon;
    const justSwitched = weapon !== this.lastWeapon;
    if (justSwitched) {
      this.previousWeapon = this.lastWeapon;
      this.lastWeapon = weapon;
      // Checked once a frame rather than at each switch, since a pickup can
      // select a weapon too (`applyPickup`), exactly as vanilla's own
      // `pendingweapon` path does.
      if (weapon === 'chainsaw') audio.play('sawup', at, PLAYER_ORIGIN);
    }
    if (weapon !== 'chainsaw' || firing) {
      this.sawIdleTimer = 0;
      return;
    }
    // A fresh switch skips straight to a full interval rather than falling
    // into the countdown below: `sawIdleTimer` is left at 0 from whatever
    // weapon was selected before, so falling through would fire `sawidl` in
    // this same call and cut off the `sawup` that just played above — both
    // share the player's origin (see this method's own doc).
    if (justSwitched) {
      this.sawIdleTimer = SAW_IDLE_INTERVAL;
      return;
    }
    this.sawIdleTimer -= dt;
    if (this.sawIdleTimer > 0) return;
    this.sawIdleTimer = SAW_IDLE_INTERVAL;
    audio.play('sawidl', at, PLAYER_ORIGIN);
  }

  /**
   * Applies this frame's number-key, mouse-wheel and right-button weapon
   * switches. Runs before `updateSounds`, so the swap below reads the weapon
   * left behind by an *earlier* switch and that same call then records the one
   * being left now — which is what makes a second click toggle back.
   */
  handleSwitching(input: Input, inv: Inventory, wheelDelta: number): void {
    // Ahead of the wheel block, which early-returns on no scroll.
    const previous = this.previousWeapon;
    if (previous !== null && inv.weapons.has(previous) && input.rightMousePressed('previousweapon')) {
      inv.currentWeapon = previous;
    }

    for (let i = 0; i < WEAPON_SLOTS.length; i++) {
      if (!input.pressed(`Digit${i + 1}`)) continue;
      const owned = WEAPON_SLOTS[i].filter((w) => inv.weapons.has(w));
      if (owned.length === 0) continue;
      const idx = owned.indexOf(inv.currentWeapon);
      inv.currentWeapon = idx === -1 ? owned[0] : owned[(idx + 1) % owned.length];
    }

    if (wheelDelta === 0) return;
    const owned = WEAPON_CYCLE.filter((w) => inv.weapons.has(w));
    if (owned.length === 0) return;
    const idx = owned.indexOf(inv.currentWeapon);
    const dir = wheelDelta > 0 ? 1 : -1;
    inv.currentWeapon = owned[(idx + dir + owned.length) % owned.length];
  }

  /**
   * Ticks the fire cooldown and, while `firing` is held and both cooldown
   * and ammo allow it, spends ammo and returns the shot(s) fired this frame:
   * one `HitscanShot` per pellet, one `ProjectileShot` per launch, or one
   * `MeleeShot` per swing. Empty whenever nothing fired.
   */
  update(firing: boolean, inv: Inventory, aimAngleRad: number): Shot[] {
    // Clamped at 0 rather than allowed to run negative. That and the plain
    // assignment below are one rule in two halves — **an idle trigger banks
    // nothing** — and it takes both: a counter that free-falls while the trigger
    // is up, then has the cooldown *added* to it, comes back up through zero one
    // tic at a time and fires every tic until it does. Breaking either half
    // alone is harmless, which is exactly why the pair is easy to get wrong.
    if (this.cooldownTics > 0) this.cooldownTics--;
    // A_ReFire's else branch: letting the trigger up — or having a weapon
    // switch pending — resets the burst, so the next shot counts as its first.
    if (!firing || inv.currentWeapon !== this.refireWeapon) this.refire = 0;
    if (!firing || this.cooldownTics > 0) return [];

    const def = WEAPONS[inv.currentWeapon];
    if (def.ammoType && inv.ammo[def.ammoType] < def.ammoPerShot) return [];

    // Assigned, not added — the other half of the rule at the decrement above:
    // the interval between two shots is exactly this weapon's own state length,
    // with nothing carried over from the last one. `WEAPONS` quotes cooldowns in
    // seconds (the table is written `N * DOOM_TIC`, and `tests/game/tables.test.ts`
    // pins every entry to a whole tic), so this recovers the N the state chain holds.
    this.cooldownTics = Math.round(def.cooldown / DOOM_TIC);
    if (def.ammoType) inv.ammo[def.ammoType] -= def.ammoPerShot;
    // `!player->refire` is read *before* A_ReFire bumps it, so the opening
    // shot of a hold is the accurate one.
    const accurate = def.accurateFirstShot && this.refire === 0;
    this.refire++;
    this.refireWeapon = inv.currentWeapon;

    if (def.kind === 'melee') {
      // Berserk scales the fist only, exactly as vanilla's A_Punch/A_Saw split
      // it — see BERSERK_FIST_MULTIPLIER.
      const berserk = inv.currentWeapon === 'fist' && hasPower(inv, 'berserk');
      return [
        {
          kind: 'melee',
          // A_Punch/A_Saw fuzz the swing angle just like a bullet's.
          angleRad: aimAngleRad + triangularSpread(def.spreadDeg),
          range: def.meleeRange,
          damage: rollDamage(def.damageDiceSides, def.damageDiceMultiplier) * (berserk ? BERSERK_FIST_MULTIPLIER : 1),
          hitSound: def.hitSound,
          missSound: def.missSound,
        },
      ];
    }

    if (def.kind === 'hitscan') {
      const shots: Shot[] = [];
      for (let i = 0; i < def.pellets; i++) {
        // Each pellet draws its own angle and (super shotgun only) its own
        // slope, exactly as vanilla's per-pellet loops do — one aim, many
        // independent bullets. `accurate` is the pistol/chaingun's first shot.
        const spread = accurate ? 0 : triangularSpread(def.spreadDeg);
        shots.push({
          kind: 'hitscan',
          angleRad: aimAngleRad + spread,
          slopeOffset: accurate ? 0 : triangularDraw(def.slopeSpread),
          damage: rollDamage(def.damageDiceSides, def.damageDiceMultiplier),
        });
      }
      return shots;
    }

    return [
      {
        kind: 'projectile',
        angleRad: aimAngleRad,
        speed: def.projectileSpeed,
        sprite: def.projectileSprite,
        damage: rollDamage(def.damageDiceSides, def.damageDiceMultiplier),
        splash: def.splash,
        spray: def.spray,
      },
    ];
  }
}
