import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bytesOf, bytesOfFile, describeWad } from '../../src/wad/describe.ts';
import { WadFile } from '../../src/wad/wad.ts';
import { manifestEntry } from '../../plugins/wad-manifest.ts';

/**
 * `describeWad` is the one implementation behind the build-time manifest, an uploaded file and a
 * scan of the player's own folder (docs/wad.md § Describing a file without loading it). The two
 * things worth pinning are that it reads a real WAD correctly *from ranges alone*, and that the
 * manifest agrees with it — the drift these three used to be free to have is what it exists to
 * stop.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/wads/${name}`, import.meta.url));
const bytes = (name: string) => readFileSync(fixture(name));

describe('WAD parsing · describing a file without loading it', () => {
  test("a DOOM 1 fixture's type, maps and lump count match what a full parse finds", async () => {
    const buf = bytes('doom1_e1m1.wad');
    const described = await describeWad('doom1_e1m1.wad', bytesOf(buf));
    const parsed = new WadFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    assert.equal(described.type, parsed.type);
    assert.deepEqual(described.maps, parsed.mapNames());
    assert.equal(described.lumpCount, parsed.entries.length);
    assert.deepEqual(described.maps, ['E1M1']);
  });

  test('a map-less add-on reports no maps but still counts its lumps', async () => {
    const described = await describeWad('doom1_lumps.wad', bytesOf(bytes('doom1_lumps.wad')));
    assert.deepEqual(described.maps, []);
    assert.ok(described.lumpCount > 0);
    assert.equal(described.dehacked, false);
  });

  test('a MAPINFO title is picked up without the file being loaded', async () => {
    const described = await describeWad('freedoom_map01.wad', bytesOf(bytes('freedoom_map01.wad')));
    assert.deepEqual(described.maps, ['MAP01']);
    // Whatever the fixture names its level, `levelNames` is keyed by map lump.
    for (const key of Object.keys(described.levelNames)) assert.match(key, /^(E\dM\d|MAP\d\d)$/);
  });

  test('a Boom WAD with its own tables describes as a PWAD with maps', async () => {
    const described = await describeWad('boomedit.wad', bytesOf(bytes('boomedit.wad')));
    assert.equal(described.type, 'PWAD');
    assert.ok(described.maps.length > 0);
  });

  test('anything that is not a WAD throws, with the message an upload shows', async () => {
    await assert.rejects(() => describeWad('notes.txt', bytesOf(new Uint8Array(64))), /not a WAD file/);
    await assert.rejects(() => describeWad('empty.wad', bytesOf(new Uint8Array(4))), /not a WAD file/);
  });

  test('a directory pointing past the end of the file is refused, not read', async () => {
    const buf = Buffer.from(bytes('doom1_e1m1.wad'));
    buf.writeInt32LE(0x7000000, 8);
    await assert.rejects(() => describeWad('broken.wad', bytesOf(buf)), /directory is out of bounds/);
  });

  /**
   * The scan path reads through `Blob.slice` rather than a whole buffer, which is the entire point
   * of `ByteRanges` — a library folder is described without its files ever being read whole.
   */
  test('reading through ranges gives the same answer as reading the whole buffer', async () => {
    const buf = bytes('boomedit.wad');
    const whole = await describeWad('boomedit.wad', bytesOf(buf));
    const sliced = await describeWad('boomedit.wad', bytesOfFile(new Blob([buf])));
    assert.deepEqual(sliced, whole);
  });

  /**
   * The guard that replaces the "these two must agree" comments the manifest plugin and the upload
   * path each used to carry: one describer, so a file cannot list differently served than picked.
   */
  test('the served manifest reports exactly what describeWad found', async () => {
    for (const name of ['boomedit.wad', 'doom1_e1m1.wad', 'freedoom_map01.wad']) {
      const entry = await manifestEntry(fixture(name), 'pwad');
      assert.ok(entry, `${name} should describe`);
      const described = await describeWad(name, bytesOf(bytes(name)));

      assert.equal(entry.type, described.type, name);
      assert.deepEqual(entry.maps, described.maps, name);
      assert.equal(entry.lumpCount, described.lumpCount, name);
      assert.equal(entry.dehacked ?? false, described.dehacked, name);
      assert.deepEqual(entry.levelNames ?? {}, described.levelNames, name);
    }
  });
});
