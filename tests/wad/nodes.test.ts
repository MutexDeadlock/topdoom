import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Wad } from '../../src/wad/wad.ts';
import { wadFile, type Lump } from '../fixtures/wadfile.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { loadMap, NO_LINE, SUBSECTOR_BIT, type DoomMap } from '../../src/wad/map.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';

/**
 * One piece of geometry (a gridmap), serialized into every on-disk BSP encoding,
 * must load back identical: `readBsp` normalizes them all to the same in-memory
 * convention. The encoders below are the test's own — real WADs exercising the
 * parsers end-to-end stay in `tests/fixtures/wads/`, and `glnodes.test.ts` is
 * where a node builder's own GL output is read.
 * See docs/wad.md § Node formats.
 */

class ByteWriter {
  private out: number[] = [];

  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }

  u32(v: number): this {
    return this.u16(v).u16(v >>> 16);
  }

  /** 16.16 fixed point. */
  fixed(v: number): this {
    return this.u32(Math.round(v * 65536));
  }

  name8(s: string): this {
    for (let i = 0; i < 8; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
    return this;
  }

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** Normalized in-memory child -> vanilla's 16-bit disk encoding. */
function vanillaChild(child: number): number {
  return child & SUBSECTOR_BIT ? 0x8000 | (child & 0x7fff) : child;
}

function sectorsLump(map: DoomMap): Lump {
  const sectors = new ByteWriter();
  for (const s of map.sectors) {
    sectors.u16(s.floorHeight).u16(s.ceilHeight).name8(s.floorTex).name8(s.ceilTex);
    sectors.u16(s.light).u16(s.special).u16(s.tag);
  }
  return { name: 'SECTORS', bytes: sectors.bytes() };
}

function sharedLumps(map: DoomMap): Lump[] {
  const vertexes = new ByteWriter();
  for (const v of map.vertexes) vertexes.u16(v.x).u16(v.y);

  const sidedefs = new ByteWriter();
  for (const s of map.sidedefs) {
    sidedefs.u16(s.xOffset).u16(s.yOffset).name8(s.upper).name8(s.lower).name8(s.middle).u16(s.sector);
  }

  const linedefs = new ByteWriter();
  for (const l of map.linedefs) {
    linedefs.u16(l.v1).u16(l.v2).u16(l.flags).u16(l.special).u16(l.tag).u16(l.right).u16(l.left);
  }

  return [
    'MAP01',
    'THINGS',
    { name: 'LINEDEFS', bytes: linedefs.bytes() },
    { name: 'SIDEDEFS', bytes: sidedefs.bytes() },
    { name: 'VERTEXES', bytes: vertexes.bytes() },
  ];
}

function vanillaBsp(map: DoomMap): Lump[] {
  const segs = new ByteWriter();
  for (const s of map.segs) {
    segs.u16(s.v1).u16(s.v2).u16(s.angle).u16(s.linedef).u16(s.direction).u16(s.offset);
  }
  const subsectors = new ByteWriter();
  for (const ss of map.subsectors) subsectors.u16(ss.count).u16(ss.first);
  const nodes = new ByteWriter();
  for (const n of map.nodes) {
    nodes.u16(n.x).u16(n.y).u16(n.dx).u16(n.dy);
    for (let i = 0; i < 8; i++) nodes.u16(0); // both bounding boxes
    nodes.u16(vanillaChild(n.rightChild)).u16(vanillaChild(n.leftChild));
  }
  return [
    { name: 'SEGS', bytes: segs.bytes() },
    { name: 'SSECTORS', bytes: subsectors.bytes() },
    { name: 'NODES', bytes: nodes.bytes() },
  ];
}

function deepV4Bsp(map: DoomMap): Lump[] {
  const segs = new ByteWriter();
  for (const s of map.segs) {
    segs.u32(s.v1).u32(s.v2).u16(s.angle).u16(s.linedef).u16(s.direction).u16(s.offset);
  }
  const subsectors = new ByteWriter();
  for (const ss of map.subsectors) subsectors.u16(ss.count).u32(ss.first);
  const nodes = new ByteWriter().ascii('xNd4').u32(0);
  for (const n of map.nodes) {
    nodes.u16(n.x).u16(n.y).u16(n.dx).u16(n.dy);
    for (let i = 0; i < 8; i++) nodes.u16(0);
    nodes.u32(n.rightChild).u32(n.leftChild);
  }
  return [
    { name: 'SEGS', bytes: segs.bytes() },
    { name: 'SSECTORS', bytes: subsectors.bytes() },
    { name: 'NODES', bytes: nodes.bytes() },
  ];
}

/**
 * The BSP as an extended payload, at the GL level its signature names: 0 is XNOD/ZNOD's
 * own seg record, 1 writes a GL seg's line as a u16 and 2/3 as a u32, and 3 alone writes
 * the partition line in 16.16 fixed point. A GL seg's `v2` goes unwritten — a GL reader
 * takes it from the next seg in the leaf — which is exact here because a gridmap's four
 * segs per subsector already run in a closed loop (`gridmap.ts`), the property a node
 * builder gives every leaf it closes.
 */
function extendedPayload(map: DoomMap, gl: 0 | 1 | 2 | 3): Uint8Array {
  const w = new ByteWriter();
  w.u32(map.vertexes.length).u32(0); // orgVerts, newVerts
  w.u32(map.subsectors.length);
  for (const ss of map.subsectors) w.u32(ss.count); // `first` is implicit
  w.u32(map.segs.length);
  if (gl === 0) {
    for (const s of map.segs) w.u32(s.v1).u32(s.v2).u16(s.linedef).u8(s.direction);
  } else {
    for (const ss of map.subsectors) {
      for (let i = 0; i < ss.count; i++) {
        const seg = map.segs[ss.first + i];
        w.u32(seg.v1).u32(0xffffffff); // no partner seg, which nothing here reads anyway
        if (gl >= 2) w.u32(seg.linedef);
        else w.u16(seg.linedef);
        w.u8(seg.direction);
      }
    }
  }
  w.u32(map.nodes.length);
  for (const n of map.nodes) {
    if (gl === 3) w.fixed(n.x).fixed(n.y).fixed(n.dx).fixed(n.dy);
    else w.u16(n.x).u16(n.y).u16(n.dx).u16(n.dy);
    for (let i = 0; i < 8; i++) w.u16(0); // both bounding boxes
    w.u32(n.rightChild).u32(n.leftChild);
  }
  return w.bytes();
}

/**
 * One extended BSP in the lump that carries it, with the other two left empty: a GL payload
 * rides in SSECTORS, the plain pair in NODES, and a `Z` signature means the body is deflated.
 */
function extendedBsp(signature: string, gl: 0 | 1 | 2 | 3, map: DoomMap): Lump[] {
  const payload = extendedPayload(map, gl);
  const body = signature[0] === 'Z' ? deflateSync(payload) : payload;
  const head = new ByteWriter().ascii(signature).bytes();
  const lump = { name: gl === 0 ? 'NODES' : 'SSECTORS', bytes: Uint8Array.from([...head, ...body]) };
  return gl === 0 ? ['SEGS', 'SSECTORS', lump] : ['SEGS', lump, 'NODES'];
}

/** Loads `map`'s geometry back through `loadMap` with its BSP encoded as `bsp`. */
function withSectors(map: DoomMap, bsp: Lump[]): DoomMap {
  const wad = new Wad([wadFile('PWAD', 'nodes-test.wad', [...sharedLumps(map), ...bsp, sectorsLump(map)])]);
  return loadMap(wad, 'MAP01');
}

describe('WAD parsing · node formats', () => {
  const source = gridMap([
    '.....',
    '.##..',
    '...#.',
    '.....',
  ]).map;

  const base = withSectors(source, vanillaBsp(source));

  test('the vanilla encoding loads back the source geometry', () => {
    assert.equal(base.nodeFormat, 'vanilla');
    assert.deepEqual(base.vertexes, source.vertexes);
    assert.deepEqual(base.segs, source.segs);
    assert.deepEqual(base.subsectors, source.subsectors);
    assert.equal(base.nodes.length, source.nodes.length);
    // Children were normalized: same subsector targets, now as unsigned 32-bit.
    source.nodes.forEach((n, i) => {
      assert.equal(base.nodes[i].rightChild, n.rightChild >>> 0);
      assert.equal(base.nodes[i].leftChild, n.leftChild >>> 0);
    });
  });

  for (const [format, bsp] of [
    ['deep-v4', deepV4Bsp(source)],
    ['xnod', extendedBsp('XNOD', 0, source)],
    ['znod', extendedBsp('ZNOD', 0, source)],
    ['xgln', extendedBsp('XGLN', 1, source)],
    ['zgln', extendedBsp('ZGLN', 1, source)],
    ['xgl2', extendedBsp('XGL2', 2, source)],
    ['zgl2', extendedBsp('ZGL2', 2, source)],
    ['xgl3', extendedBsp('XGL3', 3, source)],
    ['zgl3', extendedBsp('ZGL3', 3, source)],
  ] as const) {
    test(`${format} loads identical to vanilla`, () => {
      const loaded = withSectors(source, [...bsp]);
      assert.equal(loaded.nodeFormat, format);
      assert.deepEqual(loaded.vertexes, base.vertexes);
      assert.deepEqual(loaded.segs, base.segs);
      assert.deepEqual(loaded.subsectors, base.subsectors);
      assert.deepEqual(loaded.nodes, base.nodes);
      assert.deepEqual(buildSubSectorPolys(loaded), buildSubSectorPolys(base));
    });
  }

  test('XNOD appends its own fractional vertexes', () => {
    const w = new ByteWriter().ascii('XNOD');
    w.u32(source.vertexes.length).u32(1);
    w.fixed(100.5).fixed(-32.25);
    w.u32(0).u32(0).u32(0); // no subsectors, segs, nodes
    const loaded = withSectors(source, ['SEGS', 'SSECTORS', { name: 'NODES', bytes: w.bytes() }]);
    const added = loaded.vertexes[loaded.vertexes.length - 1];
    assert.equal(loaded.vertexes.length, source.vertexes.length + 1);
    assert.deepEqual(added, { x: 100.5, y: -32.25 });
  });

  test('a vanilla 0xFFFF child resolves to subsector 0', () => {
    const nodes = new ByteWriter();
    nodes.u16(0).u16(0).u16(1).u16(0);
    for (let i = 0; i < 8; i++) nodes.u16(0);
    nodes.u16(0xffff).u16(0x8000 | 1);
    const loaded = withSectors(source, [
      ...vanillaBsp(source).slice(0, 2),
      { name: 'NODES', bytes: nodes.bytes() },
    ]);
    assert.equal(loaded.nodes[0].rightChild, SUBSECTOR_BIT >>> 0);
    assert.equal(loaded.nodes[0].leftChild, (SUBSECTOR_BIT | 1) >>> 0);
  });

  test('a vanilla child naming a subsector past SSECTORS clamps to 0', () => {
    const nodes = new ByteWriter();
    nodes.u16(0).u16(0).u16(1).u16(0);
    for (let i = 0; i < 8; i++) nodes.u16(0);
    nodes.u16(0x8000 | 0x7abc).u16(0x8000 | 2);
    const loaded = withSectors(source, [
      ...vanillaBsp(source).slice(0, 2),
      { name: 'NODES', bytes: nodes.bytes() },
    ]);
    assert.equal(loaded.nodes[0].rightChild, SUBSECTOR_BIT >>> 0);
    assert.equal(loaded.nodes[0].leftChild, (SUBSECTOR_BIT | 2) >>> 0);
  });

  test('a GL payload whose subsectors and segs disagree is refused, not read past', () => {
    const short = { ...source, subsectors: source.subsectors.slice(0, -1) };
    // The segs are all still written, so the count in the payload outruns what the
    // subsectors claim — gzdoom's own check (`LoadZNodes`).
    const bsp = extendedBsp('XGLN', 1, { ...short, segs: source.segs });
    assert.throws(() => withSectors(short, bsp), /segs/);
  });

  test('a miniseg loads as NO_LINE, whichever width its format names it in', () => {
    for (const [signature, gl, sentinel] of [
      ['XGLN', 1, 0xffff],
      ['XGL2', 2, 0xffffffff],
    ] as const) {
      const mini = { ...source, segs: source.segs.map((s, i) => (i === 0 ? { ...s, linedef: sentinel } : s)) };
      const loaded = withSectors(mini, extendedBsp(signature, gl, mini));
      assert.equal(loaded.segs[0].linedef, NO_LINE, signature);
      assert.equal(loaded.segs[1].linedef, source.segs[1].linedef, 'and its neighbours keep their lines');
      // The leaf still closes: the miniseg ends where the seg after it begins.
      assert.equal(loaded.segs[0].v2, loaded.segs[1].v1, signature);
    }
  });

  test('XGL3 reads the partition line in fixed point, where the others read whole units', () => {
    const fractional = { ...source, nodes: source.nodes.map((n) => ({ ...n, x: n.x + 0.5, dx: -0.25 })) };
    const loaded = withSectors(fractional, extendedBsp('XGL3', 3, fractional));
    assert.equal(loaded.nodes[0].x, fractional.nodes[0].x);
    assert.equal(loaded.nodes[0].dx, -0.25);
    // The same node through XGLN keeps whole units alone, which is all its record holds.
    const whole = withSectors(fractional, extendedBsp('XGLN', 1, fractional));
    assert.ok(Number.isInteger(whole.nodes[0].x));
    assert.equal(whole.nodes[0].dx, 0);
  });
});
