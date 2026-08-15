/**
 * The record shapes every linedef/sector special is expressed as (`SpecialDef` and the `Effect`
 * union), plus the speeds, waits and damage amounts those shapes carry. `tables.ts` keys the
 * vanilla numbers onto them and `game/specials.ts` drives off the result.
 *
 * Timings/speeds approximate vanilla (`VDOORSPEED`/`PLATSPEED`/`FLOORSPEED`) rather than
 * reproducing it tic-for-tic. See docs/specials.md.
 */
import { DOOM_TIC } from '../../constants.ts';

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
/** Vanilla `T_MoveCeiling`'s `ceiling->speed = CEILSPEED / 8` — see `CrusherEffect.slowsWhenCrushing`. */
export const CRUSH_SLOWDOWN = 8;

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
 * for the linedef-type numbers in `tables.ts`; texture existence is re-checked
 * at render time via the material bank anyway, so a false-positive name match
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
  /**
   * `T_MoveCeiling`'s `ceiling->speed = CEILSPEED / 8` — while its descent is
   * actually crushing something, a crusher grinds down at an eighth speed,
   * restored to full when it reaches the bottom. `p_ceilng.c` applies it to
   * `crushAndRaise` and `silentCrushAndRaise` (25/49/73/141) and pointedly not
   * to `fastCrushAndRaise` (6/77), which is the whole reason the fast pair
   * stays fast. Not cosmetic: it is what multiplies the time a body spends
   * under the ceiling, and so the crush damage a single stroke deals, by eight
   * — docs/specials.md § Crushers.
   */
  slowsWhenCrushing: boolean;
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
 * sets a crush flag on the floor movers it spawns — see `tables.ts` — so
 * stairs never deal crush damage, unlike the ceiling crushers and the
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
 * (special 40 — see `tables.ts` for why 40's *floor* half is faithfully
 * omitted) and `lowerAndCrush` (44/72). The latter's name is misleading:
 * confirmed against `p_ceilng.c`'s `EV_DoCeiling`, `lowerAndCrush` falls
 * straight into the same `case` block `lowerToFloor` uses without ever
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

export type SectorDoorTimer = 'closeIn30' | 'raiseIn5Min';
