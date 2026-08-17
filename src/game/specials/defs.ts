/**
 * The record shapes every linedef/sector special is expressed as (`SpecialDef` and the `Effect`
 * union), plus the speeds, waits and damage amounts those shapes carry. `tables.ts` keys the
 * vanilla numbers onto them and `game/specials.ts` drives off the result.
 *
 * Timings/speeds approximate vanilla (`VDOORSPEED`/`PLATSPEED`/`FLOORSPEED`) rather than
 * reproducing it tic-for-tic. See docs/specials.md.
 */
import { DOOM_TIC } from '../../constants.ts';
import type { KeyColor, KeySlot } from '../inventory.ts';

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

/** Boom `p_spec.h: ELEVATORSPEED` — FRACUNIT*4, i.e. 4 u/tic, same rate as the fast floors. */
export const ELEVATOR_SPEED = FLOOR_SPEED * 4;

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
 * `doomdef.h`'s `ORIG_FRICTION` (`0xE800`): vanilla's own per-tic momentum
 * multiplier, the value a floor with no Boom 223 line still decays by — and the
 * same number `game/things.ts` cites for its own knockback decay.
 */
export const ORIG_FRICTION = 0xe800 / 0x10000;

/**
 * What the floor under a body does to its movement, already converted out of
 * Boom's fixed-point `friction`/`movefactor` pair into this engine's own
 * movement model — produced by `specials/forces.ts: frictionUnder`, consumed by
 * `game/player.ts: update`.
 *
 * `friction` is the per-tic momentum multiplier, used directly. The other two
 * translate vanilla's thrust-against-friction model onto the exponential
 * approach `player.ts` actually runs on — see docs/movement.md § Friction for
 * the derivation.
 */
export interface FrictionEffect {
  friction: number;
  /** Multiplier on the target velocity: vanilla's terminal speed here over vanilla's terminal speed on a normal floor. */
  targetScale: number;
  /** Multiplier on the approach rate, matching the time constant of vanilla's own decay here. */
  accelScale: number;
}

/**
 * The normal-floor answer: what `frictionUnder` returns where no 223 line
 * applies and what `player.update` assumes when no caller names a floor. One
 * declaration for both, so "a map without a friction line moves exactly as it
 * did before friction existed" is an identity rather than two literals kept in
 * step. Never mutated.
 */
export const NO_FRICTION: Readonly<FrictionEffect> = { friction: ORIG_FRICTION, targetScale: 1, accelScale: 1 };

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
  /**
   * `closeThenOpen` only: seconds shut before reopening. Absent means
   * vanilla's hardcoded `DOOR_CLOSE_WAIT_SECONDS` (16/76); Boom's generalized
   * CdO doors wait their own delay field instead (`EV_DoGenDoor`).
   */
  closeWaitSeconds?: number;
}

/**
 * Where a lift's down-stroke goes (`EV_DoPlat`/`EV_DoGenLift`'s `plat->low`,
 * always clamped to no higher than the sector's own floor). `'perpetual'` is
 * vanilla `perpetualRaise` (53/87) and Boom's `LnF2HnF`: bounce between the
 * lowest and highest neighbor floor forever, waiting at each end, starting in
 * a random direction (`P_Random(pr_plats)&1`).
 *
 * `'toggle'` is Boom's `toggleUpDn` (211/212), the odd one out: it snaps the
 * floor between its own start height and its ceiling with no travel time and
 * no wait, crushing whatever is between — docs/specials.md § Toggle plats.
 */
export type LiftTarget =
  | 'lowestNeighborFloor'
  | 'nextLowerFloor'
  | 'lowestNeighborCeiling'
  | 'perpetual'
  | 'toggle';

export interface LiftEffect {
  kind: 'lift';
  speed: number;
  waitSeconds: number;
  /** Absent = `'lowestNeighborFloor'`, vanilla's downWaitUpStay — the default every pre-Boom entry relies on. */
  target?: LiftTarget;
}

/**
 * Vanilla `EV_StopPlat` (54/89, Boom 163): freezes every tagged running lift
 * where it stands (`in_stasis`, direction remembered in `oldstatus`). Only a
 * *perpetual* lift trigger wakes them again — `EV_DoPlat` calls
 * `P_ActivateInStasis` for `perpetualRaise` alone.
 */
export interface LiftStopEffect {
  kind: 'liftStop';
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
  | 'plus512'
  /**
   * Boom's generalized floors (`p_genlin.c: EV_DoGenFloor`): the down-direction
   * relative moves (`Fby24`/`Fby32` with the direction bit clear), the sector's
   * own ceiling (`FtoC`, no gap), and `FbyST` — the floor moves by the shortest
   * lower-texture height found around the sector (`P_FindShortestTextureAround`,
   * the same scan vanilla's `raiseToTexture` runs), up or down per the
   * direction bit.
   */
  | 'minus24'
  | 'minus32'
  | 'ownCeiling'
  | 'shortestLowerTexture'
  | 'shortestLowerTextureDown';

/**
 * Boom's generalized texture/type change (`p_genlin.c`): the moved sector
 * copies its surface texture — and per `type` its special — from a model
 * sector, applied when the mover *arrives* (`T_MoveFloor`/`T_MoveCeiling`'s
 * `pastdest` gen cases), unlike vanilla's at-trigger "AndChange" family.
 * `'trigger'` models from the activating line's front sector; `'numeric'`
 * models from the first neighbor already at the destination height
 * (`P_FindModelFloorSector`/`P_FindModelCeilingSector` — ceiling-height match
 * when the destination itself is ceiling-derived), and applies nothing when
 * no such neighbor exists.
 */
export interface SurfaceChange {
  model: 'trigger' | 'numeric';
  /** FChgTxt / FChgZero / FChgTyp: texture only, texture + special cleared, texture + the model's special. */
  type: 'texOnly' | 'texZeroType' | 'texAndType';
}

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
  /** Boom's arrival-time change — see `SurfaceChange`. Absent on every vanilla entry. */
  change?: SurfaceChange;
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
  /**
   * Boom's generalized silent crusher is *fully* silent: unlike vanilla 141,
   * which clacks `pstop` at each end of its stroke, `genSilentCrusher` is in
   * neither of `T_MoveCeiling`'s end-sound cases. Only meaningful with
   * `silent`; absent = vanilla 141's end clacks.
   */
  noEndClack?: boolean;
}

/** Freezes whatever crusher is currently active on the targeted sector(s) wherever it is. */
export interface CrusherStopEffect {
  kind: 'crusherStop';
}

/**
 * Every teleport number, vanilla and Boom, in one effect — the three optional
 * axes are exactly what separates Boom's silent family from vanilla's 39/97.
 * Absent means the vanilla behavior, so the four vanilla entries are unchanged.
 * See docs/specials.md § Silent and line-to-line teleporters.
 */
export interface TeleportEffect {
  kind: 'teleport';
  /** 125/126 and Boom's 264-269: vanilla gates these to non-player things. */
  monsterOnly: boolean;
  /**
   * Boom's silent family (207-210, 243/244, 262-269, `p_telept.c`): no fog, no
   * `telept`, no reaction-time freeze. The arrival *rotates* the body by the
   * angle between the two ends instead of setting an absolute facing, carries
   * its momentum through that rotation, and keeps its height above the floor.
   */
  silent?: boolean;
  /**
   * What the tag names. `'thing'` (the default) is vanilla's landing marker
   * inside a tag-matched sector, `EV_Teleport`/`EV_SilentTeleport`; `'line'`
   * is `EV_SilentLineTeleport`'s tag-matched *linedef*, which the body is
   * placed along proportionally rather than dropped onto a marker.
   */
  destination?: 'thing' | 'line';
  /** Line-to-line only — `EV_SilentLineTeleport`'s `reverse` (262-265). */
  reversed?: boolean;
  /**
   * Boom's numbers clear `line->special` only when the teleport actually
   * happened (`if (EV_Silent…(…)) line->special = 0;`). Vanilla 39/125 clear
   * it either way — their `|| demo_compatibility` — which is the behavior the
   * four vanilla entries keep and `tests/regression/teleport-back-side.test.ts`
   * pins.
   */
  spendOnlyOnSuccess?: boolean;
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
  /** Boom's generalized stairs build downward too (`EV_DoGenStairs`' direction bit). Absent = `'up'`, every vanilla number. */
  direction?: 'up' | 'down';
  /** `EV_DoGenStairs`' Igno bit: keep chaining across neighbors whose floor texture differs. Absent = vanilla's texture-matched walk. */
  ignoreTexture?: boolean;
}

export type CeilingTarget =
  | 'highestNeighborCeiling'
  | 'floorPlus8'
  /**
   * Boom's generalized ceilings (`p_genlin.c: EV_DoGenCeiling`), the full
   * target set with the direction bit already resolved: neighbor ceilings
   * (lowest / next up / next down), the highest neighbor *floor*, the
   * sector's own floor (`CtoF`, no gap), relative 24/32 moves both ways, and
   * `CbyST` — by the shortest *upper*-texture height around the sector
   * (`P_FindShortestUpperAround`), up or down.
   */
  | 'lowestNeighborCeiling'
  | 'nextHigherCeiling'
  | 'nextLowerCeiling'
  | 'highestNeighborFloor'
  | 'ownFloor'
  | 'plus24'
  | 'plus32'
  | 'minus24'
  | 'minus32'
  | 'shortestUpperTexture'
  | 'shortestUpperTextureDown';

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
  /**
   * Boom's generalized ceilings can crush: the descent grinds on through a
   * body at full speed, dealing periodic damage (`T_MoveCeiling`'s `crushed`
   * branch pointedly excludes `genCeiling` from the slow-down the crusher
   * types get). Absent = vanilla's stall-in-place, which is right for every
   * vanilla number — see the class doc above on `lowerAndCrush`'s misleading
   * name.
   */
  crush?: boolean;
  /** Boom's arrival-time change — see `SurfaceChange`; ceilings copy `ceilTex`. Absent on every vanilla entry. */
  change?: SurfaceChange;
}

/**
 * Boom's motionless texture/type change (`p_floor.c: EV_DoChange` — linedefs
 * 78/153/154/189/190/239/240/241): each tagged sector copies floor flat *and*
 * special from a model, instantly, nothing moves. The numeric model is the
 * first neighbor at the sector's *own current* floor height, and no model
 * means no change — though the activation still counts as a hit (`rtn = 1`
 * per tagged sector regardless), so a switch still flips.
 */
export interface ChangeOnlyEffect {
  kind: 'changeOnly';
  model: 'trigger' | 'numeric';
}

/**
 * Boom's elevator (`p_floor.c: EV_DoElevator`, linedefs 227-232): floor and
 * ceiling move in lockstep, preserving the sector's gap, at `ELEVATOR_SPEED`,
 * to the next floor up, the next floor down, or the activating line's own
 * front-sector floor height. Never crushes — a blocked plane stalls the pair
 * (`T_MoveElevator` moves the ceiling first going down, the floor first going
 * up, and skips the partner when the leader is blocked).
 */
export interface ElevatorEffect {
  kind: 'elevator';
  speed: number;
  target: 'nextHigherFloor' | 'nextLowerFloor' | 'currentFloor';
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
  | LiftStopEffect
  | ElevatorEffect
  | ChangeOnlyEffect
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

/**
 * What a locked line demands, on the def rather than the door effect: vanilla
 * locks are always a color (card or skull interchangeably — `p_doors.c` tests
 * both), while Boom's generalized locked doors add exact-slot locks, "any
 * key" and "all keys" (`p_spec.c: P_CanUnlockGenDoor`). Boom's SkullsAreCards
 * bit is resolved at decode time: with it set an exact lock becomes the
 * color lock, without it `all` means all six slots (`colorsSuffice: false`).
 */
export type LockRule =
  | { kind: 'any' }
  | { kind: 'all'; colorsSuffice: boolean }
  | { kind: 'color'; color: KeyColor }
  | { kind: 'slot'; slot: KeySlot };

/**
 * Who is activating a line. Distinct from `SpecialDef.monsterCanTrigger`/
 * `monsterActivate`, which say who a *number* admits — this says who is at the
 * line right now, so `trigger` can gate and route (a monster's teleport is
 * returned to the caller, the player's goes through `onTeleport`).
 *
 * **`'monster'` means "any non-player body"**, which is `P_CrossSpecialLine`'s
 * own distinction — its allow-list branch is `if (!thing->player)` and excludes
 * only projectiles, so a barrel or a decoration a conveyor carried over a line
 * activates exactly what a monster would. The name follows Boom's own "monster
 * only" numbering, which means the same thing.
 *
 * A **voodoo doll** gates like the player it is a copy of — same keys, same
 * lines, and it is not a monster for any monster-only number — but its teleport
 * destination comes back to the caller the way a monster's does, since the doll
 * moves rather than the player. It also raises no HUD feedback: a doll bumping a
 * locked door must not print "you need the blue key". docs/specials.md § Voodoo dolls.
 */
export type Activator = 'player' | 'monster' | 'voodoo';

export interface SpecialDef {
  trigger: 'use' | 'walk' | 'shoot';
  repeatable: boolean;
  /** Manual doors act on the linedef's own back sector instead of a tag lookup (vanilla `line->backsector`). */
  manual?: boolean;
  /** What the line demands before it acts — see `LockRule`. Absent = never locked. */
  lock?: LockRule;
  /**
   * The line does nothing without a tag. Boom requires one on every
   * non-Push generalized line, on all three trigger paths (`p_spec.c`'s
   * "all walk generalized types require tag"); vanilla numbers leave this
   * unset and keep their own tag-0 behavior.
   */
  requiresTag?: boolean;
  /**
   * XORed into the line's own special after every activation that did
   * something — Boom's generalized stairs alternating build direction
   * (`EV_DoGenStairs`' `line->special ^= StairDirection`). The engine keeps
   * the *authored* number and tracks the flip separately
   * (`SpecialsController.retriggerFlips`), so a mask here is all the
   * controller needs to know about the bit layout.
   */
  retriggerXor?: number;
  /**
   * Only meaningful for `trigger: 'walk'`. Vanilla `P_CrossSpecialLine`'s
   * `!thing->player` allow-list — the seven numbers a monster may cross
   * (teleports, one door, two lifts); every other walk line ignores monsters.
   * Boom's generalized lines carry the same permission as a trigger bit, which
   * is why this is data on the def rather than a hardcoded number set.
   */
  monsterActivate?: boolean;
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
  /**
   * A second effect run over the same tag-matched sectors after `effect` —
   * Boom's three "raise ceiling, lower floor" numbers (151/166/186), the only
   * dispatch cases in the whole switch that call two `EV_` helpers. Each pass
   * covers every target before the next begins, matching the real order.
   *
   * `onlyIfPrimaryFailed` is C's `||` short-circuit: 166/186 are
   * `if (EV_DoCeiling(…) || EV_DoFloor(…))`, so their floor half runs only
   * when no tagged sector could take the ceiling, while 151 calls both
   * unconditionally. These are reachable at all only because floors and
   * ceilings hold separate per-sector slots — docs/specials.md § One mover
   * per sector. Vanilla 40 is *not* one of them: Boom deletes its
   * `EV_DoFloor` call outside demo compatibility.
   */
  secondEffect?: { effect: Effect; onlyIfPrimaryFailed?: boolean };
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
