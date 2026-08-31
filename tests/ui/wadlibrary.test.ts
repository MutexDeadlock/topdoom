import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderTree, filterTree, scanResult } from '../../src/ui/menu/library.ts';
import type { WadSource } from '../../src/wad/library.ts';

/**
 * The WAD Library overlay's left pane (docs/menu.md § WAD Library). The tree is a flat list of rows
 * carrying their own depth, built purely from the sources the menu holds — which is what lets it be
 * checked without a DOM. What matters is the grouping: which files land under which row, that a
 * parent folder always precedes its children, and that a row lists its own WADs while counting
 * everything at or below it.
 */
function source(key: string, over: Partial<WadSource> = {}): WadSource {
  return {
    key,
    id: `id:${key}`,
    label: key.split('/').pop() ?? key,
    type: 'PWAD',
    maps: [],
    lumpCount: 1,
    levelNames: {},
    size: 0,
    origin: 'server',
    bytes: () => Promise.reject(new Error('the tree must not need the bytes')),
    ...over,
  };
}

const lib = (path: string, over: Partial<WadSource> = {}) =>
  source(`lib:${path}`, {
    label: path.split('/').pop()!,
    origin: 'library',
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    ...over,
  });

const byId = (nodes: ReturnType<typeof buildFolderTree>, id: string) => {
  const node = nodes.find((n) => n.id === id);
  assert.ok(node, `expected a "${id}" row`);
  return node;
};

describe('Menu · the WAD Library tree', () => {
  test('the server groups split on the folder a file is served from, not its signature', () => {
    const nodes = buildFolderTree(
      [
        source('DOOM2.WAD', { type: 'IWAD', folder: 'iwad' }),
        source('SCYTHE.WAD', { folder: 'pwad' }),
        // A PWAD-signed mapset placed in game/iwad/ is a game WAD — docs/wad.md § The `public/game/` manifest.
        source('EPIC.WAD', { type: 'PWAD', folder: 'iwad' }),
      ],
      'Your library',
      true,
    );

    assert.deepEqual(byId(nodes, 'server:iwad').sources.map((s) => s.label), ['DOOM2.WAD', 'EPIC.WAD']);
    assert.deepEqual(byId(nodes, 'server:pwad').sources.map((s) => s.label), ['SCYTHE.WAD']);
    // No `topdoom` row above the pair any more — the panel heading carries that, and its total.
    assert.equal(
      nodes.some((n) => n.id === 'server'),
      false,
    );
    assert.equal(byId(nodes, 'server:iwad').parent, undefined);
    assert.equal(byId(nodes, 'server:pwad').parent, undefined);
  });

  test('a manifest with no folder field falls back to the signature rather than vanishing', () => {
    const nodes = buildFolderTree(
      [source('DOOM.WAD', { type: 'IWAD' }), source('AV.WAD', { type: 'PWAD' })],
      'Your library',
      true,
    );
    assert.deepEqual(byId(nodes, 'server:iwad').sources.map((s) => s.label), ['DOOM.WAD']);
    assert.deepEqual(byId(nodes, 'server:pwad').sources.map((s) => s.label), ['AV.WAD']);
  });

  /**
   * A folder that opens onto nothing is not worth a row — with one exception, and one exception to
   * *that*. A library root with a folder behind it stays even while empty, because then it reports
   * something: the folder held no WADs. With no folder set at all it goes too, since the panel
   * heading and the `Choose folder…` button under it are already the whole invitation.
   */
  test('an empty library root is a row once a folder is set', () => {
    const nodes = buildFolderTree([], 'Your library', true);
    assert.deepEqual(
      nodes.map((n) => n.id),
      ['library'],
    );
    assert.equal(byId(nodes, 'library').label, 'Your library');
  });

  test('with no folder set there is no library row at all', () => {
    assert.deepEqual(buildFolderTree([], 'Your library', false), []);
    // The served rows are unaffected — only the library root turns on the flag.
    const nodes = buildFolderTree([source('SCYTHE.WAD', { folder: 'pwad' })], 'Your library', false);
    assert.deepEqual(
      nodes.map((n) => n.id),
      ['server:pwad'],
    );
  });

  test('an empty served group drops out while its populated sibling stays', () => {
    // Only add-ons on the server: `Game WADs` has nothing to show and should not be offered.
    const nodes = buildFolderTree([source('SCYTHE.WAD', { folder: 'pwad' })], 'wads', true);
    assert.equal(
      nodes.some((n) => n.id === 'server:iwad'),
      false,
    );
    assert.deepEqual(byId(nodes, 'server:pwad').sources.map((s) => s.label), ['SCYTHE.WAD']);
  });

  test('library subfolders become rows, nested by depth and ordered parent-first', () => {
    const nodes = buildFolderTree(
      [
        lib('loose.wad'),
        lib('megawads/scythe/MAP01.wad'),
        lib('megawads/av.wad'),
        lib('vanilla/req.wad'),
      ],
      'wads',
      true,
    );

    const library = nodes.filter((n) => n.id.startsWith('library'));
    assert.deepEqual(
      library.map((n) => [n.id, n.label, n.depth]),
      [
        ['library', 'wads', 0],
        ['library/megawads', 'megawads', 1],
        ['library/megawads/scythe', 'scythe', 2],
        ['library/vanilla', 'vanilla', 1],
      ],
    );
    // A parent must never come after its own child, or the flat rows stop reading as a tree.
    assert.ok(library.findIndex((n) => n.id === 'library/megawads') < library.findIndex((n) => n.id === 'library/megawads/scythe'));
  });

  /**
   * The two counts are different questions. `sources` is what the file pane lists — the folder's
   * own WADs, the way a file manager behaves — while `total` is everything at or below it, which
   * is what the row's count shows and what keeps a pure container folder on screen.
   */
  test('a row lists only its own WADs, but counts everything beneath it', () => {
    const nodes = buildFolderTree(
      [lib('loose.wad'), lib('megawads/av.wad'), lib('megawads/scythe/MAP01.wad')],
      'wads',
      true,
    );

    assert.deepEqual(byId(nodes, 'library').sources.map((s) => s.label), ['loose.wad']);
    assert.equal(byId(nodes, 'library').total, 3);
    assert.deepEqual(byId(nodes, 'library/megawads').sources.map((s) => s.label), ['av.wad']);
    assert.equal(byId(nodes, 'library/megawads').total, 2);
    assert.deepEqual(byId(nodes, 'library/megawads/scythe').sources.map((s) => s.label), ['MAP01.wad']);
    assert.equal(byId(nodes, 'library/megawads/scythe').total, 1);
  });

  test('every WAD in a nested library sits in exactly one folder row', () => {
    const paths = ['iwad/DOOM2.WAD', 'pwad/SCYTHE.WAD', 'pwad/deep/NUTS.WAD'];
    const nodes = buildFolderTree(paths.map((p) => lib(p)), 'wads', true);
    const listed = nodes.filter((n) => n.id.startsWith('library')).flatMap((n) => n.sources);
    assert.equal(listed.length, paths.length);
    assert.equal(new Set(listed).size, paths.length);
    assert.equal(byId(nodes, 'library').total, paths.length);
  });

  /**
   * A WAD's `folder` names only the folder it sits in, so a file buried three deep names no
   * intermediate at all. Those rows have to be synthesized or the deepest one is indented under a
   * parent that isn't there — and, since collapsing walks `parent`, has nothing to fold into.
   */
  test('folders with no WAD directly in them are still rows, linked parent to child', () => {
    const nodes = buildFolderTree([lib('doom/mega/scythe/S.WAD')], 'wads', true);
    const library = nodes.filter((n) => n.id.startsWith('library'));

    assert.deepEqual(
      library.map((n) => [n.id, n.label, n.depth, n.parent]),
      [
        ['library', 'wads', 0, undefined],
        ['library/doom', 'doom', 1, 'library'],
        ['library/doom/mega', 'mega', 2, 'library/doom'],
        ['library/doom/mega/scythe', 'scythe', 3, 'library/doom/mega'],
      ],
    );
    // Only the innermost folder owns the file; the rest are containers that merely count it.
    for (const node of library) assert.equal(node.total, 1, node.id);
    assert.deepEqual(
      library.filter((n) => n.sources.length > 0).map((n) => n.id),
      ['library/doom/mega/scythe'],
    );
  });

  /**
   * A-Z among siblings, case-insensitively and with digit runs read as numbers, while a parent
   * still precedes its own children. `a`, `a/b` and `aa` are the trap: one flat sort of the full
   * paths has to get both orders out of a single comparison, and whether `a/b` lands under `a` or
   * after `aa` then depends on how the collation ranks `/` against letters. Sorting one level at a
   * time needs no such guarantee.
   */
  test('folders are ordered A-Z within each level, parents still first', () => {
    const nodes = buildFolderTree(
      ['Zebra/z.wad', 'alpha/a.wad', 'a/b/deep.wad', 'aa/x.wad', 'Map10/m.wad', 'Map2/m.wad'].map((p) => lib(p)),
      'wads',
      true,
    );

    assert.deepEqual(
      nodes.filter((n) => n.id.startsWith('library')).map((n) => n.label),
      ['wads', 'a', 'b', 'aa', 'alpha', 'Map2', 'Map10', 'Zebra'],
    );
    // `b` is a child of `a`, not a sibling that merely sorted between `a` and `aa`.
    assert.equal(byId(nodes, 'library/a/b').parent, 'library/a');
  });

  /** `public/game/pwad/` is scanned recursively now, so a served folder nests exactly like the
      player's own — one `rootedSubtree` builds both. */
  test('a served folder shows its subdirectories, rooted under Add-ons', () => {
    const nodes = buildFolderTree(
      [
        source('SCYTHE.WAD', { folder: 'pwad' }),
        source('AV.WAD', { folder: 'pwad/megawads' }),
        source('HR.WAD', { folder: 'pwad/megawads/classic' }),
      ],
      'wads',
      true,
    );

    assert.deepEqual(
      nodes.filter((n) => n.id.startsWith('server:pwad')).map((n) => [n.id, n.label, n.depth, n.parent]),
      [
        ['server:pwad', 'Add-ons', 0, undefined],
        ['server:pwad/megawads', 'megawads', 1, 'server:pwad'],
        ['server:pwad/megawads/classic', 'classic', 2, 'server:pwad/megawads'],
      ],
    );
    assert.deepEqual(byId(nodes, 'server:pwad').sources.map((s) => s.label), ['SCYTHE.WAD']);
    assert.equal(byId(nodes, 'server:pwad').total, 3);
  });

  test('a sibling folder sharing a name prefix is not its parent', () => {
    // `library:mega` is a string prefix of `library:megawads` — collapsing has to walk `parent`
    // rather than test id prefixes, or folding `mega` would hide an unrelated sibling.
    const nodes = buildFolderTree([lib('mega/a.wad'), lib('megawads/b.wad')], 'wads', true);
    assert.equal(byId(nodes, 'library/mega').parent, 'library');
    assert.equal(byId(nodes, 'library/megawads').parent, 'library');
  });

  test('a sibling folder sharing a name prefix is not counted as a child', () => {
    const nodes = buildFolderTree([lib('mega/a.wad'), lib('megawads/b.wad')], 'wads', true);
    assert.deepEqual(byId(nodes, 'library/mega').sources.map((s) => s.label), ['a.wad']);
    assert.deepEqual(byId(nodes, 'library/megawads').sources.map((s) => s.label), ['b.wad']);
  });

  test('the uploads row appears only once something has been dropped', () => {
    assert.equal(buildFolderTree([source('DOOM2.WAD', { folder: 'iwad' })], 'wads', true).some((n) => n.id === 'uploads'), false);

    const nodes = buildFolderTree([source('upload:X.WAD:1', { label: 'X.WAD', origin: 'upload' })], 'wads', true);
    assert.deepEqual(byId(nodes, 'uploads').sources.map((s) => s.label), ['X.WAD']);
  });
});

/**
 * What a finished scan reports. The load-bearing case is a folder that produced no sources at all:
 * an empty folder and a folder whose every WAD failed to parse are the same picture in the tree and
 * need opposite responses from the player, so the skipped file's own reason has to reach the status
 * line. A pick that reported nothing at all is what sent the player debugging in the first place.
 */
describe('WAD library · what a scan reports', () => {
  test('an empty folder says so, as an error — the player asked for WADs and got none', () => {
    assert.deepEqual(scanResult(0, []), ['No WADs found in that folder.', true]);
  });

  test('nothing readable quotes the first reason rather than only counting', () => {
    const [text, isError] = scanResult(0, [
      { path: 'mega/broken.wad', reason: 'not a WAD file' },
      { path: 'mega/other.wad', reason: 'unreadable' },
    ]);
    assert.equal(isError, true);
    assert.match(text, /2 skipped/);
    assert.match(text, /mega\/broken\.wad: not a WAD file/);
  });

  test('a partial scan reports both halves and is not an error', () => {
    const [text, isError] = scanResult(7, [{ path: 'junk.wad', reason: 'not a WAD file' }]);
    assert.equal(isError, false);
    assert.match(text, /Found 7 WADs/);
    assert.match(text, /skipped 1/);
  });

  test('a clean scan is just the count, singular when there is one', () => {
    assert.deepEqual(scanResult(1, []), ['Found 1 WAD.', false]);
    assert.deepEqual(scanResult(12, []), ['Found 12 WADs.', false]);
  });
});

/**
 * The header's filter, over the same tree (docs/menu.md § WAD Library). It has to reach both kinds
 * of row: a file name pulls the folders holding it on screen, and a folder name opens the folder.
 */
describe('WAD library · the filter', () => {
  const tree = () =>
    buildFolderTree(
      [
        source('server:iwad/DOOM2.WAD', { type: 'IWAD', folder: 'iwad' }),
        source('server:pwad/SCYTHE.WAD', { folder: 'pwad' }),
        source('lib:mega/hell/valiant.wad', { origin: 'library', folder: 'mega/hell' }),
        source('lib:mega/nuts.wad', { origin: 'library', folder: 'mega' }),
        source('lib:vanilla/scythe2.wad', { origin: 'library', folder: 'vanilla' }),
      ],
      'Your library',
      true,
    );

  test('an empty filter keeps everything, and every folder lists in full', () => {
    const nodes = tree();
    const { rows, whole } = filterTree(nodes, '');
    assert.equal(rows.size, nodes.length);
    assert.equal(whole.size, nodes.length);
  });

  test('a file name pulls the folders above it on screen', () => {
    const { rows, whole } = filterTree(tree(), 'valiant');
    assert.ok(rows.has('library/mega/hell'), 'the folder holding the match');
    assert.ok(rows.has('library/mega'), 'and every folder above it');
    assert.ok(rows.has('library'));
    assert.ok(!rows.has('library/vanilla'), 'a folder with no match is gone');
    assert.ok(!rows.has('server:pwad'));
    // Those folders are on screen for one file, so they list that file — not their whole contents.
    // The game WADs are the exemption below, and are the only thing `whole` holds here.
    assert.deepEqual([...whole], ['server:iwad']);
  });

  test('a folder name matches the folder itself, and opens it wholesale', () => {
    const { rows, whole } = filterTree(tree(), 'vanilla');
    assert.ok(rows.has('library/vanilla'));
    assert.ok(rows.has('library'), 'its parent comes along so it can be reached');
    assert.ok(whole.has('library/vanilla'), 'asking for a folder by name asks for what is in it');
    assert.ok(!whole.has('library'), 'but not for its parent, which was only a route');
  });

  test('a matched folder hands `whole` down to everything nested inside it', () => {
    const { rows, whole } = filterTree(tree(), 'mega');
    assert.ok(whole.has('library/mega'));
    assert.ok(whole.has('library/mega/hell'), 'a subfolder of a match is part of the match');
    assert.ok(rows.has('library/mega/hell'));
  });

  test('the filter is case-insensitive and matches anywhere in the name', () => {
    assert.ok(filterTree(tree(), 'scyth').rows.has('server:pwad'));
    assert.ok(filterTree(tree(), 'doom2').rows.has('server:iwad'));
  });

  test('a filter nothing matches leaves only the exempt game WADs', () => {
    const { rows, hits } = filterTree(tree(), 'plutonia');
    assert.deepEqual([...rows], ['server:iwad']);
    assert.equal(hits.size, 0, 'nothing was actually found');
  });

  /**
   * Finding an add-on and seeing it wants the other game is a normal outcome of a search, so the
   * game WADs stay reachable throughout — otherwise switching to the one it needs means clearing
   * the filter, switching, and typing the search again.
   */
  test('the game WADs survive any filter, listed in full', () => {
    for (const filter of ['valiant', 'vanilla', 'plutonia']) {
      const { rows, whole } = filterTree(tree(), filter);
      assert.ok(rows.has('server:iwad'), `${filter}: still on screen`);
      assert.ok(whole.has('server:iwad'), `${filter}: and listed entire, not filtered`);
    }
  });

  test('`hits` excludes the exempt row, so the pane can be aimed at the real match', () => {
    const { hits } = filterTree(tree(), 'valiant');
    assert.ok(!hits.has('server:iwad'), 'the exemption is not a find');
    assert.ok(hits.has('library/mega/hell'), 'the folder that actually matched is');
  });
});
