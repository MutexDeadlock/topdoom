/**
 * The inventory's own shapes: what a player carries, the ids every table here keys through, and the
 * `Misc` limits a DEHACKED patch can move. Imports nothing from the layer above it, so a module
 * wanting a {@link KeySlot} or an {@link AmmoType} takes neither the pickup tables nor
 * `applyPickup` with it.
 * See docs/items.md.
 */

/**
 * The four ammo classes DOOM tracks — vanilla's `ammotype_t` set, but **not its order**: that enum
 * is `am_clip, am_shell, am_cell, am_misl` (cells before rockets). Nothing keyed by
 * {@link AmmoType} cares, but anything reproducing a vanilla *loop* over ammo classes does — see
 * `AMMO_UPGRADE`.
 */
export const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'] as const;

export type AmmoType = (typeof AMMO_TYPES)[number];

/**
 * The three key colors. Vanilla's locked-door checks accept card or skull of a color
 * interchangeably (`p_doors.c`'s `!p->cards[it_bluecard] && !p->cards[it_blueskull]`), but Boom's
 * generalized locks *can* tell them apart (`P_CanUnlockGenDoor`), so ownership is tracked per exact
 * {@link KeySlot} and the vanilla-style color locks accept either (`satisfiesLock`).
 * docs/items.md § Locked doors and use triggers.
 */
export const KEY_COLORS = ['blue', 'red', 'yellow'] as const;

export type KeyColor = (typeof KEY_COLORS)[number];

/** The six key things, vanilla's `card_t` roster, tracked exactly. */
export const KEY_SLOTS = ['blueCard', 'redCard', 'yellowCard', 'blueSkull', 'redSkull', 'yellowSkull'] as const;

export type KeySlot = (typeof KEY_SLOTS)[number];

/**
 * Every weapon the player can carry, including fist and pistol, which have no map pickup but are
 * selectable and fireable (game/weapons.ts). docs/items.md § Inventory.
 */
export type WeaponId =
  | 'fist'
  | 'chainsaw'
  | 'pistol'
  | 'shotgun'
  | 'supershotgun'
  | 'chaingun'
  | 'rocketLauncher'
  | 'plasmaRifle'
  | 'bfg';

/**
 * The six powerup spheres/items, in the order the HUD shows them — named after what they do rather
 * than vanilla's `pw_*` enum (`pw_strength`, `pw_ironfeet`, `pw_allmap`, `pw_infrared`).
 */
export const POWER_IDS = [
  'invulnerability',
  'berserk',
  'invisibility',
  'radiationSuit',
  'computerMap',
  'lightVisor',
] as const;

export type PowerId = (typeof POWER_IDS)[number];

export interface Inventory {
  health: number;
  armor: number;
  /** 0 = none, 1 = green/jacket armor, 2 = blue/security armor. */
  armorType: 0 | 1 | 2;
  ammo: Record<AmmoType, number>;
  keys: Set<KeySlot>;
  weapons: Set<WeaponId>;
  /** Which owned weapon is selected — see game/weapons.ts for switching/firing. */
  currentWeapon: WeaponId;
  /**
   * Seconds of each powerup left (0 = not active, `Infinity` = lasts the rest of the level), ticked
   * down by `tickPowers` — vanilla's `player->powers[]`, which counts down in tics.
   */
  powers: Record<PowerId, number>;
  /**
   * Vanilla's `player->backpack`: doubles every ammo class's cap (`ammoMax`), and unlike the powers
   * above it survives a level transition.
   */
  backpack: boolean;
}

/**
 * The `Misc` limits a DEHACKED patch can move, and vanilla's `deh_misc[]` name for each. Grouped
 * into one record so `setInventoryLimits` has a single shape to write and the applier has a single
 * shape to build — docs/dehacked.md § Weapon, Ammo and Misc.
 */
export interface InventoryLimits {
  maxHealth: number;
  maxHealthBonus: number;
  maxArmor: number;
  greenArmorClass: number;
  blueArmorClass: number;
  initialHealth: number;
  initialBullets: number;
  /**
   * Vanilla's `soul_health` — what a soulsphere gives, capped at
   * {@link InventoryLimits.maxHealthBonus}.
   */
  soulsphereHealth: number;
  /** Vanilla's `mega_health` — the health a megasphere sets, alongside blue armor. */
  megasphereHealth: number;
  /** `deh_god_health`: the health IDDQD sets on the way on (docs/cheats.md § IDDQD). */
  godModeHealth: number;
  /**
   * `deh_idkfa_armor` / `deh_idkfa_armor_class`: the armor IDKFA hands over
   * (docs/cheats.md § IDKFA).
   */
  idkfaArmor: number;
  idkfaArmorClass: number;
}
