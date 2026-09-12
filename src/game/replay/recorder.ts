/**
 * {@link ReplayRecorder}: every slot's input wrapped so that everything a tic reads through it is
 * written down — each slot's per-tic rows (the codec in `replay/row.ts`), the settings changes and
 * the death restarts `Game` reports. What it hands over at the end is a {@link ReplayCapture}.
 * docs/replays.md § Recording.
 */
import type { RightMouseAction, TicInput } from '../input.ts';
import type { SaveCapture } from '../savegames.ts';
import type { GameSnapshot } from '../snapshot.ts';
import type { Pos2 } from '../../types.ts';
import type { CameraPose, TopDownCamera } from '../../render/camera.ts';
import { getRandomCursors } from '../../util/random.ts';
import { slotColor, type PlayerColor } from '../../wad/playercolor.ts';
import {
  CHECK_INTERVAL,
  KEYFRAME_INTERVAL,
  checkCoord,
  type LevelMarker,
  type PlayerSettings,
  type ReplayCapture,
  type ReplayData,
  type ReplayEvent,
  type SessionSettings,
  type SlotRecord,
} from './defs.ts';
import { appendRow, emptyColumns, emptyRow, sampleInput, writeRowAim, writeRowPose, writeRowWheel } from './row.ts';
import { samePlayerSettings, sameSessionSettings } from './settings.ts';

/**
 * What a recording starts from: the level as a save would capture it, and where every slot stands.
 */
export interface RecordingStart {
  capture: SaveCapture;
  /** Each slot's camera for its first tic, by slot, already snapped — `Game.startRecording`. */
  poses: CameraPose[];
  /** Each slot's player settings, by slot. */
  players: PlayerSettings[];
  /** Each slot's armour colour, by slot. */
  colors: PlayerColor[];
  /** Each slot's player name, by slot, null where none is known — a network game's roster. */
  names: (string | null)[];
  session: SessionSettings;
}

export class ReplayRecorder {
  private data: ReplayData;
  private start: RecordingStart;
  private levels: LevelMarker[];
  /**
   * Restore events reference a snapshot by index; the same object restored twice is stored once.
   */
  private snapshotIndex = new Map<GameSnapshot, number>();
  /** Each slot's settings as last written down, by slot — an event is a change from these. */
  private lastPlayers: PlayerSettings[];
  private lastSession: SessionSettings;
  /** Each slot's input as the tic reads it — see {@link ReplayRecorder.input}. */
  private taps: SlotTap[];

  constructor(inputs: readonly TicInput[], start: RecordingStart) {
    this.start = start;
    this.lastPlayers = start.players.map((settings) => ({ ...settings }));
    this.lastSession = { ...start.session };
    this.levels = [{ tic: 0, map: start.capture.map }];
    // A colour the slot would draw in anyway is left out, and a name nobody gave, so a record of
    // defaults is the one a build before either wrote. docs/replays.md § The record.
    const slots: SlotRecord[] = this.lastPlayers.map((settings, slot) => ({
      settings,
      ...(start.colors[slot] !== slotColor(slot) ? { color: start.colors[slot] } : {}),
      ...(start.names[slot] ? { name: start.names[slot] } : {}),
      tics: emptyColumns(),
      typed: [],
    }));
    this.data = {
      snapshots: [start.capture.state],
      keyframes: [{ tic: 0, map: start.capture.map, snapshot: 0 }],
      session: this.lastSession,
      slots,
      events: [],
      checks: { x: slots.map(() => []), y: slots.map(() => []), cursor: [] },
    };
    this.snapshotIndex.set(start.capture.state, 0);
    // The right-button edge is sampled under the binding in force for its own slot.
    this.taps = inputs.map(
      (live, slot) => new SlotTap(live, slots[slot], start.poses[slot], () => this.lastPlayers[slot].rightMouse),
    );
  }

  get tics(): number {
    return this.ticCount;
  }

  /** Slot `slot`'s input for the tic: its live one, written down as it is read. */
  input(slot: number): TicInput {
    return this.taps[slot];
  }

  /**
   * Called by `Game` ahead of every tic: stamps a player or session settings change made since the
   * last tic as an event for this one, and takes the desync sample when one is due.
   *
   * @param bodies   every slot's position, by slot
   * @param players  every slot's player settings the tic will be read at, by slot
   * @param poses    every slot's camera the tic will be read at; omitted, the last ones
   */
  beginTic(
    bodies: readonly Pos2[],
    players: readonly PlayerSettings[],
    session: SessionSettings,
    poses?: readonly CameraPose[],
  ): void {
    const { events, checks } = this.data;
    const tic = this.ticCount;
    for (let slot = 0; slot < this.taps.length; slot++) {
      if (poses) writeRowPose(this.taps[slot].row, poses[slot]);
      if (samePlayerSettings(players[slot], this.lastPlayers[slot])) continue;
      this.lastPlayers[slot] = { ...players[slot] };
      events.push({ tic, kind: 'settings', slot, settings: this.lastPlayers[slot] });
    }
    if (!sameSessionSettings(session, this.lastSession)) {
      this.lastSession = { ...session };
      events.push({ tic, kind: 'session', settings: this.lastSession });
    }
    if (tic % CHECK_INTERVAL === 0) {
      for (let slot = 0; slot < this.taps.length; slot++) {
        checks.x[slot].push(checkCoord(bodies[slot].x));
        checks.y[slot].push(checkCoord(bodies[slot].y));
      }
      checks.cursor.push(getRandomCursors().p);
    }
  }

  /**
   * A death restart landing: the level is about to be rebuilt from `state` before the next tic.
   * docs/replays.md § Restore events.
   *
   * @param state  null for a plain reload with a fresh inventory
   */
  restore(map: string, state: GameSnapshot | null): void {
    const snapshot = state === null ? null : this.snapshotAt(state);
    const event: ReplayEvent = { tic: this.ticCount, kind: 'restore', map, snapshot };
    this.data.events.push(event);
  }

  /**
   * Whether a seek anchor is due at the tic about to run: an interval past the last one taken.
   * `Game` asks before every tic and takes the keyframe only where the moment allows a capture at
   * all, so a due one waits rather than being skipped. docs/replays.md § Seeking.
   */
  get keyframeDue(): boolean {
    const { keyframes } = this.data;
    return this.ticCount >= keyframes[keyframes.length - 1].tic + KEYFRAME_INTERVAL;
  }

  /** The anchor {@link ReplayRecorder.keyframeDue} asked for, at the tic about to run. */
  keyframe(map: string, state: GameSnapshot): void {
    this.data.keyframes.push({ tic: this.ticCount, map, snapshot: this.snapshotAt(state) });
  }

  /** A level beginning at the current tic; the same map again (a restart) adds no marker. */
  levelLoaded(map: string): void {
    if (this.levels[this.levels.length - 1].map === map) return;
    this.levels.push({ tic: this.ticCount, map });
  }

  finish(): ReplayCapture {
    const { skill, wads, mapWad, patchWads } = this.start.capture;
    return {
      skill,
      wads,
      mapWad,
      ...(patchWads ? { patchWads } : {}),
      ticCount: this.ticCount,
      levels: this.levels,
      data: this.data,
    };
  }

  /** The tic about to run — one past the rows closed so far. Every slot closes the same tics. */
  private get ticCount(): number {
    return this.data.slots[0].tics.held.length;
  }

  /**
   * Where `state` sits in {@link ReplayData.snapshots}, appending it the first time it is asked
   * for.
   */
  private snapshotAt(state: GameSnapshot): number {
    const known = this.snapshotIndex.get(state);
    if (known !== undefined) return known;
    const index = this.data.snapshots.length;
    this.snapshotIndex.set(state, index);
    this.data.snapshots.push(state);
    return index;
  }
}

/**
 * One slot's live input, wrapped: every read answered by it, the wheel and the aim point written
 * into the tic's row as the tic saw them, and the row closed onto the slot's record by
 * {@link SlotTap.endTic}.
 */
class SlotTap implements TicInput {
  /**
   * The tic being recorded: the pose {@link ReplayRecorder.beginTic} handed over, the wheel and aim
   * as they were read.
   */
  readonly row = emptyRow();
  private live: TicInput;
  private record: SlotRecord;
  /** The right-button binding in force for this slot. */
  private binding: () => RightMouseAction;

  constructor(live: TicInput, record: SlotRecord, pose: CameraPose, binding: () => RightMouseAction) {
    this.live = live;
    this.record = record;
    this.binding = binding;
    writeRowPose(this.row, pose);
  }

  held(...codes: string[]): boolean {
    return this.live.held(...codes);
  }

  pressed(code: string): boolean {
    return this.live.pressed(code);
  }

  typed(): string {
    return this.live.typed();
  }

  get mouseDown(): boolean {
    return this.live.mouseDown;
  }

  rightMousePressed(action: RightMouseAction): boolean {
    return this.live.rightMousePressed(action);
  }

  /**
   * The sign alone: `WeaponSystem.handleSwitching` reads nothing else of a scroll, and the sign
   * is what the record keeps — so the live tic sees exactly what the playback will.
   */
  consumeWheel(): number {
    writeRowWheel(this.row, this.live.consumeWheel());
    return this.row.wheel;
  }

  aim(camera: TopDownCamera, planeZ: number): Pos2 | null {
    const point = this.live.aim(camera, planeZ);
    writeRowAim(this.row, point);
    return point;
  }

  /** Closes the tic: the row is what the reads above saw, or holds nothing if never asked. */
  endTic(): void {
    const { row } = this;
    sampleInput(this.live, this.binding(), row);
    appendRow(this.record.tics, this.record.typed, row);
    row.wheel = 0;
    row.aimX = null;
    row.aimY = null;
    this.live.endTic();
  }
}
