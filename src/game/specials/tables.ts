/**
 * Every vanilla DOOM/DOOM2 linedef and sector special number this engine understands, keyed onto
 * the `defs.ts` shapes as flat data rather than per-type code; `game/specials.ts` drives off these
 * tables.
 *
 * **Every vanilla DOOM/DOOM2 special is covered**, audited number by number —
 * the scope and the audit behind it are in docs/specials.md § Scope, along
 * with how Boom's numbers join through `lookupSpecial` without touching the
 * vanilla table. Two mechanisms sit outside `LINE_SPECIALS` because neither
 * is a triggerable linedef effect: `SECTOR_DAMAGE_SPECIALS` (a sustained
 * per-tic hazard, dispatched straight from `game.ts`) and the
 * `PARAM_LINE_SPECIALS` family (always-on level-spawn parameters like 48's
 * scroll, no trigger of their own).
 *
 * Keyed door numbers (26-28, 32-34, 99, 133-137) carry a `lock` checked in
 * `game/specials.ts`. 26-34 are manual (D1) and open their own back sector;
 * 99 and 133-137 are switches targeting sectors by tag despite also being
 * use-triggered — see docs/items.md § Locked doors and use triggers, which has
 * the evidence and the shipped bug that came of getting it wrong.
 */
import { DOOM_TIC } from '../../constants.ts';
import { decodeGeneralized, isGeneralized } from './generalized.ts';
import {
  CEILING_SPEED,
  CRUSHER_SPEED,
  CRUSHER_SPEED_FAST,
  DOOR_SPEED,
  DOOR_SPEED_FAST,
  DOOR_WAIT,
  ELEVATOR_SPEED,
  FLOOR_SPEED,
  FLOOR_SPEED_FAST,
  FLOOR_SPEED_HALF,
  LIFT_SPEED,
  LIFT_SPEED_FAST,
  LIFT_WAIT,
  STAIR_SPEED,
  STAIR_SPEED_TURBO,
  STAIR_STEP,
  STAIR_STEP_TURBO,
  type DamageFloorEffect,
  type DoorEffect,
  type DoorMode,
  type FloorEffect,
  type LiftEffect,
  type LiftTarget,
  type LightPattern,
  type MoveTarget,
  type LockRule,
  type SectorDoorTimer,
  type SpecialDef,
} from './defs.ts';

function door(speed: number, mode: DoorMode = 'openClose', waitSeconds = DOOR_WAIT): DoorEffect {
  return { kind: 'door', speed, waitSeconds, mode };
}

/** Vanilla's color locks: card or skull of the color, interchangeably (see `LockRule`). */
function color(c: 'blue' | 'red' | 'yellow'): LockRule {
  return { kind: 'color', color: c };
}

function lift(speed = LIFT_SPEED, waitSeconds = LIFT_WAIT, target?: LiftTarget): LiftEffect {
  return { kind: 'lift', speed, waitSeconds, target };
}

/**
 * The `floor->direction` each target's vanilla `EV_DoFloor` case sets
 * (`p_floor.c`): every "lower" case runs -1, every "raise" one +1. Exhaustive
 * over `MoveTarget` so a new one can't be added without answering this, though
 * the targets only Boom's generalized floors reach take their direction from
 * its own bit instead (`generalized.ts: genFloor`). See `FloorEffect.direction`.
 */
const FLOOR_TARGET_DIRECTION: Record<MoveTarget, 'up' | 'down'> = {
  lowestNeighborFloor: 'down',
  highestNeighborFloor: 'down',
  highestNeighborFloorPlus8: 'down',
  nextLowerFloor: 'down',
  minus24: 'down',
  minus32: 'down',
  shortestLowerTextureDown: 'down',
  nextHigherFloor: 'up',
  lowestNeighborCeiling: 'up',
  lowestNeighborCeilingMinus8: 'up',
  highestNeighborCeiling: 'up',
  ownCeiling: 'up',
  shortestLowerTexture: 'up',
  plus24: 'up',
  plus32: 'up',
  plus512: 'up',
};

function floor(
  target: MoveTarget,
  speed = FLOOR_SPEED,
  options: { changeTexture?: boolean; crush?: boolean } = {},
): FloorEffect {
  return {
    kind: 'floor',
    speed,
    target,
    direction: FLOOR_TARGET_DIRECTION[target],
    changeTexture: options.changeTexture ?? false,
    crush: options.crush ?? false,
  };
}

/**
 * Boom's silent teleport to a landing marker (207-210, 268/269). Every one is
 * monster-activatable — `p_spec.c`'s crossing allow-list and `p_switch.c`'s
 * use allow-list both name them — and every one clears its line only on
 * success, unlike vanilla 39. See docs/specials.md § Silent and line-to-line
 * teleporters.
 */
function silentTeleport(
  trigger: 'walk' | 'use',
  repeatable: boolean,
  options: { monsterOnly?: boolean } = {},
): SpecialDef {
  return {
    trigger,
    repeatable,
    monsterActivate: trigger === 'walk',
    effect: {
      kind: 'teleport',
      monsterOnly: options.monsterOnly ?? false,
      silent: true,
      spendOnlyOnSuccess: true,
    },
  };
}

/** Boom's silent line-to-line teleport (243/244, 262-269) — all W1/WR, all silent. */
function lineTeleport(repeatable: boolean, options: { reversed?: boolean; monsterOnly?: boolean } = {}): SpecialDef {
  return {
    trigger: 'walk',
    repeatable,
    monsterActivate: true,
    effect: {
      kind: 'teleport',
      monsterOnly: options.monsterOnly ?? false,
      silent: true,
      destination: 'line',
      reversed: options.reversed,
      spendOnlyOnSuccess: true,
    },
  };
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
  26: { trigger: 'use', repeatable: true, manual: true, lock: color('blue'), effect: door(DOOR_SPEED) },
  27: { trigger: 'use', repeatable: true, manual: true, lock: color('yellow'), effect: door(DOOR_SPEED) },
  28: { trigger: 'use', repeatable: true, manual: true, lock: color('red'), effect: door(DOOR_SPEED) },
  32: { trigger: 'use', repeatable: false, manual: true, lock: color('blue'), effect: door(DOOR_SPEED, 'openOnly') },
  33: { trigger: 'use', repeatable: false, manual: true, lock: color('red'), effect: door(DOOR_SPEED, 'openOnly') },
  34: { trigger: 'use', repeatable: false, manual: true, lock: color('yellow'), effect: door(DOOR_SPEED, 'openOnly') },
  // Keyed remote doors (S1/SR switches, tag-targeted — see file doc comment
  // on why these are not `manual` despite being use-triggered like the ones above).
  99: { trigger: 'use', repeatable: true, lock: color('blue'), effect: door(DOOR_SPEED_FAST, 'openOnly') },
  133: { trigger: 'use', repeatable: false, lock: color('blue'), effect: door(DOOR_SPEED_FAST, 'openOnly') },
  134: { trigger: 'use', repeatable: true, lock: color('red'), effect: door(DOOR_SPEED_FAST) },
  135: { trigger: 'use', repeatable: false, lock: color('red'), effect: door(DOOR_SPEED_FAST, 'openOnly') },
  136: { trigger: 'use', repeatable: true, lock: color('yellow'), effect: door(DOOR_SPEED_FAST) },
  137: { trigger: 'use', repeatable: false, lock: color('yellow'), effect: door(DOOR_SPEED_FAST, 'openOnly') },

  // Remote doors (tag-targeted).
  4: { trigger: 'walk', repeatable: false, monsterActivate: true, effect: door(DOOR_SPEED) },
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
  // Close, wait DOOR_CLOSE_WAIT_SECONDS, reopen once — vanilla's
  // close30ThenOpen (see DoorMode's doc). The matching sector-type-10/14
  // door timers (SECTOR_DOOR_SPECIALS, below) are spawned directly rather
  // than through this table, since they're never tied to a linedef trigger.
  16: { trigger: 'walk', repeatable: false, effect: door(DOOR_SPEED, 'closeThenOpen') },
  76: { trigger: 'walk', repeatable: true, effect: door(DOOR_SPEED, 'closeThenOpen') },
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

  // Shoot-triggered ("impact") specials — vanilla's `P_ShootSpecialLine`.
  // None are `manual`: all tag-target sectors like the remote doors/floors
  // above. 24 is plain `raiseFloor` (same target as 5/64/91/101 below); 47 is
  // `raiseToNearestAndChange` (same as 20/68/22/95). Repeatability and 46's
  // monster exception are both per-number quirks of vanilla itself — see
  // docs/combat.md § Shoot-triggered specials.
  24: { trigger: 'shoot', repeatable: false, effect: floor('lowestNeighborCeiling') },
  46: { trigger: 'shoot', repeatable: true, monsterCanTrigger: true, effect: door(DOOR_SPEED, 'openOnly') },
  47: { trigger: 'shoot', repeatable: false, effect: floor('nextHigherFloor', FLOOR_SPEED_HALF, { changeTexture: true }) },

  // Lifts (lower to lowest neighboring floor, wait, raise back).
  10: { trigger: 'walk', repeatable: false, monsterActivate: true, effect: lift() },
  21: { trigger: 'use', repeatable: false, effect: lift() },
  62: { trigger: 'use', repeatable: true, effect: lift() },
  88: { trigger: 'walk', repeatable: true, monsterActivate: true, effect: lift() },
  120: { trigger: 'walk', repeatable: true, effect: lift(LIFT_SPEED_FAST) },
  121: { trigger: 'walk', repeatable: false, effect: lift(LIFT_SPEED_FAST) },
  122: { trigger: 'use', repeatable: false, effect: lift(LIFT_SPEED_FAST) },
  123: { trigger: 'use', repeatable: true, effect: lift(LIFT_SPEED_FAST) },
  // Perpetual plats and their stop lines — `p_plats.c: EV_DoPlat perpetualRaise`
  // (plain PLATSPEED, i.e. FLOOR_SPEED, unlike the 4x downWaitUpStay lifts
  // above) and `EV_StopPlat`. A long-standing vanilla gap here, closed when
  // Boom's generalized lifts needed the same machinery —
  // docs/specials.md § Scope.
  53: { trigger: 'walk', repeatable: false, effect: lift(FLOOR_SPEED, LIFT_WAIT, 'perpetual') },
  87: { trigger: 'walk', repeatable: true, effect: lift(FLOOR_SPEED, LIFT_WAIT, 'perpetual') },
  54: { trigger: 'walk', repeatable: false, effect: { kind: 'liftStop' } },
  89: { trigger: 'walk', repeatable: true, effect: { kind: 'liftStop' } },
  // Ceiling lower to floor, S1/SR — `linuxdoom-1.10 p_switch.c` cases 41/43,
  // `EV_DoCeiling(lowerToFloor)`: flush with the floor, unlike 44/72's
  // floor+8 crush stop. The second vanilla gap the Boom audit found —
  // docs/specials.md § Scope.
  41: { trigger: 'use', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'ownFloor' } },
  43: { trigger: 'use', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'ownFloor' } },

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
  // The WR member of the family — `linuxdoom-1.10 p_spec.c` case 83, the
  // third vanilla gap the Boom coverage audit surfaced (BOOMEDIT.WAD uses
  // it) — docs/specials.md § Scope.
  83: { trigger: 'walk', repeatable: true, effect: floor('highestNeighborFloor') },

  // "Lowest neighboring floor" quad (W1/WR/S1/SR).
  23: { trigger: 'use', repeatable: false, effect: floor('lowestNeighborFloor') },
  38: { trigger: 'walk', repeatable: false, effect: floor('lowestNeighborFloor') },
  60: { trigger: 'use', repeatable: true, effect: floor('lowestNeighborFloor') },
  82: { trigger: 'walk', repeatable: true, effect: floor('lowestNeighborFloor') },

  // "Raise to next highest floor" family — vanilla's `raiseFloorToNearest`.
  // 18/69 (S1/SR) and 119/128 (W1/WR) are the plain (no texture change)
  // members; 129/130 (walk) and 131/132 (use) are the same target at turbo
  // speed (`raiseFloorTurbo`, confirmed against p_floor.c: identical
  // `P_FindNextHighestFloor` target, just `FLOORSPEED*4` — the same fast
  // constant `turboLower` already uses here as `FLOOR_SPEED_FAST`).
  18: { trigger: 'use', repeatable: false, effect: floor('nextHigherFloor') },
  69: { trigger: 'use', repeatable: true, effect: floor('nextHigherFloor') },
  119: { trigger: 'walk', repeatable: false, effect: floor('nextHigherFloor') },
  128: { trigger: 'walk', repeatable: true, effect: floor('nextHigherFloor') },
  130: { trigger: 'walk', repeatable: false, effect: floor('nextHigherFloor', FLOOR_SPEED_FAST) },
  129: { trigger: 'walk', repeatable: true, effect: floor('nextHigherFloor', FLOOR_SPEED_FAST) },
  131: { trigger: 'use', repeatable: false, effect: floor('nextHigherFloor', FLOOR_SPEED_FAST) },
  132: { trigger: 'use', repeatable: true, effect: floor('nextHigherFloor', FLOOR_SPEED_FAST) },

  // "Raise to next highest floor and change texture" quad (S1/SR/W1/WR) —
  // vanilla's `raiseToNearestAndChange` (p_switch.c/p_spec.c case 20/68/22/95).
  // See `FloorEffect.changeTexture` for what "change" means. 47 is the fifth
  // vanilla member (G1) but lives in the shoot-triggered block above, whose
  // repeatability rule doesn't map onto W1/WR/S1/SR.
  20: { trigger: 'use', repeatable: false, effect: floor('nextHigherFloor', FLOOR_SPEED_HALF, { changeTexture: true }) },
  68: { trigger: 'use', repeatable: true, effect: floor('nextHigherFloor', FLOOR_SPEED_HALF, { changeTexture: true }) },
  22: { trigger: 'walk', repeatable: false, effect: floor('nextHigherFloor', FLOOR_SPEED_HALF, { changeTexture: true }) },
  95: { trigger: 'walk', repeatable: true, effect: floor('nextHigherFloor', FLOOR_SPEED_HALF, { changeTexture: true }) },

  // Fixed-height raises — see `MoveTarget`'s doc for the three targets.
  // 58/59 (W1) and 92/93 (WR) are vanilla's `raiseFloor24`/
  // `raiseFloor24AndChange`; 140 (S1) is `raiseFloor512`, with no
  // "AndChange" sibling in vanilla at all. 14/15/66/67 are a *different*
  // vanilla code path (`EV_DoPlat(line, raiseAndChange, 32|24)`, not
  // `EV_DoFloor`) but land on the exact same texture-copy model as the
  // "AndChange" quad above (`sides[line->sidenum[0]].sector`, i.e. the
  // triggering line's own front sector) and the same `PLATSPEED/2` speed
  // (`FLOOR_SPEED_HALF`), so they reuse this table's ordinary `FloorEffect`
  // rather than needing anything plat-specific modeled.
  58: { trigger: 'walk', repeatable: false, effect: floor('plus24') },
  59: { trigger: 'walk', repeatable: false, effect: floor('plus24', FLOOR_SPEED, { changeTexture: true }) },
  92: { trigger: 'walk', repeatable: true, effect: floor('plus24') },
  93: { trigger: 'walk', repeatable: true, effect: floor('plus24', FLOOR_SPEED, { changeTexture: true }) },
  140: { trigger: 'use', repeatable: false, effect: floor('plus512') },
  14: { trigger: 'use', repeatable: false, effect: floor('plus32', FLOOR_SPEED_HALF, { changeTexture: true }) },
  15: { trigger: 'use', repeatable: false, effect: floor('plus24', FLOOR_SPEED_HALF, { changeTexture: true }) },
  66: { trigger: 'use', repeatable: true, effect: floor('plus24', FLOOR_SPEED_HALF, { changeTexture: true }) },
  67: { trigger: 'use', repeatable: true, effect: floor('plus32', FLOOR_SPEED_HALF, { changeTexture: true }) },

  // "Lowest neighboring ceiling" quad (W1/WR/S1/SR) — vanilla's `raiseFloor`,
  // confirmed against p_floor.c: the actual target is the *lesser* of the
  // lowest neighboring ceiling and the sector's own current ceiling (a floor
  // can never be sent above its own ceiling), not the neighbor value alone —
  // `resolveFloorTarget` in game/specials.ts applies that clamp. 24 is the
  // fifth vanilla member of this family (G1, gun-fired) — see the
  // shoot-triggered specials block above for why it's kept separate.
  5: { trigger: 'walk', repeatable: false, effect: floor('lowestNeighborCeiling') },
  64: { trigger: 'use', repeatable: true, effect: floor('lowestNeighborCeiling') },
  91: { trigger: 'walk', repeatable: true, effect: floor('lowestNeighborCeiling') },
  101: { trigger: 'use', repeatable: false, effect: floor('lowestNeighborCeiling') },

  // "Raise floor crush" quad (S1/SR/W1/WR) — vanilla's `raiseFloorCrush`,
  // confirmed against p_floor.c to share `raiseFloor`'s own-ceiling clamp
  // above, minus another 8 units, and deals `CRUSH_DAMAGE` to anyone caught
  // underneath while it rises, same as the ceiling crushers below.
  55: { trigger: 'use', repeatable: false, effect: floor('lowestNeighborCeilingMinus8', FLOOR_SPEED, { crush: true }) },
  56: { trigger: 'walk', repeatable: false, effect: floor('lowestNeighborCeilingMinus8', FLOOR_SPEED, { crush: true }) },
  65: { trigger: 'use', repeatable: true, effect: floor('lowestNeighborCeilingMinus8', FLOOR_SPEED, { crush: true }) },
  94: { trigger: 'walk', repeatable: true, effect: floor('lowestNeighborCeilingMinus8', FLOOR_SPEED, { crush: true }) },

  // "8 above highest neighboring floor, fast" quad (W1/WR/S1/SR) — vanilla's
  // turboLower: normally lowers a floor that started above every neighbor,
  // but stops 8 short of flush rather than levelling with it exactly.
  36: { trigger: 'walk', repeatable: false, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },
  70: { trigger: 'use', repeatable: true, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },
  71: { trigger: 'use', repeatable: false, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },
  98: { trigger: 'walk', repeatable: true, effect: floor('highestNeighborFloorPlus8', FLOOR_SPEED_FAST) },

  // Raise-to-texture and lower-and-change — see their Effect docs above for
  // why each needs its own trigger-time logic (`SpecialsController`) rather
  // than fitting the plain `FloorEffect`/`MoveTarget` model every other
  // family here uses.
  30: { trigger: 'walk', repeatable: false, effect: { kind: 'raiseToTexture' } },
  96: { trigger: 'walk', repeatable: true, effect: { kind: 'raiseToTexture' } },
  37: { trigger: 'walk', repeatable: false, effect: { kind: 'lowerAndChange' } },
  84: { trigger: 'walk', repeatable: true, effect: { kind: 'lowerAndChange' } },

  // Level exit — advances to the next map, same as the existing N hotkey.
  11: { trigger: 'use', repeatable: false, effect: { kind: 'exit', secret: false } },
  51: { trigger: 'use', repeatable: false, effect: { kind: 'exit', secret: true } },
  52: { trigger: 'walk', repeatable: false, effect: { kind: 'exit', secret: false } },
  124: { trigger: 'walk', repeatable: false, effect: { kind: 'exit', secret: true } },

  // Crushers — vanilla numbers confirmed against the Doom wiki's linedef type
  // table (57/74 stop crushers, not 58, which is an unrelated "floor up 24").
  6: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST, silent: false, slowsWhenCrushing: false } },
  25: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: false, slowsWhenCrushing: true } },
  49: { trigger: 'use', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: false, slowsWhenCrushing: true } },
  73: { trigger: 'walk', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: false, slowsWhenCrushing: true } },
  77: { trigger: 'walk', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST, silent: false, slowsWhenCrushing: false } },
  141: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: true, slowsWhenCrushing: true } },
  57: { trigger: 'walk', repeatable: false, effect: { kind: 'crusherStop' } },
  74: { trigger: 'walk', repeatable: true, effect: { kind: 'crusherStop' } },

  // One-way ceiling movers — see CeilingEffect's doc, including why 44/72
  // never actually deal damage despite the "crush" in their vanilla name.
  // 40 ("RaiseCeilingLowerFloor") is deliberately *ceiling-only* here: real
  // vanilla's own EV_DoCeiling/EV_DoFloor pair share one busy-sector guard
  // (sec->specialdata) per sector, and since EV_DoCeiling always runs first
  // within case 40's handler, it claims every tag-matched sector before
  // EV_DoFloor gets a turn — so the floor half is *never* reachable in real
  // vanilla, confirmed by tracing both functions' own guards rather than
  // assumed from the special's "...LowerFloor" name.
  40: { trigger: 'walk', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborCeiling' } },
  44: { trigger: 'walk', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'floorPlus8' } },
  72: { trigger: 'walk', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'floorPlus8' } },

  // Donut — see DonutEffect's doc. Vanilla only ever exposes this as a
  // switch (S1); there's no walkover or repeatable variant.
  9: { trigger: 'use', repeatable: false, effect: { kind: 'donut' } },

  // Teleporters — 125/126 are the Doom II monster-only variants (see TeleportEffect doc).
  39: { trigger: 'walk', repeatable: false, monsterActivate: true, effect: { kind: 'teleport', monsterOnly: false } },
  97: { trigger: 'walk', repeatable: true, monsterActivate: true, effect: { kind: 'teleport', monsterOnly: false } },
  125: { trigger: 'walk', repeatable: false, monsterActivate: true, effect: { kind: 'teleport', monsterOnly: true } },
  126: { trigger: 'walk', repeatable: true, monsterActivate: true, effect: { kind: 'teleport', monsterOnly: true } },

  // Stair builders — confirmed against the Doom wiki: 7/8 are 8-unit steps,
  // 100/127 are 16-unit turbo steps. The wiki names 100/127 "...and Crush",
  // but the actual vanilla `EV_BuildStairs` source (p_floor.c) never sets a
  // `crush` flag on the floor movers it spawns — `Z_Malloc` zero-inits the
  // struct and nothing overwrites it — so real vanilla turbo-16 stairs don't
  // actually crush, unlike the unrelated 55/56/65/94 floor family and the
  // ceiling crushers, which do set it. Caught by checking the source directly
  // rather than trusting the wiki's naming, the same discipline that already
  // caught 174/58/40 elsewhere in this file.
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

  // Switch/walkover-triggered instant light changes — see LightChangeMode's
  // doc for each mode's exact vanilla source (EV_LightTurnOn/
  // EV_TurnTagLightsOff/EV_StartLightStrobing). Distinct from
  // SECTOR_LIGHT_SPECIALS below: those assign an ongoing blink pattern once
  // at map load from a sector's own `special`; these mutate (or, for
  // 'startStrobe', start animating) a *tag-matched* sector's light on demand.
  12: { trigger: 'walk', repeatable: false, effect: { kind: 'lightChange', mode: 'brightestNeighbor' } },
  80: { trigger: 'walk', repeatable: true, effect: { kind: 'lightChange', mode: 'brightestNeighbor' } },
  13: { trigger: 'walk', repeatable: false, effect: { kind: 'lightChange', mode: 'setLevel', level: 255 } },
  81: { trigger: 'walk', repeatable: true, effect: { kind: 'lightChange', mode: 'setLevel', level: 255 } },
  138: { trigger: 'use', repeatable: true, effect: { kind: 'lightChange', mode: 'setLevel', level: 255 } },
  35: { trigger: 'walk', repeatable: false, effect: { kind: 'lightChange', mode: 'setLevel', level: 35 } },
  79: { trigger: 'walk', repeatable: true, effect: { kind: 'lightChange', mode: 'setLevel', level: 35 } },
  139: { trigger: 'use', repeatable: true, effect: { kind: 'lightChange', mode: 'setLevel', level: 35 } },
  104: { trigger: 'walk', repeatable: false, effect: { kind: 'lightChange', mode: 'darkestNeighbor' } },
  17: { trigger: 'walk', repeatable: false, effect: { kind: 'lightChange', mode: 'startStrobe' } },
};

/**
 * `Sector.special` values that animate light level rather than move geometry.
 * 4 ("STROBE FAST/DEATH SLIME") is *also* a damage floor — confirmed against
 * `P_SpawnSpecials`, which spawns the exact same `FASTDARK`, non-synced
 * strobe as sector type 2 and then explicitly restores `sector->special = 4`
 * afterward, specifically so `P_PlayerInSpecialSector`'s own read of
 * `sector->special` still sees 4 and deals damage. This engine never clears
 * `sector.special` after seeding a light pattern in the first place (unlike
 * vanilla, which only avoids doing so here because of that explicit
 * restore), so 4 living in both this table and `SECTOR_DAMAGE_SPECIALS`
 * "just works" without needing to reproduce that restore step.
 */
export const SECTOR_LIGHT_SPECIALS: Record<number, LightPattern> = {
  1: 'blinkRandom',
  2: 'blink05',
  3: 'blink1',
  4: 'blink05',
  8: 'glow',
  12: 'syncBlink05',
  13: 'syncBlink1',
  17: 'flicker',
};

/** Vanilla `P_PlayerInSpecialSector`'s damage-floor cases — see `DamageFloorEffect` for what `suit` means. */
export const SECTOR_DAMAGE_SPECIALS: Record<number, DamageFloorEffect> = {
  7: { amount: 5, suit: 'blocks' }, // NUKAGE DAMAGE
  5: { amount: 10, suit: 'blocks' }, // HELLSLIME DAMAGE
  16: { amount: 20, suit: 'leaks' }, // SUPER HELLSLIME DAMAGE
  4: { amount: 20, suit: 'leaks' }, // STROBE HURT
  11: { amount: 20, suit: 'ignored', exitBelowHealth: 10 }, // EXIT SUPER DAMAGE (E1M8 finale)
};
/** Vanilla's `P_Random() < 5`: the chance a `'leaks'` damage floor hurts anyway despite a radiation suit. */
export const SUIT_LEAK_CHANCE = 5 / 256;
/**
 * Not vanilla's literal `leveltime&0x1f` (every 32 tics since level start, a
 * global clock) — a plain independent countdown instead. Unlike
 * `CRUSH_DAMAGE_INTERVAL`, this one genuinely can stay per-instance: there's
 * only ever one player, so there's no second simultaneous instance for an
 * unsynced phase to drift against. 32 tics at 35 tics/sec.
 */
export const DAMAGE_FLOOR_INTERVAL = 32 * DOOM_TIC;

/**
 * Boom's parameter lines: specials consumed once at level spawn
 * (`P_SpawnSpecials`) to configure a permanent per-line/per-sector behavior —
 * scrollers, friction, pushers, property transfers — rather than dispatched
 * from a trigger. `lookupSpecial` deliberately returns `null` for all of them:
 * they are `specials/forces.ts`'s, not the trigger funnel's. Listing them here
 * is what lets the inspect-wad coverage report tell "handled elsewhere" from
 * "unknown number".
 *
 * Everything in this set is implemented, by one of two owners: `forces.ts` for
 * the numbers that change how things move, `transfers.ts` for the ones that
 * change how a sector is drawn.
 * docs/specials.md § Scrollers and conveyors, § Friction, § Pushers, § Render transfers.
 */
export const PARAM_LINE_SPECIALS: Set<number> = new Set([
  48, // scroll wall left — vanilla's own, and Boom's `Add_Scroller(sc_side, FRACUNIT, 0)`
  85, // scroll wall right
  213, // transfer floor light
  214, 215, 216, 217, 218, // accelerative scrollers
  223, // friction
  224, 225, 226, // wind, current, point pusher
  242, // transfer heights (deep water)
  245, 246, 247, 248, 249, // displacement scrollers
  250, 251, 252, 253, // scroll ceiling/floor/carry
  254, 255, // wall scrollers (line vector / sidedef offsets)
  260, // translucent midtexture
  261, // transfer ceiling light
]);

/**
 * Boom's extended (non-generalized, non-parameter) linedef numbers — the
 * 142-259 families `p_spec.c`/`p_switch.c` added beside the vanilla cases.
 * Kept apart from `LINE_SPECIALS` so the vanilla table's audit stays exactly
 * what it claims; every entry here is transcribed from the Boom dispatch
 * switches (`P_CrossSpecialLine`, `P_UseSpecialLine`, `P_ShootSpecialLine`),
 * one case at a time. The teleport variants (207-210/243-244/262-269) and
 * toggle plats (211/212) are knowingly absent until their mechanisms land —
 * `DEFERRED_LINE_SPECIALS` below. docs/specials.md § Scope.
 */
export const BOOM_LINE_SPECIALS: Record<number, SpecialDef> = {
  // ---- W1 ----------------------------------------------------------------
  142: { trigger: 'walk', repeatable: false, effect: floor('plus512') },
  143: { trigger: 'walk', repeatable: false, effect: floor('plus24', FLOOR_SPEED_HALF, { changeTexture: true }) },
  144: { trigger: 'walk', repeatable: false, effect: floor('plus32', FLOOR_SPEED_HALF, { changeTexture: true }) },
  145: { trigger: 'walk', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'ownFloor' } },
  146: { trigger: 'walk', repeatable: false, effect: { kind: 'donut' } },
  153: { trigger: 'walk', repeatable: false, effect: { kind: 'changeOnly', model: 'trigger' } },
  199: { trigger: 'walk', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'lowestNeighborCeiling' } },
  200: { trigger: 'walk', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborFloor' } },
  219: { trigger: 'walk', repeatable: false, effect: floor('nextLowerFloor') },
  227: { trigger: 'walk', repeatable: false, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextHigherFloor' } },
  231: { trigger: 'walk', repeatable: false, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextLowerFloor' } },
  235: { trigger: 'walk', repeatable: false, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'currentFloor' } },
  239: { trigger: 'walk', repeatable: false, effect: { kind: 'changeOnly', model: 'numeric' } },

  // ---- WR ----------------------------------------------------------------
  147: { trigger: 'walk', repeatable: true, effect: floor('plus512') },
  148: { trigger: 'walk', repeatable: true, effect: floor('plus24', FLOOR_SPEED_HALF, { changeTexture: true }) },
  149: { trigger: 'walk', repeatable: true, effect: floor('plus32', FLOOR_SPEED_HALF, { changeTexture: true }) },
  // The WR silent crusher — vanilla 141's W1 twin, and the number the old
  // scope note singled out as Boom-only.
  150: { trigger: 'walk', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: true, slowsWhenCrushing: true } },
  // 151/166/186 are Boom's copies of vanilla 40's ceiling+floor combo, and
  // unlike 40's their floor half really runs: Boom gives floors and ceilings
  // separate per-sector slots, so `EV_DoFloor` is no longer shut out by the
  // ceiling that just claimed the sector (`SpecialDef.secondEffect`;
  // docs/specials.md § One mover per sector). 151 calls both unconditionally,
  // 166/186 short-circuit — see each entry.
  151: {
    trigger: 'walk',
    repeatable: true,
    effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborCeiling' },
    secondEffect: { effect: floor('lowestNeighborFloor') },
  },
  152: { trigger: 'walk', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'ownFloor' } },
  154: { trigger: 'walk', repeatable: true, effect: { kind: 'changeOnly', model: 'trigger' } },
  155: { trigger: 'walk', repeatable: true, effect: { kind: 'donut' } },
  156: { trigger: 'walk', repeatable: true, effect: { kind: 'lightChange', mode: 'startStrobe' } },
  157: { trigger: 'walk', repeatable: true, effect: { kind: 'lightChange', mode: 'darkestNeighbor' } },
  201: { trigger: 'walk', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'lowestNeighborCeiling' } },
  202: { trigger: 'walk', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborFloor' } },
  220: { trigger: 'walk', repeatable: true, effect: floor('nextLowerFloor') },
  228: { trigger: 'walk', repeatable: true, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextHigherFloor' } },
  232: { trigger: 'walk', repeatable: true, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextLowerFloor' } },
  236: { trigger: 'walk', repeatable: true, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'currentFloor' } },
  240: { trigger: 'walk', repeatable: true, effect: { kind: 'changeOnly', model: 'numeric' } },
  256: { trigger: 'walk', repeatable: true, effect: { kind: 'stairs', stepHeight: STAIR_STEP, speed: STAIR_SPEED } },
  257: { trigger: 'walk', repeatable: true, effect: { kind: 'stairs', stepHeight: STAIR_STEP_TURBO, speed: STAIR_SPEED_TURBO } },

  // ---- S1 ----------------------------------------------------------------
  158: { trigger: 'use', repeatable: false, effect: { kind: 'raiseToTexture' } },
  159: { trigger: 'use', repeatable: false, effect: { kind: 'lowerAndChange' } },
  160: { trigger: 'use', repeatable: false, effect: floor('plus24', FLOOR_SPEED, { changeTexture: true }) },
  161: { trigger: 'use', repeatable: false, effect: floor('plus24') },
  162: { trigger: 'use', repeatable: false, effect: lift(FLOOR_SPEED, LIFT_WAIT, 'perpetual') },
  163: { trigger: 'use', repeatable: false, effect: { kind: 'liftStop' } },
  164: { trigger: 'use', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST, silent: false, slowsWhenCrushing: false } },
  165: { trigger: 'use', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: true, slowsWhenCrushing: true } },
  166: {
    trigger: 'use',
    repeatable: false,
    effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborCeiling' },
    // `if (EV_DoCeiling(…) || EV_DoFloor(…))` — C short-circuits, so the
    // floor only lowers when no tagged sector took the ceiling.
    secondEffect: { effect: floor('lowestNeighborFloor'), onlyIfPrimaryFailed: true },
  },
  167: { trigger: 'use', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'floorPlus8' } },
  168: { trigger: 'use', repeatable: false, effect: { kind: 'crusherStop' } },
  169: { trigger: 'use', repeatable: false, effect: { kind: 'lightChange', mode: 'brightestNeighbor' } },
  170: { trigger: 'use', repeatable: false, effect: { kind: 'lightChange', mode: 'setLevel', level: 35 } },
  171: { trigger: 'use', repeatable: false, effect: { kind: 'lightChange', mode: 'setLevel', level: 255 } },
  172: { trigger: 'use', repeatable: false, effect: { kind: 'lightChange', mode: 'startStrobe' } },
  173: { trigger: 'use', repeatable: false, effect: { kind: 'lightChange', mode: 'darkestNeighbor' } },
  // The S1 teleport the old scope note flagged as the Boom-only number a
  // first audit pass mistook for vanilla.
  174: { trigger: 'use', repeatable: false, effect: { kind: 'teleport', monsterOnly: false } },
  175: { trigger: 'use', repeatable: false, effect: door(DOOR_SPEED, 'closeThenOpen') },
  189: { trigger: 'use', repeatable: false, effect: { kind: 'changeOnly', model: 'trigger' } },
  203: { trigger: 'use', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'lowestNeighborCeiling' } },
  204: { trigger: 'use', repeatable: false, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborFloor' } },
  221: { trigger: 'use', repeatable: false, effect: floor('nextLowerFloor') },
  229: { trigger: 'use', repeatable: false, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextHigherFloor' } },
  233: { trigger: 'use', repeatable: false, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextLowerFloor' } },
  237: { trigger: 'use', repeatable: false, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'currentFloor' } },
  241: { trigger: 'use', repeatable: false, effect: { kind: 'changeOnly', model: 'numeric' } },

  // ---- SR ----------------------------------------------------------------
  78: { trigger: 'use', repeatable: true, effect: { kind: 'changeOnly', model: 'numeric' } },
  176: { trigger: 'use', repeatable: true, effect: { kind: 'raiseToTexture' } },
  177: { trigger: 'use', repeatable: true, effect: { kind: 'lowerAndChange' } },
  178: { trigger: 'use', repeatable: true, effect: floor('plus512') },
  179: { trigger: 'use', repeatable: true, effect: floor('plus24', FLOOR_SPEED, { changeTexture: true }) },
  180: { trigger: 'use', repeatable: true, effect: floor('plus24') },
  181: { trigger: 'use', repeatable: true, effect: lift(FLOOR_SPEED, LIFT_WAIT, 'perpetual') },
  182: { trigger: 'use', repeatable: true, effect: { kind: 'liftStop' } },
  183: { trigger: 'use', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST, silent: false, slowsWhenCrushing: false } },
  184: { trigger: 'use', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: false, slowsWhenCrushing: true } },
  185: { trigger: 'use', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: true, slowsWhenCrushing: true } },
  186: {
    trigger: 'use',
    repeatable: true,
    effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborCeiling' },
    // `if (EV_DoCeiling(…) || EV_DoFloor(…))` — C short-circuits, so the
    // floor only lowers when no tagged sector took the ceiling.
    secondEffect: { effect: floor('lowestNeighborFloor'), onlyIfPrimaryFailed: true },
  },
  187: { trigger: 'use', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'floorPlus8' } },
  188: { trigger: 'use', repeatable: true, effect: { kind: 'crusherStop' } },
  190: { trigger: 'use', repeatable: true, effect: { kind: 'changeOnly', model: 'trigger' } },
  191: { trigger: 'use', repeatable: true, effect: { kind: 'donut' } },
  192: { trigger: 'use', repeatable: true, effect: { kind: 'lightChange', mode: 'brightestNeighbor' } },
  193: { trigger: 'use', repeatable: true, effect: { kind: 'lightChange', mode: 'startStrobe' } },
  194: { trigger: 'use', repeatable: true, effect: { kind: 'lightChange', mode: 'darkestNeighbor' } },
  195: { trigger: 'use', repeatable: true, effect: { kind: 'teleport', monsterOnly: false } },
  196: { trigger: 'use', repeatable: true, effect: door(DOOR_SPEED, 'closeThenOpen') },
  205: { trigger: 'use', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'lowestNeighborCeiling' } },
  206: { trigger: 'use', repeatable: true, effect: { kind: 'ceiling', speed: CEILING_SPEED, target: 'highestNeighborFloor' } },
  222: { trigger: 'use', repeatable: true, effect: floor('nextLowerFloor') },
  230: { trigger: 'use', repeatable: true, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextHigherFloor' } },
  234: { trigger: 'use', repeatable: true, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'nextLowerFloor' } },
  238: { trigger: 'use', repeatable: true, effect: { kind: 'elevator', speed: ELEVATOR_SPEED, target: 'currentFloor' } },
  258: { trigger: 'use', repeatable: true, effect: { kind: 'stairs', stepHeight: STAIR_STEP, speed: STAIR_SPEED } },
  259: { trigger: 'use', repeatable: true, effect: { kind: 'stairs', stepHeight: STAIR_STEP_TURBO, speed: STAIR_SPEED_TURBO } },

  // ---- G1 ----------------------------------------------------------------
  197: { trigger: 'shoot', repeatable: false, effect: { kind: 'exit', secret: false } },
  198: { trigger: 'shoot', repeatable: false, effect: { kind: 'exit', secret: true } },

  // ---- Silent + line-to-line teleporters ----------------------------------
  // Grouped by family rather than by trigger: the whole point of these
  // fourteen numbers is the three axes below, and reading them down the
  // columns is how they were checked against `p_spec.c`/`p_switch.c`.
  // docs/specials.md § Silent and line-to-line teleporters.
  207: silentTeleport('walk', false),
  208: silentTeleport('walk', true),
  209: silentTeleport('use', false),
  210: silentTeleport('use', true),
  268: silentTeleport('walk', false, { monsterOnly: true }),
  269: silentTeleport('walk', true, { monsterOnly: true }),

  // ---- Toggle plats -------------------------------------------------------
  // `EV_DoPlat(toggleUpDn)`: speed and wait are set but never used, since each
  // stroke is instant — docs/specials.md § Toggle plats.
  211: { trigger: 'use', repeatable: true, effect: lift(LIFT_SPEED, LIFT_WAIT, 'toggle') },
  212: { trigger: 'walk', repeatable: true, effect: lift(LIFT_SPEED, LIFT_WAIT, 'toggle') },

  243: lineTeleport(false),
  244: lineTeleport(true),
  262: lineTeleport(false, { reversed: true }),
  263: lineTeleport(true, { reversed: true }),
  264: lineTeleport(false, { reversed: true, monsterOnly: true }),
  265: lineTeleport(true, { reversed: true, monsterOnly: true }),
  266: lineTeleport(false, { monsterOnly: true }),
  267: lineTeleport(true, { monsterOnly: true }),
};

/**
 * Boom numbers whose *mechanism* hasn't landed yet. `lookupSpecial` returns
 * null for them like any unknown number; this set exists so the inspect-wad
 * coverage report can call them "deferred" instead of "unknown".
 *
 * **Empty**: every Boom linedef number this engine can meet now resolves to
 * something — the triggerables through `lookupSpecial`, the parameter lines
 * through `forces.ts` and `transfers.ts`. Kept declared as the seam for the
 * next number that lands ahead of its mechanism.
 * docs/specials.md § Scope.
 */
export const DEFERRED_LINE_SPECIALS: Set<number> = new Set<number>([]);

/**
 * Decoded generalized defs, one per distinct number per session — the decode
 * is pure, and memoizing also gives callers a stable identity per number
 * (`computeMovableSectors` and the trigger paths re-look-up per line).
 */
const generalizedCache = new Map<number, SpecialDef | null>();

/**
 * Which family a linedef special belongs to — what `lookupSpecial` resolves
 * against, named. `'unknown'` is the one that matters: it is the Boom-compat
 * acceptance gate (`scripts/inspect-wad.ts`'s coverage report), so it lives
 * here beside the tables rather than in the script, where it could drift out
 * of step with the lookup and report a false pass.
 */
export type SpecialClass = 'none' | 'vanilla' | 'boom' | 'generalized' | 'param' | 'deferred' | 'unknown';

export function classifyLineSpecial(special: number): SpecialClass {
  if (special === 0) return 'none';
  if (LINE_SPECIALS[special]) return 'vanilla';
  if (BOOM_LINE_SPECIALS[special]) return 'boom';
  if (isGeneralized(special)) return 'generalized';
  if (PARAM_LINE_SPECIALS.has(special)) return 'param';
  if (DEFERRED_LINE_SPECIALS.has(special)) return 'deferred';
  return 'unknown';
}

/**
 * The one lookup the trigger paths go through — the seam where Boom's
 * extended numbers and the generalized bitfield ranges join the vanilla
 * table without reshaping it. docs/specials.md § Scope.
 */
export function lookupSpecial(special: number): SpecialDef | null {
  const table = LINE_SPECIALS[special] ?? BOOM_LINE_SPECIALS[special];
  if (table) return table;
  let gen = generalizedCache.get(special);
  if (gen === undefined) {
    gen = decodeGeneralized(special);
    generalizedCache.set(special, gen);
  }
  return gen;
}

/**
 * `Sector.special` values spawning a one-shot delayed door at map load rather
 * than waiting for a linedef trigger — `P_SpawnDoorCloseIn30`/
 * `P_SpawnDoorRaiseIn5Mins`. Each assumes the sector starts in the opposite
 * state. docs/specials.md § Delayed doors.
 */
export const SECTOR_DOOR_SPECIALS: Record<number, SectorDoorTimer> = {
  10: 'closeIn30',
  14: 'raiseIn5Min',
};
