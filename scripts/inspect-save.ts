/**
 * Headless look inside a downloaded save file: prints the meta a person can't
 * eyeball (versions, WAD ids, player position) and decodes the gzipped state
 * through the same codec the game stores it with, so a bug report's save can be
 * read without a browser. See docs/savegames.md.
 *
 *   node scripts/inspect-save.ts <save.topdoom.json>
 *   node scripts/inspect-save.ts save.topdoom.json --state state.json   # dump the full snapshot
 *   node scripts/inspect-save.ts save.topdoom.json --thumb thumb.jpg    # dump the thumbnail
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { STATE_ENCODING, base64ToBytes, decompressText } from '../src/game/savestore.ts';
import { SAVE_VERSION, wadLabel, wadRoles, type SaveWad } from '../src/game/savegames.ts';
import type { GameSnapshot } from '../src/game/snapshot.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const path = args.find((a) => !a.startsWith('--') && a !== flag('--state') && a !== flag('--thumb'));
if (!path) {
  console.error('usage: node scripts/inspect-save.ts <save.topdoom.json> [--state out.json] [--thumb out.jpg]');
  process.exit(1);
}

const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

console.log(`${file.name} — ${file.map} skill ${file.skill}, saved ${file.at}`);
console.log(`format version ${file.version} (this build: ${SAVE_VERSION}), state encoding ${file.stateEncoding} (this build: ${STATE_ENCODING})`);
const wads = (file.wads ?? []) as SaveWad[];
const set = { wads, mapWad: String(file.mapWad ?? ''), patchWads: file.patchWads as string[] | undefined };
for (const [i, wad] of wads.entries()) {
  const roles = wadRoles(set, i);
  console.log(`  ${wadLabel(wad)}${roles.length > 0 ? `  (${roles.join(', ')})` : ''}`);
}

const state = JSON.parse(
  await decompressText(base64ToBytes(file.state as string)),
) as GameSnapshot;

console.log(state.netgame ? `\nnetgame, ${state.players.length} players` : '\nsingle player');
for (const [slot, { player: p, cameraYawDeg, dead }] of state.players.entries()) {
  const where = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}  z ${p.z}  angle ${p.angle.toFixed(3)}`;
  console.log(`player ${slot + 1}: ${where}  camera yaw ${cameraYawDeg}°${dead ? '  (dead)' : ''}`);
}
console.log(`level time ${Number(file.levelTime).toFixed(1)}s, records ${state.cheated ? 'forfeited' : 'eligible'}`);
console.log(
  `state: ${Object.keys(state).length} top-level keys — ` +
    Object.entries(state)
      .map(([k, v]) => (Array.isArray(v) ? `${k}[${v.length}]` : k))
      .join(', '),
);

const stateOut = flag('--state');
if (stateOut) {
  writeFileSync(stateOut, JSON.stringify(state, null, '\t'));
  console.log(`\nsnapshot written to ${stateOut}`);
}
const thumbOut = flag('--thumb');
if (thumbOut) {
  const dataUrl = String(file.thumb ?? '');
  const comma = dataUrl.indexOf(',');
  if (comma < 0) {
    console.error('no thumbnail in this file');
  } else {
    writeFileSync(thumbOut, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
    console.log(`thumbnail written to ${thumbOut}`);
  }
}
