/**
 * What standing in a sector does to the player: damage floors (with the radiation suit's leak
 * roll) and the secret-found tally. See docs/specials.md § Damage floors and § Secret sectors.
 */
import type { DoomMap } from '../../wad/map.ts';
import type { Pos2, Pos3 } from '../../types.ts';
import type { World } from '../world.ts';
import { hasPower, type Inventory } from '../inventory.ts';
import { DAMAGE_FLOOR_INTERVAL, SUIT_LEAK_CHANCE } from './tables.ts';
import { consumeSecret, decodeSectorType } from './sectortypes.ts';
import type { DamageFloorEffect } from './defs.ts';
import { pRandom } from '../../util/random.ts';
import type { SectorEffectsSnapshot } from '../snapshot.ts';

/** What one frame's `SectorEffects.update` did, for the caller to realize (sound, message, level exit). */
export interface SectorEffectResult {
  /** The player is standing on an `exitBelowHealth` floor at or below its threshold, dead or alive — end the level. */
  exit: boolean;
  /** The player just entered a secret sector, on that single frame only (`sector.special` is cleared with it). */
  secretFound: boolean;
}

/**
 * The sector specials that need no mover at all, just `sector.special` and
 * where the player is standing: damage floors and the secret counter
 * (vanilla's `P_PlayerInSpecialSector`). Runs for the **console player only**,
 * so a voodoo doll parked on a damage floor costs nothing. See
 * docs/specials.md § Damage floors, § Secret sectors and § Voodoo dolls.
 */
export class SectorEffects {
  /** Secret sectors on the map (special 9 or the Boom secret bit), counted once per level load. */
  readonly totalSecrets: number;
  /** How many of `totalSecrets` the player has entered so far — the HUD's and the intermission's tally. */
  secretsFound = 0;
  /**
   * Counts down to the next damage-floor tick while the player stands on one.
   * Reset (not merely paused) whenever they aren't, so re-entering a hazard
   * always gives the same brief grace period rather than resuming mid-countdown
   * from a stale visit.
   */
  private timer = DAMAGE_FLOOR_INTERVAL;

  constructor(map: DoomMap) {
    let secrets = 0;
    for (const sector of map.sectors) if (decodeSectorType(sector.special).secret) secrets++;
    this.totalSecrets = secrets;
  }

  /**
   * Savegame restore. `totalSecrets` stays whatever this instance counted from
   * the freshly loaded map — which is why a restoring `loadMapByIndex`
   * constructs this *before* applying the saved sector specials (a consumed
   * secret zeroes its sector's `special`) — docs/savegames.md § Apply order.
   */
  restore(s: SectorEffectsSnapshot): void {
    this.secretsFound = s.secretsFound;
    this.timer = s.timer;
  }

  /** The counterpart snapshot — docs/savegames.md § What is saved and what is deliberately not. */
  snapshot(): SectorEffectsSnapshot {
    return { secretsFound: this.secretsFound, timer: this.timer };
  }

  /**
   * Whether dying at this point ends the level: the sector there is an `exitBelowHealth` floor,
   * E1M8's sector 66 and nothing else in stock DOOM. A deliberate deviation — vanilla checks this
   * only from `P_PlayerInSpecialSector`, which `P_PlayerThink` skips for a dead player, so a
   * monster killing the player in the pit leaves them dead in it with the episode unfinished.
   * Deliberately not gated on `player.z`, unlike the damage above: the sector's whole purpose is
   * the ending, whether or not the corpse had landed. docs/specials.md § Damage floors.
   */
  exitsOnDeath(world: World, at: Pos2): boolean {
    const sector = world.sectorAt(at.x, at.y);
    return sector ? decodeSectorType(sector.special).damage?.exitBelowHealth !== undefined : false;
  }

  /**
   * Runs this frame's specials for the sector the player is standing in and reports what they did
   * — a secret being entered, and whether one of them ends the level (an `exitBelowHealth` floor).
   * Gated on `player.z === sector.floorHeight` (vanilla's `mo->z != floorheight`),
   * read off the local sector rather than `World.groundFloor`.
   */
  update(
    dt: number,
    world: World,
    player: Pos3,
    inv: Inventory,
    damage: (amount: number) => void,
  ): SectorEffectResult {
    const sector = world.sectorAt(player.x, player.y);
    if (!sector || player.z !== sector.floorHeight) {
      this.timer = DAMAGE_FLOOR_INTERVAL;
      return { exit: false, secretFound: false };
    }
    let secretFound = false;
    let decoded = decodeSectorType(sector.special);
    if (decoded.secret) {
      // Clearing the special here is what stops a later frame double-counting the same secret:
      // the re-decode below no longer reports it. `consumeSecret` clears only the Boom bit.
      this.secretsFound++;
      sector.special = consumeSecret(sector.special);
      decoded = decodeSectorType(sector.special);
      secretFound = true;
    }
    const effect = decoded.damage;
    if (!effect) {
      this.timer = DAMAGE_FLOOR_INTERVAL;
      return { exit: false, secretFound };
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      // The interval keeps running even when a suit blocks the hit, matching
      // vanilla's own global `leveltime&0x1f` clock: the suit skips the damage,
      // it doesn't bank it up for the moment it expires.
      this.timer += DAMAGE_FLOOR_INTERVAL;
      if (!suitBlocks(effect, inv)) damage(effect.amount);
    }
    // Tested every frame the player stands here and at any health down to 0, *outside* the damage
    // pulse above — both are load-bearing on E1M8's sector 66. docs/specials.md § Damage floors.
    const exit = effect.exitBelowHealth !== undefined && inv.health <= effect.exitBelowHealth;
    return { exit, secretFound };
  }
}

/** Whether a worn radiation suit stops this damage floor's hit — see `DamageFloorEffect.suit` for why the three types differ. */
function suitBlocks(effect: DamageFloorEffect, inv: Inventory): boolean {
  if (effect.suit === 'ignored' || !hasPower(inv, 'radiationSuit')) return false;
  // `P_PlayerInSpecialSector`'s `P_Random() < 5`, and `SUIT_LEAK_CHANCE` is that 5 over 256.
  return effect.suit === 'blocks' || pRandom() >= SUIT_LEAK_CHANCE * 256;
}
