/**
 * The DEHACKED/BEX text parser: raw lump text in, a `DehPatch` out. Pure, with no `Wad`
 * dependency, so the tests and any tooling can drive it directly — the same split
 * `campaign/mapinfo.ts` uses. It never throws: anything it can't read becomes a warning and the
 * walk continues, because a patch that trips one line must not cost the level. See
 * docs/dehacked.md § The record grammar.
 */
import { DOOM_TIC } from '../../constants.ts';
import { stripTitlePrefix } from '../../wad/campaign/names.ts';
import type {
  DehAmmoEdit,
  DehPatch,
  DehRecordKind,
  DehShortfall,
  DehSupport,
  DehThingEdit,
  DehWarning,
  DehWeaponEdit,
} from './defs.ts';
import {
  MOBJ_INFO,
  SFX_ORDER,
  THING_SOUND_FIELDS,
  classifyDehackedField,
  classifyDehackedFlag,
  classifyDehackedRecord,
  classifyDehackedString,
  unhonoredFlags,
  type MobjRow,
} from './tables.ts';

/**
 * Above this, a `Width`/`Height`/missile `Speed` value is read as 16.16 fixed point, and below it
 * as plain map units.
 *
 * **A heuristic, not a vanilla rule.** DeHackEd writes what the exe stores, which is fixed point,
 * but a hand-edited patch writes map units — EPIC.WAD's `Thing 97 / Radius = 2` means two map
 * units, not 1/32768 of one. The two ranges sit two orders of magnitude apart with nothing
 * between them: the largest plain radius in `info.c` is `MT_SPIDER`'s 128, and the smallest
 * fixed-point one is `MT_TROOPSHOT`'s `6*FRACUNIT` = 393216. docs/dehacked.md § Units.
 */
const FIXED_POINT_THRESHOLD = 4096;

/** `info.c` writes its fixed-point fields as `n*FRACUNIT`. */
const FRACUNIT = 65536;

/** A `Text` record's old string is only matched against a title if it could plausibly be one. */
const MAX_TITLE_BYTES = 64;

/**
 * The two `key = value` lines that carry no edit and belong to no record. A patch may repeat them
 * mid-file — EPIC.WAD switches from `Doom version = 21` to `19` halfway through — so they are
 * skipped wherever they appear rather than closing whatever record is open.
 */
const HEADER_KEYS = new Set(['doom version', 'patch format']);

/** Reads a fixed-point-or-map-units field down to plain map units. */
function mapUnits(raw: number): number {
  return Math.abs(raw) >= FIXED_POINT_THRESHOLD ? raw / FRACUNIT : raw;
}

/**
 * Collects warnings deduped by `(record, field)`, which is what keeps a report readable. Also the
 * merge point across a set's several lumps (`readDehacked`), so one dedupe key serves both.
 */
export class WarningLog {
  private rows = new Map<string, DehWarning>();

  add(record: string, support: DehShortfall, detail: string, field?: string): void {
    this.absorb({ record, field, support, detail, count: 1 });
  }

  /** Folds already-counted rows in — a second lump skipping the same field stays one row. */
  merge(rows: Iterable<DehWarning>): void {
    for (const row of rows) this.absorb(row);
  }

  private absorb(row: DehWarning): void {
    const key = `${row.record} ${row.field ?? ''}`;
    const seen = this.rows.get(key);
    if (seen) {
      seen.count += row.count;
      return;
    }
    this.rows.set(key, { ...row });
  }

  /** Most serious first, so a report's opening line is the one worth reading. */
  drain(): DehWarning[] {
    const rank: Record<DehShortfall, number> = { unknown: 0, unsupported: 1, noTarget: 2 };
    return [...this.rows.values()].sort((a, b) => rank[a.support] - rank[b.support] || b.count - a.count);
  }
}

/**
 * A cursor over the raw lump text that yields lines but can also be jumped forward by a byte
 * count. That is the whole reason this parser doesn't just split on newlines: a vanilla `Text`
 * record is followed by two raw runs whose lengths it declares, and those runs routinely contain
 * newlines of their own — EPIC.WAD's level titles do. A line array would have already chopped
 * them apart. docs/dehacked.md § The record grammar.
 */
class TextCursor {
  private text: string;
  at = 0;

  constructor(text: string) {
    this.text = text;
  }

  get done(): boolean {
    return this.at >= this.text.length;
  }

  /** The next line, with the cursor left just past its terminator. */
  nextLine(): string {
    const end = this.text.indexOf('\n', this.at);
    if (end === -1) {
      const rest = this.text.slice(this.at);
      this.at = this.text.length;
      return rest;
    }
    const line = this.text.slice(this.at, end);
    this.at = end + 1;
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }

  /** Exactly `n` characters from the cursor, newlines included, consuming them. */
  take(n: number): string {
    const out = this.text.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

/** `key = value`, or null for a comment, a blank, or a line that is not an assignment at all. */
function assignment(line: string): { key: string; value: string } | null {
  const body = line.split('#')[0];
  const eq = body.indexOf('=');
  if (eq === -1) return null;
  const key = body.slice(0, eq).trim();
  const value = body.slice(eq + 1).trim();
  return key ? { key, value } : null;
}

/**
 * A `Bits` value, in either form a real patch writes — EPIC.WAD uses both, `Bits = SOLID` on one
 * thing and `Bits = 768` on another. A value with no letters in it is the numeric mask; anything
 * else is a `+`/`|`/`,`-separated mnemonic list. Returns the mask and any mnemonic the flag table
 * doesn't know.
 */
function parseBits(value: string): { mask: number; unknown: string[] } {
  if (/^[0-9][0-9\s]*$/.test(value.trim())) return { mask: Number(value.trim()) >>> 0, unknown: [] };
  let mask = 0;
  const unknown: string[] = [];
  for (const token of value.split(/[+|,\s]+/).filter(Boolean)) {
    const row = classifyDehackedFlag(token);
    if (row) mask |= row.bit;
    else unknown.push(token);
  }
  return { mask: mask >>> 0, unknown };
}

/**
 * A `Text` record is a raw substitution rather than a keyed edit, so what it changes has to be
 * recognised from the old string alone. Level titles are the one corpus this engine can act on:
 * normalized, they are exactly `LEVEL_NAMES`' own values, which is what lets a table lookup stand
 * in for reconstructing id's original bytes.
 */
function titleSubstitution(oldText: string, newText: string): { from: string; to: string } | null {
  if (oldText.length > MAX_TITLE_BYTES) return null;
  const from = stripTitlePrefix(oldText);
  if (!from) return null;
  return { from, to: stripTitlePrefix(newText) };
}

/**
 * Reads one DEHACKED or BEX patch.
 *
 * `titleLookup` resolves a normalized vanilla level title to the map lump it names, which is how a
 * vanilla `Text` substitution reaches a level: the patch says "the level called Entryway is called
 * something else now", and only `campaign/names.ts` knows that Entryway is `MAP01`. Passing it in
 * rather than importing it keeps this module free of any campaign knowledge.
 */
export function parseDehacked(
  text: string,
  titleLookup: (title: string) => string | undefined = () => undefined,
): DehPatch {
  const cursor = new TextCursor(text);
  const warnings = new WarningLog();
  const applied: Record<string, number> = {};
  const thingEdits: DehThingEdit[] = [];
  const strings = new Map<string, string>();
  const pars = new Map<string, number>();
  const ammoEdits: DehAmmoEdit[] = [];
  const weaponEdits: DehWeaponEdit[] = [];
  const misc: Record<string, number> = {};
  const soundLumps = new Map<string, string>();
  const musicLumps = new Map<string, string>();

  /** The record the following `key = value` lines belong to. */
  let kind: DehRecordKind = 'header';
  let label = '';
  let row: MobjRow | undefined;
  let edit: DehThingEdit | null = null;
  /** Whether the open `Thing` record has had a field land on it — see `closeThing`. */
  let editTouched = false;
  let ammo: DehAmmoEdit | null = null;
  let weapon: DehWeaponEdit | null = null;
  /** Whether the open record was already reported, so its field lines add nothing. */
  let skipping = false;

  /** Files the open `Thing` edit, if it turned out to carry anything beyond its identity. */
  const closeThing = (): void => {
    if (edit && editTouched) thingEdits.push(edit);
    if (ammo && (ammo.maxAmmo !== undefined || ammo.perAmmo !== undefined)) ammoEdits.push(ammo);
    if (weapon && weapon.ammoType !== -1) weaponEdits.push(weapon);
    edit = null;
    editTouched = false;
    ammo = null;
    weapon = null;
  };

  while (!cursor.done) {
    const trimmed = cursor.nextLine().trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // A bracketed BEX section, or a `Word N` record header. Anything else is a field line
    // belonging to whichever record is open.
    const header = /^(\[[A-Za-z]+\]|[A-Za-z]+)(?:\s+(-?\d+))?/.exec(trimmed);
    const word = header ? header[1] : '';
    const classified = classifyDehackedRecord(word);
    // A bracketed BEX section runs until the next bracket or a record kind we know. Without that,
    // `[PARS]`' own `par 1 30` lines read as `Word N` record headers and eat the whole section.
    const inSection = kind === 'pars' || kind === 'strings';
    const isRecordHeader =
      header !== null &&
      (trimmed.startsWith('[') ||
        (header[2] !== undefined && (!inSection || classified.support !== 'unknown')));

    if (isRecordHeader) {
      const index = header[2] === undefined ? 0 : Number(header[2]);
      closeThing();
      kind = classified.kind;
      label = word;
      row = undefined;

      if (classified.support !== 'applied') {
        warnings.add(word, classified.support, recordDetailFor(word, trimmed, classified.support));
        // Its own field lines say nothing the record header hasn't: seven `Frame` records would
        // otherwise contribute a second row per distinct field name on top of the one that matters.
        skipping = true;
        continue;
      }
      skipping = false;

      ammo = kind === 'ammo' ? { index } : null;
      weapon = kind === 'weapon' ? { index, ammoType: -1 } : null;

      if (kind === 'thing') {
        row = MOBJ_INFO[index - 1];
        if (!row) {
          warnings.add(word, 'unknown', `\`${trimmed}\` names no mobjtype (there are ${MOBJ_INFO.length})`);
          continue;
        }
        edit = { index };
      } else if (kind === 'text') {
        readText(trimmed, cursor, titleLookup, strings, warnings);
      }
      continue;
    }

    if (kind === 'pars') {
      readPar(trimmed, pars, warnings);
      continue;
    }

    const pair = assignment(trimmed);
    if (!pair) continue;
    if (HEADER_KEYS.has(pair.key.toLowerCase())) continue;
    if (skipping) continue;

    if (kind === 'strings') {
      readString(pair.key, pair.value, cursor, strings, warnings);
      continue;
    }
    // A BEX `[SOUNDS]`/`[MUSIC]` entry is `mnemonic = lump`, keyed by name rather than by index.
    // Only the bracketed form reaches here — `RECORD_KINDS` classifies the numeric `Sound N` /
    // `Music N` records `noTarget`, so `skipping` above has already dropped their field lines.
    if (kind === 'sound') {
      soundLumps.set(pair.key.trim().toLowerCase(), pair.value.trim());
      continue;
    }
    if (kind === 'music') {
      musicLumps.set(pair.key.trim().toLowerCase(), pair.value.trim());
      continue;
    }

    const support = classifyDehackedField(kind, pair.key, row);
    if (support !== 'applied') {
      warnings.add(label, support, detailFor(kind, pair.key, support, row), pair.key);
      continue;
    }
    const key = pair.key.trim().toLowerCase();
    const value = Number(pair.value);
    if (kind === 'thing' && edit && row) {
      editTouched = readThingField(edit, row, pair.key, pair.value, label, warnings) || editTouched;
    } else if (kind === 'ammo' && ammo && Number.isFinite(value)) {
      if (key === 'max ammo') ammo.maxAmmo = value;
      else ammo.perAmmo = value;
    } else if (kind === 'weapon' && weapon && Number.isFinite(value)) {
      weapon.ammoType = value;
    } else if (kind === 'misc' && Number.isFinite(value)) {
      // Keyed by the DEH name as written, not by the sink: `MISC_SINKS` is the applier's business,
      // and half-resolving it here is what let `BFG Cells/Shot` report as applied while landing
      // nowhere. `classifyDehackedField` has already rejected any name with no sink.
      misc[key] = value;
    }
  }

  closeThing();
  if (thingEdits.length) applied.thing = thingEdits.length;
  if (ammoEdits.length) applied.ammo = ammoEdits.length;
  if (weaponEdits.length) applied.weapon = weaponEdits.length;
  if (Object.keys(misc).length) applied.misc = Object.keys(misc).length;
  if (soundLumps.size) applied.sound = soundLumps.size;
  if (musicLumps.size) applied.music = musicLumps.size;
  if (pars.size) applied.pars = pars.size;
  if (strings.size) applied.strings = strings.size;

  return {
    thingEdits,
    ammoEdits,
    weaponEdits,
    misc,
    soundLumps,
    musicLumps,
    strings,
    pars,
    warnings: warnings.drain(),
    applied,
  };
}

/**
 * One sentence naming why a whole record class is skipped, so `RECORD_KINDS`' classification is
 * what decides — including `noTarget`, which is the numeric `Sound`/`Music`/`Cheat` records: those
 * only move a pointer into the exe's own string table, which this engine has no equivalent of.
 */
function recordDetailFor(word: string, line: string, support: DehShortfall): string {
  if (support === 'unknown') return `unrecognised record \`${line}\``;
  if (support === 'noTarget') return `\`${word}\` records index a table this engine does not have`;
  return `\`${word}\` records edit the frame table, which this engine does not have`;
}

/** One sentence naming what was skipped, rather than restating the class. */
function detailFor(kind: DehRecordKind, field: string, support: DehSupport, row?: MobjRow): string {
  if (support === 'unknown') return `\`${field}\` is not a field of a \`${kind}\` record`;
  if (support === 'noTarget' && kind === 'thing' && row && row.doomednum === -1) {
    return `\`${field}\` on ${row.type}, which no table here keys`;
  }
  if (support === 'noTarget') return `\`${field}\` has nothing to change in this engine`;
  return `\`${field}\` edits the frame table, which this engine does not have`;
}

/**
 * A vanilla `Text <oldlen> <newlen>` record: two raw runs follow the header line, and the cursor
 * is jumped over exactly as many characters as it declares — see `TextCursor`.
 */
function readText(
  headerLine: string,
  cursor: TextCursor,
  titleLookup: (title: string) => string | undefined,
  strings: Map<string, string>,
  warnings: WarningLog,
): void {
  const lengths = /^Text\s+(\d+)\s+(\d+)/i.exec(headerLine);
  if (!lengths) {
    warnings.add('Text', 'unknown', `\`${headerLine}\` gives no byte counts`);
    return;
  }
  const oldText = cursor.take(Number(lengths[1]));
  const newText = cursor.take(Number(lengths[2]));
  const pair = titleSubstitution(oldText, newText);
  const mapName = pair ? titleLookup(pair.from) : undefined;
  if (pair && mapName) {
    strings.set(mapName, pair.to);
    return;
  }
  warnings.add(
    'Text',
    'unsupported',
    `substitutes \`${oldText.slice(0, 24).replace(/\n/g, ' ')}\`, which is not a level title`,
  );
}

/**
 * One `Thing` field, unit-converted into this engine's terms. Returns whether anything landed on
 * the edit, which is what tells `closeThing` an otherwise-empty record is worth filing.
 * docs/dehacked.md § Units.
 */
function readThingField(
  edit: DehThingEdit,
  row: MobjRow,
  field: string,
  value: string,
  label: string,
  warnings: WarningLog,
): boolean {
  const raw = Number(value);
  const key = field.trim().toLowerCase();
  if (key !== 'bits' && !Number.isFinite(raw)) {
    warnings.add(label, 'unknown', `\`${field} = ${value}\` is not a number`, field);
    return false;
  }
  switch (key) {
    case 'hit points':
      edit.health = raw;
      return true;
    case 'mass':
      edit.mass = raw;
      return true;
    case 'missile damage':
      edit.damage = raw;
      return true;
    // `P_DamageMobj` rolls `P_Random() < info->painchance` against a 0..255 draw.
    case 'pain chance':
      edit.painChance = raw / 256;
      return true;
    case 'width':
      edit.radius = mapUnits(raw);
      return true;
    case 'height':
      edit.height = mapUnits(raw);
      return true;
    case 'speed':
      // A missile's `mobjinfo.speed` is map units per tic, in fixed point, so it converts to an
      // absolute speed. A walker's is plain map units per `A_Chase` and stays in those terms, so
      // the applier can scale this engine's derived units/sec by the ratio against vanilla's.
      edit.speed = row.missile ? mapUnits(raw) / DOOM_TIC : raw;
      return true;
    case 'bits': {
      const bits = parseBits(value);
      edit.bits = bits.mask;
      for (const name of bits.unknown) {
        warnings.add(label, 'unknown', `\`Bits\` names \`${name}\`, which is not a mobjflag`, 'Bits');
      }
      // Keyed per flag, so the report names the one a patch wanted rather than counting `Bits`
      // lines. The line itself still applies — only these flags of it don't.
      for (const flag of unhonoredFlags(bits.mask)) {
        const detail = `\`Bits\` asks for \`MF_${flag.name}\`, which has no sink here`;
        warnings.add(label, flag.support, detail, `Bits/${flag.name}`);
      }
      return true;
    }
    default: {
      const slot = THING_SOUND_FIELDS[key];
      if (!slot) return false;
      // Index 0 is `sfx_None`; `MonsterSounds`' fields are already optional, so it means silence.
      const name = SFX_ORDER[raw];
      if (name === undefined) {
        warnings.add(label, 'unknown', `\`${field} = ${value}\` names no sound (there are ${SFX_ORDER.length})`, field);
        return false;
      }
      edit.sounds = { ...edit.sounds, [slot]: name };
      return true;
    }
  }
}

/**
 * One `[STRINGS]` entry. A line ending in a backslash continues onto the next, and the usual C
 * escapes are expanded — `deh_procStrings`.
 */
function readString(
  key: string,
  first: string,
  cursor: TextCursor,
  strings: Map<string, string>,
  warnings: WarningLog,
): void {
  let value = first;
  while (value.endsWith('\\') && !cursor.done) {
    value = value.slice(0, -1) + cursor.nextLine().trim();
  }
  const expanded = value
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
  const support = classifyDehackedString(key);
  if (support !== 'applied') {
    // Only an unrecognised mnemonic earns a row. A `GOT*` or an `OB_MPFIST` is recognised and
    // deliberately homeless, and reporting those said nothing a reader could act on.
    if (support === 'unknown') warnings.add('[STRINGS]', support, 'mnemonic this parser does not recognise');
    return;
  }
  strings.set(key.trim().toUpperCase(), expanded);
}

/**
 * One `[PARS]` line, in either form the format allows: `par <map> <secs>` for a commercial map and
 * `par <episode> <map> <secs>` for an episodic one. freedoom2 writes the two-number form, with a
 * `#` comment on every line.
 */
function readPar(line: string, pars: Map<string, number>, warnings: WarningLog): void {
  const body = line.split('#')[0].trim();
  if (!body) return;
  const tokens = body.split(/\s+/);
  if (tokens[0].toLowerCase() !== 'par') return;
  const nums = tokens.slice(1).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) {
    warnings.add('[PARS]', 'unknown', `\`${body}\` is not a par line`);
    return;
  }
  if (nums.length === 2) pars.set(`MAP${String(nums[0]).padStart(2, '0')}`, nums[1]);
  else if (nums.length === 3) pars.set(`E${nums[0]}M${nums[1]}`, nums[2]);
  else warnings.add('[PARS]', 'unknown', `\`${body}\` gives ${nums.length} numbers, not 2 or 3`);
}
