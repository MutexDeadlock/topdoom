import type { AmmoType, Inventory, WeaponId } from './inventory.ts';
import type { Input } from './input.ts';

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
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'PUNGA0',
  },
  chainsaw: {
    ammoType: null,
    ammoPerShot: 0,
    cooldown: 0.1,
    kind: 'melee',
    pellets: 0,
    spreadDeg: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'CSAWA0',
  },
  pistol: {
    ammoType: 'bullets',
    ammoPerShot: 1,
    cooldown: 0.35,
    kind: 'hitscan',
    pellets: 1,
    spreadDeg: 5.6,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'PISGA0',
  },
  shotgun: {
    ammoType: 'shells',
    ammoPerShot: 1,
    cooldown: 0.65,
    kind: 'hitscan',
    pellets: 7,
    spreadDeg: 5.6,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'SHOTA0',
  },
  supershotgun: {
    ammoType: 'shells',
    ammoPerShot: 2,
    cooldown: 0.95,
    kind: 'hitscan',
    pellets: 20,
    spreadDeg: 8.4,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'SGN2A0',
  },
  chaingun: {
    ammoType: 'bullets',
    ammoPerShot: 1,
    cooldown: 0.1,
    kind: 'hitscan',
    pellets: 1,
    spreadDeg: 5.6,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'MGUNA0',
  },
  rocketLauncher: {
    ammoType: 'rockets',
    ammoPerShot: 1,
    cooldown: 0.6,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    projectileSpeed: 1000,
    projectileSprite: 'MISL',
    iconLump: 'LAUNA0',
  },
  plasmaRifle: {
    ammoType: 'cells',
    ammoPerShot: 1,
    cooldown: 0.15,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    projectileSpeed: 1600,
    projectileSprite: 'PLSS',
    iconLump: 'PLASA0',
  },
  bfg: {
    ammoType: 'cells',
    ammoPerShot: 40,
    cooldown: 1,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    projectileSpeed: 700,
    projectileSprite: 'BFS1',
    iconLump: 'BFUGA0',
  },
};

export interface HitscanShot {
  kind: 'hitscan';
  angleRad: number;
}

export interface ProjectileShot {
  kind: 'projectile';
  angleRad: number;
  speed: number;
  sprite: string;
}

export type Shot = HitscanShot | ProjectileShot;

/**
 * Owns weapon selection (number keys, mouse wheel) and fire timing/ammo.
 * Deliberately knows nothing about THREE.js: `update` only returns *what*
 * was fired this frame (one `Shot` per hitscan pellet or per projectile
 * launched), and main.ts turns those into tracer lines / flying projectile
 * sprites — the same split as game/specials.ts's line triggers vs. main.ts's
 * teleport-fog puffs.
 *
 * There's no monster AI or damage model yet (see CLAUDE.md's "Current
 * state"), so a `Shot` has no notion of what it hit — firing only spends
 * ammo and produces something to render, the same "state now, behavior
 * later" split collected weapons themselves were in before this file existed.
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
   * and ammo allow it, spends ammo and returns the shot(s) fired this frame.
   * Empty whenever nothing fired, including every frame for a melee weapon
   * (it still pays cooldown/no ammo, just has nothing to render — there's no
   * target to swing at yet).
   */
  update(dt: number, firing: boolean, inv: Inventory, aimAngleRad: number): Shot[] {
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    if (!firing || this.cooldownRemaining > 0) return [];

    const def = WEAPONS[inv.currentWeapon];
    if (def.ammoType && inv.ammo[def.ammoType] < def.ammoPerShot) return [];

    this.cooldownRemaining = def.cooldown;
    if (def.ammoType) inv.ammo[def.ammoType] -= def.ammoPerShot;

    if (def.kind === 'melee') return [];

    if (def.kind === 'hitscan') {
      const shots: Shot[] = [];
      for (let i = 0; i < def.pellets; i++) {
        // Matches vanilla's own P_Random-P_Random trick: two uniform draws
        // subtracted gives a triangular distribution centred on the aim line.
        const spread = def.spreadDeg > 0 ? ((Math.random() - Math.random()) * def.spreadDeg * Math.PI) / 180 : 0;
        shots.push({ kind: 'hitscan', angleRad: aimAngleRad + spread });
      }
      return shots;
    }

    return [{ kind: 'projectile', angleRad: aimAngleRad, speed: def.projectileSpeed, sprite: def.projectileSprite }];
  }
}
