import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { fixtureWad, wadFile } from '../fixtures/wadfile.ts';
import { readAnimated } from '../../src/wad/animated.ts';
import { readSwitches, switchPairs } from '../../src/wad/switches.ts';

/**
 * Boom's two table lumps, decoded from byte streams built here plus the real
 * ones BOOMEDIT.WAD ships. See docs/wad.md § ANIMATED and SWITCHES.
 */

/** `int8 istexture; char endname[9]; char startname[9]; int32 speed`, byte-packed. */
function animatedRecord(istexture: number, end: string, start: string, speed: number): number[] {
  const out: number[] = [istexture & 0xff];
  for (const name of [end, start]) {
    for (let i = 0; i < 9; i++) out.push(i < name.length ? name.charCodeAt(i) : 0);
  }
  for (let i = 0; i < 4; i++) out.push((speed >> (i * 8)) & 0xff);
  return out;
}

/** `char name1[9]; char name2[9]; short episode`, byte-packed. */
function switchesRecord(off: string, on: string, episode: number): number[] {
  const out: number[] = [];
  for (const name of [off, on]) {
    for (let i = 0; i < 9; i++) out.push(i < name.length ? name.charCodeAt(i) : 0);
  }
  return [...out, episode & 0xff, (episode >> 8) & 0xff];
}

const wadWith = (name: string, bytes: number[]) =>
  new Wad([wadFile('PWAD', 'test.wad', [{ name, bytes: Uint8Array.from(bytes) }])]);

describe('WAD parsing · ANIMATED', () => {
  test('decodes a table, mapping istexture onto the inverse `kind`', () => {
    const defs = readAnimated(
      wadWith('ANIMATED', [
        ...animatedRecord(0, 'NUKAGE3', 'NUKAGE1', 2),
        ...animatedRecord(1, 'BFALL4', 'BFALL1', 8),
        ...animatedRecord(-1, '', '', 0),
      ]),
    );
    assert.deepEqual(defs, [
      { kind: 'flat', start: 'NUKAGE1', end: 'NUKAGE3', speedTics: 2 },
      { kind: 'wall', start: 'BFALL1', end: 'BFALL4', speedTics: 8 },
    ]);
  });

  /**
   * The real-world shape: BOOMEDIT.WAD's lump ends after the terminator byte
   * alone rather than a whole record, so the byte must be tested before the
   * rest of its record is read.
   */
  test('a terminator truncated to its single byte still ends the table', () => {
    const bytes = [...animatedRecord(0, 'LAVA4', 'LAVA1', 8), 0xff, 0, 0, 0];
    const defs = readAnimated(wadWith('ANIMATED', bytes));
    assert.equal(defs?.length, 1);
    assert.equal(defs![0].start, 'LAVA1');
  });

  test('a record cut short without any terminator keeps what parsed', () => {
    const full = animatedRecord(0, 'LAVA4', 'LAVA1', 8);
    const defs = readAnimated(wadWith('ANIMATED', [...full, ...full.slice(0, 10)]));
    assert.equal(defs?.length, 1, 'the whole record survived; the fragment was dropped');
  });

  test('a zero or negative speed is dropped rather than dividing the animator by zero', () => {
    const defs = readAnimated(
      wadWith('ANIMATED', [
        ...animatedRecord(0, 'LAVA4', 'LAVA1', 0),
        ...animatedRecord(0, 'BLOOD3', 'BLOOD1', 8),
        ...animatedRecord(-1, '', '', 0),
      ]),
    );
    assert.deepEqual(defs?.map((d) => d.start), ['BLOOD1']);
  });

  test('names are upper-cased on the way in, matching every texture lookup', () => {
    const defs = readAnimated(
      wadWith('ANIMATED', [...animatedRecord(1, 'bfall4', 'bfall1', 8), ...animatedRecord(-1, '', '', 0)]),
    );
    assert.deepEqual(defs, [{ kind: 'wall', start: 'BFALL1', end: 'BFALL4', speedTics: 8 }]);
  });

  test('no lump at all is null, not an empty table', () => {
    assert.equal(readAnimated(new Wad([wadFile('PWAD', 'test.wad', ['THINGS'])])), null);
  });
});

describe('WAD parsing · SWITCHES', () => {
  test('decodes pairs and stops at the zero-episode terminator', () => {
    const pairs = readSwitches(
      wadWith('SWITCHES', [
        ...switchesRecord('SW1BRCOM', 'SW2BRCOM', 1),
        ...switchesRecord('SW1PANEL', 'SW2PANEL', 3),
        ...switchesRecord('', '', 0),
        ...switchesRecord('SW1AFTER', 'SW2AFTER', 1),
      ]),
    );
    assert.deepEqual(pairs, [
      { off: 'SW1BRCOM', on: 'SW2BRCOM' },
      { off: 'SW1PANEL', on: 'SW2PANEL' },
    ]);
  });

  /**
   * The episode field is read only to find the terminator — the existence
   * check below is what vanilla's filter was ever a proxy for.
   */
  test('every episode is kept; only missing textures drop a pair', () => {
    const pairs = readSwitches(
      wadWith('SWITCHES', [
        ...switchesRecord('SW1SHARE', 'SW2SHARE', 1),
        ...switchesRecord('SW1COMM', 'SW2COMM', 3),
        ...switchesRecord('', '', 0),
      ]),
    )!;
    assert.equal(pairs.length, 2, 'both episodes survive the read');
    const lookup = switchPairs(pairs, (name) => name.endsWith('COMM'));
    assert.equal(lookup('SW1COMM'), 'SW2COMM', 'the pair whose textures exist resolves');
    assert.equal(lookup('SW1SHARE'), null, 'the pair whose textures are absent does not');
  });

  test('the lookup works in both directions and is case-insensitive', () => {
    const lookup = switchPairs([{ off: 'SW1ELUP', on: 'SW2ELUP' }], () => true);
    assert.equal(lookup('SW1ELUP'), 'SW2ELUP');
    assert.equal(lookup('SW2ELUP'), 'SW1ELUP');
    assert.equal(lookup('sw1elup'), 'SW2ELUP');
    assert.equal(lookup('BRICK1'), null);
  });

  /** Boom pairs need not share a suffix — the whole reason a table beats the SW1/SW2 convention. */
  test('a pair with unrelated names resolves, which the name convention could not', () => {
    const lookup = switchPairs([{ off: 'LEVER_UP', on: 'PANELRED' }], () => true);
    assert.equal(lookup('LEVER_UP'), 'PANELRED');
    assert.equal(lookup('PANELRED'), 'LEVER_UP');
  });

  test('no lump at all is null, not an empty table', () => {
    assert.equal(readSwitches(new Wad([wadFile('PWAD', 'test.wad', ['THINGS'])])), null);
  });
});

describe('WAD parsing · BOOMEDIT.WAD ships both lumps', () => {
  const boomedit = (): Wad => new Wad([fixtureWad('boomedit.wad')]);

  test('its ANIMATED decodes to the vanilla set plus its own speeds', () => {
    const defs = readAnimated(boomedit())!;
    assert.equal(defs.length, 22);
    assert.equal(defs.filter((d) => d.kind === 'flat').length, 9);
    // Its NUKAGE and SFALL entries run at 2 tics/frame rather than vanilla's 8
    // — the per-entry speed a hardcoded table can't express.
    assert.equal(defs.find((d) => d.start === 'NUKAGE1')?.speedTics, 2);
    assert.equal(defs.find((d) => d.start === 'SFALL1')?.speedTics, 2);
  });

  test('its SWITCHES carries pairs the stock IWADs do not have', () => {
    const pairs = readSwitches(boomedit())!;
    assert.equal(pairs.length, 42, '43 records, the last of which is the terminator');
    assert.ok(pairs.some((p) => p.off === 'SW1ELUP' && p.on === 'SW2ELUP'));
  });
});
