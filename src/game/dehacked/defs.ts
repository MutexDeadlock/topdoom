/**
 * The record shapes a parsed DEHACKED patch is carried in, and the vocabulary its coverage report
 * speaks: what a patch asked for, and how far each of those asks got. See docs/dehacked.md.
 */

/**
 * How far one DEHACKED record or field got.
 *
 * The distinction that matters is `noTarget` against `unsupported`: the first means the patch asked
 * for something this engine simply doesn't have (a finale screen, a pickup message), the second
 * means it asked for something deliberately left out of scope even though a target exists or could
 * (frames, sprite renames, re-keying a thing's doomednum). Both keep playing; only the second is
 * ever worth revisiting. `unknown` is neither — the parser didn't recognise the text at all.
 */
export type DehSupport = 'applied' | 'noTarget' | 'unsupported' | 'unknown';

/**
 * What a `DehWarning` can carry. A warning is raised only where a field did *not* fully land, so
 * `applied` is excluded at the type rather than filtered for at each reader.
 */
export type DehShortfall = Exclude<DehSupport, 'applied'>;

/** The record kinds a patch is built from — vanilla's own headers plus BEX's bracketed sections. */
export type DehRecordKind =
  | 'thing'
  | 'weapon'
  | 'ammo'
  | 'misc'
  | 'sound'
  | 'music'
  | 'sprite'
  | 'frame'
  | 'pointer'
  | 'cheat'
  | 'text'
  | 'strings'
  | 'pars'
  | 'codeptr'
  | 'helper'
  | 'header';

/**
 * One thing a patch asked for that didn't fully land, already deduped. `count` is why: freedoom2's
 * DEHACKED carries seven `Frame` records and five `Sprite` records, and a report that printed one
 * line each would bury the two facts worth knowing under twelve rows.
 */
export interface DehWarning {
  /** The record as the patch spelled it, minus its index: `Thing`, `[CODEPTR]`. */
  record: string;
  /** The field inside it, where the record itself was understood but one of its lines wasn't. */
  field?: string;
  support: DehShortfall;
  /** One sentence a reader can act on, naming what was skipped rather than restating the class. */
  detail: string;
  /** How many times this exact `(record, field)` pair occurred. */
  count: number;
}

/** One `Thing N` record's patchable fields, already unit-converted into this engine's terms. */
export interface DehThingEdit {
  /** 1-based `Thing` index as the patch wrote it, for reports. The applier re-derives the
   * `MOBJ_INFO` row from it, so the row's own fields are not copied in here. */
  index: number;
  health?: number;
  /** Map units per second, already through the walker/missile unit rules (docs/dehacked.md § Units). */
  speed?: number;
  radius?: number;
  height?: number;
  mass?: number;
  /** `mobjinfo.damage`, the multiplier on `PIT_CheckThing`'s `((P_Random()%8)+1)` roll. */
  damage?: number;
  /** 0..1, vanilla's `painchance` over 256. */
  painChance?: number;
  /**
   * The full replacement `mobjinfo.flags` mask, or undefined where the record set no `Bits` line.
   * A `Bits` value replaces the whole mask rather than adding to it, so the difference between
   * "absent" and "zero" is load-bearing — docs/dehacked.md § Bits.
   */
  bits?: number;
  /**
   * The sound fields, already resolved through `SFX_ORDER`. A key present with `null` means the
   * patch asked for silence (`sfx_None`, index 0) and the field is deleted rather than set.
   */
  sounds?: Partial<Record<'see' | 'attack' | 'pain' | 'death' | 'active', string | null>>;
}

/** One `Ammo N` record's two fields, `d_deh.c`'s `deh_ammo[]`. */
export interface DehAmmoEdit {
  /** 0-based `ammotype_t`: slot 2 is cells and slot 3 is rockets. */
  index: number;
  /** Vanilla's `maxammo[]`. */
  maxAmmo?: number;
  /** Vanilla's `clipammo[]` — what one clip is worth, which every ammo grant multiplies by. */
  perAmmo?: number;
}

/**
 * One `Weapon N` record. Only the ammo type survives: vanilla's `weaponinfo[]` holds that and five
 * state pointers, and nothing else — no damage, no rate. docs/dehacked.md § Weapon, Ammo and Misc.
 */
export interface DehWeaponEdit {
  /** 0-based `weapontype_t`. */
  index: number;
  /** 0-based `ammotype_t`, or 5 (`am_noammo`) for a weapon that draws none. */
  ammoType: number;
}

/** Everything a parsed patch carries, plus the report of what it asked for that didn't land. */
export interface DehPatch {
  thingEdits: readonly DehThingEdit[];
  ammoEdits: readonly DehAmmoEdit[];
  weaponEdits: readonly DehWeaponEdit[];
  /** `Misc`'s values, keyed by the lowercased `deh_misc[]` name — `MISC_SINKS` says where each goes. */
  misc: Readonly<Record<string, number>>;
  /** BEX `[SOUNDS]`: sfx name to the lump it should resolve to. */
  soundLumps: ReadonlyMap<string, string>;
  /** BEX `[MUSIC]` and `Music N`: `mus_*` mnemonic to the lump it should resolve to. */
  musicLumps: ReadonlyMap<string, string>;
  /** BEX `[STRINGS]` entries and vanilla `Text` substitutions alike, keyed by mnemonic. */
  strings: ReadonlyMap<string, string>;
  /** `[PARS]` seconds, keyed by map lump name. */
  pars: ReadonlyMap<string, number>;
  warnings: readonly DehWarning[];
  /** How many records of each kind were read, for the "what applied" half of the report. */
  applied: Readonly<Record<string, number>>;
}
