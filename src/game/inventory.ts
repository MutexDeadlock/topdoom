/** The four ammo classes DOOM tracks; matches vanilla's `ammotype_t`. */
export const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'] as const;
export type AmmoType = (typeof AMMO_TYPES)[number];

/**
 * Card and skull keys of the same color are tracked as one slot: this engine
 * has no locked-door requirement check yet (see game/specials.ts's note on
 * that), so there is nothing that would ever need to tell them apart.
 */
export const KEY_COLORS = ['blue', 'red', 'yellow'] as const;
export type KeyColor = (typeof KEY_COLORS)[number];

/**
 * Every weapon the player can carry, including fist and pistol — vanilla
 * starts every game with both already owned and neither has a map pickup,
 * but now that weapons are selectable/fireable (game/weapons.ts) they still
 * need an id like every other weapon to be `currentWeapon`-able.
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

export interface Inventory {
  health: number;
  armor: number;
  /** 0 = none, 1 = green/jacket armor, 2 = blue/security armor. */
  armorType: 0 | 1 | 2;
  ammo: Record<AmmoType, number>;
  keys: Set<KeyColor>;
  weapons: Set<WeaponId>;
  /** Which owned weapon is selected — see game/weapons.ts for switching/firing. */
  currentWeapon: WeaponId;
}

/** Vanilla DOOM's own new-game defaults: full health, no armor, fist + pistol with 50 bullets. */
export function createInventory(): Inventory {
  return {
    health: 100,
    armor: 0,
    armorType: 0,
    ammo: { bullets: 50, shells: 0, rockets: 0, cells: 0 },
    keys: new Set(),
    weapons: new Set(['fist', 'pistol']),
    currentWeapon: 'pistol',
  };
}

/** Item pickup radius (map units) vanilla uses for most pickups (health/armor/ammo/keys). */
export const ITEM_PICKUP_RADIUS = 20;

const MAX_HEALTH = 100;
/** Bonus items (health bonus, soulsphere, megasphere) push health past the normal cap, up to this. */
const MAX_HEALTH_BONUS = 200;
const MAX_ARMOR = 200;
const AMMO_MAX: Record<AmmoType, number> = { bullets: 200, shells: 50, rockets: 50, cells: 300 };

const HEALTH_PICKUPS: Record<number, { amount: number; bonus: boolean }> = {
  2011: { amount: 10, bonus: false }, // Stimpack
  2012: { amount: 25, bonus: false }, // Medikit
  2014: { amount: 1, bonus: true }, // Health bonus
  2013: { amount: 100, bonus: true }, // Soulsphere
};

const ARMOR_PICKUPS: Record<number, { amount: number; armorType: 1 | 2 }> = {
  2018: { amount: 100, armorType: 1 }, // Green armor
  2019: { amount: 200, armorType: 2 }, // Blue armor
};

const AMMO_PICKUPS: Record<number, { type: AmmoType; amount: number }> = {
  2007: { type: 'bullets', amount: 10 }, // Clip
  2048: { type: 'bullets', amount: 50 }, // Box of bullets
  2008: { type: 'shells', amount: 4 }, // Shotgun shells
  2049: { type: 'shells', amount: 20 }, // Box of shells
  2010: { type: 'rockets', amount: 1 }, // Rocket
  2046: { type: 'rockets', amount: 5 }, // Box of rockets
  2047: { type: 'cells', amount: 20 }, // Cell charge
  17: { type: 'cells', amount: 100 }, // Cell charge pack
};

const KEY_PICKUPS: Record<number, KeyColor> = {
  5: 'blue',
  40: 'blue',
  13: 'red',
  38: 'red',
  6: 'yellow',
  39: 'yellow',
};

const MEGASPHERE = 83;
const ARMOR_BONUS = 2015;

/**
 * Ammo granted alongside a weapon pickup follows vanilla's `P_GiveWeapon`:
 * it hands over `2 * clipammo[type]` — twice the amount a single ammo
 * pickup of that type gives — for a weapon placed directly on the map (as
 * opposed to one dropped by a dead monster, which only gives half; this
 * engine has no monster drops yet, so every weapon pickup takes the "not
 * dropped" branch). The chainsaw needs no ammo at all.
 */
const WEAPON_PICKUPS: Record<number, { weapon: WeaponId; ammoType: AmmoType | null; ammoAmount: number }> = {
  2005: { weapon: 'chainsaw', ammoType: null, ammoAmount: 0 },
  2001: { weapon: 'shotgun', ammoType: 'shells', ammoAmount: 8 },
  82: { weapon: 'supershotgun', ammoType: 'shells', ammoAmount: 8 },
  2002: { weapon: 'chaingun', ammoType: 'bullets', ammoAmount: 20 },
  2003: { weapon: 'rocketLauncher', ammoType: 'rockets', ammoAmount: 2 },
  2004: { weapon: 'plasmaRifle', ammoType: 'cells', ammoAmount: 40 },
  2006: { weapon: 'bfg', ammoType: 'cells', ammoAmount: 40 },
};

/**
 * Applies a picked-up thing's effect, following vanilla's
 * `P_TouchSpecialThing` rules for the subset of items this engine models —
 * health, armor, ammo, keys and weapons. Powerups are still left alone
 * (still decorative, not collectible) since there is no player-status-effect
 * system yet to give them meaning — the same "state now, behavior later"
 * split weapon ownership itself used to be in before game/weapons.ts made
 * a picked-up weapon selectable and fireable.
 *
 * Returns false for an item that can't (or shouldn't) be picked up right
 * now — e.g. a Stimpack at full health, or a weapon already owned whose
 * ammo type is already full — so the caller leaves it on the ground and
 * visible, matching vanilla rather than "wasting" the pickup.
 */
export function applyPickup(inv: Inventory, type: number): boolean {
  if (type === MEGASPHERE) {
    inv.health = MAX_HEALTH_BONUS;
    inv.armor = MAX_ARMOR;
    inv.armorType = 2;
    return true;
  }
  if (type === ARMOR_BONUS) {
    inv.armor = Math.min(inv.armor + 1, MAX_ARMOR);
    if (inv.armorType === 0) inv.armorType = 1;
    return true;
  }

  const health = HEALTH_PICKUPS[type];
  if (health) {
    const cap = health.bonus ? MAX_HEALTH_BONUS : MAX_HEALTH;
    if (inv.health >= cap) return false;
    inv.health = Math.min(inv.health + health.amount, cap);
    return true;
  }

  const armor = ARMOR_PICKUPS[type];
  if (armor) {
    if (inv.armor >= armor.amount) return false;
    inv.armor = armor.amount;
    inv.armorType = armor.armorType;
    return true;
  }

  const ammo = AMMO_PICKUPS[type];
  if (ammo) {
    const cap = AMMO_MAX[ammo.type];
    if (inv.ammo[ammo.type] >= cap) return false;
    inv.ammo[ammo.type] = Math.min(inv.ammo[ammo.type] + ammo.amount, cap);
    return true;
  }

  const key = KEY_PICKUPS[type];
  if (key) {
    inv.keys.add(key);
    return true;
  }

  const weapon = WEAPON_PICKUPS[type];
  if (weapon) {
    const hadWeapon = inv.weapons.has(weapon.weapon);
    let gaveAmmo = false;
    if (weapon.ammoType) {
      const cap = AMMO_MAX[weapon.ammoType];
      if (inv.ammo[weapon.ammoType] < cap) {
        inv.ammo[weapon.ammoType] = Math.min(inv.ammo[weapon.ammoType] + weapon.ammoAmount, cap);
        gaveAmmo = true;
      }
    }
    inv.weapons.add(weapon.weapon);
    // Matches vanilla's P_GiveWeapon, which switches the player to a weapon
    // the instant it's newly picked up (not on every re-pickup of one already owned).
    if (!hadWeapon) inv.currentWeapon = weapon.weapon;
    return !hadWeapon || gaveAmmo;
  }

  return false;
}

/** Keys don't survive a level transition in vanilla (`G_PlayerFinishLevel`); health/armor/ammo do. */
export function finishLevel(inv: Inventory): void {
  inv.keys.clear();
}

/**
 * Reduces health by `amount`, letting worn armor absorb part of it first —
 * matches vanilla's own `P_DamageMobj`: green armor (`armorType` 1) absorbs a
 * third of the damage, blue (`armorType` 2) half, spending armor points
 * 1-for-1 with whatever it absorbed and falling back to bare (`armorType` 0)
 * once it runs out mid-hit. `health` is clamped at 0 rather than going
 * negative — main.ts's own death check is a simple `<= 0`, not "how far past
 * 0".
 */
export function applyDamage(inv: Inventory, amount: number): void {
  let damage = amount;
  if (inv.armorType > 0 && inv.armor > 0) {
    let saved = inv.armorType === 1 ? damage / 3 : damage / 2;
    if (inv.armor <= saved) {
      saved = inv.armor;
      inv.armorType = 0;
    }
    inv.armor -= saved;
    damage -= saved;
  }
  inv.health = Math.max(0, inv.health - damage);
}
