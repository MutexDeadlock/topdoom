import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDehacked, readDehacked } from '../../src/game/dehacked.ts';
import { titleLookupFor } from '../../src/wad/campaign/names.ts';
import { Wad } from '../../src/wad/wad.ts';
import { wadFile } from '../fixtures/wadfile.ts';
import { dehFixture, dehFixtureBytes } from '../fixtures/dehacked.ts';

const lookup = titleLookupFor();

/**
 * The patch grammar, against hand-written records for the edge cases and against the two real
 * lumps for the shapes only a real patch produces. See docs/dehacked.md § The record grammar.
 */
describe('DEHACKED · the record grammar', () => {
  test('a Text record consumes exactly the byte counts it declares, newlines included', () => {
    // The whole reason the parser walks a cursor rather than a line array: `oldlen` here spans
    // the newline in the middle of the old string, so a line-split parser would already have
    // chopped the record apart before it could be read.
    const patch = parseDehacked('Text 11 7\nEntry\nway!!Renamed\n', () => 'MAP01');
    assert.equal(patch.strings.get('MAP01'), 'Renamed');
  });

  test('a Text record naming no level title is reported rather than guessed at', () => {
    const patch = parseDehacked('Text 4 4\nPOSSXXXX\n', lookup);
    assert.equal(patch.strings.size, 0);
    const warning = patch.warnings.find((w) => w.record === 'Text');
    assert.equal(warning?.support, 'unsupported');
    assert.match(warning!.detail, /POSS/);
  });

  test('Bits parses both the numeric and the mnemonic form', () => {
    // EPIC.WAD writes one of each, so both are load-bearing on real content.
    assert.equal(parseDehacked('Thing 12\nBits = 768\n').thingEdits[0].bits, 0x100 | 0x200);
    assert.equal(parseDehacked('Thing 12\nBits = SOLID\n').thingEdits[0].bits, 0x2);
    assert.equal(parseDehacked('Thing 12\nBits = SOLID+SHOOTABLE\n').thingEdits[0].bits, 0x6);
    // A leading MF_ is stripped, and `|` and `,` separate as well as `+`.
    assert.equal(parseDehacked('Thing 12\nBits = MF_SOLID|MF_SHADOW\n').thingEdits[0].bits, 0x2 | 0x40000);
  });

  test('Bits records the whole mask, so a value that omits a flag can remove it', () => {
    // Not a delta: EPIC's `Thing 130 / Bits = 768` deliberately drops MF_SOLID|MF_SHOOTABLE from
    // a hanging body. `undefined` and `0` therefore have to stay distinguishable.
    assert.equal(parseDehacked('Thing 12\nBits = 0\n').thingEdits[0].bits, 0);
    assert.equal(parseDehacked('Thing 12\nMass = 5\n').thingEdits[0].bits, undefined);
  });

  test('a Bits mnemonic that is not a mobjflag is named in the report', () => {
    const patch = parseDehacked('Thing 12\nBits = SOLID+WOBBLY\n');
    assert.equal(patch.thingEdits[0].bits, 0x2);
    assert.match(patch.warnings.find((w) => w.field === 'Bits')!.detail, /WOBBLY/);
  });

  test('Bits reports the flags it drops, and stays quiet about the ones it should', () => {
    // The `Bits` line itself always applies, so without a per-flag row the flags it silently
    // dropped were never reported at all. docs/dehacked.md § Bits.
    const patch = parseDehacked('Thing 12\nBits = SOLID+SHOOTABLE+COUNTKILL+NOBLOOD+SPECIAL\n');
    assert.deepEqual(
      patch.warnings.map((w) => [w.field, w.support]),
      [['Bits/SPECIAL', 'unsupported'], ['Bits/NOBLOOD', 'unsupported']],
    );
    // The applied flags in that same mask still land.
    assert.equal(patch.thingEdits[0].bits, 0x2 | 0x4 | 0x400000 | 0x80000 | 0x1);
  });

  test('a quiet flag is not reported: for it, having no sink is the right answer', () => {
    // Vanilla's own blockmap bookkeeping and per-actor runtime state. Filtered at the source, so
    // the console and `inspect-wad` cannot disagree about what counts as noise.
    const patch = parseDehacked('Thing 12\nBits = SOLID+NOSECTOR+NOBLOCKMAP+CORPSE+AMBUSH\n');
    assert.deepEqual(patch.warnings, []);
  });

  test('a numeric Bits mask is reported the same way a mnemonic one is', () => {
    const patch = parseDehacked('Thing 12\nBits = 524288\n'); // MF_NOBLOOD
    assert.deepEqual(patch.warnings.map((w) => w.field), ['Bits/NOBLOOD']);
  });

  test('a repeated version header mid-file does not close the record above it', () => {
    // EPIC.WAD switches from `Doom version = 21` to `19` partway through.
    const patch = parseDehacked('Thing 12\nMass = 7\nDoom version = 19\nPatch format = 6\nHit points = 9\n');
    assert.deepEqual(patch.thingEdits, [{ index: 12, mass: 7, health: 9 }]);
  });

  test('[PARS] reads both the two-number and the three-number form', () => {
    const patch = parseDehacked('[PARS]\npar  1   30  # 00:30 - a comment\npar 2 8 165\n');
    assert.deepEqual([...patch.pars], [['MAP01', 30], ['E2M8', 165]]);
  });

  test('[STRINGS] expands escapes and joins continuation lines', () => {
    const patch = parseDehacked('[STRINGS]\nHUSTR_1 = one\\ntwo\nHUSTR_2 = split \\\n  onward\n');
    assert.equal(patch.strings.get('HUSTR_1'), 'one\ntwo');
    assert.equal(patch.strings.get('HUSTR_2'), 'split onward');
  });

  test('an unrecognised record is reported once, however many times it occurs', () => {
    const patch = parseDehacked('Wobble 1\nMass = 3\nWobble 2\nMass = 4\n');
    const rows = patch.warnings.filter((w) => w.record === 'Wobble');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].support, 'unknown');
  });

  test('a record the engine cannot honour swallows its own field lines', () => {
    // Seven `Frame` records would otherwise contribute a row per distinct field name on top of
    // the one row that actually says something.
    const patch = parseDehacked('Frame 185\nSprite subnumber = 32773\nDuration = 4\n');
    assert.deepEqual(
      patch.warnings.map((w) => [w.record, w.field, w.count]),
      [['Frame', undefined, 1]],
    );
  });

  test('a Thing index outside mobjinfo is reported rather than silently dropped', () => {
    const patch = parseDehacked('Thing 500\nHit points = 1\n');
    assert.equal(patch.thingEdits.length, 0);
    assert.match(patch.warnings[0].detail, /137/);
  });

  test('malformed input never throws — it degrades to a warning and the walk continues', () => {
    const patch = parseDehacked('Thing 12\nHit points = banana\nMass = 12\n');
    assert.deepEqual(patch.thingEdits, [{ index: 12, mass: 12 }]);
    assert.equal(patch.warnings.some((w) => w.support === 'unknown'), true);
  });
});

/** Unit conversion out of DEH's terms into this engine's. docs/dehacked.md § Units. */
describe('DEHACKED · units', () => {
  test('radius and height read as fixed point above the threshold and map units below', () => {
    // `info.c` writes `16*FRACUNIT`; a hand-edited patch writes `2`. EPIC.WAD does the latter.
    assert.equal(parseDehacked('Thing 12\nWidth = 1048576\n').thingEdits[0].radius, 16);
    assert.equal(parseDehacked('Thing 12\nWidth = 2\n').thingEdits[0].radius, 2);
    assert.equal(parseDehacked('Thing 12\nHeight = 3670016\n').thingEdits[0].height, 56);
  });

  test('pain chance is read over 256, the range P_DamageMobj rolls against', () => {
    assert.equal(parseDehacked('Thing 12\nPain chance = 128\n').thingEdits[0].painChance, 0.5);
  });

  test("a missile's speed becomes units per second, a walker's stays in vanilla's own terms", () => {
    // MT_TROOPSHOT is Thing 32, `10*FRACUNIT` per tic in `info.c` — 350 units/sec at 35 tics.
    assert.equal(parseDehacked('Thing 32\nSpeed = 655360\n').thingEdits[0].speed, 350);
    // MT_TROOP is Thing 12, whose `speed` of 8 is plain map units per `A_Chase`. It is left as
    // written so the applier can scale this engine's derived units/sec by the ratio.
    assert.equal(parseDehacked('Thing 12\nSpeed = 16\n').thingEdits[0].speed, 16);
  });
});

/**
 * The two lumps this engine actually ships alongside. These pin behaviour against real patches
 * rather than against what the format's documentation says a patch looks like.
 */
describe('DEHACKED · the committed patches', () => {
  test("EPIC.WAD's 32 Text records rename every DOOM II level", () => {
    const patch = parseDehacked(dehFixture('epic'), lookup);
    assert.equal(patch.strings.size, 32);
    assert.equal(patch.strings.get('MAP01'), "1 - a fool's paradise");
    assert.equal(patch.strings.get('MAP30'), '30 - the forgotten god');
  });

  test("EPIC.WAD's two Thing records keep the fields with a sink and report the rest", () => {
    const patch = parseDehacked(dehFixture('epic'), lookup);
    assert.deepEqual(patch.thingEdits, [
      { index: 97, bits: 0x2 },
      {
        index: 130,
        health: 40,
        bits: 0x100 | 0x200,
        // `Pain sound = 62` / `Death sound = 62`, resolved through `sfxenum_t`.
        sounds: { pain: 'bgdth1', death: 'bgdth1' },
      },
    ]);
    // Its seven frame fields are out of scope, and reported as such rather than dropped.
    assert.equal(patch.warnings.filter((w) => w.support === 'unsupported').length, 7);
  });

  test("EPIC.WAD's `Radius` line is unknown here, exactly as it is in vanilla", () => {
    // `d_deh.c`'s `deh_mobjinfo[]` spells the radius field `Width`; nothing in the format accepts
    // `Radius`, so prboom ignores this line too. Reporting it unknown is the faithful answer, not
    // a gap — docs/dehacked.md § What is not supported.
    const patch = parseDehacked(dehFixture('epic'), lookup);
    const row = patch.warnings.find((w) => w.field === 'Radius');
    assert.equal(row?.support, 'unknown');
  });

  test("freedoom2's [PARS] and level titles both land, and its Frame records do not", () => {
    const patch = parseDehacked(dehFixture('freedoom2'), lookup);
    assert.equal(patch.pars.get('MAP01'), 30);
    assert.equal(patch.pars.get('MAP17'), 120); // freedoom's own time, not vanilla's 420
    assert.equal(patch.strings.get('HUSTR_1'), 'MAP01: Hydroelectric Plant');
    assert.equal(patch.strings.get('HUSTR_E1M1'), 'E1M1: Outer Prison');
    const frames = patch.warnings.find((w) => w.record === 'Frame');
    assert.equal(frames?.support, 'unsupported');
    assert.equal(frames?.count, 7);
  });

  test('strings with no target report as one row per group, not one per mnemonic', () => {
    // freedoom2's real lump sets 132 of them; naming each would bury the row that matters.
    const patch = parseDehacked(dehFixture('freedoom2'), lookup);
    const rows = patch.warnings.filter((w) => w.record === '[STRINGS]');
    assert.ok(rows.length < 12, `expected a handful of grouped rows, got ${rows.length}`);
    assert.ok(rows.some((w) => w.field === 'pickup messages'));
  });
});

/** Finding the lump in a loaded set, and merging across files. */
describe('DEHACKED · lump discovery', () => {
  test('a set with no DEHACKED lump reads as null, leaving every table alone', () => {
    assert.equal(readDehacked(new Wad(wadFile('IWAD', 'plain.wad', ['MAP01']))), null);
  });

  test('a patch is read out of the WAD that carries it, and names its source file', () => {
    const wad = new Wad([
      wadFile('IWAD', 'doom2.wad', ['MAP01']),
      wadFile('PWAD', 'epic.wad', [{ name: 'DEHACKED', bytes: dehFixtureBytes('epic') }]),
    ]);
    const patch = readDehacked(wad, lookup)!;
    assert.equal(patch.strings.get('MAP01'), "1 - a fool's paradise");
    assert.deepEqual(patch.sources.map((f) => f.name), ['epic.wad']);
  });

  test('two patches merge cumulatively, with the later file winning per key', () => {
    // Unlike a MAPINFO lump, which is one-per-set: a patch that retunes a monster must not repeal
    // an earlier one that renamed the levels.
    const wad = new Wad([
      wadFile('IWAD', 'doom2.wad', [{ name: 'DEHACKED', text: '[PARS]\npar 1 11\npar 2 22\n' }]),
      wadFile('PWAD', 'later.wad', [{ name: 'DEHACKED', text: '[PARS]\npar 2 99\npar 3 33\n' }]),
    ]);
    const patch = readDehacked(wad)!;
    assert.deepEqual([...patch.pars], [['MAP01', 11], ['MAP02', 99], ['MAP03', 33]]);
    assert.deepEqual(patch.sources.map((f) => f.name), ['doom2.wad', 'later.wad']);
  });
});
