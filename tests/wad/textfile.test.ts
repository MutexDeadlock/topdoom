import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextFile, siblingTextFile } from '../../src/wad/textfile.ts';

/**
 * The `.txt` a release ships beside its WAD (docs/wad.md § The text file beside a WAD): which name
 * counts as that file, and how DOS-era bytes become text. Both halves are pure, so neither needs a
 * folder or a DOM.
 */
describe('WAD text file · finding the sibling', () => {
  test('the base name matches whatever case either side is spelled in', () => {
    assert.equal(siblingTextFile('DOOM2.WAD', ['doom2.txt']), 'doom2.txt');
    assert.equal(siblingTextFile('scythe.wad', ['README.TXT', 'SCYTHE.TXT']), 'SCYTHE.TXT');
  });

  test('the name that comes back is the one on disk, not the one asked for', () => {
    // It is what the fetch or the file handle then has to open, so a normalised answer would 404.
    assert.equal(siblingTextFile('GoingDown.wad', ['GOINGDOWN.TXT']), 'GOINGDOWN.TXT');
  });

  test('only the WAD’s own name counts', () => {
    assert.equal(siblingTextFile('scythe.wad', ['scythe2.txt', 'readme.txt', 'scythe.nfo']), undefined);
  });
});

describe('WAD text file · decoding', () => {
  test('UTF-8 is read as UTF-8', () => {
    assert.equal(decodeTextFile(new TextEncoder().encode('mouldy — Going Down')), 'mouldy — Going Down');
  });

  test('a CP437 banner is read as CP437 rather than as replacement characters', () => {
    // 0xC9 0xCD 0xBB is the box-drawing run every idgames banner is built out of; as UTF-8 it is
    // not a valid sequence at all, which is exactly what picks the fallback.
    const bytes = Uint8Array.from([0xc9, 0xcd, 0xcd, 0xbb, 0x0a, 0x53, 0x63, 0x79, 0x74, 0x68, 0x65]);
    assert.equal(decodeTextFile(bytes), '╔══╗\nScythe');
  });

  test('CRLF and the DOS end-of-file byte are transport, not text', () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode('one\r\ntwo\r\n'), 0x1a]);
    assert.equal(decodeTextFile(bytes), 'one\ntwo\n');
  });
});
