import { hasPower, type AmmoType, type Inventory, type WeaponId } from './inventory.ts';
import type { Input } from './input.ts';

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
   * Splash a projectile's impact also applies, independent of its own
   * randomized direct-hit roll above — vanilla's rocket explosion
   * (`A_Explode`) passes a **fixed** radius/damage of 128 to `P_RadiusAttack`,
   * not the missile's own random contact-damage roll; those are two separate
   * numbers that only look related because this file happens to reuse the
   * same dice for the rocket's direct hit. `hitsPlayer` is true for the
   * rocket — vanilla really does let a rocket's own blast hurt whoever fired
   * it (the classic "rocket jump" self-damage) — and false for the BFG:
   * vanilla's BFG ball never calls `A_Explode` at all, its real "spray"
   * damage is sourced *from* the shooter via individual autoaimed hitscans
   * and can only ever land on something else, never them. Implementing that
   * 40-ray spray exactly is far more code than this milestone justifies, so
   * it's approximated as a monster-only splash instead — bigger than the
   * rocket's, but never able to hurt the player who fired it. `null` means no
   * splash at all (plasma, a direct-hit-only bolt in vanilla too).
   *
   * `tracers` draws a thin line (`render/tracer.ts`'s `Tracer`, the same primitive
   * hitscan weapons use) from the impact to every monster the splash actually
   * hit — true only for the BFG, giving its spray some visible feedback for
   * what it hit, the same reason a hitscan weapon's tracer exists in the
   * first place. This isn't vanilla behavior (vanilla's spray rays are pure
   * math, never rendered at all) but reuses this engine's own established
   * "show what a shot hit" visual language rather than leaving the BFG's
   * approximated splash invisible. The rocket leaves this off — its own
   * explosion sprite is already vanilla's whole visual for it.
   */
  splash: { radius: number; damage: number; hitsPlayer: boolean; tracers: boolean } | null;
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
    // Vanilla A_Punch: (P_Random()%10+1)<<1, i.e. 2-20, times 10 with berserk.
    damageDiceSides: 10,
    damageDiceMultiplier: 2,
    splash: null,
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
    // Vanilla A_Saw rolls the same 2-20 as the punch — the chainsaw's advantage
    // is its fire rate (`cooldown`), not a bigger bite, and berserk never
    // touches it (see BERSERK_FIST_MULTIPLIER).
    damageDiceSides: 10,
    damageDiceMultiplier: 2,
    splash: null,
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
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
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
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
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
    // Same per-pellet formula as the shotgun (vanilla's SSG damage is close
    // enough to it that the 20-vs-7 pellet count alone already accounts for
    // the SSG's real advantage) rather than a second, separately-tuned roll.
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
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
    // Vanilla's chaingun reuses the pistol's own damage roll.
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
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
    damageDiceSides: 8,
    damageDiceMultiplier: 20,
    // Vanilla's A_Explode: a fixed 128/128 radius attack, independent of the
    // direct-hit roll above.
    splash: { radius: 128, damage: 128, hitsPlayer: true, tracers: false },
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
    damageDiceSides: 4,
    damageDiceMultiplier: 5,
    splash: null,
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
    // See WeaponDef.splash's doc — a monster-only stand-in for vanilla's real
    // 40-ray spray, sized to feel like the 40-cell cost; hitsPlayer: false is
    // the actual bug fix (a nearby monster's death shouldn't also kill you).
    damageDiceSides: 8,
    damageDiceMultiplier: 30,
    splash: { radius: 384, damage: 200, hitsPlayer: false, tracers: true },
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
  /** Splash to apply at the impact point regardless of what (if anything) was targeted, straight from WeaponDef.splash — null for a non-explosive projectile (plasma). */
  splash: { radius: number; damage: number; hitsPlayer: boolean; tracers: boolean } | null;
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
      },
    ];
  }
}
