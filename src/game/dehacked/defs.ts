/**
 * The record shapes a parsed DEHACKED patch is carried in, and the vocabulary its coverage report
 * speaks: what a patch asked for, and how far each of those asks got. See docs/dehacked.md.
 */

/**
 * How far one DEHACKED record or field got. Only `unsupported` — out of scope though a target
 * exists or could — is worth revisiting; `noTarget` is a target this engine doesn't have, `unknown`
 * text the parser didn't recognise. docs/dehacked.md § The coverage report.
 */
export type DehSupport = 'applied' | 'noTarget' | 'unsupported' | 'unknown';

/**
 * What a {@link DehWarning} can carry. A warning is raised only where a field did *not* fully land,
 * so `applied` is excluded at the type rather than filtered for at each reader.
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
 * One thing a patch asked for that didn't fully land, already deduped and counted.
 * docs/dehacked.md § The coverage report.
 */
export interface DehWarning {
  /** The record as the patch spelled it, minus its index: `Thing`, `[CODEPTR]`. */
  record: string;
  /** The field inside it, where the record itself was understood but one of its lines wasn't. */
  field?: string;
  support: DehShortfall;
  /** One sentence a reader can act on, naming what was skipped rather than restating the class. */
  detail: string;
  /** How many times this exact `(record, field, support)` triple occurred. */
  count: number;
}

/** One `Thing N` record's patchable fields, already unit-converted into this engine's terms. */
export interface DehThingEdit {
  /** 1-based `Thing` index as the patch wrote it, for reports. The applier re-derives the
   * `MOBJ_INFO` row from it, so the row's own fields are not copied in here. */
  index: number;
  health?: number;
  /**
   * Map units per second, already through the walker/missile unit rules (docs/dehacked.md § Units).
   */
  speed?: number;
  radius?: number;
  height?: number;
  mass?: number;
  /** `mobjinfo.damage`, the multiplier on `PIT_CheckThing`'s `((P_Random()%8)+1)` roll. */
  damage?: number;
  /** 0..1, vanilla's `painchance` over 256. */
  painChance?: number;
  /**
   * The full replacement `mobjinfo.flags` mask, or undefined where the record set no `Bits` line —
   * "absent" and "zero" differ. docs/dehacked.md § Bits.
   */
  bits?: number;
  /**
   * The sound fields, already resolved through `SFX_ORDER`. A key present with `null` means the
   * patch asked for silence (`sfx_None`, index 0) and the field is deleted rather than set.
   */
  sounds?: Partial<Record<'see' | 'attack' | 'pain' | 'death' | 'active', string | null>>;
  /**
   * The eight state pointers (`Initial frame` … `Respawn frame`), as `states[]` indices. A key
   * present with 0 is `S_NULL` — "this type has no such state" — and is as meaningful as any other
   * value, which is why this is a partial record and not a set of optional numbers defaulting to 0.
   * docs/dehacked.md § Frames.
   */
  states?: Partial<Record<StatePointer, number>>;
}

/**
 * The eight `mobjinfo` state pointers a `Thing` record can repoint, by the name `MOBJ_STATES` uses.
 */
export type StatePointer = 'spawn' | 'see' | 'pain' | 'melee' | 'missile' | 'death' | 'xdeath' | 'raise';

/**
 * One `Frame N` record's fields, in vanilla's own units: `Sprite number` is a `sprnames[]` index,
 * `Sprite subnumber` the raw `state_t.frame` (letter plus `FF_FULLBRIGHT`), `Duration` tics (-1
 * holds forever), `Next frame` a `states[]` index. Left raw because the applier patches them into a
 * copy of `STATES` and walks that, rather than converting each field on its own.
 */
export interface DehFrameEdit {
  /** 0-based `states[]` index, as the patch wrote it. */
  index: number;
  spriteNum?: number;
  subNumber?: number;
  duration?: number;
  nextFrame?: number;
  /**
   * `state_t`'s general-purpose data fields, in order: index 0 is `Unknown 1` (`misc1`), index 1 is
   * `Unknown 2` (`misc2`). Dense — a slot the patch never wrote reads 0, which is what `info.c`
   * gives both fields on every state. Only MBF's own pointers read them (`A_Spawn`'s type and z,
   * `A_PlaySound`'s sound) — docs/dehacked.md § Action pointers.
   */
  args?: readonly number[];
}

/**
 * One repointed state: which `states[]` row, and the `A_*` name its action becomes — `''` for
 * `A_NULL`, an action cleared, which is as meaningful as any other value. Both record forms land
 * here, `Pointer N (Frame mm)` having already resolved its `Codep Frame` through the **pristine**
 * action column. docs/dehacked.md § Action pointers.
 */
export interface DehPointerEdit {
  /** 0-based `states[]` index — the state whose action changes, not the one it was copied from. */
  state: number;
  action: string;
}

/** One `Ammo N` record's two fields, `d_deh.c`'s `deh_ammo[]`. */
export interface DehAmmoEdit {
  /** 0-based `ammotype_t`: slot 2 is cells and slot 3 is rockets. */
  index: number;
  /** The most of this ammo type a player may carry — vanilla's `maxammo[]`. */
  maxAmmo?: number;
  /** Vanilla's `clipammo[]` — what one clip is worth, which every ammo grant multiplies by. */
  perAmmo?: number;
}

/**
 * One `Weapon N` record: vanilla's whole `weaponinfo[]` row, an ammo type and five state pointers.
 * docs/dehacked.md § Weapon, Ammo and Misc.
 */
export interface DehWeaponEdit {
  /** 0-based `weapontype_t`. */
  index: number;
  /**
   * 0-based `ammotype_t`, or 5 (`am_noammo`) for a weapon that draws none; -1 where the record set
   * none.
   */
  ammoType: number;
  /**
   * The five state pointers, as `states[]` indices, by the name `WEAPON_STATES` uses rather than
   * the swapped labels the patch writes. A key present with 0 is `S_NULL`, as meaningful as any
   * other value. Only `atk` reaches a sink here, the fire rate walked off its chain
   * (docs/weapons.md § Fire rates); the other four are carried so the record reads whole.
   */
  states?: Partial<Record<WeaponStatePointer, number>>;
}

/**
 * The five `weaponinfo` state pointers a `Weapon` record can repoint, by the name `WEAPON_STATES`
 * uses.
 */
export type WeaponStatePointer = 'up' | 'down' | 'ready' | 'atk' | 'flash';

/** Everything a parsed patch carries, plus the report of what it asked for that didn't land. */
export interface DehPatch {
  thingEdits: readonly DehThingEdit[];
  ammoEdits: readonly DehAmmoEdit[];
  weaponEdits: readonly DehWeaponEdit[];
  frameEdits: readonly DehFrameEdit[];
  pointerEdits: readonly DehPointerEdit[];
  /**
   * BEX `[SPRITES]` and vanilla `Text 4 4` alike: a pristine `sprnames[]` name, lowercased, to the
   * four-character name its lumps should resolve through instead.
   * docs/dehacked.md § Sprite renames.
   */
  spriteRenames: ReadonlyMap<string, string>;
  /**
   * `Misc`'s values, keyed by the lowercased `deh_misc[]` name — `MISC_SINKS` says where each goes.
   */
  misc: Readonly<Record<string, number>>;
  /** BEX `[SOUNDS]`: sfx name to the lump it should resolve to. */
  soundLumps: ReadonlyMap<string, string>;
  /** BEX `[MUSIC]` and `Music N`: `mus_*` mnemonic to the lump it should resolve to. */
  musicLumps: ReadonlyMap<string, string>;
  /** BEX `[STRINGS]` entries and vanilla `Text` substitutions alike, keyed by mnemonic. */
  strings: ReadonlyMap<string, string>;
  /** `[PARS]` seconds, keyed by map lump name. */
  pars: ReadonlyMap<string, number>;
  /**
   * How many rows `states[]` has once this patch's `Frame`, `Pointer` and `[CODEPTR]` records have
   * grown it — vanilla's 967 plus MBF's 109 where it names nothing past them. The applier sizes its
   * copy of the frame table to this. docs/dehacked.md § Extended states.
   */
  stateCount: number;
  warnings: readonly DehWarning[];
  /** How many records of each kind were read, for the "what applied" half of the report. */
  applied: Readonly<Record<string, number>>;
}
