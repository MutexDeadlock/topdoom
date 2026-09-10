/**
 * The four typed cheat codes — IDDQD, IDKFA, IDCLIP, IDCLEV — the rolling buffer that spots one,
 * the two toggles they leave behind and the level IDCLEV asks for. `game.ts` feeds it whatever was
 * typed this tic and acts on what comes back. See docs/cheats.md.
 */
import { AMMO_TYPES, KEY_SLOTS, ammoMax, inventoryLimit, type Inventory, type WeaponId } from './inventory.ts';
import { WEAPON_ORDER } from './dehacked/tables.ts';
import type { GameMode } from '../wad/campaign/gamemode.ts';
import type { CheatSnapshot } from './snapshot.ts';

/**
 * `st_stuff.c`'s own responses, in `d_englsh.h`'s wording and keyed by its mnemonic so a DEH/BEX
 * patch can replace one by name — the shape `specials/tables.ts`'s `LOCKED_LINES` has, and for the
 * same reason (docs/dehacked.md § Cheat responses). Only the five this engine can raise: the other
 * `STSTR_*` strings belong to cheats it doesn't have, and to IDCLEV, which prints nothing
 * (docs/cheats.md § IDCLEV).
 */
export const CHEAT_MESSAGES: Record<string, string> = {
  STSTR_DQDON: 'Degreelessness Mode On',
  STSTR_DQDOFF: 'Degreelessness Mode Off',
  STSTR_KFAADDED: 'Very Happy Ammo Added',
  STSTR_NCON: 'No Clipping Mode ON',
  STSTR_NCOFF: 'No Clipping Mode OFF',
};

/** Which cheat one code fires. */
type CheatId = 'god' | 'ammoKeys' | 'noclip' | 'levelWarp';

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
  ['idclev', 'levelWarp'],
];

const LONGEST_CODE = Math.max(...CHEAT_CODES.map(([code]) => code.length));

/**
 * The characters IDCLEV takes after its code — `cheat_clev_seq`'s two parameter slots, which
 * `cht_GetParam` fills with whatever keys follow, digits or not.
 */
const WARP_PARAMS = 2;

/** Which of the two spellings IDCLEV tries first — vanilla's `gamemode == commercial`. */
const COMMERCIAL_MAP = /^MAP\d\d$/;

/**
 * The weapons IDKFA withholds per game mode: the ones vanilla owns but can never select there.
 * prboom-plus' `WeaponSelectable` is the list — "Can't select the super shotgun in Doom 1"
 * (`gamemission == doom`), and no plasma rifle or BFG under `gamemode == shareware`.
 * docs/cheats.md § IDKFA.
 */
const WITHHELD_WEAPONS: Record<GameMode, readonly WeaponId[]> = {
  shareware: ['supershotgun', 'plasmaRifle', 'bfg'],
  registered: ['supershotgun'],
  commercial: [],
};

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
  /**
   * Whether any code has fired this session — including IDKFA, which leaves no toggle behind. It
   * is what keeps a cheated session from claiming best times on the levels after the one it was
   * typed on, where the toggles alone would forget an IDKFA (docs/cheats.md § Saves and best
   * times). Never cleared: a session that cheated has cheated.
   */
  used = false;
  private buffer = '';
  /**
   * The characters typed since IDCLEV matched, until there are `WARP_PARAMS` of them; null when no
   * code is waiting for its parameters. They do not reach `buffer`, the way `cht_GetParam` consumes
   * the keys it collects.
   */
  private params: string | null = null;
  /** A completed IDCLEV's two characters, until `takeWarp` reads them. */
  private warp: string | null = null;

  /** Whether any cheat is on at all. */
  get active(): boolean {
    return this.god || this.noclip;
  }

  /**
   * Whether what has been typed so far is the beginning of a code. Derived from the buffer rather
   * than latched alongside it, so no edit to `type` can leave the two disagreeing. `game.ts` reads
   * it to refuse a save or a keyframe over a half-typed code, which no snapshot carries.
   * IDCLEV waiting for its two characters counts: they are buffer state as much as the code is.
   * docs/cheats.md § Typing a code.
   */
  get typing(): boolean {
    if (this.params !== null) return true;
    return CHEAT_CODES.some(([code]) => startsPartway(code, this.buffer));
  }

  /**
   * Takes the characters typed since the last tic and fires whatever code they completed, returning
   * the response line to show (or null for a tic that completed none). `mode` is the loaded set's
   * own (`wad/campaign/gamemode.ts`): IDKFA's weapon roster reads it.
   *
   * The match is a rolling suffix rather than vanilla's per-cheat cursor, which resets to the start
   * of its sequence on any mismatched key and swallows the mismatched character with it — so
   * vanilla misses `iiddqd` where this catches it. Strictly more forgiving, and it can't recognise
   * anything vanilla wouldn't.
   *
   * IDCLEV completes no effect and no line of its own: the two characters after it are swallowed
   * as parameters (`cht_GetParam`) and left for `takeWarp`, whatever they are.
   */
  type(typed: string, inv: Inventory, mode: GameMode): string | null {
    let message: string | null = null;
    for (const char of typed) {
      if (this.params !== null) {
        this.params += char;
        if (this.params.length < WARP_PARAMS) continue;
        this.warp = this.params;
        this.params = null;
        continue;
      }
      this.buffer = (this.buffer + char).slice(-LONGEST_CODE);
      const fired = CHEAT_CODES.find(([code]) => this.buffer.endsWith(code));
      if (fired) {
        // Cleared so the tail of one code can't stand in for the head of the next.
        this.buffer = '';
        const [, id] = fired;
        // IDCLEV fires nothing yet, and is not `used` until the level it names turns out to exist:
        // `ST_Responder` returns before it changes anything for a map that doesn't.
        if (id === 'levelWarp') {
          this.params = '';
          continue;
        }
        this.used = true;
        message = this.fire(id, inv, mode);
      }
    }
    return message;
  }

  /**
   * The two characters IDCLEV took after its code, once both are typed — cleared by the read, so
   * one code changes level once. Null on every other tic. Which levels exist is not this module's
   * to know, so resolving them to a map is the caller's. docs/cheats.md § IDCLEV.
   */
  takeWarp(): string | null {
    const warp = this.warp;
    this.warp = null;
    return warp;
  }

  /**
   * The warp is happening: the code counts as used, and the toggles go — `G_DeferedInitNew` puts
   * every player in `PST_REBORN`, and `G_PlayerReborn`'s memset takes `player_t.cheats` with it.
   * `used` outlives that memset here, being this engine's own record that the run cheated
   * (docs/cheats.md § Saves and best times).
   */
  warped(): void {
    this.used = true;
    this.reborn();
  }

  /**
   * A coop respawn: `G_PlayerReborn`'s memset takes the toggles, as a warp's does, and `used` stays
   * — the run cheated all the same. docs/multiplayer-coop.md § Respawn.
   */
  reborn(): void {
    this.god = false;
    this.noclip = false;
  }

  snapshot(): CheatSnapshot {
    return { god: this.god, noclip: this.noclip };
  }

  /**
   * A save taken by a session that never typed a code carries nothing, and means both off and
   * nothing cheated. A block being there at all is what says a code
   * fired: it is only written for a session that used one. docs/cheats.md § Saves and best times.
   */
  restore(saved?: CheatSnapshot): void {
    this.god = saved?.god ?? false;
    this.noclip = saved?.noclip ?? false;
    this.used = saved !== undefined;
  }

  /** One cheat's effect, `ST_Responder`'s own block per code — IDCLEV's is the caller's. */
  private fire(id: Exclude<CheatId, 'levelWarp'>, inv: Inventory, mode: GameMode): string {
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
        // Every weapon and every key, as vanilla's own loops run them — `NUMWEAPONS` and
        // `NUMCARDS` are the whole rosters — less what this mode could never select
        // (docs/cheats.md § IDKFA).
        for (const weapon of WEAPON_ORDER) {
          if (!WITHHELD_WEAPONS[mode].includes(weapon)) inv.weapons.add(weapon);
        }
        for (const type of AMMO_TYPES) inv.ammo[type] = ammoMax(inv, type);
        for (const slot of KEY_SLOTS) inv.keys.add(slot);
        return CHEAT_MESSAGES.STSTR_KFAADDED;
      case 'noclip':
        this.noclip = !this.noclip;
        return this.noclip ? CHEAT_MESSAGES.STSTR_NCON : CHEAT_MESSAGES.STSTR_NCOFF;
    }
  }
}

/**
 * The map names IDCLEV's two characters could mean, best first. Vanilla picks the spelling from
 * `gamemode` — `ExMy` outside DOOM 2, `MAPxx` in it — and the loaded set's own current map is what
 * says which this is; the other spelling is still tried, so a set that names its maps the other way
 * round is reachable at all. Neither is checked for being digits: a pair that spells no map name
 * simply finds none, which is what vanilla's range tests come to.
 * docs/cheats.md § IDCLEV.
 */
export function warpTargets(warp: string, current: string): [string, string] {
  const episode = `E${warp[0]}M${warp[1]}`;
  const commercial = `MAP${warp}`;
  return COMMERCIAL_MAP.test(current) ? [commercial, episode] : [episode, commercial];
}

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
