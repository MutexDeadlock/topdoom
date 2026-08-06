import { hasPower, type AmmoType, type Inventory, type WeaponId } from './inventory.ts';
import type { Input } from './input.ts';
import type { SfxId } from '../audio/sfx.ts';

/**
 * Vanilla's `MELEERANGE`: how far `A_Punch`/`A_Saw` trace out from the
 * player's own centre. `game/monsters.ts` keeps its own, slightly longer
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

export type WeaponKind = 'melee' | 'hitscan' | 'projectile';

export interface WeaponDef {
  /** Ammo class this weapon spends, or null for the ammo-less melee weapons. */
  ammoType: AmmoType | null;
  ammoPerShot: number;
  /** Seconds between shots while the trigger is held. */
  cooldown: number;
  kind: WeaponKind;
  /** Hitscan only: bullets/pellets fired per trigger pull. */
  pellets: number;
  /** Hitscan only: each pellet's random spread off the aim line, in degrees. */
  spreadDeg: number;
  /** Melee only: how far in front of the player the swing reaches (`PLAYER_MELEE_RANGE`); 0 for everything else. */
  meleeRange: number;
  /** Projectile only: travel speed, map units/sec. */
  projectileSpeed: number;
  /** Projectile only: SpriteBank name the flying shot is drawn as. */
  projectileSprite: string;
  /**
   * Status-bar icon lump. Reuses the ground pickup's own sprite frame (the
   * same convention ui/hud.ts already uses for ammo/keys/health) for every
   * weapon that has one; fist and pistol have no map pickup, so their own
   * first-person "ready" frame stands in instead.
   */
  iconLump: string;
  /**
   * A direct/pellet hit's damage roll is `((rand % damageDiceSides) + 1) *
   * damageDiceMultiplier` — vanilla's own P_Random-based per-weapon formula
   * (pistol/chaingun/shotgun pellets: 5,10,15; plasma bolt: 5,10,15,20;
   * rocket: 20-160 in steps of 20; fist and chainsaw: 2-20), lifted rather
   * than tuned by feel since it decides how tough a fight actually is, the
   * same reasoning ammo-per-shot already used. The fist's roll is additionally
   * scaled while berserk is held — see `BERSERK_FIST_MULTIPLIER`.
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

/** `((rand % sides) + 1) * multiplier` — vanilla's own P_Random damage-roll shape. 0 sides means "always 0". */
export function rollDamage(sides: number, multiplier: number): number {
  return sides > 0 ? (Math.floor(Math.random() * sides) + 1) * multiplier : 0;
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
 * Fire rates and spread are tuned by feel rather than converted from
 * vanilla's tic-based weapon states, the same reasoning as player.ts's
 * GRAVITY — they don't translate cleanly to a dt-scaled model. Ammo-per-shot
 * costs have no such conversion problem and are lifted straight from
 * vanilla's `P_FireWeapon` table, since they're what determines how long a
 * pickup's ammo actually lasts.
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fist: {
    ammoType: null,
    ammoPerShot: 0,
    cooldown: 0.25,
    kind: 'melee',
    pellets: 0,
    spreadDeg: 0,
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
    cooldown: 0.1,
    kind: 'melee',
    pellets: 0,
    spreadDeg: 0,
    meleeRange: PLAYER_MELEE_RANGE,
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
    cooldown: 0.35,
    kind: 'hitscan',
    pellets: 1,
    spreadDeg: 5.6,
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
    cooldown: 0.65,
    kind: 'hitscan',
    pellets: 7,
    spreadDeg: 5.6,
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
    cooldown: 0.95,
    kind: 'hitscan',
    pellets: 20,
    spreadDeg: 8.4,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'SGN2A0',
    fireSound: 'dshtgn',
    hitSound: null,
    missSound: null,
    // Same per-pellet formula as the shotgun (vanilla's SSG damage is close
    // enough to it that the 20-vs-7 pellet count alone already accounts for
    // the SSG's real advantage) rather than a second, separately-tuned roll.
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  chaingun: {
    ammoType: 'bullets',
    ammoPerShot: 1,
    cooldown: 0.1,
    kind: 'hitscan',
    pellets: 1,
    spreadDeg: 5.6,
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
    cooldown: 0.6,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    meleeRange: 0,
    projectileSpeed: 1000,
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
    cooldown: 0.15,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    meleeRange: 0,
    projectileSpeed: 1600,
    projectileSprite: 'PLSS',
    iconLump: 'PLASA0',
    // As with the rocket: `plasma` is MT_PLASMA's own seesound.
    fireSound: null,
    hitSound: null,
    missSound: null,
    damageDiceSides: 4,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  bfg: {
    ammoType: 'cells',
    ammoPerShot: 40,
    cooldown: 1,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    meleeRange: 0,
    projectileSpeed: 700,
    projectileSprite: 'BFS1',
    iconLump: 'BFUGA0',
    // The one projectile weapon with a sound of its own: MT_BFG's seesound is 0
    // and `A_BFGsound` is a separate state action that plays this.
    fireSound: 'bfg',
    hitSound: null,
    missSound: null,
    damageDiceSides: 8,
    damageDiceMultiplier: 30,
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
  /** This pellet's own damage roll (WeaponDef.damageDiceSides/Multiplier) — only applied if it actually lands on the locked-on target (game.ts). */
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
}

export type Shot = HitscanShot | ProjectileShot | MeleeShot;

/**
 * Owns weapon selection (number keys, mouse wheel) and fire timing/ammo.
 * Deliberately knows nothing about THREE.js: `update` only returns *what*
 * was fired this frame (one `Shot` per hitscan pellet or per projectile
 * launched), and `game.ts` turns those into tracer lines / flying projectile
 * sprites — the same split as `game/specials.ts`'s line triggers vs.
 * `game.ts`'s teleport-fog puffs, and `game/monsters.ts`'s own `MonsterAttack`
 * return value for a monster's fired shot.
 *
 * A `Shot` doesn't know *what* it's aimed at beyond the angle/damage numbers
 * here — whether it actually lands on anything (a locked-on target within
 * range, a monster caught in a free shot's path, or one caught in a
 * projectile's splash) is resolved entirely in `game.ts`, which is also
 * where the damage this class rolls per shot actually gets applied.
 */
export class WeaponSystem {
  private cooldownRemaining = 0;

  /** Applies this frame's number-key and mouse-wheel weapon switches. */
  handleSwitching(input: Input, inv: Inventory, wheelDelta: number): void {
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
  update(dt: number, firing: boolean, inv: Inventory, aimAngleRad: number): Shot[] {
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    if (!firing || this.cooldownRemaining > 0) return [];

    const def = WEAPONS[inv.currentWeapon];
    if (def.ammoType && inv.ammo[def.ammoType] < def.ammoPerShot) return [];

    this.cooldownRemaining = def.cooldown;
    if (def.ammoType) inv.ammo[def.ammoType] -= def.ammoPerShot;

    if (def.kind === 'melee') {
      // Berserk scales the fist only, exactly as vanilla's A_Punch/A_Saw split
      // it — see BERSERK_FIST_MULTIPLIER.
      const berserk = inv.currentWeapon === 'fist' && hasPower(inv, 'berserk');
      return [
        {
          kind: 'melee',
          angleRad: aimAngleRad,
          range: def.meleeRange,
          damage: rollDamage(def.damageDiceSides, def.damageDiceMultiplier) * (berserk ? BERSERK_FIST_MULTIPLIER : 1),
        },
      ];
    }

    if (def.kind === 'hitscan') {
      const shots: Shot[] = [];
      for (let i = 0; i < def.pellets; i++) {
        // Matches vanilla's own P_Random-P_Random trick: two uniform draws
        // subtracted gives a triangular distribution centred on the aim line.
        const spread = def.spreadDeg > 0 ? ((Math.random() - Math.random()) * def.spreadDeg * Math.PI) / 180 : 0;
        shots.push({
          kind: 'hitscan',
          angleRad: aimAngleRad + spread,
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
