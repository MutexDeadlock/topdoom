/**
 * A `WadSource` as the menu sees one, with no bytes behind it — what the WAD library's own tests
 * and the level-list tests both stand on. Reading the bytes is the one thing neither may do: a
 * listing that needed them would load every WAD in the library to draw a row.
 * docs/menu-wads.md, docs/testing.md § Shared helpers.
 */
import type { WadSource } from '../../src/wad/library.ts';

/**
 * `key` doubles as the label unless `over` says otherwise, so a test names a source once.
 * `bytes` rejects rather than returning nothing: a caller that reaches for it fails loudly and
 * says which rule it broke.
 */
export function wadSource(key: string, over: Partial<WadSource> = {}): WadSource {
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
    bytes: () => Promise.reject(new Error('a listing must not need the bytes')),
    ...over,
  };
}
