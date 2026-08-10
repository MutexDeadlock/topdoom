/**
 * Vanilla DOOM linedef/sector special numbers this engine understands, as a
 * flat data table rather than per-type code. Timings/speeds approximate vanilla
 * (`VDOORSPEED`/`PLATSPEED`/`FLOORSPEED`) rather than reproducing it
 * tic-for-tic; `game/specials.ts` drives off this table.
 *
 * **Every vanilla DOOM/DOOM2 special is covered, and nothing beyond** — the
 * scope, the audit behind it, and why Boom numbers are excluded are in
 * docs/specials.md. Two mechanisms sit outside `LINE_SPECIALS` because neither
 * is a triggerable linedef effect: `SECTOR_DAMAGE_SPECIALS` (a sustained
 * per-tic hazard, dispatched straight from `game.ts`) and `SCROLL_LINE_SPECIAL`
 * (an always-on animation with no trigger of its own).
 *
 * Keyed door numbers (26-28, 32-34, 99, 133-137) carry a `requiredKey` checked
 * in `game/specials.ts`. 26-34 are manual (D1) and open their own back sector;
 * 99 and 133-137 are switches targeting sectors by tag despite also being
 * use-triggered — see docs/items.md § Locked doors and use triggers, which has
 * the evidence and the shipped bug that came of getting it wrong.
 */
import { DOOM_TIC } from '../constants.ts';

/** Map units/second. Vanilla speeds are per-tic at 35 tics/s. */
export const DOOR_SPEED = 70; // 2 u/tic
export const DOOR_SPEED_FAST = 280; // 8 u/tic
export const DOOR_WAIT = 150 * DOOM_TIC; // seconds a door stays open
export const FLOOR_SPEED = 35;
// Vanilla's `downWaitUpStay`/`blazeDWUS` plat types run at PLATSPEED*4/*8 (and
// PLATSPEED == FLOORSPEED), not *1/*4 — confirmed against the actual source
// (p_plats.c: EV_DoPlat) after a naive "fast is 4x normal" guess here turned
// out to make both tiers wrong (the "fast" lift ran at what should've been
// the *normal* speed, and "normal" ran 4x too slow).
export const LIFT_SPEED = FLOOR_SPEED * 4; // 4 u/tic
export const LIFT_SPEED_FAST = FLOOR_SPEED * 8; // 8 u/tic
export const LIFT_WAIT = 105 * DOOM_TIC; // seconds a lift stays down
/** Vanilla turboLower: FLOORSPEED*4, same fast-quad scaling as doors/lifts above. */
export const FLOOR_SPEED_FAST = FLOOR_SPEED * 4;
/** Vanilla's "AndChange" plat family (raiseToNearestAndChange) runs at PLATSPEED/2, and PLATSPEED == FLOORSPEED. */
export const FLOOR_SPEED_HALF = FLOOR_SPEED / 2;
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
/** Vanilla: a mover with `crush` set deals this much damage every `CRUSH_DAMAGE_INTERVAL` while something is caught in its sector. */
export const CRUSH_DAMAGE = 10;
/**
 * Vanilla's `leveltime&3` (4 tics at 35 tics/sec) — one clock shared by every
 * crushing mover on the map, not a per-mover countdown (`SpecialsController`'s
 * `crushDamageTimer`/`crushDamageDue`, the same shared-clock shape
 * `MOVE_SOUND_INTERVAL` already uses for the grind sound). A per-mover
 * countdown reset on each fire drifts out of phase with the level's real tic
 * count and can add an extra hit a real vanilla/GZDoom crusher wouldn't have
 * dealt — confirmed the difference testing `crusher_test.wad` against GZDoom.
 */
export const CRUSH_DAMAGE_INTERVAL = 4 * DOOM_TIC;

/** Gap vanilla leaves between an open door's ceiling and the lowest neighboring ceiling. */
export const DOOR_OPEN_GAP = 4;

/**
 * Vanilla hardcodes `35*30` tics (30 real seconds) in two unrelated places
 * that both end up meaning the same thing — "how long an already-open door
 * sits shut before it moves again": `close30ThenOpen`'s wait at the bottom
 * before it reopens (specials 16/76), and `P_SpawnDoorCloseIn30`'s wait
 * before a sector-type-10 door closes for the first and only time. Reused
 * for both rather than declared twice.
 */
export const DOOR_CLOSE_WAIT_SECONDS = 30;
/** Vanilla `P_SpawnDoorRaiseIn5Mins`: seconds a sector-type-14 door waits, fully closed, before it opens for the first and only time. */
export const DOOR_RAISE_WAIT_SECONDS = 5 * 60;

/** Vanilla BUTTONTIME: seconds a used switch shows its "pressed" texture before reverting. */
export const SWITCH_FLASH_SECONDS = 35 * DOOM_TIC;

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

export type DoorMode =
  | 'openClose'
  | 'openOnly'
  | 'closeOnly'
  /**
   * Vanilla's `close30ThenOpen` (specials 16/76): closes immediately, same
   * as `closeOnly`, but instead of stopping there, waits
   * `DOOR_CLOSE_WAIT_SECONDS` at the bottom and reopens once — to wherever
   * it already was (its *current* ceiling height at trigger time, not a
   * freshly computed neighbor ceiling — confirmed against `p_doors.c`:
   * `door->topheight = sec->ceilingheight;`, unlike every other `DoorMode`
   * here), then stays open for good, matching vanilla's own
   * `sector->specialdata = NULL` once the reopen completes.
   */
  | 'closeThenOpen';

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
  /** The 55/56/65/94 family's target ("raiseFloorCrush" in vanilla): the floor rises, rather than the usual lower/level pattern. */
  | 'lowestNeighborCeilingMinus8'
  /** The 36/70/71/98 "turboLower" family's target: stops 8 short of flush with the highest neighbor. */
  | 'highestNeighborFloorPlus8'
  /**
   * Fixed-height raises — vanilla's `raiseFloor24`/`raiseFloor24AndChange`
   * (58/59/92/93), the `EV_DoPlat(line, raiseAndChange, 24|32)` pair
   * (14/15/66/67), and `raiseFloor512` (140). Unlike every other target
   * above, these are relative to the sector's *own current* floor height,
   * not any neighbor's — confirmed against `p_floor.c`'s `raiseFloor24`/
   * `raiseFloor512` cases (`floor->sector->floorheight + N*FRACUNIT`) and
   * `p_plats.c`'s `raiseAndChange` case (`sec->floorheight + amount*FRACUNIT`).
   */
  | 'plus24'
  | 'plus32'
  | 'plus512';

export interface FloorEffect {
  kind: 'floor';
  speed: number;
  target: MoveTarget;
  /**
   * Vanilla's "AndChange" specials (20/22/68/95 — `raiseToNearestAndChange`):
   * on trigger, copy the *triggering linedef's own front-sector* floor
   * texture onto the sector(s) about to move, and clear their `special`
   * ("NO MORE DAMAGE, IF APPLICABLE" in vanilla's own source comment — a
   * light-blink special already has its own independent thinker in this
   * engine too, so clearing it here doesn't stop that, matching vanilla).
   * Not the *target* sector's texture — the model is the switch/walkover
   * line's own front side, which is how mappers control what a raised floor
   * turns into.
   */
  changeTexture: boolean;
  /**
   * The 55/56/65/94 family (`raiseFloorCrush`): deals `CRUSH_DAMAGE` every
   * `CRUSH_DAMAGE_INTERVAL` to anyone caught in the target sector while the
   * floor is moving, same as the ceiling crushers below.
   */
  crush: boolean;
}

export type LightPattern = 'blinkRandom' | 'blink05' | 'blink1' | 'glow' | 'syncBlink05' | 'syncBlink1' | 'flicker';

export interface ExitEffect {
  kind: 'exit';
  secret: boolean;
}

/**
 * Ceiling repeatedly lowers to floor+`EIGHT_UNIT_GAP`, then returns to its
 * start height, forever, dealing `CRUSH_DAMAGE` every `CRUSH_DAMAGE_INTERVAL`
 * to anyone it doesn't leave room for — only while lowering: `T_MoveCeiling`
 * (`p_ceilng.c`) hardcodes `crush=false` for the raise call regardless of the
 * mover's own crush flag, so real vanilla never deals crush damage on the way
 * back up either.
 */
export interface CrusherEffect {
  kind: 'crusher';
  speed: number;
  /**
   * Vanilla's `silentCrushAndRaise` (141): no grinding `stnmov` while it moves,
   * just a `pstop` clack at each end (`p_ceilng.c`'s own `switch` on the ceiling
   * type, in both directions). The only thing that distinguishes it from 25 —
   * which is the whole point of the type, so it can't be folded in.
   */
  silent: boolean;
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
 * vanilla's `EV_BuildStairs`/`T_BuildStairs`. Despite the wiki naming the
 * 16-unit vanilla specials (100/127) "...and Crush", the actual source never
 * sets a crush flag on the floor movers it spawns — see the table below —
 * so stairs never deal crush damage, unlike the ceiling crushers and the
 * 55/56/65/94 floor family.
 */
export interface StairsEffect {
  kind: 'stairs';
  stepHeight: number;
  speed: number;
}

export type CeilingTarget = 'highestNeighborCeiling' | 'floorPlus8';

/**
 * A one-way ceiling mover: moves once to `target`, then stops — no hold, no
 * reversal, unlike `DoorEffect`/`CrusherEffect`. Vanilla's `raiseToHighest`
 * (special 40 — see the file doc comment for why 40's *floor* half is
 * faithfully omitted) and `lowerAndCrush` (44/72). The latter's name is
 * misleading: confirmed against `p_ceilng.c`'s `EV_DoCeiling`, `lowerAndCrush`
 * falls straight into the same `case` block `lowerToFloor` uses without ever
 * passing through the earlier `ceiling->crush = true;` line the *cyclic*
 * crush types (`crushAndRaise` family) do — so despite the name, a real
 * vanilla 44/72 ceiling never actually deals crush damage, it just lowers to
 * floor+`EIGHT_UNIT_GAP` once and sits there. `game/specials.ts`'s
 * `CeilingMover` has no `crush`/damage handling at all as a result — there is
 * no vanilla case that would ever need it.
 */
export interface CeilingEffect {
  kind: 'ceiling';
  speed: number;
  target: CeilingTarget;
}

/**
 * Vanilla's `raiseToTexture` (30/96): rises to the shortest bottom-texture
 * height among the sector's neighboring two-sided lines (checking *both*
 * sidedefs of each, not just the far side — confirmed against `p_floor.c`),
 * added to the sector's own current floor height. No texture change of its
 * own. See `SpecialsController.triggerRaiseToTexture` for the scan.
 */
export interface RaiseToTextureEffect {
  kind: 'raiseToTexture';
}

/**
 * Vanilla's `lowerAndChange` (37/84): lowers to the lowest neighboring floor,
 * then copies the texture and `special` of whichever neighbor already sits at
 * that height — **on arrival, not at trigger time** (`T_MoveFloor`'s `pastdest`
 * branch). A genuinely different texture-source rule from
 * `FloorEffect.changeTexture`'s. See docs/specials.md § raiseToTexture,
 * lowerAndChange.
 */
export interface LowerAndChangeEffect {
  kind: 'lowerAndChange';
}

/**
 * Vanilla's `EV_DoDonut` (special 9): the tagged "hole" lowers while the
 * surrounding "ring" rises, both toward a third sector's floor height, the ring
 * also taking its texture on arrival. Ring and outer sector are discovered at
 * trigger time, as arbitrarily as vanilla's own search. This engine does
 * vanilla's two-sided check *correctly* rather than reproducing its
 * operator-precedence bug. docs/specials.md § The donut.
 */
export interface DonutEffect {
  kind: 'donut';
}

export type LightChangeMode =
  /** Vanilla's `EV_LightTurnOn(line, bright)` with a nonzero `bright` (13/35/79/81/138/139): set to that exact level. */
  | 'setLevel'
  /** `EV_LightTurnOn(line, 0)` (12/80): vanilla searches for "0 means brightest neighbor" — the max light level among immediate two-sided neighbors, or pitch black (0) if there are none. */
  | 'brightestNeighbor'
  /** `EV_TurnTagLightsOff` (104): the min of the sector's own current level and every immediate neighbor's — never brightens, unlike `brightestNeighbor` never having a floor. */
  | 'darkestNeighbor'
  /** `EV_StartLightStrobing` (17): spawns the same slow, non-synced strobe pattern (`blink1`) a sector-type 3 gets at map load, skipped if the sector already has an active mover (vanilla's own `sec->specialdata` guard). */
  | 'startStrobe';

export interface LightChangeEffect {
  kind: 'lightChange';
  mode: LightChangeMode;
  /** Only meaningful for `mode: 'setLevel'`. */
  level?: number;
}

export type Effect =
  | DoorEffect
  | LiftEffect
  | FloorEffect
  | ExitEffect
  | CrusherEffect
  | CrusherStopEffect
  | TeleportEffect
  | StairsEffect
  | CeilingEffect
  | RaiseToTextureEffect
  | LowerAndChangeEffect
  | DonutEffect
  | LightChangeEffect;

export interface SpecialDef {
  trigger: 'use' | 'walk' | 'shoot';
  repeatable: boolean;
  /** Manual doors act on the linedef's own back sector instead of a tag lookup (vanilla `line->backsector`). */
  manual?: boolean;
  /**
   * Only meaningful for `trigger: 'shoot'`. Vanilla's `P_ShootSpecialLine`
   * rejects every shoot-triggered special from a non-player shooter except
   * one hardcoded exception — `case 46: ok = 1;` in its own `!thing->player`
   * gate, with the source comment "46 is the only special that can be
   * activated by a corpse or item that touches or shoots it" (loosely; a
   * monster's own hitscan/projectile is what actually exercises this here,
   * this engine has no corpse-sliding). This is a property of the specific
   * number, not of being shoot-triggered in general, so it's data on the
   * def rather than something `trigger === 'shoot'` implies on its own.
   */
  monsterCanTrigger?: boolean;
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

function floor(
  target: MoveTarget,
  speed = FLOOR_SPEED,
  options: { changeTexture?: boolean; crush?: boolean } = {},
): FloorEffect {
  return { kind: 'floor', speed, target, changeTexture: options.changeTexture ?? false, crush: options.crush ?? false };
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
  6: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST, silent: false } },
  25: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: false } },
  49: { trigger: 'use', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: false } },
  73: { trigger: 'walk', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: false } },
  77: { trigger: 'walk', repeatable: true, effect: { kind: 'crusher', speed: CRUSHER_SPEED_FAST, silent: false } },
  141: { trigger: 'walk', repeatable: false, effect: { kind: 'crusher', speed: CRUSHER_SPEED, silent: true } },
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
  39: { trigger: 'walk', repeatable: false, effect: { kind: 'teleport', monsterOnly: false } },
  97: { trigger: 'walk', repeatable: true, effect: { kind: 'teleport', monsterOnly: false } },
  125: { trigger: 'walk', repeatable: false, effect: { kind: 'teleport', monsterOnly: true } },
  126: { trigger: 'walk', repeatable: true, effect: { kind: 'teleport', monsterOnly: true } },

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

/**
 * Vanilla `P_PlayerInSpecialSector`'s damage-floor cases — a sustained per-tic
 * hazard, not a mover's crush hit. Player-only, as in vanilla.
 *
 * **`suit` is deliberately not uniform**, matching vanilla: blocked outright,
 * leaking `SUIT_LEAK_CHANCE` of hits, or ignored entirely for E1M8's finale
 * type, which is scripted to end the level rather than survived.
 * `exitBelowHealth` is that same finale quirk. See docs/specials.md § Damage
 * floors.
 */
export interface DamageFloorEffect {
  amount: number;
  suit: 'blocks' | 'leaks' | 'ignored';
  exitBelowHealth?: number;
}
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
 * Vanilla's `P_UpdateSpecials`: scrolls the line's *front* sidedef texture
 * offset forever — no trigger, no tag. Purely cosmetic, so unlike everything
 * else here it bypasses `SpecialsController` entirely (`TextureScroller`).
 * docs/render.md § Scrolling textures.
 */
export const SCROLL_LINE_SPECIAL = 48;
export const SCROLL_SPEED = 35;

export type SectorDoorTimer = 'closeIn30' | 'raiseIn5Min';

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
