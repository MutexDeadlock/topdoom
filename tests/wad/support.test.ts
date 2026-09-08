import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesOf, describeWad } from '../../src/wad/describe.ts';
import {
  asWadSupport,
  describeSupport,
  nothingLoads,
  supportLevel,
  wadSupport,
  type MapLumpSummary,
  type WadSupport,
} from '../../src/wad/support.ts';
import { fixtureWad, wadFile, type Lump } from '../fixtures/wadfile.ts';

/**
 * The verdict the WAD Library's support column shows (docs/wad.md § Will it run?). Two halves worth
 * pinning: the rules themselves, which are pure and need no WAD at all, and that `describeWad`
 * reaches them from a real directory — the reading is where a rule quietly stops firing.
 */

/**
 * A map group as `wadSupport` sees it: every lump a loadable map needs, with `over` resizing any of
 * them and `omit` dropping them entirely — a lump that is *absent* and one that is present but
 * empty are different things an editor writes, and both have to reach the same verdict.
 */
function mapSummary(
  name: string,
  over: Record<string, number> = {},
  omit: readonly string[] = [],
): MapLumpSummary {
  const lumps = new Map<string, number>(
    ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS'].map(
      (lump) => [lump, 100],
    ),
  );
  for (const [lump, size] of Object.entries(over)) lumps.set(lump, size);
  for (const lump of omit) lumps.delete(lump);
  return { name, lumps };
}

const codes = (support: WadSupport) => support.map((issue) => issue.code);

/**
 * A UDMF map group: the bracketed lumps `wadSupport` judges one by, with the namespace
 * `describe.ts` would have sniffed off the TEXTMAP head already filled in.
 */
function udmfSummary(
  name: string,
  namespace: string,
  over: Record<string, number> = {},
  omit: readonly string[] = [],
): MapLumpSummary {
  const lumps = new Map<string, number>([
    ['TEXTMAP', 400],
    ['ZNODES', 100],
    ['ENDMAP', 0],
  ]);
  for (const [lump, size] of Object.entries(over)) lumps.set(lump, size);
  for (const lump of omit) lumps.delete(lump);
  return { name, lumps, udmfNamespace: namespace };
}

/**
 * The lumps of one plain, loadable map, as `wadFile` takes them. `over` replaces a lump's bytes —
 * an empty `Uint8Array` for a lump that is present but says nothing.
 */
function okMap(name: string, over: Record<string, Uint8Array> = {}): Lump[] {
  const sizes: Record<string, number> = {
    THINGS: 10,
    LINEDEFS: 14,
    SIDEDEFS: 30,
    VERTEXES: 4,
    SEGS: 12,
    SSECTORS: 4,
    NODES: 28,
    SECTORS: 26,
  };
  return [
    name,
    ...Object.entries(sizes).map(([lump, size]) => ({
      name: lump,
      bytes: over[lump] ?? new Uint8Array(size),
    })),
  ];
}

async function support(name: string, lumps: readonly Lump[]): Promise<WadSupport> {
  const file = wadFile('PWAD', name, lumps);
  return (await describeWad(name, bytesOf(file.buffer))).support;
}

/** A real WAD from `tests/fixtures/wads/`, described rather than loaded. */
async function describeFixture(file: string) {
  return describeWad(file, bytesOf(fixtureWad(file).buffer));
}

describe('WAD parsing · will it run?', () => {
  test('a plain map with every lump it needs is fully supported', () => {
    const verdict = wadSupport([mapSummary('MAP01')], false);
    assert.deepEqual(verdict, []);
    assert.equal(supportLevel(verdict), 'ok');
  });

  test('a file with no maps at all is supported — a texture pack has nothing to break', () => {
    assert.equal(supportLevel(wadSupport([], false)), 'ok');
  });

  test('a UDMF map is judged by its own lumps, not the binary ones it does not have', () => {
    const udmf = udmfSummary('MAP01', 'zdoom');
    const verdict = wadSupport([udmf], false);
    assert.deepEqual(verdict, [{ code: 'udmf', maps: ['MAP01'] }]);
    // Broken: its progression runs on specials that never fire. It still loads, so the player
    // may pick it — `nothingLoads` below is what that costs.
    assert.equal(supportLevel(verdict), 'broken');
  });

  test('a UDMF map in a Doom-specials namespace plays in full', () => {
    for (const namespace of ['doom', 'Doom', 'zdoomtranslated']) {
      assert.deepEqual(wadSupport([udmfSummary('MAP01', namespace)], false), [], namespace);
    }
  });

  test('a UDMF map without ZNODES has no BSP, and without ENDMAP no shape at all', () => {
    assert.deepEqual(codes(wadSupport([udmfSummary('MAP01', 'doom', { ZNODES: 0 })], false)), ['noBsp']);
    assert.deepEqual(codes(wadSupport([udmfSummary('MAP01', 'doom', {}, ['ZNODES'])], false)), ['noBsp']);
    assert.deepEqual(codes(wadSupport([udmfSummary('MAP01', 'doom', {}, ['ENDMAP'])], false)), ['incomplete']);
  });

  test('a map missing a lump a level is made of will not load', () => {
    for (const lump of ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SECTORS']) {
      assert.deepEqual(codes(wadSupport([mapSummary('MAP01', {}, [lump])], false)), ['incomplete'], lump);
      // Present but empty is the same thing — an editor writes the entry either way.
      assert.deepEqual(codes(wadSupport([mapSummary('MAP01', { [lump]: 0 })], false)), ['incomplete'], lump);
    }
  });

  /**
   * docs/wad.md § Node formats — an extended payload lives in one lump and leaves the other
   * empty: NODES for XNOD/ZNOD, SSECTORS for the GL family. Either way the map loads.
   */
  test('an extended BSP is supported, with the lump it did not use left empty', () => {
    const empties: Record<string, number>[] = [
      { SEGS: 0, SSECTORS: 0 },
      { SEGS: 0, NODES: 0 },
    ];
    for (const empty of empties) {
      const nodes = mapSummary('MAP01', empty);
      assert.equal(supportLevel(wadSupport([nodes], false)), 'ok', JSON.stringify(empty));
    }
  });

  test('a single-subsector map keeps its verdict — SSECTORS alone is a BSP', () => {
    assert.equal(supportLevel(wadSupport([mapSummary('MAP01', { NODES: 0 })], false)), 'ok');
  });

  test('a map with neither NODES nor SSECTORS has no BSP to draw from', () => {
    assert.deepEqual(codes(wadSupport([mapSummary('MAP01', { NODES: 0 }, ['SSECTORS'])], false)), ['noBsp']);
  });

  test('a Hexen map loads but is only partly played', () => {
    const verdict = wadSupport([mapSummary('MAP01', { BEHAVIOR: 200 })], false);
    assert.deepEqual(verdict, [{ code: 'hexen', maps: ['MAP01'] }]);
    assert.equal(supportLevel(verdict), 'partial');
  });

  test('a UDMF map carrying a BEHAVIOR lump too is judged as UDMF, not Hexen', () => {
    const both = udmfSummary('MAP01', 'zdoom', { BEHAVIOR: 200 });
    assert.deepEqual(codes(wadSupport([both], false)), ['udmf']);
  });

  test('a DEHACKED shortfall is a file-level reason, naming no maps', () => {
    const verdict = wadSupport([mapSummary('MAP01')], true);
    assert.deepEqual(verdict, [{ code: 'dehacked', maps: [] }]);
    assert.equal(supportLevel(verdict), 'partial');
  });

  test('the worst issue decides the level, and issues are reported worst first', () => {
    const verdict = wadSupport(
      [mapSummary('MAP01', { BEHAVIOR: 200 }), udmfSummary('MAP02', 'doom', { ZNODES: 0 }), mapSummary('MAP03')],
      true,
    );
    assert.equal(supportLevel(verdict), 'broken');
    assert.deepEqual(verdict, [
      { code: 'noBsp', maps: ['MAP02'] },
      { code: 'hexen', maps: ['MAP01'] },
      { code: 'dehacked', maps: [] },
    ]);
  });

  test('every map raising the same reason is listed against it once', () => {
    const maps = ['MAP01', 'MAP02', 'MAP03'].map((name) => mapSummary(name, { BEHAVIOR: 200 }));
    assert.deepEqual(wadSupport(maps, false), [{ code: 'hexen', maps: ['MAP01', 'MAP02', 'MAP03'] }]);
  });
});

/**
 * What the WAD Library greys a row out on (docs/menu-wads.md § WAD Library). Deliberately narrower
 * than `broken`: one bad map in a megawad must not cost the player the other thirty-one.
 */
describe('WAD parsing · a file with nothing left to load', () => {
  // A UDMF map shipped without its ZNODES: refused, there being no node builder here.
  const udmf = (name: string) => udmfSummary(name, 'doom', { ZNODES: 0 });

  /**
   * The `udmf` code is the one `broken` reason a file survives: such a map loads and is walkable,
   * and is flagged for what will not run in it, so refusing the row would take away a file the
   * player deliberately chose to try.
   */
  test('a ZDoom-namespace UDMF file is flagged broken but stays pickable', () => {
    const maps = ['MAP01', 'MAP02'].map((name) => udmfSummary(name, 'zdoom'));
    const verdict = wadSupport(maps, false);
    assert.equal(supportLevel(verdict), 'broken');
    assert.equal(nothingLoads(verdict, 2), false);
    // And it does not claim the file will not load.
    assert.match(describeSupport(verdict, 2), /^This WAD may not play as intended\n/);
  });

  test('a ZDoom-namespace map among refused ones does not save the file on its own', () => {
    const verdict = wadSupport([udmf('MAP01'), udmfSummary('MAP02', 'zdoom')], false);
    assert.equal(nothingLoads(verdict, 2), false);
    // Every map refused for real is still a refused file, whatever else is flagged.
    assert.equal(nothingLoads(wadSupport([udmf('MAP01'), udmf('MAP02')], false), 2), true);
  });

  test('a file whose every map is refused has nothing to pick it for', () => {
    const verdict = wadSupport([udmf('MAP01'), udmf('MAP02')], false);
    assert.equal(nothingLoads(verdict, 2), true);
  });

  test('one refused map among many leaves the rest playable', () => {
    const maps = [udmf('MAP01'), mapSummary('MAP02'), mapSummary('MAP03')];
    const verdict = wadSupport(maps, false);
    // Still `broken` — the column says so — but the file is emphatically still pickable.
    assert.equal(supportLevel(verdict), 'broken');
    assert.equal(nothingLoads(verdict, 3), false);
  });

  test('a merely partial file is never refused, however much of it is partial', () => {
    const maps = ['MAP01', 'MAP02'].map((name) => mapSummary(name, { BEHAVIOR: 200 }));
    assert.equal(nothingLoads(wadSupport(maps, true), 2), false);
  });

  test('a map-less add-on has nothing to fail to load, patch or no patch', () => {
    assert.equal(nothingLoads(wadSupport([], true), 0), false);
    assert.equal(nothingLoads([], 0), false);
  });

  test('refused and partial maps together still leave the partial ones to play', () => {
    const verdict = wadSupport([udmf('MAP01'), mapSummary('MAP02', { BEHAVIOR: 200 })], false);
    assert.equal(nothingLoads(verdict, 2), false);
  });

  test('a fully supported file is never refused', () => {
    assert.equal(nothingLoads(wadSupport([mapSummary('MAP01')], false), 1), false);
  });
});

describe('WAD parsing · the support tooltip', () => {
  test('a supported file says so in one line', () => {
    assert.equal(describeSupport([], 32), 'Fully supported');
  });

  test('"some maps" only when the reasons leave other maps alone', () => {
    const partial = wadSupport([mapSummary('MAP01', { BEHAVIOR: 200 }), mapSummary('MAP02')], false);
    assert.match(describeSupport(partial, 2), /^Some maps may not play as intended\n/);

    const all = wadSupport([mapSummary('MAP01', { BEHAVIOR: 200 })], false);
    assert.match(describeSupport(all, 1), /^This WAD may not play as intended\n/);
  });

  test('a file-level reason is about the whole WAD, however few maps it ships', () => {
    assert.match(describeSupport(wadSupport([mapSummary('MAP01')], true), 1), /^This WAD may not play/);
  });

  test('each reason names three maps and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      mapSummary(`MAP${String(i + 1).padStart(2, '0')}`, { BEHAVIOR: 1 }),
    );
    const text = describeSupport(wadSupport(many, false), 11);
    assert.match(text, /• MAP01, MAP02, MAP03 and 8 more: Hexen format/);
  });

  test('the maps a reason names are sorted, not in the order the directory found them', () => {
    const maps = ['MAP20', 'MAP03', 'MAP11'].map((name) => mapSummary(name, { BEHAVIOR: 1 }));
    assert.match(describeSupport(wadSupport(maps, false), 3), /• MAP03, MAP11, MAP20: Hexen format/);
  });

  test('exactly three maps are all named, with nothing left to count', () => {
    const maps = ['MAP01', 'MAP02', 'MAP03'].map((name) => mapSummary(name, { BEHAVIOR: 1 }));
    const text = describeSupport(wadSupport(maps, false), 4);
    assert.match(text, /• MAP01, MAP02, MAP03: Hexen format/);
    assert.doesNotMatch(text, /more/);
  });

  test('a broken file says it will not load', () => {
    const broken = wadSupport([udmfSummary('MAP01', 'doom', { ZNODES: 0 })], false);
    assert.match(describeSupport(broken, 1), /^This WAD will not load\n• MAP01: no BSP nodes/);
  });
});

describe('WAD parsing · reaching the verdict from a directory', () => {
  test('a real Hexen fixture is found partial, by its BEHAVIOR lump', async () => {
    const described = await describeFixture('mock2_map02_hexen.wad');
    assert.deepEqual(described.support, [{ code: 'hexen', maps: ['MAP02'] }]);
  });

  test('a real vanilla fixture is found supported', async () => {
    assert.deepEqual((await describeFixture('doom1_e1m1.wad')).support, []);
  });

  test('a TEXTMAP after the marker is read as UDMF, and its namespace off the lump head', async () => {
    const group = (namespace: string): Lump[] => [
      'MAP01',
      { name: 'TEXTMAP', text: `// a comment first\nnamespace = "${namespace}";` },
      { name: 'ZNODES', bytes: new Uint8Array(8) },
      'ENDMAP',
    ];
    const zdoom = await support('udmf.wad', group('ZDoom'));
    assert.deepEqual(zdoom, [{ code: 'udmf', maps: ['MAP01'] }]);
    // A Doom-specials namespace raises nothing: the map plays in full.
    assert.deepEqual(await support('udmfdoom.wad', group('Doom')), []);
  });

  test('a UDMF map shipped without ZNODES is caught', async () => {
    const verdict = await support('udmfnobsp.wad', [
      'MAP01',
      { name: 'TEXTMAP', text: 'namespace = "doom";' },
      'ENDMAP',
    ]);
    assert.deepEqual(codes(verdict), ['noBsp']);
  });

  test('a real GL-node fixture is found supported', async () => {
    assert.deepEqual((await describeFixture('doom1_e1m1_xgl.wad')).support, []);
  });

  test('a map shipped without nodes is caught', async () => {
    const empty = new Uint8Array(0);
    const lumps = okMap('MAP01', { NODES: empty, SSECTORS: empty });
    assert.deepEqual(codes(await support('nonodes.wad', lumps)), ['noBsp']);
  });

  /** The walk has to close a group when a lump that isn't part of one turns up, or the next map's
      verdict inherits the previous map's lumps. */
  test('each map is judged on its own lumps, not on the ones before it', async () => {
    const verdict = await support('two.wad', [
      ...okMap('MAP01'),
      'F_START',
      'F_END',
      'MAP02',
      { name: 'TEXTMAP', text: 'namespace = "zdoom";' },
      { name: 'ZNODES', bytes: new Uint8Array(8) },
      'ENDMAP',
    ]);
    assert.deepEqual(verdict, [{ code: 'udmf', maps: ['MAP02'] }]);
  });

  /** UDMF brackets its group (udmf.txt § II.B): port lumps of any name up to ENDMAP belong to
      the map, and the first lump after ENDMAP does not. */
  test('a UDMF group keeps its oddly-named lumps and ends at ENDMAP', async () => {
    const verdict = await support('bracket.wad', [
      'MAP01',
      { name: 'TEXTMAP', text: 'namespace = "doom";' },
      'LIGHTMAP', // a port lump the walk must step over to reach ZNODES
      { name: 'ZNODES', bytes: new Uint8Array(8) },
      'ENDMAP',
      ...okMap('MAP02'),
    ]);
    assert.deepEqual(verdict, []);
  });

  test('a marker with nothing behind it is a map missing everything', async () => {
    assert.deepEqual(codes(await support('bare.wad', ['MAP01', 'F_START'])), ['incomplete']);
  });

  /**
   * Only `unsupported` counts: a patch this engine has no *target* for (a finale screen) changes
   * nothing about how a level plays, and counting those turned ordinary DEH add-ons amber.
   */
  test('a DEHACKED asking for a branching pointer is a shortfall; a repoint that lands is not', async () => {
    const patched = await support('deh.wad', [
      ...okMap('MAP01'),
      { name: 'DEHACKED', text: 'Patch File for DeHackEd v3.0\n\n[CODEPTR]\nFrame 186 = A_RandomJump\n' },
    ]);
    assert.deepEqual(codes(patched), ['dehacked']);

    // A repoint the frame walker reads lands, so it says nothing about the file's support.
    const repointed = await support('deh3.wad', [
      ...okMap('MAP01'),
      { name: 'DEHACKED', text: 'Patch File for DeHackEd v3.0\n\n[CODEPTR]\nFrame 186 = A_Chase\n' },
    ]);
    assert.deepEqual(codes(repointed), []);

    const strings = await support('deh2.wad', [
      ...okMap('MAP01'),
      { name: 'DEHACKED', text: 'Patch File for DeHackEd v3.0\n\n[STRINGS]\nHUSTR_1 = Entryway\n' },
    ]);
    assert.deepEqual(strings, []);
  });
});

describe('WAD parsing · a stored verdict read back', () => {
  test('a verdict survives a round trip through JSON', () => {
    const verdict = wadSupport([mapSummary('MAP01', { BEHAVIOR: 1 })], true);
    assert.deepEqual(asWadSupport(JSON.parse(JSON.stringify(verdict))), verdict);
  });

  test('anything that is not a verdict reads as unknown, which is not "supported"', () => {
    for (const value of [undefined, null, 42, 'ok', {}, { level: 'ok', issues: [] }]) {
      assert.equal(asWadSupport(value), undefined, JSON.stringify(value) ?? 'undefined');
    }
    assert.equal(asWadSupport([{ code: 'nope', maps: [] }]), undefined);
    assert.equal(asWadSupport([{ code: 'hexen', maps: [7] }]), undefined);
    // An empty verdict is a real one: the file was checked and nothing was wrong with it.
    assert.deepEqual(asWadSupport([]), []);
  });
});
