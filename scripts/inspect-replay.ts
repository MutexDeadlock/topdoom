/**
 * Headless look inside a downloaded replay: prints the meta a person can't eyeball (versions,
 * engine, WAD ids, level markers) and decodes the gzipped record through the same codec the game
 * stores it with, so a desync report's replay can be read without a browser.
 * See docs/replays.md.
 *
 *   node scripts/inspect-replay.ts <run.topdoomreplay.json>
 *   node scripts/inspect-replay.ts run.topdoomreplay.json --tics 0-60      # decode a tic range
 *   node scripts/inspect-replay.ts run.topdoomreplay.json --tics 0-60 --slot 1   # another player's
 *   node scripts/inspect-replay.ts run.topdoomreplay.json --data data.json # dump the whole record
 *   node scripts/inspect-replay.ts run.topdoomreplay.json --state s.json --snapshot 1
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { VERSION } from '../src/constants.ts';
import { STATE_ENCODING, base64ToBytes } from '../src/game/savestore.ts';
import { wadLabel, wadRoles, type SaveWad } from '../src/game/savegames.ts';
import {
  BOUND_KEYS,
  BUTTON_FIRE,
  BUTTON_RIGHT_EDGE,
  COMPAT,
  REPLAY_VERSION,
  checkTic,
  compatDrift,
  decodeRecord,
  maskHas,
  poseAt,
  replayMap,
  replaySeconds,
  unpackData,
  type LevelMarker,
  type PlayerSettings,
  type ReplayData,
  type ReplayEvent,
  type SessionSettings,
} from '../src/game/replay.ts';
import { AIM_QUANTUM } from '../src/game/input.ts';
import { asPlayerColor, slotColor } from '../src/wad/playercolor.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const values = ['--tics', '--slot', '--data', '--state', '--snapshot'].map(flag);
const path = args.find((a) => !a.startsWith('--') && !values.includes(a));
if (!path) {
  console.error(
    'usage: node scripts/inspect-replay.ts <run.topdoomreplay.json> [--tics a-b [--slot n]] [--data out.json] [--state out.json [--snapshot n]]',
  );
  process.exit(1);
}

const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const ticCount = Number(file.ticCount ?? 0);
const levels = (file.levels ?? []) as LevelMarker[];

console.log(`${file.name} — ${replayMap({ levels })} skill ${file.skill}, recorded ${file.at}`);
if (file.player) console.log(`by ${file.player}`);
if (file.description) console.log(`"${file.description}"`);
console.log(`${ticCount} tics (${clock(replaySeconds(ticCount))})`);
console.log(
  `format version ${file.version} (this build: ${REPLAY_VERSION}), ` +
    `data encoding ${file.dataEncoding} (this build: ${STATE_ENCODING})`,
);
console.log(`recorded by TopDoom ${file.build} (this build: ${VERSION}) on ${file.engine}`);
console.log(
  `simulation epoch ${Number(file.compat ?? 0)} (this build: ${COMPAT})` +
    `${compatDrift(Number(file.compat ?? 0)) === null ? '' : ' — may desync'}`,
);

const wads = (file.wads ?? []) as SaveWad[];
const set = { wads, mapWad: String(file.mapWad ?? ''), patchWads: file.patchWads as string[] | undefined };
for (const [i, wad] of wads.entries()) {
  const roles = wadRoles(set, i);
  console.log(`  ${wadLabel(wad)}${roles.length > 0 ? `  (${roles.join(', ')})` : ''}`);
}

const markers = levels.map((l) => `${l.map} @ ${clock(replaySeconds(l.tic))}`).join(', ');
console.log(`\nlevels: ${markers || 'none recorded'}`);

const stored = (await decodeRecord(base64ToBytes(file.data as string))) as ReplayData | null;
// A file the game would refuse still gets read this far — saying what it is missing beats a stack
// trace, and this is the tool a broken download is brought to.
if (!stored) {
  console.log('\nWARNING: the stored lines frame no record — an older layout or a cut-off file, which this build will not play');
  process.exit(0);
}
// The smooth columns are differences on disk (docs/replays.md § The record).
const data = unpackData(stored);
const keyframes = Array.isArray(data.keyframes) ? data.keyframes : [];
if (keyframes.length === 0) console.log('\nWARNING: no seek anchors — this replay will not play');

console.log(
  `record: ${data.slots.length} player(s), ${data.snapshots.length} snapshot(s), ${keyframes.length} keyframe(s), ` +
    `${data.events.length} event(s), ${data.checks.cursor.length} check sample(s)`,
);
console.log(`session at tic 0: ${describeSession(data.session)}`);
if (keyframes.length > 0) {
  console.log(`seek anchors: ${keyframes.map((f) => `${f.map} @ ${clock(replaySeconds(f.tic))}`).join(', ')}`);
}

for (const [index, slot] of data.slots.entries()) {
  const { tics } = slot;
  const color = asPlayerColor(slot.color, slotColor(index));
  const name = slot.name ? ` (${slot.name})` : '';
  console.log(`\nplayer ${index + 1}${name}: ${describePlayer(slot.settings)}, color ${color}`);
  const camera = poseAt(tics, 0);
  if (camera) {
    console.log(
      `  camera at tic 0: yaw ${camera.yaw.toFixed(1)}°, distance ${camera.distance.toFixed(0)}, tilt ${camera.tilt.toFixed(1)}°`,
    );
  }
  const rows = tics.held.length;
  if (rows !== ticCount) console.log(`  WARNING: the meta claims ${ticCount} tics, this record holds ${rows}`);
  const counts = new Map<string, number>();
  for (const mask of tics.held) {
    for (const code of BOUND_KEYS) {
      if (maskHas(mask, code)) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const fire = tics.buttons.filter((b) => (b & BUTTON_FIRE) !== 0).length;
  const rightEdges = tics.buttons.filter((b) => (b & BUTTON_RIGHT_EDGE) !== 0).length;
  const wheel = tics.wheel.filter((w) => w !== 0).length;
  const noAim = tics.aimX.filter((x) => x === null).length;
  console.log(`  input: fire held ${fire} tic(s), right-click ${rightEdges}, wheel ${wheel}, aim off-plane ${noAim}`);
  const held = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  keys held: ${held.map(([code, n]) => `${code} ${n}`).join(', ') || 'none'}`);
  if (slot.typed.length > 0) {
    console.log(`  typed: ${slot.typed.map(([tic, text]) => `${tic}:${JSON.stringify(text)}`).join(' ')}`);
  }
}

if (data.events.length > 0) {
  console.log('\nevents:');
  for (const event of data.events) console.log(`  tic ${event.tic}  ${describeEvent(event)}`);
}

const checks = data.checks;
if (checks.cursor.length > 0) {
  const sample = (i: number): string => {
    const where = checks.x.map((xs, slot) => `${xs[i]}, ${checks.y[slot][i]}`).join(' | ');
    return `tic ${checkTic(i)}: ${where}  P_Random cursor ${checks.cursor[i]}`;
  };
  console.log(`\nchecks: ${sample(0)}`);
  if (checks.cursor.length > 1) console.log(`        ${sample(checks.cursor.length - 1)}`);
}

const range = flag('--tics');
if (range) {
  const slotIndex = Number(flag('--slot') ?? 0);
  const tics = data.slots[slotIndex]?.tics;
  if (!tics) {
    console.error(`no player ${slotIndex + 1} in this replay`);
  } else {
    const [from, to] = range.split('-').map((n) => Number(n));
    const codes = (mask: number): string => BOUND_KEYS.filter((c) => maskHas(mask, c)).join('+') || '-';
    console.log(`\nplayer ${slotIndex + 1}\ntic  held / pressed  buttons  wheel  aim`);
    for (let t = Math.max(0, from); t <= Math.min(tics.held.length - 1, Number.isFinite(to) ? to : from); t++) {
      const aim =
        tics.aimX[t] === null
          ? 'off-plane'
          : `${(tics.aimX[t]! * AIM_QUANTUM).toFixed(2)}, ${(tics.aimY[t]! * AIM_QUANTUM).toFixed(2)}`;
      const buttons = [
        (tics.buttons[t] & BUTTON_FIRE) !== 0 ? 'fire' : null,
        (tics.buttons[t] & BUTTON_RIGHT_EDGE) !== 0 ? 'right' : null,
      ]
        .filter((b) => b !== null)
        .join('+');
      const keys = `${codes(tics.held[t])} / ${codes(tics.pressed[t])}`;
      console.log(`${t}  ${keys}  ${buttons || '-'}  ${tics.wheel[t]}  ${aim}`);
    }
  }
}

const dataOut = flag('--data');
if (dataOut) {
  writeFileSync(dataOut, JSON.stringify(data, null, '\t'));
  console.log(`\nrecord written to ${dataOut}`);
}
const stateOut = flag('--state');
if (stateOut) {
  const index = Number(flag('--snapshot') ?? 0);
  const snapshot = data.snapshots[index];
  if (!snapshot) {
    console.error(`no snapshot ${index} in this replay`);
  } else {
    writeFileSync(stateOut, JSON.stringify(snapshot, null, '\t'));
    console.log(`snapshot ${index} written to ${stateOut}`);
  }
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function onOff(v: boolean): string {
  return v ? 'on' : 'off';
}

function describePlayer(s: PlayerSettings): string {
  return (
    `autorun ${onOff(s.autorun)}, auto weapon switch ${onOff(s.autoSwitchWeapon)}, ` +
    `right mouse ${s.rightMouse}, camera ${s.cameraMode}`
  );
}

function describeSession(s: SessionSettings): string {
  return `infinite tall actors ${onOff(s.infiniteTallActors)}, pistol start ${onOff(s.pistolStart)}`;
}

function describeEvent(event: ReplayEvent): string {
  if (event.kind === 'settings') return `settings  player ${event.slot + 1}: ${describePlayer(event.settings)}`;
  if (event.kind === 'session') return `session   ${describeSession(event.settings)}`;
  return `restore   ${event.map}  ${event.snapshot === null ? 'fresh start' : `snapshot ${event.snapshot}`}`;
}
