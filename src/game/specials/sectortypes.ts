/**
 * One decoder in front of every `Sector.special` interpretation: vanilla numbers
 * (< 32) hit the exact-equality tables unchanged, Boom's generalized sector
 * types (>= 32) are a bitfield — lighting in bits 0-4, damage in 5-6, secret at
 * 7, friction at 8, push at 9. See docs/specials.md § Generalized sector types.
 */
import { SECTOR_DAMAGE_SPECIALS, SECTOR_DOOR_SPECIALS, SECTOR_LIGHT_SPECIALS } from './tables.ts';
import type { DamageFloorEffect, LightPattern, SectorDoorTimer } from './defs.ts';

// Boom p_spec.h: the generalized sector-type bit layout.
const SECTOR_DAMAGE_MASK = 0x60;
const SECTOR_DAMAGE_SHIFT = 5;
const SECTOR_SECRET_MASK = 0x80;
const SECTOR_FRICTION_MASK = 0x100;
const SECTOR_PUSH_MASK = 0x200;

/**
 * `P_PlayerInSpecialSector`'s generalized damage classes: 0 none, then the
 * exact vanilla 5/10/20 tiers — only the 20 tier rolls the suit leak, same as
 * vanilla 16/4 (`pr_slimehurt` in Boom's own source).
 */
const GENERALIZED_DAMAGE: (DamageFloorEffect | null)[] = [
  null,
  { amount: 5, suit: 'blocks' },
  { amount: 10, suit: 'blocks' },
  { amount: 20, suit: 'leaks' },
];

/**
 * Whether the decoder recognized anything at all in a sector's special — the sector half of the
 * coverage gate.
 */
export function sectorTypeUnderstood(d: DecodedSectorType): boolean {
  return d.lightPattern !== null || d.damage !== null || d.secret || d.friction || d.push || d.doorTimer !== null;
}

export interface DecodedSectorType {
  lightPattern: LightPattern | null;
  damage: DamageFloorEffect | null;
  /** Consuming it differs by era — see `consumeSecret`. */
  secret: boolean;
  /** Boom sector friction enable — gates `Forces.frictionUnder` (docs/specials-forces.md §
  Friction). */ friction: boolean;
  /** Boom sector pusher enable — gates `Forces.pushForBody` (docs/specials-forces.md § Pushers). */
  push: boolean;
  doorTimer: SectorDoorTimer | null;
}

export function decodeSectorType(special: number): DecodedSectorType {
  if (special < 32) {
    return {
      lightPattern: SECTOR_LIGHT_SPECIALS[special] ?? null,
      damage: SECTOR_DAMAGE_SPECIALS[special] ?? null,
      secret: special === 9,
      friction: false,
      push: false,
      doorTimer: SECTOR_DOOR_SPECIALS[special] ?? null,
    };
  }
  // Boom runs the vanilla spawn switch on `special & 31` (`P_SpawnSpecials`),
  // so a generalized sector's low bits carry the vanilla light behaviors and
  // even the 10/14 door timers.
  const base = special & 31;
  return {
    lightPattern: SECTOR_LIGHT_SPECIALS[base] ?? null,
    damage: GENERALIZED_DAMAGE[(special & SECTOR_DAMAGE_MASK) >> SECTOR_DAMAGE_SHIFT],
    secret: (special & SECTOR_SECRET_MASK) !== 0,
    friction: (special & SECTOR_FRICTION_MASK) !== 0,
    push: (special & SECTOR_PUSH_MASK) !== 0,
    doorTimer: SECTOR_DOOR_SPECIALS[base] ?? null,
  };
}

/**
 * The special's value after its secret is collected: vanilla 9 zeroes the
 * whole special; the generalized bit clears just itself — and if nothing but
 * low bits remain, Boom zeroes it too ("sector is not special anymore",
 * `P_PlayerInSpecialSector`).
 */
export function consumeSecret(special: number): number {
  if (special < 32) return 0;
  const rest = special & ~SECTOR_SECRET_MASK;
  return rest < 32 ? 0 : rest;
}
