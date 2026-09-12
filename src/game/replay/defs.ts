/**
 * The replay format: what a recording holds, the constants the record is quantized against, and
 * the pure helpers the recorder, the playback and the menu share. The store and the persisted
 * player name live in the parent `game/replay.ts`. docs/replays.md § The record.
 */
import type { CameraMode } from '../autocamera.ts';
import type { RightMouseAction } from '../input.ts';
import type { SaveWad, SaveWadSet } from '../savegames.ts';
import type { Skill } from '../skill.ts';
import type { GameSnapshot } from '../snapshot.ts';
import type { CameraPose } from '../../render/camera.ts';
import type { PlayerColor } from '../../wad/playercolor.ts';
import { DOOM_TIC } from '../../constants.ts';

/**
 * Bumped on any change a reader of the previous version would misread — including a `SAVE_VERSION`
 * bump, since the record embeds savegame snapshots. `tests/game/replay.test.ts` pins the pair.
 */
export const REPLAY_VERSION = 1;

/**
 * The **simulation epoch**, and the one number in this file that is not about the format: bumped
 * whenever a change to what a *tic* does could make an old recording run differently — movement,
 * collision, the specials tables, `mobjinfo`, weapon rates and damage, monster AI, who draws from
 * the random table and in what order. Never bumped for a release, for rendering, for the HUD or for
 * the menu: none of those reach the tic. A replay whose {@link ReplayMeta.compat} differs from this
 * **still plays**; it only says it may desync ({@link compatDrift}), where a {@link REPLAY_VERSION}
 * mismatch refuses outright. docs/replays.md § Compatibility, CLAUDE.md § Project-wide rules.
 */
export const COMPAT = 1;

/**
 * How a replay's simulation epoch stands against this build's.
 *
 * @param compat  the replay's epoch; `0` is a replay written before the field existed, which is by
 *                definition older
 * @returns null when they agree
 */
export function compatDrift(compat: number): 'older' | 'newer' | null {
  if (compat === COMPAT) return null;
  return compat < COMPAT ? 'older' : 'newer';
}

/** One desync sample per second of simulation (35 tics). */
export const CHECK_INTERVAL = 35;

/**
 * How often a recording lays down a seek anchor: one a minute of simulation. The interval is what
 * a seek costs — a jump runs the tics from the anchor it lands on — traded against the ~4 kB each
 * keyframe adds to the file. docs/replays.md § Seeking.
 */
export const KEYFRAME_INTERVAL = 35 * 60;

/** The playback speeds the bar's slider steps through, 1× at index 3. */
export const SPEED_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

export const NORMAL_SPEED_INDEX = 3;

/**
 * The lattice the recorded camera pose sits on, in map units and degrees — far below what a pick
 * or a turn can resolve (tuned by feel, the aim point's own `AIM_QUANTUM`). Snapped *before* the
 * recording's own tic reads the camera, so what a replay stores is exactly what ran.
 * docs/replays.md § Camera state.
 */
export const POSE_QUANTUM = 1 / 64;

/** `pose` snapped onto the {@link POSE_QUANTUM} lattice. */
export function quantizePose(pose: CameraPose): CameraPose {
  return {
    yaw: snapToLattice(pose.yaw),
    point: [snapToLattice(pose.point[0]), snapToLattice(pose.point[1]), snapToLattice(pose.point[2])],
    distance: snapToLattice(pose.distance),
    tilt: snapToLattice(pose.tilt),
  };
}

/**
 * The tic count {@link TicColumns.buttons} bit for the left button being down, and for the right
 * button's edge.
 */
export const BUTTON_FIRE = 1;
export const BUTTON_RIGHT_EDGE = 2;

/**
 * The ten persisted settings a tic can observe — `replay/settings.ts` captures and pins them. One
 * record on disk; the engine splits it by owner (docs/multiplayer.md § Player settings).
 */
export interface SimSettings extends PlayerSettings, SessionSettings {}

/** The four a player carries per slot, so another player runs under their own. */
export interface PlayerSettings {
  autorun: boolean;
  autoSwitchWeapon: boolean;
  rightMouse: RightMouseAction;
  cameraMode: CameraMode;
}

/**
 * The five the whole session runs under, whichever slot reads them. The last three are the host's
 * netgame rules a tic reads (`game/rules.ts`, docs/multiplayer-deathmatch.md § Settings) — never
 * the mode, which a game decides once: a record from before them reads as coop with none —
 * `withSessionDefaults` (`replay/settings.ts`).
 */
export interface SessionSettings {
  infiniteTallActors: boolean;
  pistolStart: boolean;
  friendlyFire: boolean;
  /** Net frags that end a deathmatch level; 0 for none. */
  fragLimit: number;
  /** Minutes that end a deathmatch level; 0 for none. */
  timeLimit: number;
}

/** Where a level began in the tic stream — the bar's markers and the list's level line. */
export interface LevelMarker {
  tic: number;
  map: string;
}

/**
 * Something that reached the simulation between two tics and was not input: a settings change
 * made in the menu — one slot's player settings, or the session's — or a death restart's reload
 * landing. Applied *before* tic `tic` runs. `snapshot` indexes {@link ReplayData.snapshots}; null
 * is the plain reload with a fresh inventory. docs/replays.md § Restore events.
 */
export type ReplayEvent =
  | { tic: number; kind: 'settings'; slot: number; settings: PlayerSettings }
  | { tic: number; kind: 'session'; settings: SessionSettings }
  | { tic: number; kind: 'restore'; map: string; snapshot: number | null };

/**
 * The per-tic record, one column per field so the JSON stays short and gzips well.
 * {@link TicColumns.held} and {@link TicColumns.pressed} are `BOUND_KEYS` masks;
 * {@link TicColumns.wheel} is the sign of the tic's scroll; {@link TicColumns.aimX} and
 * {@link TicColumns.aimY} are the aim point in `AIM_QUANTUM` units, null where the pointer missed
 * the plane.
 */
export interface TicColumns {
  held: number[];
  pressed: number[];
  buttons: number[];
  wheel: number[];
  aimX: (number | null)[];
  aimY: (number | null)[];
  /**
   * The camera the tic was read at, in {@link POSE_QUANTUM} units: orbit, follow point (the
   * camera's own `THREE` triple), distance, tilt. Recorded rather than recomputed, so a later
   * change to how the camera behaves cannot move an old recording. docs/replays.md § Camera state.
   */
  poseYaw: number[];
  poseX: number[];
  poseY: number[];
  poseZ: number[];
  poseDistance: number[];
  poseTilt: number[];
}

/**
 * The columns whose values crawl rather than jump — the aim point and the camera pose, both
 * quantized coordinates. On disk they are stored as **second** differences: the camera and the aim
 * point glide, so their acceleration is smaller than their velocity, and what gzip sees is a
 * column of near-zeros. The mask columns are left alone, where differencing measured *worse*.
 * docs/replays.md § The record.
 */
const DELTA_COLUMNS = ['aimX', 'aimY', 'poseYaw', 'poseX', 'poseY', 'poseZ', 'poseDistance', 'poseTilt'] as const;

/** The stored form of `tics`: the smooth columns as second differences. */
export function packTics(tics: TicColumns): TicColumns {
  return walkColumns(tics, true);
}

/** {@link packTics} undone — what everything above the store reads. */
export function unpackTics(tics: TicColumns): TicColumns {
  return walkColumns(tics, false);
}

/** The six pose columns as a pose, or null past the end of the stream. */
export function poseAt(tics: TicColumns, tic: number): CameraPose | null {
  const yaw = tics.poseYaw[tic];
  if (yaw === undefined) return null;
  return {
    yaw: yaw * POSE_QUANTUM,
    point: [tics.poseX[tic] * POSE_QUANTUM, tics.poseY[tic] * POSE_QUANTUM, tics.poseZ[tic] * POSE_QUANTUM],
    distance: tics.poseDistance[tic] * POSE_QUANTUM,
    tilt: tics.poseTilt[tic] * POSE_QUANTUM,
  };
}

/**
 * The desync samples as columns, one entry per {@link CHECK_INTERVAL} tics from tic 0 —
 * {@link checkTic} is the tic an index stands for, so no tic column is stored. Every slot's
 * position is **rounded to whole map units**: the cursor beside it is exact, and it is the cursor
 * that moves on every diverging random draw, so what rounding can hide is a drift below half a
 * unit that has not yet drawn — which the next sample a second later no longer hides. Rounded
 * rather than hashed because a hash costs the same bytes and answers only yes/no, where these
 * still say where the run was and by how much it drifted. docs/replays.md § The record.
 */
export interface CheckColumns {
  /** Each slot's `player.x`, rounded — by slot, then by sample. */
  x: number[][];
  /** Each slot's `player.y`, rounded. */
  y: number[][];
  /** The `P_Random` cursor, exact. */
  cursor: number[];
}

/** The tic check sample `index` was taken at. */
export function checkTic(index: number): number {
  return index * CHECK_INTERVAL;
}

/** A sampled position as it is stored and compared — the one rounding rule, used by both sides. */
export function checkCoord(v: number): number {
  return Math.round(v);
}

/**
 * A moment the playback can jump to: the world as a savegame holds it, on the map it belongs to.
 * `[0]` is the recording's own start. The camera is not here — it is in the tic columns, one pose
 * per tic (§ Camera state), and a jump reads the pose of the tic it lands on.
 * docs/replays.md § Seeking.
 */
export interface Keyframe {
  tic: number;
  /** The map this state belongs to — a recording that advanced spans several. */
  map: string;
  /** Index into {@link ReplayData.snapshots}. */
  snapshot: number;
}

/** One player slot's share of a recording: what it ran under, and what it was told tic by tic. */
export interface SlotRecord {
  /** The slot's player settings at tic 0; later changes are its `settings` events. */
  settings: PlayerSettings;
  /**
   * The armour colour the slot's player picked; absent where it is the slot's own default
   * (`slotColor`), as in every record written before colours. docs/sprites.md § Player colours.
   */
  color?: PlayerColor;
  /**
   * The player's name where the recording knew one — a network game's roster; absent otherwise, as
   * in every record written before names. docs/replays.md § The record.
   */
  name?: string;
  tics: TicColumns;
  /** The characters typed in a tic, for the tics that typed any — cheat codes. */
  typed: [tic: number, text: string][];
}

/** The stored (gzipped) half of a replay. */
export interface ReplayData {
  /** `[0]` is the moment recording began; restore events index the rest. */
  snapshots: GameSnapshot[];
  /** Never empty and `[0].tic === 0`: the start, and every seek anchor after it. */
  keyframes: Keyframe[];
  /** The session settings at tic 0; later changes are `session` events. */
  session: SessionSettings;
  /** Every slot's record, by slot — as many as `snapshots[0].players`. docs/multiplayer-coop.md. */
  slots: SlotRecord[];
  events: ReplayEvent[];
  /** The desync samples, one per {@link CHECK_INTERVAL} tics — {@link CheckColumns}. */
  checks: CheckColumns;
}

/** The listed half: everything about a replay that a row shows without decoding the data. */
export interface ReplayMeta {
  id: string;
  version: number;
  /** ISO date the recording was stored. */
  at: string;
  name: string;
  /** Whatever the player wrote about the run — the panel's **Notes** field, newlines and all. */
  description: string;
  player: string;
  /** `VERSION` of the build that recorded it. */
  build: string;
  /**
   * {@link COMPAT} of the build that recorded it — what says whether this build's simulation is
   * the one that ran. `0` for a replay written before the field existed, which reads as older.
   */
  compat: number;
  /** {@link describeEngine} of the recording browser. */
  engine: string;
  skill: Skill;
  wads: SaveWad[];
  mapWad: string;
  patchWads?: string[];
  ticCount: number;
  /** Never empty: `[0]` is the map recording began on, which is what {@link replayMap} reads. */
  levels: LevelMarker[];
}

export interface Replay extends ReplayMeta {
  data: ReplayData;
}

/** What `Game` hands over when a recording ends; the store stamps the rest. */
export type ReplayCapture = Omit<
  Replay,
  'id' | 'version' | 'at' | 'name' | 'description' | 'player' | 'build' | 'compat' | 'engine'
>;

export interface ReplayListEntry {
  meta: ReplayMeta;
  /**
   * Why this build cannot play the row — the format version (the savegame version included), or a
   * meta too damaged to read — and null when it can. The list shows it in red beside the row and
   * greys Play; it is the same sentence `readReplay` would have thrown.
   */
  refusal: string | null;
}

/** The map a recording began on: the first level marker, which every stored replay has. */
export function replayMap(meta: Pick<ReplayMeta, 'levels'>): string {
  return meta.levels[0]?.map ?? '?';
}

/**
 * A replay's identity for the savegame WAD gate — `wadSetRefusal` and friends.
 * {@link SaveWadSet.maps} is what a replay adds over a save: a run that advanced played levels
 * beyond the one it started on, and a stand-in game WAD must not be what supplies any of them
 * (docs/savegames.md § A stand-in game WAD).
 */
export function replayWadSet(meta: ReplayMeta): SaveWadSet {
  const { wads, mapWad, patchWads, levels } = meta;
  return {
    map: replayMap(meta),
    maps: levels.map((level) => level.map),
    wads,
    mapWad,
    ...(patchWads ? { patchWads } : {}),
  };
}

/**
 * The JavaScript engine behind a user-agent string, with the browser for the reader — what a
 * replay was recorded on, since `Math.sin` and friends differ between engines
 * (docs/replays.md § What breaks determinism). "unknown" for anything unrecognized.
 */
export function describeEngine(userAgent: string): string {
  const browser = (name: string, pattern: RegExp): string => {
    const version = userAgent.match(pattern)?.[1];
    return version ? `${name} ${version}` : name;
  };
  if (/Firefox\//.test(userAgent)) return `SpiderMonkey · ${browser('Firefox', /Firefox\/(\d+)/)}`;
  if (/Edg\//.test(userAgent)) return `V8 · ${browser('Edge', /Edg\/(\d+)/)}`;
  if (/OPR\//.test(userAgent)) return `V8 · ${browser('Opera', /OPR\/(\d+)/)}`;
  if (/Chrome\//.test(userAgent)) return `V8 · ${browser('Chrome', /Chrome\/(\d+)/)}`;
  if (/Safari\//.test(userAgent) && /Version\//.test(userAgent)) {
    return `JavaScriptCore · ${browser('Safari', /Version\/(\d+)/)}`;
  }
  return 'unknown';
}

/** The speed at a slider position, clamped into the table. */
export function speedAt(index: number): number {
  const i = Math.max(0, Math.min(SPEED_STEPS.length - 1, Math.round(index)));
  return SPEED_STEPS[i];
}

/** How far through the stream tic `tic` is, 0..1; an empty stream reads as finished. */
export function positionFraction(tic: number, ticCount: number): number {
  if (ticCount <= 0) return 1;
  return Math.max(0, Math.min(1, tic / ticCount));
}

/** The tic a position on the bar's track stands for, clamped into the stream. */
export function ticAtFraction(fraction: number, ticCount: number): number {
  return Math.max(0, Math.min(ticCount, Math.round(fraction * ticCount)));
}

/** A replay's length in seconds — the tic count on vanilla's clock. */
export function replaySeconds(ticCount: number): number {
  return ticCount * DOOM_TIC;
}

/** The other way round: what a span of seconds is worth in tics — the arrow keys' skip. */
export function replayTics(seconds: number): number {
  return Math.round(seconds / DOOM_TIC);
}

function snapToLattice(v: number): number {
  return Math.round(v / POSE_QUANTUM) * POSE_QUANTUM;
}

/**
 * {@link DELTA_COLUMNS} against a linear prediction from the two values before (`pack`), or that
 * undone. The prediction is `2 * p1 - p2`, so a column moving at a constant rate stores zeros;
 * both directions carry the same two-value state, which is what makes the round trip exact in
 * integers.
 * A null — the tics the pointer missed the aim plane — carries no value and leaves the prediction
 * where it was.
 */
function walkColumns(tics: TicColumns, pack: boolean): TicColumns {
  const out: TicColumns = { ...tics };
  for (const name of DELTA_COLUMNS) {
    const values = tics[name] as (number | null)[];
    const walked: (number | null)[] = new Array(values.length);
    let p1 = 0;
    let p2 = 0;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === null || value === undefined) {
        walked[i] = null;
        continue;
      }
      const prediction = 2 * p1 - p2;
      const absolute = pack ? value : value + prediction;
      walked[i] = pack ? absolute - prediction : absolute;
      p2 = p1;
      p1 = absolute;
    }
    out[name] = walked as number[] & (number | null)[];
  }
  return out;
}
