/**
 * The doomednum- and type-keyed pickup data `applyPickup` looks every collected thing up in —
 * vanilla's own amounts, classes and orders. See docs/items.md § Collecting things.
 */
import { ThingType } from '../things/doomednums.ts';
import type { AmmoType, InventoryLimits, KeySlot, PowerId, WeaponId } from './defs.ts';

/**
 * How long each powerup lasts, in seconds — vanilla's own `INVULNTICS`
 * (30s), `INVISTICS`/`IRONTICS` (60s) and `INFRATICS` (120s) over 35, plain
 * constants that survive the conversion out of tics intact (unlike
 * `weapons.ts`'s fire rates, see there). Berserk and the computer area map
 * are `Infinity`: vanilla stores them as a flag that never counts down, and
 * both are cleared at the end of the level like every other power
 * (`finishLevel`).
 */
export const POWER_SECONDS: Record<PowerId, number> = {
  invulnerability: 30,
  berserk: Infinity,
  invisibility: 60,
  radiationSuit: 60,
  computerMap: Infinity,
  lightVisor: 120,
};

/**
 * A health pickup grants either a fixed amount or whatever a `LIMITS` field currently says — the
 * soulsphere is the one `Misc` can move (`Soulsphere health`), so it names the field and is read at
 * the point of use rather than mirrored here, exactly as `ARMOR_PICKUP_CLASS` below.
 * `bonus` picks which cap applies. docs/items.md § Collecting things.
 */
type HealthPickup = { bonus: boolean } & ({ amount: number } | { limit: keyof InventoryLimits });

export const HEALTH_PICKUPS: Record<number, HealthPickup> = {
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
export const ARMOR_PICKUP_CLASS: Record<number, 'greenArmorClass' | 'blueArmorClass'> = {
  [ThingType.greenArmor]: 'greenArmorClass',
  [ThingType.blueArmor]: 'blueArmorClass',
};

/**
 * Each ammo pickup's `num` as `P_TouchSpecialThing` passes it to `P_GiveAmmo`, which multiplies it
 * by `clipammo[type]` — so these are **clip counts, not amounts**: a clip is one, a box is five.
 * Vanilla's own indirection, kept rather than folded flat, because `CLIP_AMMO` is patchable and
 * everything computed off it has to follow.
 */
export const AMMO_PICKUPS: Record<number, { type: AmmoType; clips: number }> = {
  [ThingType.clip]: { type: 'bullets', clips: 1 },
  [ThingType.boxOfBullets]: { type: 'bullets', clips: 5 },
  [ThingType.shells]: { type: 'shells', clips: 1 },
  [ThingType.boxOfShells]: { type: 'shells', clips: 5 },
  [ThingType.rocket]: { type: 'rockets', clips: 1 },
  [ThingType.boxOfRockets]: { type: 'rockets', clips: 5 },
  [ThingType.cellCharge]: { type: 'cells', clips: 1 },
  [ThingType.cellChargePack]: { type: 'cells', clips: 5 },
};

export const KEY_PICKUPS: Record<number, KeySlot> = {
  [ThingType.blueKeycard]: 'blueCard',
  [ThingType.blueSkullKey]: 'blueSkull',
  [ThingType.redKeycard]: 'redCard',
  [ThingType.redSkullKey]: 'redSkull',
  [ThingType.yellowKeycard]: 'yellowCard',
  [ThingType.yellowSkullKey]: 'yellowSkull',
};

/** The powerup spheres/items, by doomednum — see `POWER_SECONDS` for how long each lasts. */
export const POWERUP_PICKUPS: Record<number, PowerId> = {
  [ThingType.invulnerability]: 'invulnerability',
  [ThingType.berserk]: 'berserk',
  [ThingType.invisibility]: 'invisibility',
  [ThingType.radiationSuit]: 'radiationSuit',
  [ThingType.computerMap]: 'computerMap',
  [ThingType.lightAmpVisor]: 'lightVisor',
};

/**
 * `P_GiveAmmo`'s tail: collecting a class you had **none** of raises the ready weapon to the one it
 * feeds. An **ordered array in `ammotype_t` order** (`doomdef.h`: `am_clip, am_shell, am_cell,
 * am_misl`), deliberately not reusing `AMMO_TYPES`, whose last two entries are swapped — the order
 * is observable through the backpack. docs/items.md § Ammo raises the weapon.
 */
export const AMMO_UPGRADE: { ammo: AmmoType; from: readonly WeaponId[]; to: readonly WeaponId[] }[] = [
  { ammo: 'bullets', from: ['fist'], to: ['chaingun', 'pistol'] },
  { ammo: 'shells', from: ['fist', 'pistol'], to: ['shotgun'] },
  { ammo: 'cells', from: ['fist', 'pistol'], to: ['plasmaRifle'] },
  { ammo: 'rockets', from: ['fist'], to: ['rocketLauncher'] },
];

/**
 * Ammo granted alongside a weapon pickup follows vanilla's `P_GiveWeapon`:
 * it hands over `2 * clipammo[type]` — twice what a single clip gives — for a
 * weapon placed directly on the map, or exactly half that for one a dead
 * monster dropped (`applyPickup`'s `dropped` param). The chainsaw needs none.
 */
export const WEAPON_PICKUPS: Record<
  number,
  { weapon: WeaponId; ammoType: AmmoType | null; clips: number }
> = {
  [ThingType.chainsaw]: { weapon: 'chainsaw', ammoType: null, clips: 0 },
  [ThingType.shotgun]: { weapon: 'shotgun', ammoType: 'shells', clips: 2 },
  [ThingType.superShotgun]: { weapon: 'supershotgun', ammoType: 'shells', clips: 2 },
  [ThingType.chaingun]: { weapon: 'chaingun', ammoType: 'bullets', clips: 2 },
  [ThingType.rocketLauncher]: { weapon: 'rocketLauncher', ammoType: 'rockets', clips: 2 },
  [ThingType.plasmaRifle]: { weapon: 'plasmaRifle', ammoType: 'cells', clips: 2 },
  [ThingType.bfg9000]: { weapon: 'bfg', ammoType: 'cells', clips: 2 },
};

/**
 * What the feed prints for each pickup, keyed by `d_englsh.h`'s own `GOT*` mnemonic and verbatim
 * from it — `P_TouchSpecialThing`'s `player->message` per sprite. Keyed by mnemonic so a BEX
 * `[STRINGS]` patch replaces one by name (`dehacked/apply.ts`'s `replaceByMnemonic`), whole lines
 * rather than names to interpolate; `GOTSHELLS`' literal 4 is vanilla's own and does not follow
 * `CLIP_AMMO`. docs/hud.md § HUD messages, docs/dehacked.md § Pickup messages.
 */
export const PICKUP_LINES: Record<string, string> = {
  GOTARMOR: 'Picked up the armor.',
  GOTMEGA: 'Picked up the MegaArmor!',
  GOTHTHBONUS: 'Picked up a health bonus.',
  GOTARMBONUS: 'Picked up an armor bonus.',
  GOTSTIM: 'Picked up a stimpack.',
  GOTMEDINEED: 'Picked up a medikit that you REALLY need!',
  GOTMEDIKIT: 'Picked up a medikit.',
  GOTSUPER: 'Supercharge!',
  GOTBLUECARD: 'Picked up a blue keycard.',
  GOTYELWCARD: 'Picked up a yellow keycard.',
  GOTREDCARD: 'Picked up a red keycard.',
  GOTBLUESKUL: 'Picked up a blue skull key.',
  GOTYELWSKUL: 'Picked up a yellow skull key.',
  GOTREDSKULL: 'Picked up a red skull key.',
  GOTINVUL: 'Invulnerability!',
  GOTBERSERK: 'Berserk!',
  GOTINVIS: 'Partial Invisibility',
  GOTSUIT: 'Radiation Shielding Suit',
  GOTMAP: 'Computer Area Map',
  GOTVISOR: 'Light Amplification Visor',
  GOTMSPHERE: 'MegaSphere!',
  GOTCLIP: 'Picked up a clip.',
  GOTCLIPBOX: 'Picked up a box of bullets.',
  GOTROCKET: 'Picked up a rocket.',
  GOTROCKBOX: 'Picked up a box of rockets.',
  GOTCELL: 'Picked up an energy cell.',
  GOTCELLBOX: 'Picked up an energy cell pack.',
  GOTSHELLS: 'Picked up 4 shotgun shells.',
  GOTSHELLBOX: 'Picked up a box of shotgun shells.',
  GOTBACKPACK: 'Picked up a backpack full of ammo!',
  GOTBFG9000: 'You got the BFG9000!  Oh, yes.',
  GOTCHAINGUN: 'You got the chaingun!',
  GOTCHAINSAW: 'A chainsaw!  Find some meat!',
  GOTLAUNCHER: 'You got the rocket launcher!',
  GOTPLASMA: 'You got the plasma gun!',
  GOTSHOTGUN: 'You got the shotgun!',
  GOTSHOTGUN2: 'You got the super shotgun!',
};

/**
 * Which `PICKUP_LINES` mnemonic each pickup prints, `P_TouchSpecialThing`'s sprite cases by
 * doomednum. The medikit is absent: it picks between `GOTMEDINEED` and `GOTMEDIKIT` by the health
 * it leaves, which `pickupLine` decides.
 */
export const PICKUP_LINE_OF: Record<number, string> = {
  [ThingType.greenArmor]: 'GOTARMOR',
  [ThingType.blueArmor]: 'GOTMEGA',
  [ThingType.healthBonus]: 'GOTHTHBONUS',
  [ThingType.armorBonus]: 'GOTARMBONUS',
  [ThingType.stimpack]: 'GOTSTIM',
  [ThingType.soulsphere]: 'GOTSUPER',
  [ThingType.megasphere]: 'GOTMSPHERE',
  [ThingType.blueKeycard]: 'GOTBLUECARD',
  [ThingType.yellowKeycard]: 'GOTYELWCARD',
  [ThingType.redKeycard]: 'GOTREDCARD',
  [ThingType.blueSkullKey]: 'GOTBLUESKUL',
  [ThingType.yellowSkullKey]: 'GOTYELWSKUL',
  [ThingType.redSkullKey]: 'GOTREDSKULL',
  [ThingType.invulnerability]: 'GOTINVUL',
  [ThingType.berserk]: 'GOTBERSERK',
  [ThingType.invisibility]: 'GOTINVIS',
  [ThingType.radiationSuit]: 'GOTSUIT',
  [ThingType.computerMap]: 'GOTMAP',
  [ThingType.lightAmpVisor]: 'GOTVISOR',
  [ThingType.clip]: 'GOTCLIP',
  [ThingType.boxOfBullets]: 'GOTCLIPBOX',
  [ThingType.rocket]: 'GOTROCKET',
  [ThingType.boxOfRockets]: 'GOTROCKBOX',
  [ThingType.cellCharge]: 'GOTCELL',
  [ThingType.cellChargePack]: 'GOTCELLBOX',
  [ThingType.shells]: 'GOTSHELLS',
  [ThingType.boxOfShells]: 'GOTSHELLBOX',
  [ThingType.backpack]: 'GOTBACKPACK',
  [ThingType.bfg9000]: 'GOTBFG9000',
  [ThingType.chaingun]: 'GOTCHAINGUN',
  [ThingType.chainsaw]: 'GOTCHAINSAW',
  [ThingType.rocketLauncher]: 'GOTLAUNCHER',
  [ThingType.plasmaRifle]: 'GOTPLASMA',
  [ThingType.shotgun]: 'GOTSHOTGUN',
  [ThingType.superShotgun]: 'GOTSHOTGUN2',
};
