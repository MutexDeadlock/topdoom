/**
 * The player's inventory — health, armor, ammo, keys, weapons, powerups — and how each pickup type
 * applies to it, vanilla's own amounts and caps. See docs/items.md.
 */
import type { SfxId } from '../audio/sfx.ts';
import { ThingType } from './things/doomednums.ts';
import { DEFAULT_SKILL, ammoAtSkill, type Skill } from './skill.ts';
import { PLAYER_RADIUS } from './player.ts';
import { readStorage, writeStorage } from '../util/storage.ts';
import type { LockRule } from './specials/defs.ts';
import {
  KEY_COLORS,
  KEY_SLOTS,
  POWER_IDS,
  type AmmoType,
  type Inventory,
  type InventoryLimits,
  type KeyColor,
  type KeySlot,
  type PowerId,
  type WeaponId,
} from './inventory/defs.ts';
export {
  // Re-exported so this file stays the inventory's one public entry point — nothing outside
  // `inventory/` needs to know which file inside it a shape lives in.
  // docs/conventions.md § File names.
  AMMO_TYPES,
  KEY_COLORS,
  KEY_SLOTS,
  POWER_IDS,
  type AmmoType,
  type Inventory,
  type InventoryLimits,
  type KeyColor,
  type KeySlot,
  type PowerId,
  type WeaponId,
} from './inventory/defs.ts';
import {
  AMMO_PICKUPS,
  AMMO_UPGRADE,
  ARMOR_PICKUP_CLASS,
  HEALTH_PICKUPS,
  KEY_PICKUPS,
  POWERUP_PICKUPS,
  POWER_SECONDS,
  WEAPON_PICKUPS,
} from './inventory/tables.ts';

/** The color half of a slot — what the HUD tints and lock messages name. */
export function keySlotColor(slot: KeySlot): KeyColor {
  return (slot.startsWith('blue') ? 'blue' : slot.startsWith('red') ? 'red' : 'yellow') as KeyColor;
}

/**
 * Whether `keys` opens `lock` — the one lock check every trigger path uses.
 * Lives here rather than beside `LockRule` (`specials/defs.ts`) because it is
 * a question about the inventory, and keeping it here leaves that module's
 * import of the key types type-only.
 */
export function satisfiesLock(keys: ReadonlySet<KeySlot>, lock: LockRule): boolean {
  switch (lock.kind) {
    case 'any':
      return keys.size > 0;
    case 'color':
      return hasKeyColor(keys, lock.color);
    case 'slot':
      return keys.has(lock.slot);
    case 'all':
      return lock.colorsSuffice ? KEY_COLORS.every((c) => hasKeyColor(keys, c)) : keys.size === KEY_SLOTS.length;
  }
}

/** Vanilla DOOM's own new-game defaults: full health, no armor, fist + pistol with 50 bullets. */
export function createInventory(): Inventory {
  return {
    // Vanilla's `initial_health` / `initial_bullets`, both of which a DEHACKED `Misc` record can
    // move — docs/dehacked.md § Weapon, Ammo and Misc.
    health: LIMITS.initialHealth,
    armor: 0,
    armorType: 0,
    ammo: { bullets: LIMITS.initialBullets, shells: 0, rockets: 0, cells: 0 },
    keys: new Set(),
    weapons: new Set(['fist', 'pistol']),
    currentWeapon: 'pistol',
    powers: { invulnerability: 0, berserk: 0, invisibility: 0, radiationSuit: 0, computerMap: 0, lightVisor: 0 },
    backpack: false,
  };
}

/**
 * Every key at once — `P_SpawnPlayer`'s `if (deathmatch) for (i=0 ; i<NUMCARDS ; i++)
 * p->cards[i] = true;` (`p_mobj.c`), for a deathmatch body on every spawn and reborn.
 * docs/multiplayer-deathmatch.md § Rules.
 */
export function giveAllKeys(inv: Inventory): void {
  for (const key of KEY_SLOTS) inv.keys.add(key);
}

/** Whether a powerup is currently active. */
export function hasPower(inv: Inventory, power: PowerId): boolean {
  return inv.powers[power] > 0;
}

/**
 * Ages every timed powerup by `dt`; the `Infinity`-duration ones (berserk, computer map) are left
 * alone.
 */
export function tickPowers(inv: Inventory, dt: number): void {
  for (const p of POWER_IDS) {
    if (inv.powers[p] > 0 && inv.powers[p] !== Infinity) {
      inv.powers[p] = Math.max(0, inv.powers[p] - dt);
    }
  }
}

/** Item pickup radius (map units) vanilla uses for most pickups (health/armor/ammo/keys). */
const ITEM_PICKUP_RADIUS = 20;

/**
 * `PIT_CheckThing`'s `blockdist` for the player against an item (map units):
 * the two radii summed, tested as an axis-aligned box, not a circle
 * (docs/items.md § Collecting things).
 */
export const PICKUP_RANGE = PLAYER_RADIUS + ITEM_PICKUP_RADIUS;

const AMMO_MAX: Record<AmmoType, number> = { bullets: 200, shells: 50, rockets: 50, cells: 300 };

/**
 * Vanilla's own `maxammo[]`, doubled once a backpack has been collected —
 * `P_TouchSpecialThing`'s backpack case multiplies every entry by 2 in place,
 * permanently. Every cap check in this file goes through here rather than
 * reading `AMMO_MAX` directly, so a weapon's own ammo grant respects the
 * raised cap too, not just plain ammo pickups.
 */
export function ammoMax(inv: Inventory, type: AmmoType): number {
  return inv.backpack ? AMMO_MAX[type] * 2 : AMMO_MAX[type];
}

/**
 * Vanilla's `clipammo[]` — one clip's worth of each ammo class. Every ammo grant in this file goes
 * through it, because `P_GiveAmmo` multiplies its `num` by this table: `AMMO_PICKUPS` above counts
 * clips, `WEAPON_PICKUPS` below hands over two of them, and a backpack gives one of each
 * (`P_GiveAmmo(player, i, 1)` per class) on top of raising the caps.
 *
 * Patchable: a DEHACKED `Ammo N / Per ammo` line writes here, and the multipliers above are why
 * that reaches the pickups too. docs/dehacked.md § Weapon, Ammo and Misc.
 */
const CLIP_AMMO: Record<AmmoType, number> = { bullets: 10, shells: 4, rockets: 1, cells: 20 };

/**
 * Vanilla's `maxammo[i]` for one class. `ammoMax` is the only reader, so the backpack's doubling
 * follows on its own.
 */
export function setMaxAmmo(type: AmmoType, max: number): void {
  AMMO_MAX[type] = max;
}

/**
 * Vanilla's `clipammo[i]`. Nothing else needs re-deriving: `AMMO_PICKUPS` and `WEAPON_PICKUPS`
 * both count clips rather than amounts, exactly as `P_GiveAmmo` does, so they follow from here.
 */
export function setClipAmmo(type: AmmoType, per: number): void {
  CLIP_AMMO[type] = per;
}

/**
 * One patchable `Misc` limit, read at the point of use rather than copied — the same rule
 * `HEALTH_PICKUPS`' `{limit}` rows follow, so a patch applied mid-session is seen by the next read.
 * `game/cheats.ts` is the reader outside this module.
 */
export function inventoryLimit(field: keyof InventoryLimits): number {
  return LIMITS[field];
}

/** Writes the `Misc` limits a patch supplied, leaving the rest alone. */
export function setInventoryLimits(limits: Partial<InventoryLimits>): void {
  Object.assign(LIMITS, limits);
}

/** Everything the two `set*` functions above can move, as vanilla leaves it. */
const LIMITS: InventoryLimits = {
  /** Vanilla's `MAXHEALTH` (`d_player.h`) — the cap ordinary health pickups stop at. */
  maxHealth: 100,
  /**
   * Bonus items (health bonus, soulsphere, megasphere) push health past the normal cap, to this.
   */
  maxHealthBonus: 200,
  /** Vanilla's blue-armor cap, `P_GiveArmor`'s `armortype*100` for `armortype` 2. */
  maxArmor: 200,
  greenArmorClass: 1,
  blueArmorClass: 2,
  initialHealth: 100,
  initialBullets: 50,
  soulsphereHealth: 100,
  megasphereHealth: 200,
  /** `st_stuff.c`'s own literals, in `ST_Responder`'s cheat block. */
  godModeHealth: 100,
  idkfaArmor: 200,
  idkfaArmorClass: 2,
};

/**
 * The pristine values, for `resetDehacked` — see docs/dehacked.md § Applying: reset, then patch.
 */
const PRISTINE_LIMITS: InventoryLimits = { ...LIMITS };

const PRISTINE_AMMO_MAX: Record<AmmoType, number> = { ...AMMO_MAX };

const PRISTINE_CLIP_AMMO: Record<AmmoType, number> = { ...CLIP_AMMO };

/** Puts every patchable value in this module back to vanilla's, before a new patch is applied. */
export function resetInventoryLimits(): void {
  Object.assign(AMMO_MAX, PRISTINE_AMMO_MAX);
  Object.assign(CLIP_AMMO, PRISTINE_CLIP_AMMO);
  setInventoryLimits(PRISTINE_LIMITS);
}

const PISTOL_START_STORAGE_KEY = 'pistolStart';

/**
 * Whether every level is entered on a fresh `createInventory()` instead of carrying health, armor,
 * ammo and weapons over — the speedrunners' "pistol start", off by default and not vanilla's
 * behavior for an ordinary exit (it is what vanilla does between *episodes*, and what its level
 * select has always done). Read by `game.ts: enterLevel`, the one place a level transition installs
 * an inventory. docs/items.md § Pistol start.
 * Shaped like every persisted setting — docs/menu.md § Persisted settings.
 */
let pistolStart = readStorage(PISTOL_START_STORAGE_KEY, false);

export function getPistolStart(): boolean {
  return pistolStart;
}

export function setPistolStart(enabled: boolean): void {
  pistolStart = enabled;
  writeStorage(PISTOL_START_STORAGE_KEY, enabled);
}

/** A replay's pin on the setting, without touching the stored one; `null` puts that back. */
export function overridePistolStart(enabled: boolean | null): void {
  pistolStart = enabled ?? readStorage(PISTOL_START_STORAGE_KEY, false);
}

const AUTO_SWITCH_STORAGE_KEY = 'autoSwitchWeapon';

/**
 * Whether the game picks a *better* weapon for you: on ammo collected from empty (`AMMO_UPGRADE`)
 * and on the ready weapon running dry (`AMMO_FALLBACK_ORDER`, game/weapons.ts). **On by default** —
 * vanilla does both unconditionally, so the setting exists to opt out. The local slot reads it live
 * (`GLOBAL_PLAYER_SETTINGS`), so it applies to the level already running; the rules themselves take
 * the collecting slot's own (`PickupOptions.autoSwitch`, `WeaponSystem.autoSwitch`).
 * docs/weapons.md § Automatic weapon switching.
 *
 * Two switches are deliberately **outside** it, both because neither is a guess at which weapon is
 * better: a newly picked-up weapon selecting itself (`P_GiveWeapon`, in `applyPickup` below), and
 * berserk selecting the fist (`givePower`) — punching is that pickup's entire effect.
 * Shaped like every persisted setting — docs/menu.md § Persisted settings.
 */
let autoSwitchWeapon = readStorage(AUTO_SWITCH_STORAGE_KEY, true);

export function getAutoSwitchWeapon(): boolean {
  return autoSwitchWeapon;
}

export function setAutoSwitchWeapon(enabled: boolean): void {
  autoSwitchWeapon = enabled;
  writeStorage(AUTO_SWITCH_STORAGE_KEY, enabled);
}

/** A replay's pin on the setting, without touching the stored one; `null` puts that back. */
export function overrideAutoSwitchWeapon(enabled: boolean | null): void {
  autoSwitchWeapon = enabled ?? readStorage(AUTO_SWITCH_STORAGE_KEY, true);
}

/** How one pickup lands, beside the item itself. */
export interface PickupOptions {
  /** A monster's drop: granted ammo halves (`P_GiveAmmo`'s monster-drop rule). Default false. */
  dropped?: boolean;
  /** Skills 1 and 5 double granted ammo. Default `DEFAULT_SKILL`. */
  skill?: Skill;
  /**
   * The collecting player's automatic weapon switching, which `AMMO_UPGRADE` is gated on — the
   * slot's `PlayerSettings.autoSwitchWeapon`. Default on, the setting's own default.
   */
  autoSwitch?: boolean;
  /**
   * Weapons stay: a weapon the map placed gives nothing to a player who already owns it, not even
   * its ammo — `P_GiveWeapon`'s `if (netgame && (deathmatch!=2) && !dropped)`, which is coop here,
   * every deathmatch being `-altdeath`. Default false. docs/multiplayer-coop.md § Items and kills.
   */
  weaponsStay?: boolean;
}

/**
 * Applies a picked-up thing's effect, vanilla's `P_TouchSpecialThing` rules. Returns false for an
 * item that shouldn't be collected right now (Stimpack at full health), so the caller leaves it on
 * the ground — and in a netgame, `leftInNetgame` says which taken ones stay there too. See
 * docs/items.md § Collecting things.
 */
export function applyPickup(inv: Inventory, type: number, options: PickupOptions = {}): boolean {
  const { dropped = false, skill = DEFAULT_SKILL, autoSwitch = true, weaponsStay = false } = options;
  // DOOM II only: full health *and* blue armor at once, both past what any single pickup gives.
  if (type === ThingType.megasphere) {
    inv.health = LIMITS.megasphereHealth;
    // `P_GiveArmor(blue_armor_class)`, the same call the blue shirt makes — so the amount follows
    // from the class rather than from `maxArmor`, which is only the armor bonus' own cap, and
    // armor already above it is left alone. The pickup is taken either way.
    const armorType = LIMITS.blueArmorClass as 1 | 2;
    if (inv.armor < armorType * 100) {
      inv.armor = armorType * 100;
      inv.armorType = armorType;
    }
    return true;
  }
  // The one armor pickup that adds a point past a shirt's own amount, up to `maxArmor`.
  if (type === ThingType.armorBonus) {
    inv.armor = Math.min(inv.armor + 1, LIMITS.maxArmor);
    if (inv.armorType === 0) inv.armorType = 1;
    return true;
  }

  const health = HEALTH_PICKUPS[type];
  if (health) {
    const cap = health.bonus ? LIMITS.maxHealthBonus : LIMITS.maxHealth;
    if (inv.health >= cap) return false;
    const amount = 'limit' in health ? LIMITS[health.limit] : health.amount;
    inv.health = Math.min(inv.health + amount, cap);
    return true;
  }

  const armorClass = ARMOR_PICKUP_CLASS[type];
  if (armorClass) {
    const armorType = LIMITS[armorClass] as 1 | 2;
    const amount = armorType * 100;
    if (inv.armor >= amount) return false;
    inv.armor = amount;
    inv.armorType = armorType;
    return true;
  }

  if (type === ThingType.backpack) {
    // Doubles every `AMMO_MAX` (vanilla's `P_GiveBackpack`). Vanilla raises the caps only the
    // first time, but always hands over one clip of everything and always consumes the
    // backpack — even at full ammo, unlike every other ammo pickup here.
    inv.backpack = true;
    // Walked in `AMMO_UPGRADE`'s order, not `AMMO_TYPES`', because `P_GiveBackpack`'s
    // `P_GiveAmmo` per class each overwrite the last one's weapon pick — see that table. `ready` is
    // held still across all four for the reason `upgradeOnAmmo`'s own doc gives.
    const ready = inv.currentWeapon;
    for (const { ammo: t } of AMMO_UPGRADE) {
      const had = inv.ammo[t];
      inv.ammo[t] = Math.min(had + ammoAtSkill(CLIP_AMMO[t], skill), ammoMax(inv, t));
      if (autoSwitch) upgradeOnAmmo(inv, t, had, ready);
    }
    return true;
  }

  const power = POWERUP_PICKUPS[type];
  if (power) return givePower(inv, power);

  const ammo = AMMO_PICKUPS[type];
  if (ammo) {
    const cap = ammoMax(inv, ammo.type);
    if (inv.ammo[ammo.type] >= cap) return false;
    const full = ammo.clips * CLIP_AMMO[ammo.type];
    const amount = ammoAtSkill(dropped ? Math.floor(full / 2) : full, skill);
    const had = inv.ammo[ammo.type];
    inv.ammo[ammo.type] = Math.min(had + amount, cap);
    if (autoSwitch) upgradeOnAmmo(inv, ammo.type, had, inv.currentWeapon);
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
    // "leave placed weapons forever on net games": owning one already is the end of it.
    if (weaponsStay && !dropped && hadWeapon) return false;
    let gaveAmmo = false;
    if (weapon.ammoType) {
      const cap = ammoMax(inv, weapon.ammoType);
      const full = weapon.clips * CLIP_AMMO[weapon.ammoType];
      const amount = ammoAtSkill(dropped ? Math.floor(full / 2) : full, skill);
      const had = inv.ammo[weapon.ammoType];
      if (had < cap) {
        inv.ammo[weapon.ammoType] = Math.min(had + amount, cap);
        gaveAmmo = true;
        // Before the weapon's own switch below, as `P_GiveWeapon` runs `P_GiveAmmo` first and then
        // lets its own `pendingweapon` overwrite whatever that chose. Do not reorder.
        if (autoSwitch) upgradeOnAmmo(inv, weapon.ammoType, had, inv.currentWeapon);
      }
    }
    inv.weapons.add(weapon.weapon);
    // Matches vanilla's P_GiveWeapon, which switches the player to a weapon
    // the instant it's newly picked up (not on every re-pickup of one already owned).
    // Ungated by `autoSwitch`, unlike the two rules it does govern: vanilla has no
    // preference list here, just "the thing you just picked up is what you are now holding".
    if (!hadWeapon) inv.currentWeapon = weapon.weapon;
    return !hadWeapon || gaveAmmo;
  }

  return false;
}

/**
 * Whether a netgame leaves a taken pickup where it lies, for every other player — `p_inter.c`'s
 * early returns: every key in any netgame ("leave cards for everyone", `if (!netgame) break;
 * return;`) and, where weapons stay, a weapon the map placed ("leave placed weapons forever on net
 * games"). A monster's drop is taken as in single player.
 * docs/multiplayer-coop.md § Items and kills.
 *
 * @param weaponsStay  {@link PickupOptions.weaponsStay}
 */
export function leftInNetgame(type: number, dropped: boolean, weaponsStay: boolean): boolean {
  return !!KEY_PICKUPS[type] || (weaponsStay && !!WEAPON_PICKUPS[type] && !dropped);
}

/**
 * The sound a collected item makes — vanilla's `P_TouchSpecialThing`, which
 * starts from `itemup` and overrides it per sprite: `getpow` for the six
 * powerups plus the soulsphere and megasphere (the two health items that push
 * past 100), `wpnup` for the seven weapons. Everything else — health, armor,
 * ammo, keys, the backpack — keeps the plain `itemup` blip.
 *
 * Played **unattenuated** by the caller, as vanilla's own
 * `S_StartSound(NULL, sound)` does: you are standing on it.
 */
export function pickupSound(type: number): SfxId {
  if (type === ThingType.megasphere || type === ThingType.soulsphere || POWERUP_PICKUPS[type])
    return 'getpow';
  if (WEAPON_PICKUPS[type]) return 'wpnup';
  return 'itemup';
}

/**
 * Keys and powerups don't survive a level transition in vanilla
 * (`G_PlayerFinishLevel` clears `player->cards` and `player->powers` and
 * drops the `MF_SHADOW` invisibility flag off the player); health, armor,
 * ammo and the backpack's raised ammo caps do.
 */
export function finishLevel(inv: Inventory): void {
  inv.keys.clear();
  for (const p of POWER_IDS) inv.powers[p] = 0;
}

/**
 * Vanilla's own `damage < 1000` gate on invulnerability (and godmode) in
 * `P_DamageMobj`: the powerup ignores every ordinary hit, but a big enough
 * one — `TELEFRAG_DAMAGE`'s 10000 — still lands, so invulnerability is no
 * defence against being teleported onto (docs/death.md § Telefrag).
 */
const INVULNERABLE_DAMAGE_LIMIT = 1000;

/**
 * Reduces health by `amount`, letting worn armor absorb part of it first — vanilla's `P_DamageMobj`
 * armor formula in its whole points, with invulnerability short-circuiting it where vanilla checks
 * (see {@link INVULNERABLE_DAMAGE_LIMIT}). `health` clamps at 0, as `player->health` does.
 * docs/death.md § Player death.
 *
 * `god` is IDDQD's `CF_GODMODE` (docs/cheats.md § IDDQD) — a parameter rather than an inventory
 * field because it is not something the player carries, and required rather than defaulted so a
 * damage path added later has to say which it is.
 *
 * @param inv     the player's, whose armor and health the hit spends
 * @param amount  the damage in whole points
 * @param god     IDDQD's god mode
 * @returns the body's health after the hit, unclamped — vanilla's `target->health`, below 0 on a
 *          killing blow, which the gib and the death cry read — or null where the hit was blocked
 */
export function applyDamage(inv: Inventory, amount: number, god: boolean): number | null {
  if ((god || hasPower(inv, 'invulnerability')) && amount < INVULNERABLE_DAMAGE_LIMIT) return null;
  let damage = amount;
  if (inv.armorType > 0 && inv.armor > 0) {
    // C's integer division, as `p_inter.c`'s `saved = damage/3`: armor and health stay whole.
    let saved = Math.trunc(inv.armorType === 1 ? damage / 3 : damage / 2);
    if (inv.armor <= saved) {
      saved = inv.armor;
      inv.armorType = 0;
    }
    inv.armor -= saved;
    damage -= saved;
  }
  const health = inv.health - damage;
  inv.health = Math.max(0, health);
  return health;
}

/**
 * Applies `AMMO_UPGRADE` for one ammo class, given what the player held **before** the grant —
 * vanilla's `oldammo`. Call it once per class granted, in `AMMO_UPGRADE`'s own order where several
 * land together; `ready` is the weapon held when the *pickup* began, which the caller has to hold
 * still because this engine has no pending/ready split. docs/items.md § Ammo raises the weapon.
 *
 * The `bullets` row's `pistol` fallback is unconditional in vanilla (`weaponowned[wp_pistol]` is
 * never false there); here it takes the same ownership test as every other entry, since
 * `Inventory.weapons` is authoritative — the deviation `AMMO_FALLBACK_ORDER` also carries
 * (game/weapons.ts). Only called where the collecting player's `autoSwitch` is on.
 */
function upgradeOnAmmo(inv: Inventory, type: AmmoType, oldAmount: number, ready: WeaponId): void {
  if (oldAmount > 0) return;
  const rule = AMMO_UPGRADE.find((r) => r.ammo === type);
  if (!rule || !rule.from.includes(ready)) return;
  const pick = rule.to.find((w) => inv.weapons.has(w));
  if (pick) inv.currentWeapon = pick;
}

/**
 * Vanilla's `P_GivePower`, which is not uniform across the six powers: the four timed ones restart
 * their own clock, berserk also runs `P_GiveBody(player, 100)` and switches to the fist, and the
 * computer area map is the only one that can be refused — its generic "already have it" branch
 * leaves a second one on the ground. docs/items.md § Powerups and the backpack.
 */
function givePower(inv: Inventory, power: PowerId): boolean {
  if (power === 'berserk') {
    inv.health = Math.max(inv.health, LIMITS.maxHealth);
    inv.powers.berserk = POWER_SECONDS.berserk;
    inv.currentWeapon = 'fist';
    return true;
  }
  if (power === 'computerMap') {
    if (inv.powers.computerMap > 0) return false;
    inv.powers.computerMap = POWER_SECONDS.computerMap;
    return true;
  }
  inv.powers[power] = POWER_SECONDS[power];
  return true;
}

/** Whether a card *or* skull of `color` is owned — vanilla's every-lock-tests-both rule. */
function hasKeyColor(keys: ReadonlySet<KeySlot>, color: KeyColor): boolean {
  return keys.has(`${color}Card`) || keys.has(`${color}Skull`);
}
