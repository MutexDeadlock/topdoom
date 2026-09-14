/**
 * Boom's generalized linedefs (0x2F80-0x7FFF): seven bitfield-encoded families
 * decoded into the same {@link SpecialDef}/`Effect` shapes the vanilla table uses.
 * Every mask, enum ordering and speed/wait value below is transcribed from
 * boom202/PrBoom+ `p_spec.h` and `p_genlin.c` (`EV_DoGen*`), cross-checked
 * against boomref.txt. See docs/specials.md § Generalized linedefs.
 */
import { DOOM_TIC } from '../../constants.ts';
import { keySlotColor, type KeySlot } from '../inventory.ts';
import type {
  CeilingTarget,
  DoorMode,
  LiftTarget,
  LockRule,
  MoveTarget,
  SpecialDef,
  SurfaceChange,
} from './defs.ts';

// p_spec.h: the family bases. The generalized range is [GenCrusherBase, GenEnd).
const GEN_CRUSHER_BASE = 0x2f80;
const GEN_STAIRS_BASE = 0x3000;
const GEN_LIFT_BASE = 0x3400;
const GEN_LOCKED_BASE = 0x3800;
const GEN_DOOR_BASE = 0x3c00;
const GEN_CEILING_BASE = 0x4000;
const GEN_FLOOR_BASE = 0x6000;
const GEN_END = 0x8000;

/**
 * p_spec.h `StairDirection` — `EV_DoGenStairs` XORs it into the line's special on every successful
 * retrigger ({@link SpecialDef.retriggerXor}).
 */
const STAIR_DIRECTION_BIT = 0x0100;

export function isGeneralized(special: number): boolean {
  return special >= GEN_CRUSHER_BASE && special < GEN_END;
}

/**
 * The whole range, one pure function — memoized by `lookupSpecial`
 * (`tables.ts`), so decode allocates once per distinct number per session.
 */
export function decodeGeneralized(special: number): SpecialDef | null {
  if (!isGeneralized(special)) return null;
  if (special >= GEN_FLOOR_BASE) return genFloor(special);
  if (special >= GEN_CEILING_BASE) return genCeiling(special);
  if (special >= GEN_DOOR_BASE) return genDoor(special);
  if (special >= GEN_LOCKED_BASE) return genLockedDoor(special);
  if (special >= GEN_LIFT_BASE) return genLift(special);
  if (special >= GEN_STAIRS_BASE) return genStairs(special);
  return genCrusher(special);
}

/**
 * `p_spec.h: triggertype_e` (bits 0-2): WalkOnce, WalkMany, SwitchOnce,
 * SwitchMany, GunOnce, GunMany, PushOnce, PushMany — Push is a use press that
 * acts on the line's own back sector, i.e. {@link SpecialDef.manual}.
 */
function triggerBits(value: number): Pick<SpecialDef, 'trigger' | 'repeatable' | 'manual' | 'requiresTag'> {
  // Everything but the two Push kinds acts by tag, and Boom refuses those
  // outright when the tag is 0 (`requiresTag`).
  switch (value & 0x0007) {
    case 0:
      return { trigger: 'walk', repeatable: false, requiresTag: true };
    case 1:
      return { trigger: 'walk', repeatable: true, requiresTag: true };
    case 2:
      return { trigger: 'use', repeatable: false, requiresTag: true };
    case 3:
      return { trigger: 'use', repeatable: true, requiresTag: true };
    case 4:
      return { trigger: 'shoot', repeatable: false, requiresTag: true };
    case 5:
      return { trigger: 'shoot', repeatable: true, requiresTag: true };
    case 6:
      return { trigger: 'use', repeatable: false, manual: true };
    default:
      return { trigger: 'use', repeatable: true, manual: true };
  }
}

// Speed tiers (slow/normal/fast/turbo), in map units per second (vanilla
// speeds are per-tic at 35 tics/s):
/** `EV_DoGenDoor`/`EV_DoGenLockedDoor`: VDOORSPEED (2 u/tic) x 1/2/4/8. */
const DOOR_SPEEDS = [70, 140, 280, 560];
/** `EV_DoGenFloor`: FLOORSPEED (1 u/tic) x 1/2/4/8. */
const FLOOR_SPEEDS = [35, 70, 140, 280];
/** `EV_DoGenCeiling`/`EV_DoGenCrusher`: CEILSPEED (1 u/tic) x 1/2/4/8. */
const CEILING_SPEEDS = [35, 70, 140, 280];
/** `EV_DoGenLift`: PLATSPEED (1 u/tic) x 2/4/8/16. */
const LIFT_SPEEDS = [70, 140, 280, 560];
/** `EV_DoGenStairs`: FLOORSPEED x 1/4, 1/2, 2, 4. */
const STAIR_SPEEDS = [35 / 4, 35 / 2, 70, 140];

/** `EV_DoGenDoor`'s Dely: 35 tics, VDOORWAIT (150), 2x, 7x. */
const DOOR_WAITS = [35 * DOOM_TIC, 150 * DOOM_TIC, 300 * DOOM_TIC, 1050 * DOOM_TIC];
/** `EV_DoGenLift`'s Dely: 1, PLATWAIT (3), 5, 10 seconds. */
const LIFT_WAITS = [1, 3, 5, 10];
/** `EV_DoGenStairs`' Step field. */
const STAIR_STEPS = [4, 8, 16, 24];

/** Change field (bits 10-11 of floors/ceilings): FNoChg, FChgZero, FChgTxt, FChgTyp. */
function changeBits(chg: number, numericModel: boolean): SurfaceChange | undefined {
  if (chg === 0) return undefined;
  return {
    model: numericModel ? 'numeric' : 'trigger',
    type: chg === 1 ? 'texZeroType' : chg === 2 ? 'texOnly' : 'texAndType',
  };
}

/** `floortarget_e`, with the direction bit resolved where it matters. */
function floorTarget(targ: number, up: boolean): MoveTarget {
  switch (targ) {
    case 0: // FtoHnF
      return 'highestNeighborFloor';
    case 1: // FtoLnF
      return 'lowestNeighborFloor';
    case 2: // FtoNnF
      return up ? 'nextHigherFloor' : 'nextLowerFloor';
    case 3: // FtoLnC
      return 'lowestNeighborCeiling';
    case 4: // FtoC
      return 'ownCeiling';
    case 5: // FbyST
      return up ? 'shortestLowerTexture' : 'shortestLowerTextureDown';
    case 6: // Fby24
      return up ? 'plus24' : 'minus24';
    default: // Fby32
      return up ? 'plus32' : 'minus32';
  }
}

/** `ceilingtarget_e`, direction resolved the same way. */
function ceilingTarget(targ: number, up: boolean): CeilingTarget {
  switch (targ) {
    case 0: // CtoHnC
      return 'highestNeighborCeiling';
    case 1: // CtoLnC
      return 'lowestNeighborCeiling';
    case 2: // CtoNnC
      return up ? 'nextHigherCeiling' : 'nextLowerCeiling';
    case 3: // CtoHnF
      return 'highestNeighborFloor';
    case 4: // CtoF
      return 'ownFloor';
    case 5: // CbyST
      return up ? 'shortestUpperTexture' : 'shortestUpperTextureDown';
    case 6: // Cby24
      return up ? 'plus24' : 'minus24';
    default: // Cby32
      return up ? 'plus32' : 'minus32';
  }
}

/**
 * Boom gives generalized floors and ceilings the identical field layout
 * (`p_spec.h`: `Floor*`/`Ceiling*` masks are the same bits) — speed 3-4,
 * model 5, direction 6, target 7-9, change 10-11, crush 12. Only the speed
 * table, the target names and the effect kind differ between the two.
 */
function planeBits(v: number): { speedIx: number; model: boolean; up: boolean; targ: number; chg: number; crush: boolean } {
  return {
    speedIx: (v & 0x0018) >> 3,
    model: (v & 0x0020) !== 0,
    up: (v & 0x0040) !== 0,
    targ: (v & 0x0380) >> 7,
    chg: (v & 0x0c00) >> 10,
    crush: (v & 0x1000) !== 0,
  };
}

function genFloor(special: number): SpecialDef {
  const v = special - GEN_FLOOR_BASE;
  const { speedIx, model, up, targ, chg, crush } = planeBits(v);
  const speed = FLOOR_SPEEDS[speedIx];
  return {
    ...triggerBits(v),
    // With no change set, the model bit doubles as "allow monsters" —
    // p_spec.c's generalized gates on all three trigger paths.
    monsterActivate: chg === 0 && model,
    effect: {
      kind: 'floor',
      speed,
      target: floorTarget(targ, up),
      direction: up ? 'up' : 'down',
      changeTexture: false,
      crush,
      change: changeBits(chg, model),
    },
  };
}

function genCeiling(special: number): SpecialDef {
  const v = special - GEN_CEILING_BASE;
  const { speedIx, model, up, targ, chg, crush } = planeBits(v);
  const speed = CEILING_SPEEDS[speedIx];
  return {
    ...triggerBits(v),
    monsterActivate: chg === 0 && model,
    effect: {
      kind: 'ceiling',
      speed,
      target: ceilingTarget(targ, up),
      direction: up ? 'up' : 'down',
      crush,
      change: changeBits(chg, model),
    },
  };
}

/** `doorkind_e`: OdCDoor, ODoor, CdODoor, CDoor. */
const DOOR_KINDS: DoorMode[] = ['openClose', 'openOnly', 'closeThenOpen', 'closeOnly'];

function genDoor(special: number): SpecialDef {
  const v = special - GEN_DOOR_BASE;
  const speed = DOOR_SPEEDS[(v & 0x0018) >> 3];
  const kind = DOOR_KINDS[(v & 0x0060) >> 5];
  const monster = (v & 0x0080) !== 0;
  const wait = DOOR_WAITS[(v & 0x0300) >> 8];
  return {
    ...triggerBits(v),
    monsterActivate: monster,
    effect: {
      kind: 'door',
      speed,
      waitSeconds: wait,
      mode: kind,
      // A generalized CdO door waits its own delay field shut, not vanilla
      // 16/76's hardcoded 30 seconds.
      closeWaitSeconds: kind === 'closeThenOpen' ? wait : undefined,
    },
  };
}

/**
 * `keykind_e` 1-6 (RCard..YSkull); its 0 (AnyKey) and 7 (AllKeys) name no slot and are handled
 * separately.
 */
const SLOT_BY_KEYKIND: KeySlot[] = ['redCard', 'blueCard', 'yellowCard', 'redSkull', 'blueSkull', 'yellowSkull'];

function genLockedDoor(special: number): SpecialDef {
  const v = special - GEN_LOCKED_BASE;
  const speed = DOOR_SPEEDS[(v & 0x0018) >> 3];
  const openOnly = (v & 0x0020) !== 0; // LockedKind: genRaise vs genOpen
  const keyKind = (v & 0x01c0) >> 6;
  // LockedNKeys is Boom's "skulls are cards" bit despite the name —
  // `P_CanUnlockGenDoor` reads it as `skulliscard`.
  const skullIsCard = (v & 0x0200) !== 0;
  const lock: LockRule =
    keyKind === 0
      ? { kind: 'any' }
      : keyKind === 7
        ? { kind: 'all', colorsSuffice: skullIsCard }
        : skullIsCard
          ? { kind: 'color', color: keySlotColor(SLOT_BY_KEYKIND[keyKind - 1]) }
          : { kind: 'slot', slot: SLOT_BY_KEYKIND[keyKind - 1] };
  return {
    ...triggerBits(v),
    // `EV_DoGenLockedDoor` is never reachable by a monster: the generalized
    // gates on all three trigger paths skip the locked range for non-players.
    lock,
    effect: {
      kind: 'door',
      speed,
      waitSeconds: 150 * DOOM_TIC, // fixed VDOORWAIT, no delay field
      mode: openOnly ? 'openOnly' : 'openClose',
    },
  };
}

/** `lifttarget_e`: F2LnF, F2NnF, F2LnC, LnF2HnF. */
const LIFT_TARGETS: LiftTarget[] = ['lowestNeighborFloor', 'nextLowerFloor', 'lowestNeighborCeiling', 'perpetual'];

function genLift(special: number): SpecialDef {
  const v = special - GEN_LIFT_BASE;
  return {
    ...triggerBits(v),
    monsterActivate: (v & 0x0020) !== 0,
    effect: {
      kind: 'lift',
      speed: LIFT_SPEEDS[(v & 0x0018) >> 3],
      waitSeconds: LIFT_WAITS[(v & 0x00c0) >> 6],
      target: LIFT_TARGETS[(v & 0x0300) >> 8],
    },
  };
}

function genStairs(special: number): SpecialDef {
  const v = special - GEN_STAIRS_BASE;
  return {
    ...triggerBits(v),
    monsterActivate: (v & 0x0020) !== 0,
    retriggerXor: STAIR_DIRECTION_BIT,
    effect: {
      kind: 'stairs',
      speed: STAIR_SPEEDS[(v & 0x0018) >> 3],
      stepHeight: STAIR_STEPS[(v & 0x00c0) >> 6],
      direction: (v & STAIR_DIRECTION_BIT) !== 0 ? 'up' : 'down',
      ignoreTexture: (v & 0x0200) !== 0,
    },
  };
}

function genCrusher(special: number): SpecialDef {
  const v = special - GEN_CRUSHER_BASE;
  const speedIx = (v & 0x0018) >> 3;
  const silent = (v & 0x0040) !== 0;
  return {
    ...triggerBits(v),
    monsterActivate: (v & 0x0020) !== 0,
    effect: {
      kind: 'crusher',
      speed: CEILING_SPEEDS[speedIx],
      silent,
      // T_MoveCeiling slows a grinding gen crusher only when
      // `oldspeed < CEILSPEED*3` — the slow and normal tiers.
      slowsWhenCrushing: speedIx <= 1,
      noEndClack: silent ? true : undefined,
    },
  };
}
