import type { DoomMap } from '../wad/map.ts';
import type { Pos3 } from '../types.ts';
import type { World } from './world.ts';
import { hasPower, type Inventory } from './inventory.ts';
import {
  DAMAGE_FLOOR_INTERVAL,
  SECTOR_DAMAGE_SPECIALS,
  SUIT_LEAK_CHANCE,
  type DamageFloorEffect,
} from '../wad/specials.ts';

/**
 * Vanilla's `P_PlayerInSpecialSector` — the sector specials that need no mover
 * at all, just `sector.special` and where the player is standing: damage
 * floors and the secret counter. Player-only, matching vanilla. See
 * docs/specials.md § Damage floors and § Secret sectors.
 */
export class SectorEffects {
  /** Vanilla `totalsecret` — sectors with `special === 9`, counted once per level load. */
  readonly totalSecrets: number;
  /** Vanilla `player->secretcount`. */
  secretsFound = 0;
  /**
   * Counts down to the next damage-floor tick while the player stands on one.
   * Reset (not merely paused) whenever they aren't, so re-entering a hazard
   * always gives the same brief grace period rather than resuming mid-countdown
   * from a stale visit.
   */
  private timer = DAMAGE_FLOOR_INTERVAL;

  constructor(map: DoomMap) {
    // Vanilla P_SpawnSpecials' own `case 9: totalsecret++`.
    let secrets = 0;
    for (const sector of map.sectors) if (sector.special === 9) secrets++;
    this.totalSecrets = secrets;
  }

  /**
   * Runs this frame's specials for the sector the player is standing in and
   * reports whether one of them ends the level (a `exitBelowHealth` floor).
   * Gated on `player.z === sector.floorHeight` (vanilla's `mo->z != floorheight`),
   * read off the local sector rather than `World.groundFloor`.
   */
  update(dt: number, world: World, player: Pos3, inv: Inventory, damage: (amount: number) => void): boolean {
    const sector = world.sectorAt(player.x, player.y);
    if (!sector || player.z !== sector.floorHeight) {
      this.timer = DAMAGE_FLOOR_INTERVAL;
      return false;
    }
    if (sector.special === 9) {
      // Vanilla's `case 9: player->secretcount++; sector->special = 0;` — clearing it here means
      // the lookup below never matches 9 again, so this can't double-count on a later frame.
      this.secretsFound++;
      sector.special = 0;
    }
    const effect = SECTOR_DAMAGE_SPECIALS[sector.special];
    if (!effect) {
      this.timer = DAMAGE_FLOOR_INTERVAL;
      return false;
    }
    this.timer -= dt;
    if (this.timer > 0) return false;
    // The interval keeps running even when a suit blocks the hit, matching
    // vanilla's own global `leveltime&0x1f` clock: the suit skips the damage,
    // it doesn't bank it up for the moment it expires.
    this.timer += DAMAGE_FLOOR_INTERVAL;
    if (suitBlocks(effect, inv)) return false;
    damage(effect.amount);
    return effect.exitBelowHealth !== undefined && inv.health > 0 && inv.health <= effect.exitBelowHealth;
  }
}

/** Whether a worn radiation suit stops this damage floor's hit — see `DamageFloorEffect.suit` for why the three types differ. */
function suitBlocks(effect: DamageFloorEffect, inv: Inventory): boolean {
  if (effect.suit === 'ignored' || !hasPower(inv, 'radiationSuit')) return false;
  return effect.suit === 'blocks' || Math.random() >= SUIT_LEAK_CHANCE;
}
