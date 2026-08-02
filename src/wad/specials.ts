/**
 * Vanilla DOOM linedef/sector special numbers this engine understands, as a
 * flat data table rather than per-type code. Not exhaustive — a curated set
 * covering doors, lifts, generic floor movers, lights and level exits, which
 * is what `game/specials.ts` drives off. Timings/speeds approximate vanilla
 * (`VDOORSPEED`/`PLATSPEED`/`FLOORSPEED` etc.) rather than reproducing it
 * tic-for-tic.
 *
 * Keyed door numbers (26-28, 32-34, 99, 133-137) carry a `requiredKey` on
 * their `DoorEffect`, checked against the player's collected keys in
 * `game/specials.ts` before the door is allowed to trigger — same per-special
 * card/skull checks vanilla's `P_UseSpecialLine` does. 26-34 are manual (D1),
 * like their unkeyed siblings 1/31/117/118; 99 and 133-137 are switches
 * (S1/SR) that target sectors by tag like any other remote door, *not*
 * manual, despite being use-triggered same as the manual ones — confirmed by
 * scanning every stock DOOM/DOOM2 map: every 99/133-137 linedef shares its
 * exact tag with the sector(s) it's supposed to open (e.g. DOOM2 MAP04's
 * blue door is a pair of 99s both tagged 6), while 26-34's occasional
 * nonzero tag is leftover map-editor noise vanilla's manual-door code never
 * reads. Getting this wrong silently no-ops the door: MAP04's special 99
 * wasn't in this table at all until this fix, so its blue-locked door never
 * opened regardless of whether the player had the key.
 *
 * Crushers, teleporters and stair builders are modeled too (see the tables
 * below); still deliberately absent: damage-floor sector specials (no
 * sustained-damage/death system yet) and scrolling textures. Boom/MBF-only
 * special numbers (e.g. the S1/SR teleports at 174/195, or the "silent"
 * crusher at 150) are out of scope — this table only covers the vanilla
 * DOOM/DOOM2 special numbers, confirmed against the Doom wiki's linedef type
 * table rather than assumed, since a plausible-looking Boom number slipped in
 * on the first pass here (174 was briefly, wrongly, listed as a vanilla S1
 * teleport).
 */

/** Map units/second. Vanilla speeds are per-tic at 35 tics/s. */
export const DOOR_SPEED = 70; // 2 u/tic
export const DOOR_SPEED_FAST = 280; // 8 u/tic
export const DOOR_WAIT = 150 / 35; // seconds a door stays open
export const LIFT_SPEED = 35; // 1 u/tic
export const LIFT_SPEED_FAST = 140; // 4 u/tic
export const LIFT_WAIT = 105 / 35; // seconds a lift stays down
export const FLOOR_SPEED = 35;
/** Vanilla turboLower: FLOORSPEED*4, same fast-quad scaling as doors/lifts above. */
export const FLOOR_SPEED_FAST = FLOOR_SPEED * 4;
export const CEILING_SPEED = 35;
/** Vanilla CEILSPEED: 1 u/tic; crush-and-raise "fast" variants run at 2x. */
export const CRUSHER_SPEED = 35;
export const CRUSHER_SPEED_FAST = 70;
/**
 * Vanilla's recurring 8-unit gap: how far a crusher's bottom sits above the
 * floor, and how far the 55/56/65/94 and 36/70/71/98 floor families stop
 * short of the ceiling/neighbor-floor height they're nominally targeting,
 * rather than sealing flush with it.
 */
export const EIGHT_UNIT_GAP = 8;
/** DOOM's teleport landing marker (doomednum 14) — a spawn marker only, never rendered (see thingdefs.ts). */
export const TELEPORT_DEST = 14;
/** Vanilla P_BuildStairs: build8 runs at FLOORSPEED/4, turbo16 at FLOORSPEED*4. */
export const STAIR_SPEED = FLOOR_SPEED / 4;
export const STAIR_SPEED_TURBO = FLOOR_SPEED * 4;
export const STAIR_STEP = 8;
export const STAIR_STEP_TURBO = 16;

/** Gap vanilla leaves between an open door's ceiling and the lowest neighboring ceiling. */
export const DOOR_OPEN_GAP = 4;

/** Vanilla BUTTONTIME: seconds a used switch shows its "pressed" texture before reverting. */
export const SWITCH_FLASH_SECONDS = 35 / 35;

/**
 * Vanilla switch textures always come in SW1xxxx/SW2xxxx pairs sharing a
 * suffix (e.g. SW1BRCOM/SW2BRCOM) — no exceptions in the stock IWADs, so this
 * is derived from the naming convention rather than a hardcoded pair list
 * (which is exactly the kind of hand-transcribed table that turned out wrong
 * for the linedef-type numbers above; texture existence is re-checked at
 * render time via the material bank anyway, so a false-positive name match
 * here is harmless).
 */
export function switchPairTexture(name: string): string | null {
  if (name.startsWith('SW1')) return 'SW2' + name.slice(3);
  if (name.startsWith('SW2')) return 'SW1' + name.slice(3);
  return null;
}

export type DoorMode = 'openClose' | 'openOnly' | 'closeOnly';

export interface DoorEffect {
  kind: 'door';
  speed: number;
  waitSeconds: number;
  mode: DoorMode;
  /** Card/skull key of this color the player must already have collected, for the keyed door specials. */
  requiredKey?: 'blue' | 'red' | 'yellow';
}

export interface LiftEffect {
  kind: 'lift';
  speed: number;
  waitSeconds: number;
}

export type MoveTarget =
  | 'lowestNeighborFloor'
  | 'highestNeighborFloor'
  | 'nextHigherFloor'
  | 'nextLowerFloor'
  | 'lowestNeighborCeiling'
  | 'highestNeighborCeiling'
  /** The 55/56/65/94 family's target: the floor rises, rather than the usual lower/level pattern. */
  | 'lowestNeighborCeilingMinus8'
  /** The 36/70/71/98 "turboLower" family's target: stops 8 short of flush with the highest neighbor. */
  | 'highestNeighborFloorPlus8';

export interface FloorEffect {
  kind: 'floor';
  speed: number;
  target: MoveTarget;
}

export type LightPattern = 'blinkRandom' | 'blink05' | 'blink1' | 'glow' | 'syncBlink05' | 'syncBlink1' | 'flicker';

export interface ExitEffect {
  kind: 'exit';
  secret: boolean;
}

/** Ceiling repeatedly lowers to floor+`EIGHT_UNIT_GAP`, then returns to its start height, forever. */
export interface CrusherEffect {
  kind: 'crusher';
  speed: number;
}

/** Freezes whatever crusher is currently active on the targeted sector(s) wherever it is. */
export interface CrusherStopEffect {
  kind: 'crusherStop';
}

export interface TeleportEffect {
  kind: 'teleport';
  /** 125/126: vanilla gates these to non-player things; with no monster AI to walk them, they never fire. */
  monsterOnly: boolean;
}

/**
 * Raises a chain of adjacent sectors sharing the trigger sector's floor
 * texture, each `stepHeight` higher than the last, all starting at once —
 * vanilla's `EV_BuildStairs`/`T_BuildStairs`. The 16-unit vanilla specials
 * (100/127) are also flagged to crush anything caught under the rising step;
 * not modeled here, same as the ceiling crushers above and for the same
 * reason (no damage/death pipeline yet).
 */
export interface StairsEffect {
  kind: 'stairs';
  stepHeight: number;
  speed: number;
}

export type Effect =
  | DoorEffect
  | LiftEffect
  | FloorEffect
  | ExitEffect
  | CrusherEffect
  | CrusherStopEffect
  | TeleportEffect
  | StairsEffect;

export interface SpecialDef {
  trigger: 'use' | 'walk';
  repeatable: boolean;
  /** Manual doors act on the linedef's own back sector instead of a tag lookup (vanilla `line->backsector`). */
  manual?: boolean;
  effect: Effect;
}

function door(
  speed: number,
  mode: DoorMode = 'openClose',
  waitSeconds = DOOR_WAIT,
  requiredKey?: 'blue' | 'red' | 'yellow',
): DoorEffect {
  return { kind: 'door', speed, waitSeconds, mode, requiredKey };
}

function lift(speed = LIFT_SPEED, waitSeconds = LIFT_WAIT): LiftEffect {
  return { kind: 'lift', speed, waitSeconds };
}

function floor(target: MoveTarget, speed = FLOOR_SPEED): FloorEffect {
  return { kind: 'floor', speed, target };
}

export const LINE_SPECIALS: Record<number, SpecialDef> = {
  // Manual doors (untagged, target the line's own back sector).
  1: { trigger: 'use', repeatable: true, manual: true, effect: door(DOOR_SPEED) },
  31: { trigger: 'use', repeatable: false, manual: true, effect: door(DOOR_SPEED, 'openOnly') },
  117: { trigger: 'use', repeatable: true, manual: true, effect: door(DOOR_SPEED_FAST) },
  118: { trigger: 'use', repeatable: false, manual: true, effect: door(DOOR_SPEED_FAST, 'openOnly') },
  // Keyed manual doors — key colors per vanilla P_UseSpecialLine, confirmed
  // against source rather than guessed: note 26/27/28 order (Blue/Yellow/Red)
  // does not match 32/33/34's (Blue/Red/Yellow).
  26: { trigger: 'use', repeatable: true, manual: true, effect: door(DOOR_SPEED, 'openClose', DOOR_WAIT, 'blue') },
  27: { trigger: 'use', repeatable: true, manual: true, effect: door(DOOR_SPEED, 'openClose', DOOR_WAIT, 'yellow') },
  28: { trigger: 'use', repeatable: true, manual: true, effect: door(DOOR_SPEED, 'openClose', DOOR_WAIT, 'red') },
  32: { trigger: 'use', repeatable: false, manual: true, effect: door(DOOR_SPEED, 'openOnly', DOOR_WAIT, 'blue') },
  33: { trigger: 'use', repeatable: false, manual: true, effect: door(DOOR_SPEED, 'openOnly', DOOR_WAIT, 'red') },
  34: { trigger: 'use', repeatable: false, manual: true, effect: door(DOOR_SPEED, 'openOnly', DOOR_WAIT, 'yellow') },
  // Keyed remote doors (S1/SR switches, tag-targeted — see file doc comment
  // on why these are not `manual` despite being use-triggered like the ones above).
  99: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED_FAST, 'openOnly', DOOR_WAIT, 'blue') },
  133: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED_FAST, 'openOnly', DOOR_WAIT, 'blue') },
  134: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED_FAST, 'openClose', DOOR_WAIT, 'red') },
  135: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED_FAST, 'openOnly', DOOR_WAIT, 'red') },
  136: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED_FAST, 'openClose', DOOR_WAIT, 'yellow') },
  137: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED_FAST, 'openOnly', DOOR_WAIT, 'yellow') },

  // Remote doors (tag-targeted).
  4: { trigger: 'walk', repeatable: false, effect: door(DOOR_SPEED) },
  29: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED) },
  90: { trigger: 'walk', repeatable: true, effect: door(DOOR_SPEED) },
  63: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED) },
  2: { trigger: 'walk', repeatable: false, effect: door(DOOR_SPEED, 'openOnly') },
  103: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED, 'openOnly') },
  61: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED, 'openOnly') },
  86: { trigger: 'walk', repeatable: true, effect: door(DOOR_SPEED, 'openOnly') },
  3: { trigger: 'walk', repeatable: false, effect: door(DOOR_SPEED, 'closeOnly') },
  50: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED, 'closeOnly') },
  42: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED, 'closeOnly') },
  75: { trigger: 'walk', repeatable: true, effect: door(DOOR_SPEED, 'closeOnly') },
  // Fast doors group by trigger type first (WR/W1/S1/SR), each a
  // openClose/openOnly/closeOnly triad — confirmed against three independent
  // references after the vanilla assumption "108/109 are a W1/S1 openClose
  // pair" turned out wrong (real bug: DOOM2 MAP02 tag 5 uses 114, which is
  // SR openClose — a repeatable *switch*, not the one-shot walk-closeOnly
  // this table previously had it as, so tag 5's door could never be opened).
  105: { trigger: 'walk', repeatable: true, effect: door(DOOR_SPEED_FAST) },
  106: { trigger: 'walk', repeatable: true, effect: door(DOOR_SPEED_FAST, 'openOnly') },
  107: { trigger: 'walk', repeatable: true, effect: door(DOOR_SPEED_FAST, 'closeOnly') },
  108: { trigger: 'walk', repeatable: false, effect: door(DOOR_SPEED_FAST) },
  109: { trigger: 'walk', repeatable: false, effect: door(DOOR_SPEED_FAST, 'openOnly') },
  110: { trigger: 'walk', repeatable: false, effect: door(DOOR_SPEED_FAST, 'closeOnly') },
  111: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED_FAST) },
  112: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED_FAST, 'openOnly') },
  113: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED_FAST, 'closeOnly') },
  114: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED_FAST) },
  115: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED_FAST, 'openOnly') },
  116: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED_FAST, 'closeOnly') },

  // Lifts (lower to lowest neighboring floor, wait, raise back).
  10: { trigger: 'walk', repeatable: false, effect: lift() },
  21: { trigger: 'use', repeatable: false, effect: lift() },
  62: { trigger: 'use', repeatable: true, effect: lift() },
  88: { trigger: 'walk', repeatable: true, effect: lift() },
  120: { trigger: 'walk', repeatable: true, effect: lift(LIFT_SPEED_FAST) },
  121: { trigger: 'walk', repeatable: false, effect: lift(LIFT_SPEED_FAST) },
  122: { trigger: 'use', repeatable: false, effect: lift(LIFT_SPEED_FAST) },
  123: { trigger: 'use', repeatable: true, effect: lift(LIFT_SPEED_FAST) },

  // Generic floor movers — trigger/repeatability and target each confirmed
  // against the Doom wiki's linedef type table individually (a broad,
  // all-at-once fetch across this whole family contradicted an earlier,
  // already-verified single-number fetch on where 19 belongs, so every
  // number below was re-checked one at a time rather than trusted from that
  // summary — matching this file's existing rule of not trusting a plausible
  // Doom-wiki summary without a targeted check). 23 turned out to be a switch
  // (S1), not a walkover, in an earlier pass here.
  19: { trigger: 'walk', repeatable: false, effect: floor('highestNeighborFloor') },
  45: { trigger: 'use', repeatable: true, effect: floor('highestNeighborFloor') },
  102: { trigger: 'use', repeatable: false, effect: floor('highestNeighborFloor') },

  // "Lowest neighboring floor" quad (W1/WR/S1/SR).
  23: { trigger: 'use', repeatable: false, effect: floor('lowestNeighborFloor') },
  38: { trigger: 'walk', repeatable: false, effect: floor('lowestNeighborFloor') },
  60: { trigger: 'use', repeatable: true, effect: floor('lowestNeighborFloor') },
  82: { trigger: 'walk', repeatable: true, effect: floor('lowestNeighborFloor') },

  18: { trigger: 'use', repeatable: false, effect: floor('nextHigherFloor') },

  // "Lowest neighboring ceiling" quad (W1/WR/S1/SR). 24 is the fifth vanilla
  // member of this family (G1, gun-fired) but there's no shoot-trigger input
  // yet (see CLAUDE.md: weapon switching/shooting isn't implemented), so it's
  // left out rather than wired to the wrong trigger kind.
  5: { trigger: 'walk', repeatable: false, effect: floor('lowestNeighborCeiling') },
  64: { trigger: 'use', repeatable: true, effect: floor('lowestNeighborCeiling') },
  91: { trigger: 'walk', repeatable: true, effect: floor('lowestNeighborCeiling') },
  101: { trigger: 'use', repeatable: false, effect: floor('lowestNeighborCeiling') },

  // "8 below lowest neighboring ceiling, crush" quad (W1/WR/S1/SR) — these
  // raise (not lower) the floor; the crush part is out of scope, same as the
  // ceiling crushers and the 16-unit stair specials (no damage/death pipeline
  // yet).
  55: { trigger: 'use', repeatable: false, effect: floor('lowestNeighborCeilingMinus8') },
  56: { trigger: 'walk', repeatable: false, effect: floor('lowestNeighborCeilingMinus8') },
  65: { trigger: 'use', repeatable: true, effect: floor('lowestNeighborCeilingMinus8') },
  94: { trigger: 'walk', repeatable: true, effect: floor('lowestNeighborCeilingMinus8') },

  // "8 above highest neighboring floor, fast" quad (W1/WR/S1/SR) — vanilla's
  // turboLower: normally lowers a floor that started above every neighbor,
  // but stops 8 short of flush rather than levelling with it exactly.
  36: { trigger: 'walk', repeatable: false, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },
  70: { trigger: 'use', repeatable: true, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },
  71: { trigger: 'use', repeatable: false, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },
  98: { trigger: 'walk', repeatable: true, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },

  // Level exit — advances to the next map, same as the existing N hotkey.
  11: { trigger: 'use', repeatable: false, effect: { kind: 'exit', secret: false } },
  51: { trigger: 'use', repeatable: false, effect: { kind: 'exit', secret: true } },
  52: { trigger: 'walk', repeatable: false, effect: { kind: 'exit', secret: false } },
  124: { trigger: 'walk', repeatable: false, effect: { kind: 'exit', secret: true } },

  // Crushers — vanilla numbers confirmed against the Doom wiki's linedef type
  // table (57/74 stop crushers, not 58, which is an unrelated "floor up 24").
  6: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST } },
  25: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED } },
  49: { trigger: 'use', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED } },
  73: { trigger: 'walk', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED } },
  77: { trigger: 'walk', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST } },
  141: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED } },
  57: { trigger: 'walk', repeatable: false, effect: { kind: 'crusherStop' } },
  74: { trigger: 'walk', repeatable: true, effect: { kind: 'crusherStop' } },

  // Teleporters — 125/126 are the Doom II monster-only variants (see TeleportEffect doc).
  39: { trigger: 'walk', repeatable: false, effect: { kind: 'teleport', monsterOnly: false } },
  97: { trigger: 'walk', repeatable: true, effect: { kind: 'teleport', monsterOnly: false } },
  125: { trigger: 'walk', repeatable: false, effect: { kind: 'teleport', monsterOnly: true } },
  126: { trigger: 'walk', repeatable: true, effect: { kind: 'teleport', monsterOnly: true } },

  // Stair builders — confirmed against the Doom wiki: 7/8 are 8-unit steps, 100/127 are 16-unit turbo steps.
  7: { trigger: 'use', repeatable: false, effect: { kind: 'stairs', stepHeight: STAIR_STEP, speed: STAIR_SPEED } },
  8: { trigger: 'walk', repeatable: false, effect: { kind: 'stairs', stepHeight: STAIR_STEP, speed: STAIR_SPEED } },
  100: {
    trigger: 'walk',
    repeatable: false,
    effect: { kind: 'stairs', stepHeight: STAIR_STEP_TURBO, speed: STAIR_SPEED_TURBO },
  },
  127: {
    trigger: 'use',
    repeatable: false,
    effect: { kind: 'stairs', stepHeight: STAIR_STEP_TURBO, speed: STAIR_SPEED_TURBO },
  },
};

/** `Sector.special` values that animate light level rather than move geometry. */
export const SECTOR_LIGHT_SPECIALS: Record<number, LightPattern> = {
  1: 'blinkRandom',
  2: 'blink05',
  3: 'blink1',
  8: 'glow',
  12: 'syncBlink05',
  13: 'syncBlink1',
  17: 'flicker',
};
