import type { SfxId } from '../audio/sfx.ts';
import { ThingType } from './thingtypes.ts';
import { DEFAULT_SKILL, ammoAtSkill, type Skill } from './skill.ts';

/** The four ammo classes DOOM tracks; matches vanilla's `ammotype_t`. */
export const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'] as const;
export type AmmoType = (typeof AMMO_TYPES)[number];

/**
 * Card and skull keys of the same color are tracked as one slot, because vanilla's locked-door
 * checks accept either: every one of them tests both (`p_doors.c`'s
 * `!p->cards[it_bluecard] && !p->cards[it_blueskull]`), so nothing in the game can tell them
 * apart — which is also why vanilla's own locked-door message says "key" for a skull
 * (`ui/hud/message.ts`).
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
  keys: Set<KeyColor>;
  weapons: Set<WeaponId>;
  /** Which owned weapon is selected — see game/weapons.ts for switching/firing. */
  currentWeapon: WeaponId;
  /**
   * Seconds of each powerup left (0 = not active, `Infinity` = lasts the rest
   * of the level), ticked down by `tickPowers`. Vanilla's `player->powers[]`,
   * which counts tics the same way.
   */
  powers: Record<PowerId, number>;
  /** Vanilla's `player->backpack`: doubles every ammo class's cap (`ammoMax`), and unlike the powers above it survives a level transition. */
  backpack: boolean;
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
    powers: { invulnerability: 0, berserk: 0, invisibility: 0, radiationSuit: 0, computerMap: 0, lightVisor: 0 },
    backpack: false,
  };
}

/** Whether a powerup is currently active. */
export function hasPower(inv: Inventory, power: PowerId): boolean {
  return inv.powers[power] > 0;
}

/** Ages every timed powerup by `dt`; the `Infinity`-duration ones (berserk, computer map) are left alone. */
export function tickPowers(inv: Inventory, dt: number): void {
  for (const p of POWER_IDS) {
    if (inv.powers[p] > 0 && inv.powers[p] !== Infinity) inv.powers[p] = Math.max(0, inv.powers[p] - dt);
  }
}

/** Item pickup radius (map units) vanilla uses for most pickups (health/armor/ammo/keys). */
export const ITEM_PICKUP_RADIUS = 20;

/** Vanilla's `MAXHEALTH` (`d_player.h`) — the cap ordinary health pickups stop at. */
const MAX_HEALTH = 100;
/** Bonus items (health bonus, soulsphere, megasphere) push health past the normal cap, up to this. */
const MAX_HEALTH_BONUS = 200;
/** Vanilla's blue-armor cap, `P_GiveArmor`'s `armortype*100` for `armortype` 2. */
const MAX_ARMOR = 200;
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

const HEALTH_PICKUPS: Record<number, { amount: number; bonus: boolean }> = {
  [ThingType.stimpack]: { amount: 10, bonus: false },
  [ThingType.medikit]: { amount: 25, bonus: false },
  [ThingType.healthBonus]: { amount: 1, bonus: true },
  [ThingType.soulsphere]: { amount: 100, bonus: true },
};

const ARMOR_PICKUPS: Record<number, { amount: number; armorType: 1 | 2 }> = {
  [ThingType.greenArmor]: { amount: 100, armorType: 1 },
  [ThingType.blueArmor]: { amount: 200, armorType: 2 },
};

const AMMO_PICKUPS: Record<number, { type: AmmoType; amount: number }> = {
  [ThingType.clip]: { type: 'bullets', amount: 10 },
  [ThingType.boxOfBullets]: { type: 'bullets', amount: 50 },
  [ThingType.shells]: { type: 'shells', amount: 4 },
  [ThingType.boxOfShells]: { type: 'shells', amount: 20 },
  [ThingType.rocket]: { type: 'rockets', amount: 1 },
  [ThingType.boxOfRockets]: { type: 'rockets', amount: 5 },
  [ThingType.cellCharge]: { type: 'cells', amount: 20 },
  [ThingType.cellChargePack]: { type: 'cells', amount: 100 },
};

const KEY_PICKUPS: Record<number, KeyColor> = {
  [ThingType.blueKeycard]: 'blue',
  [ThingType.blueSkullKey]: 'blue',
  [ThingType.redKeycard]: 'red',
  [ThingType.redSkullKey]: 'red',
  [ThingType.yellowKeycard]: 'yellow',
  [ThingType.yellowSkullKey]: 'yellow',
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
 * Vanilla's `clipammo[]` — one pickup's worth of each ammo class, which is
 * exactly what a backpack hands over on top of raising the caps
 * (`P_GiveAmmo(player, i, 1)` per class, and `P_GiveAmmo` multiplies its
 * `num` by this table). Deliberately spelled out rather than read back off
 * `AMMO_PICKUPS` above: those two happening to hold the same numbers is
 * vanilla's own coincidence (the clip/shells/rocket/cell items *are* one
 * `clipammo` each), not a relationship worth encoding.
 */
const CLIP_AMMO: Record<AmmoType, number> = { bullets: 10, shells: 4, rockets: 1, cells: 20 };

/**
 * Ammo granted alongside a weapon pickup follows vanilla's `P_GiveWeapon`:
 * it hands over `2 * clipammo[type]` — twice the amount a single ammo
 * pickup of that type gives — for a weapon placed directly on the map, or
 * exactly half that (`1 * clipammo[type]`) for one a dead monster dropped
 * (`applyPickup`'s `dropped` param). The chainsaw needs no ammo at all.
 */
const WEAPON_PICKUPS: Record<number, { weapon: WeaponId; ammoType: AmmoType | null; ammoAmount: number }> = {
  [ThingType.chainsaw]: { weapon: 'chainsaw', ammoType: null, ammoAmount: 0 },
  [ThingType.shotgun]: { weapon: 'shotgun', ammoType: 'shells', ammoAmount: 8 },
  [ThingType.superShotgun]: { weapon: 'supershotgun', ammoType: 'shells', ammoAmount: 8 },
  [ThingType.chaingun]: { weapon: 'chaingun', ammoType: 'bullets', ammoAmount: 20 },
  [ThingType.rocketLauncher]: { weapon: 'rocketLauncher', ammoType: 'rockets', ammoAmount: 2 },
  [ThingType.plasmaRifle]: { weapon: 'plasmaRifle', ammoType: 'cells', ammoAmount: 40 },
  [ThingType.bfg9000]: { weapon: 'bfg', ammoType: 'cells', ammoAmount: 40 },
};

/**
 * Applies a picked-up thing's effect, following vanilla's
 * `P_TouchSpecialThing` rules for every item type this engine models —
 * health, armor, ammo, keys, weapons, the backpack and the six powerups.
 *
 * Returns false for an item that can't (or shouldn't) be picked up right
 * now — e.g. a Stimpack at full health, or a weapon already owned whose
 * ammo type is already full — so the caller leaves it on the ground and
 * visible, matching vanilla rather than "wasting" the pickup.
 *
 * `dropped` is true for an item spawned by `ThingLayer.damage` on a
 * monster's death (`game/thingdefs.ts`'s `MONSTER_DROPS`) rather than one
 * placed directly on the map, and halves whatever ammo it would otherwise
 * grant — matching vanilla's own `P_GiveAmmo`/`P_GiveWeapon`, which give a
 * dropped pickup's ammo at half the rate of a map-placed one. Only ammo and
 * weapon pickups are affected; nothing else (health, armor, keys) is ever
 * dropped by a monster in vanilla, so `dropped` is meaningless there.
 *
 * `skill` only ever reaches the three paths that grant ammo, which skills 1 and 5 double
 * (`ammoAtSkill`); it defaults to skill 3, the one skill that changes nothing here.
 */
export function applyPickup(inv: Inventory, type: number, dropped = false, skill: Skill = DEFAULT_SKILL): boolean {
  // DOOM II only: full health *and* blue armor at once, both past what any single pickup gives.
  if (type === ThingType.megasphere) {
    inv.health = MAX_HEALTH_BONUS;
    inv.armor = MAX_ARMOR;
    inv.armorType = 2;
    return true;
  }
  // The one armor pickup that adds a point past `ARMOR_PICKUPS`' own amounts, up to `MAX_ARMOR`.
  if (type === ThingType.armorBonus) {
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

  if (type === ThingType.backpack) {
    // Doubles every `AMMO_MAX` (vanilla's `P_GiveBackpack`). Vanilla raises the caps only the
    // first time, but always hands over one clip of everything and always consumes the
    // backpack — even at full ammo, unlike every other ammo pickup here.
    inv.backpack = true;
    for (const t of AMMO_TYPES) inv.ammo[t] = Math.min(inv.ammo[t] + ammoAtSkill(CLIP_AMMO[t], skill), ammoMax(inv, t));
    return true;
  }

  const power = POWERUP_PICKUPS[type];
  if (power) return givePower(inv, power);

  const ammo = AMMO_PICKUPS[type];
  if (ammo) {
    const cap = ammoMax(inv, ammo.type);
    if (inv.ammo[ammo.type] >= cap) return false;
    const amount = ammoAtSkill(dropped ? Math.floor(ammo.amount / 2) : ammo.amount, skill);
    inv.ammo[ammo.type] = Math.min(inv.ammo[ammo.type] + amount, cap);
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
      const amount = ammoAtSkill(dropped ? Math.floor(weapon.ammoAmount / 2) : weapon.ammoAmount, skill);
      if (inv.ammo[weapon.ammoType] < cap) {
        inv.ammo[weapon.ammoType] = Math.min(inv.ammo[weapon.ammoType] + amount, cap);
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
    inv.health = Math.max(inv.health, MAX_HEALTH);
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

/**
 * Vanilla's own `damage < 1000` gate on invulnerability (and godmode) in
 * `P_DamageMobj`: the powerup ignores every ordinary hit, but a big enough
 * one — a telefrag's 10000, which this engine doesn't model — still lands.
 * Kept as the literal vanilla threshold rather than "ignore everything",
 * since nothing here would behave differently and the number is the rule.
 */
const INVULNERABLE_DAMAGE_LIMIT = 1000;

/**
 * Reduces health by `amount`, letting worn armor absorb part of it first —
 * matches vanilla's own `P_DamageMobj`: green armor (`armorType` 1) absorbs a
 * third of the damage, blue (`armorType` 2) half, spending armor points
 * 1-for-1 with whatever it absorbed and falling back to bare (`armorType` 0)
 * once it runs out mid-hit. Invulnerability short-circuits the whole thing
 * first, in the same place vanilla's own `P_DamageMobj` checks it (see
 * `INVULNERABLE_DAMAGE_LIMIT`). `health` is clamped at 0 rather than going
 * negative — `game.ts`'s own death check is a simple `<= 0`, not "how far past
 * 0". Returns whether the hit actually landed (`false` while invulnerable
 * blocked it outright), the same "did anything happen" boolean `applyPickup`
 * already returns for the same reason — `game.ts: damagePlayer` needs it to
 * skip the pain flash/flinch animation for a hit that did nothing.
 */
export function applyDamage(inv: Inventory, amount: number): boolean {
  if (hasPower(inv, 'invulnerability') && amount < INVULNERABLE_DAMAGE_LIMIT) return false;
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
