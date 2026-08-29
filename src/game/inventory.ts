/**
 * The player's inventory — health, armor, ammo, keys, weapons, powerups — and how each pickup type
 * applies to it, vanilla's own amounts and caps. See docs/items.md.
 */
import type { SfxId } from '../audio/sfx.ts';
import { ThingType } from './things/doomednums.ts';
import { DEFAULT_SKILL, ammoAtSkill, type Skill } from './skill.ts';
import { PLAYER_RADIUS } from './player.ts';
import type { LockRule } from './specials/defs.ts';

/**
 * The four ammo classes DOOM tracks — vanilla's `ammotype_t` set, but **not its order**: that enum
 * is `am_clip, am_shell, am_cell, am_misl` (cells before rockets). Nothing keyed by `AmmoType`
 * cares, but anything reproducing a vanilla *loop* over ammo classes does — see `AMMO_UPGRADE`.
 */
export const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'] as const;
export type AmmoType = (typeof AMMO_TYPES)[number];

/**
 * The three key colors. Vanilla's own locked-door checks accept card or skull
 * of a color interchangeably (`p_doors.c`'s
 * `!p->cards[it_bluecard] && !p->cards[it_blueskull]`) — which is why its
 * message says "key" for a skull — but Boom's generalized locks *can* tell
 * them apart (`P_CanUnlockGenDoor`), so ownership is tracked per exact
 * `KeySlot` below and the vanilla-style color locks accept either slot
 * (`satisfiesLock`, below).
 */
export const KEY_COLORS = ['blue', 'red', 'yellow'] as const;
export type KeyColor = (typeof KEY_COLORS)[number];

/** The six key things, vanilla's `card_t` roster, tracked exactly. */
export const KEY_SLOTS = ['blueCard', 'redCard', 'yellowCard', 'blueSkull', 'redSkull', 'yellowSkull'] as const;
export type KeySlot = (typeof KEY_SLOTS)[number];

/** The color half of a slot — what the HUD tints and lock messages name. */
export function keySlotColor(slot: KeySlot): KeyColor {
  return (slot.startsWith('blue') ? 'blue' : slot.startsWith('red') ? 'red' : 'yellow') as KeyColor;
}

/** Whether a card *or* skull of `color` is owned — vanilla's every-lock-tests-both rule. */
export function hasKeyColor(keys: ReadonlySet<KeySlot>, color: KeyColor): boolean {
  return keys.has(`${color}Card`) || keys.has(`${color}Skull`);
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

/**
 * Every weapon the player can carry, including fist and pistol — vanilla
 * starts every game with both already owned and neither has a map pickup, but
 * both are selectable and fireable (game/weapons.ts), so both need an ID like
 * every other weapon to be `currentWeapon`-able.
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
 * The six powerup spheres/items, in the order the HUD shows them. Named after
 * what they do rather than after vanilla's own `pw_*` enum (`pw_strength`,
 * `pw_ironfeet`, `pw_allmap`, `pw_infrared`), which is named after DOOM's
 * development history more than its effects.
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

/**
 * How long each powerup lasts, in seconds — vanilla's own `INVULNTICS`
 * (30s), `INVISTICS`/`IRONTICS` (60s) and `INFRATICS` (120s) over 35, plain
 * constants that survive the conversion out of tics intact (unlike
 * `weapons.ts`'s fire rates, see there). Berserk and the computer area map
 * are `Infinity`: vanilla stores them as a flag that never counts down, and
 * both are cleared at the end of the level like every other power
 * (`finishLevel`).
 */
const POWER_SECONDS: Record<PowerId, number> = {
  invulnerability: 30,
  berserk: Infinity,
  invisibility: 60,
  radiationSuit: 60,
  computerMap: Infinity,
  lightVisor: 120,
};

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
   * Seconds of each powerup left (0 = not active, `Infinity` = lasts the rest
   * of the level), ticked down by `tickPowers`. Vanilla's `player->powers[]`,
   * which counts tics the same way.
   */
  powers: Record<PowerId, number>;
  /**
   * Vanilla's `player->backpack`: doubles every ammo class's cap (`ammoMax`), and unlike the powers
   * above it survives a level transition.
   */
  backpack: boolean;
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
    if (inv.powers[p] > 0 && inv.powers[p] !== Infinity) inv.powers[p] = Math.max(0, inv.powers[p] - dt);
  }
}

/** Item pickup radius (map units) vanilla uses for most pickups (health/armor/ammo/keys). */
export const ITEM_PICKUP_RADIUS = 20;

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
 * A health pickup grants either a fixed amount or whatever a `LIMITS` field currently says — the
 * soulsphere is the one `Misc` can move (`Soulsphere health`), so it names the field and is read at
 * the point of use rather than mirrored here, exactly as `ARMOR_PICKUP_CLASS` below.
 * `bonus` picks which cap applies. docs/items.md § Collecting things.
 */
type HealthPickup = { bonus: boolean } & ({ amount: number } | { limit: keyof InventoryLimits });

const HEALTH_PICKUPS: Record<number, HealthPickup> = {
  [ThingType.stimpack]: { amount: 10, bonus: false },
  [ThingType.medikit]: { amount: 25, bonus: false },
  [ThingType.healthBonus]: { amount: 1, bonus: true },
  [ThingType.soulsphere]: { limit: 'soulsphereHealth', bonus: true },
};

/**
 * Which `LIMITS` armor class each armor shirt grants — `P_GiveArmor(1)` for the green one and
 * `(2)` for the blue. The amount it hands over is `armortype*100` and so follows from the class,
 * which is why it is read off `LIMITS` at the point of use rather than mirrored into a second
 * table that a `Misc` patch would then have to keep in step. docs/items.md § Collecting things.
 */
const ARMOR_PICKUP_CLASS: Record<number, 'greenArmorClass' | 'blueArmorClass'> = {
  [ThingType.greenArmor]: 'greenArmorClass',
  [ThingType.blueArmor]: 'blueArmorClass',
};

/**
 * Each ammo pickup's `num` as `P_TouchSpecialThing` passes it to `P_GiveAmmo`, which multiplies it
 * by `clipammo[type]` — so these are **clip counts, not amounts**: a clip is one, a box is five.
 * Vanilla's own indirection, kept rather than folded flat, because `CLIP_AMMO` is patchable and
 * everything computed off it has to follow.
 */
const AMMO_PICKUPS: Record<number, { type: AmmoType; clips: number }> = {
  [ThingType.clip]: { type: 'bullets', clips: 1 },
  [ThingType.boxOfBullets]: { type: 'bullets', clips: 5 },
  [ThingType.shells]: { type: 'shells', clips: 1 },
  [ThingType.boxOfShells]: { type: 'shells', clips: 5 },
  [ThingType.rocket]: { type: 'rockets', clips: 1 },
  [ThingType.boxOfRockets]: { type: 'rockets', clips: 5 },
  [ThingType.cellCharge]: { type: 'cells', clips: 1 },
  [ThingType.cellChargePack]: { type: 'cells', clips: 5 },
};

const KEY_PICKUPS: Record<number, KeySlot> = {
  [ThingType.blueKeycard]: 'blueCard',
  [ThingType.blueSkullKey]: 'blueSkull',
  [ThingType.redKeycard]: 'redCard',
  [ThingType.redSkullKey]: 'redSkull',
  [ThingType.yellowKeycard]: 'yellowCard',
  [ThingType.yellowSkullKey]: 'yellowSkull',
};

/** The powerup spheres/items, by doomednum — see `POWER_SECONDS` for how long each lasts. */
const POWERUP_PICKUPS: Record<number, PowerId> = {
  [ThingType.invulnerability]: 'invulnerability',
  [ThingType.berserk]: 'berserk',
  [ThingType.invisibility]: 'invisibility',
  [ThingType.radiationSuit]: 'radiationSuit',
  [ThingType.computerMap]: 'computerMap',
  [ThingType.lightAmpVisor]: 'lightVisor',
};

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
 * `P_GiveAmmo`'s tail: collecting a class you had **none** of raises the ready weapon to the one it
 * feeds, so walking over a box of shells with nothing but fists brings up a shotgun you already
 * owned. Only fist and pistol are ever raised off — vanilla's own comment is "Preferences are not
 * user selectable", which is why there is no dial here beyond the whole feature's own toggle
 * (`getAutoSwitchWeapon`). docs/items.md § Ammo raises the weapon.
 *
 * An **ordered array in `ammotype_t` order** (`doomdef.h`: `am_clip, am_shell, am_cell, am_misl`),
 * deliberately not a `Record` and deliberately not reusing `AMMO_TYPES`, whose last two entries are
 * swapped. `P_GiveBackpack` grants all four in this order and each overwrites the last one's pick,
 * so the order decides what a backpack taken at zero across the board hands you: the rocket
 * launcher, `am_misl` being last.
 */
const AMMO_UPGRADE: { ammo: AmmoType; from: readonly WeaponId[]; to: readonly WeaponId[] }[] = [
  { ammo: 'bullets', from: ['fist'], to: ['chaingun', 'pistol'] },
  { ammo: 'shells', from: ['fist', 'pistol'], to: ['shotgun'] },
  { ammo: 'cells', from: ['fist', 'pistol'], to: ['plasmaRifle'] },
  { ammo: 'rockets', from: ['fist'], to: ['rocketLauncher'] },
];

/**
 * Applies `AMMO_UPGRADE` for one ammo class, given what the player held **before** the grant —
 * vanilla's `oldammo`, which is why a partial stock is left alone ("player was lower on purpose").
 * Call it once per class granted, in `AMMO_UPGRADE`'s own order where several land together.
 *
 * `ready` is the weapon held when the *pickup* began, not when this class was granted, and the two
 * differ only in the backpack loop. Vanilla sets `pendingweapon` here and never touches
 * `readyweapon`, so each of `P_GiveBackpack`'s four grants tests against the same weapon and simply
 * overwrites the previous one's pick; this engine has no pending/ready split, so the caller has to
 * hold that weapon still. Reading `inv.currentWeapon` per call instead would let the first
 * qualifying class lock out every later one — a backpack taken at zero would hand over a chaingun
 * and stop there. docs/items.md § Ammo raises the weapon.
 *
 * The `bullets` row's `pistol` fallback is unconditional in vanilla (`weaponowned[wp_pistol]` is
 * never false there); here it goes through the same ownership test as every other entry, since
 * `Inventory.weapons` is a real set this engine treats as authoritative — the same deviation
 * `AMMO_FALLBACK_ORDER` carries in game/weapons.ts.
 */
function upgradeOnAmmo(inv: Inventory, type: AmmoType, oldAmount: number, ready: WeaponId): void {
  if (oldAmount > 0 || !getAutoSwitchWeapon()) return;
  const rule = AMMO_UPGRADE.find((r) => r.ammo === type);
  if (!rule || !rule.from.includes(ready)) return;
  const pick = rule.to.find((w) => inv.weapons.has(w));
  if (pick) inv.currentWeapon = pick;
}

/**
 * Ammo granted alongside a weapon pickup follows vanilla's `P_GiveWeapon`:
 * it hands over `2 * clipammo[type]` — twice what a single clip gives — for a
 * weapon placed directly on the map, or exactly half that for one a dead
 * monster dropped (`applyPickup`'s `dropped` param). The chainsaw needs none.
 */
const WEAPON_PICKUPS: Record<number, { weapon: WeaponId; ammoType: AmmoType | null; clips: number }> = {
  [ThingType.chainsaw]: { weapon: 'chainsaw', ammoType: null, clips: 0 },
  [ThingType.shotgun]: { weapon: 'shotgun', ammoType: 'shells', clips: 2 },
  [ThingType.superShotgun]: { weapon: 'supershotgun', ammoType: 'shells', clips: 2 },
  [ThingType.chaingun]: { weapon: 'chaingun', ammoType: 'bullets', clips: 2 },
  [ThingType.rocketLauncher]: { weapon: 'rocketLauncher', ammoType: 'rockets', clips: 2 },
  [ThingType.plasmaRifle]: { weapon: 'plasmaRifle', ammoType: 'cells', clips: 2 },
  [ThingType.bfg9000]: { weapon: 'bfg', ammoType: 'cells', clips: 2 },
};

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
  /** Vanilla's `soul_health` — what a soulsphere gives, capped at `maxHealthBonus`. */
  soulsphereHealth: number;
  /** Vanilla's `mega_health` — the health a megasphere sets, alongside blue armor. */
  megasphereHealth: number;
  /** `deh_god_health`: the health IDDQD sets on the way on (docs/cheats.md § IDDQD). */
  godModeHealth: number;
  /**
   * `deh_idkfa_armor` / `deh_idkfa_armor_class`: the armor IDKFA hands over (docs/cheats.md §
   * IDKFA).
   */
  idkfaArmor: number;
  idkfaArmorClass: number;
}

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

/**
 * Applies a picked-up thing's effect, vanilla's `P_TouchSpecialThing` rules. Returns false for an
 * item that shouldn't be collected right now (Stimpack at full health), so the caller leaves it on
 * the ground. `dropped` halves granted ammo (`P_GiveAmmo`'s monster-drop rule); `skill` doubles it
 * on skills 1 and 5. See docs/items.md § Collecting things.
 */
export function applyPickup(inv: Inventory, type: number, dropped = false, skill: Skill = DEFAULT_SKILL): boolean {
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
      upgradeOnAmmo(inv, t, had, ready);
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
    upgradeOnAmmo(inv, ammo.type, had, inv.currentWeapon);
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
      const cap = ammoMax(inv, weapon.ammoType);
      const full = weapon.clips * CLIP_AMMO[weapon.ammoType];
      const amount = ammoAtSkill(dropped ? Math.floor(full / 2) : full, skill);
      const had = inv.ammo[weapon.ammoType];
      if (had < cap) {
        inv.ammo[weapon.ammoType] = Math.min(had + amount, cap);
        gaveAmmo = true;
        // Before the weapon's own switch below, as `P_GiveWeapon` runs `P_GiveAmmo` first and then
        // lets its own `pendingweapon` overwrite whatever that chose. Do not reorder.
        upgradeOnAmmo(inv, weapon.ammoType, had, inv.currentWeapon);
      }
    }
    inv.weapons.add(weapon.weapon);
    // Matches vanilla's P_GiveWeapon, which switches the player to a weapon
    // the instant it's newly picked up (not on every re-pickup of one already owned).
    // Ungated by `getAutoSwitchWeapon`, unlike the two rules it does govern: vanilla has no
    // preference list here, just "the thing you just picked up is what you are now holding".
    if (!hadWeapon) inv.currentWeapon = weapon.weapon;
    return !hadWeapon || gaveAmmo;
  }

  return false;
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
 * Vanilla's `P_GivePower`, which is not uniform across the six powers:
 *
 * - The four **timed** ones (invulnerability, invisibility, radiation suit,
 *   light visor) always take, restarting their own clock — picking up a
 *   second one at 5 seconds left gives a fresh full duration, not 5 + full.
 * - **Berserk** always takes too, and does two things besides setting the
 *   flag: `P_GiveBody(player, 100)` tops health back up to the normal 100 cap
 *   (never past it, unlike the bonus items above), and the player is switched
 *   to the fist, since punching is the entire point of the pickup.
 * - The **computer area map** is the one that can be refused: it falls into
 *   `P_GivePower`'s generic "if you already have it, return false" branch, so
 *   a second one is left on the ground rather than silently consumed.
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

const PISTOL_START_STORAGE_KEY = 'topdoom.pistolStart';

/**
 * Whether every level is entered on a fresh `createInventory()` instead of carrying health, armor,
 * ammo and weapons over — the speedrunners' "pistol start", off by default and not vanilla's
 * behavior for an ordinary exit (it is what vanilla does between *episodes*, and what its level
 * select has always done). Read by `game.ts: enterLevel`, the one place a level transition installs
 * an inventory. docs/items.md § Pistol start.
 * Shaped like every persisted setting — docs/menu.md § Persisted settings.
 */
let pistolStart = globalThis.localStorage?.getItem(PISTOL_START_STORAGE_KEY) === 'true';

export function getPistolStart(): boolean {
  return pistolStart;
}

export function setPistolStart(enabled: boolean): void {
  pistolStart = enabled;
  globalThis.localStorage?.setItem(PISTOL_START_STORAGE_KEY, String(enabled));
}

const AUTO_SWITCH_STORAGE_KEY = 'topdoom.autoSwitchWeapon';

/**
 * Whether the game picks a *better* weapon for you: on ammo collected from empty (`AMMO_UPGRADE`)
 * and on the ready weapon running dry (`AMMO_FALLBACK_ORDER`, game/weapons.ts). **On by default** —
 * vanilla does both unconditionally, so the setting exists to opt out. Read per call, so it applies
 * to the level already running. docs/weapons.md § Automatic weapon switching.
 *
 * Two switches are deliberately **outside** it, both because neither is a guess at which weapon is
 * better: a newly picked-up weapon selecting itself (`P_GiveWeapon`, in `applyPickup` below), and
 * berserk selecting the fist (`givePower`) — punching is that pickup's entire effect.
 * Shaped like every persisted setting — docs/menu.md § Persisted settings.
 */
let autoSwitchWeapon = globalThis.localStorage?.getItem(AUTO_SWITCH_STORAGE_KEY) !== 'false';

export function getAutoSwitchWeapon(): boolean {
  return autoSwitchWeapon;
}

export function setAutoSwitchWeapon(enabled: boolean): void {
  autoSwitchWeapon = enabled;
  globalThis.localStorage?.setItem(AUTO_SWITCH_STORAGE_KEY, String(enabled));
}

/**
 * Vanilla's own `damage < 1000` gate on invulnerability (and godmode) in
 * `P_DamageMobj`: the powerup ignores every ordinary hit, but a big enough
 * one — `TELEFRAG_DAMAGE`'s 10000 — still lands, so invulnerability is no
 * defence against being teleported onto (docs/death.md § Telefrag).
 */
const INVULNERABLE_DAMAGE_LIMIT = 1000;

/**
 * Reduces health by `amount`, letting worn armor absorb part of it first — vanilla's own
 * `P_DamageMobj` armor formula, with invulnerability short-circuiting it in the same place vanilla
 * checks (see `INVULNERABLE_DAMAGE_LIMIT`). `health` is clamped at 0 rather than going negative:
 * `game.ts`'s death check is a simple `<= 0`. Returns whether the hit actually landed, the same
 * "did anything happen" boolean `applyPickup` returns. docs/death.md § Player death.
 *
 * `god` is IDDQD's `CF_GODMODE` (docs/cheats.md § IDDQD), taken as a parameter
 * rather than read from the inventory because it is not something the player
 * carries: vanilla tests the two in one condition here, under the same limit.
 * Required rather than defaulted, so a damage path added later has to say which
 * it is instead of silently losing god mode.
 */
export function applyDamage(inv: Inventory, amount: number, god: boolean): boolean {
  if ((god || hasPower(inv, 'invulnerability')) && amount < INVULNERABLE_DAMAGE_LIMIT) return false;
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
  return true;
}
