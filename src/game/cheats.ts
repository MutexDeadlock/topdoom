/**
 * The three typed cheat codes — IDDQD, IDKFA, IDCLIP — the rolling buffer that spots one and the
 * two toggles they leave behind. `game.ts` feeds it whatever was typed this tic and acts on what
 * comes back. See docs/cheats.md.
 */
import { AMMO_TYPES, KEY_SLOTS, ammoMax, inventoryLimit, type Inventory } from './inventory.ts';
import { WEAPON_ORDER } from './dehacked/tables.ts';
import type { CheatSnapshot } from './snapshot.ts';

/**
 * `st_stuff.c`'s own responses, in `d_englsh.h`'s wording and keyed by its mnemonic so a DEH/BEX
 * patch can replace one by name — the shape `specials/tables.ts`'s `LOCKED_LINES` has, and for the
 * same reason (docs/dehacked.md § Cheat responses). Only the five this engine can raise: the other
 * `STSTR_*` strings belong to cheats it doesn't have.
 */
export const CHEAT_MESSAGES: Record<string, string> = {
  STSTR_DQDON: 'Degreelessness Mode On',
  STSTR_DQDOFF: 'Degreelessness Mode Off',
  STSTR_KFAADDED: 'Very Happy Ammo Added',
  STSTR_NCON: 'No Clipping Mode ON',
  STSTR_NCOFF: 'No Clipping Mode OFF',
};

/** Which cheat one code fires. */
export type CheatId = 'god' | 'ammoKeys' | 'noclip';

/**
 * The codes, `st_stuff.c`'s `cheat_*_seq[]` tables descrambled. Both noclip spellings are live at
 * once whatever the IWAD is, which is vanilla's own behavior and not a convenience: `ST_Responder`
 * tests `cheat_noclip` (`idspispopd`) and `cheat_commercial_noclip` (`idclip`) in one condition,
 * over the comment "Simplified, accepting both".
 */
const CHEAT_CODES: readonly (readonly [string, CheatId])[] = [
  ['iddqd', 'god'],
  ['idkfa', 'ammoKeys'],
  ['idclip', 'noclip'],
  ['idspispopd', 'noclip'],
];

const LONGEST_CODE = Math.max(...CHEAT_CODES.map(([code]) => code.length));

/**
 * Whether the tail of `buffer` is the beginning of `code` — the buffer carries whatever junk was
 * typed before a code was started, so it is its *suffixes* that are candidate prefixes.
 */
function startsPartway(code: string, buffer: string): boolean {
  for (let n = Math.min(buffer.length, code.length - 1); n > 0; n--) {
    if (code.startsWith(buffer.slice(-n))) return true;
  }
  return false;
}

/**
 * What the player has typed lately, and the two cheats that stay switched on once typed. Owned by
 * `Game` for the session rather than per level: vanilla keeps them in `player_t`, which an ordinary
 * level exit doesn't clear.
 */
export class Cheats {
  /** Damage is refused outright — vanilla's `CF_GODMODE`, read by `game.ts: damagePlayer`. */
  god = false;
  /**
   * Walls and things stop blocking — vanilla's `MF_NOCLIP`, pushed onto `Player.noclip` at the top
   * of every tic, which is what every reader goes through.
   */
  noclip = false;
  private buffer = '';

  /** Whether any cheat is on at all — what a save bothers to record. */
  get active(): boolean {
    return this.god || this.noclip;
  }

  /**
   * Whether what has been typed so far is the beginning of a code. Derived from the buffer rather
   * than latched alongside it, so no edit to `type` can leave the two disagreeing. `game.ts` reads
   * it to keep a letter of one from also firing a bound key — the DEVMODE map jump `P` sits inside
   * `idclip`. docs/cheats.md § Typing a code.
   */
  get typing(): boolean {
    return CHEAT_CODES.some(([code]) => startsPartway(code, this.buffer));
  }

  /**
   * Takes the characters typed since the last tic and fires whatever code they completed, returning
   * the response line to show (or null for a tic that completed none).
   *
   * The match is a rolling suffix rather than vanilla's per-cheat cursor, which resets to the start
   * of its sequence on any mismatched key and swallows the mismatched character with it — so
   * vanilla misses `iiddqd` where this catches it. Strictly more forgiving, and it can't recognise
   * anything vanilla wouldn't.
   */
  type(typed: string, inv: Inventory): string | null {
    let message: string | null = null;
    for (const char of typed) {
      this.buffer = (this.buffer + char).slice(-LONGEST_CODE);
      const fired = CHEAT_CODES.find(([code]) => this.buffer.endsWith(code));
      if (fired) {
        // Cleared so the tail of one code can't stand in for the head of the next.
        this.buffer = '';
        message = this.fire(fired[1], inv);
      }
    }
    return message;
  }

  /** One cheat's effect, `ST_Responder`'s own block per code. */
  private fire(id: CheatId, inv: Inventory): string {
    switch (id) {
      case 'god':
        this.god = !this.god;
        if (!this.god) return CHEAT_MESSAGES.STSTR_DQDOFF;
        // `st_stuff.c`'s literal 100, which is a `Misc` row of its own (`God Mode Health`) and so
        // is read through the limits rather than from the start health a patch may also have moved.
        inv.health = inventoryLimit('godModeHealth');
        return CHEAT_MESSAGES.STSTR_DQDON;
      case 'ammoKeys':
        // Vanilla's `armorpoints = 200` / `armortype = 2`, both `Misc` rows (`IDKFA Armor`,
        // `IDKFA Armor Class`) and both independent of what a real armor pickup is worth.
        inv.armor = inventoryLimit('idkfaArmor');
        inv.armorType = inventoryLimit('idkfaArmorClass') as 0 | 1 | 2;
        // Every weapon and every key, exactly as vanilla's own loops run them: `NUMWEAPONS` and
        // `NUMCARDS` are the whole rosters, so DOOM 1 hands over the super shotgun too.
        for (const weapon of WEAPON_ORDER) inv.weapons.add(weapon);
        for (const type of AMMO_TYPES) inv.ammo[type] = ammoMax(inv, type);
        for (const slot of KEY_SLOTS) inv.keys.add(slot);
        return CHEAT_MESSAGES.STSTR_KFAADDED;
      case 'noclip':
        this.noclip = !this.noclip;
        return this.noclip ? CHEAT_MESSAGES.STSTR_NCON : CHEAT_MESSAGES.STSTR_NCOFF;
    }
  }

  snapshot(): CheatSnapshot {
    return { god: this.god, noclip: this.noclip };
  }

  /**
   * A save from before cheats existed — or one taken with none on — carries nothing, and means both
   * off.
   */
  restore(saved?: CheatSnapshot): void {
    this.god = saved?.god ?? false;
    this.noclip = saved?.noclip ?? false;
  }
}
