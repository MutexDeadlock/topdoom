/**
 * One tic's input as a row: `TicColumns` for a single tic plus the characters it typed, how a
 * recording appends one and a playback reads one back, the array a network game sends one as, and
 * `RowInput`, the `TicInput` that serves one. The one codec the recorder, the playback and the
 * network share. docs/replays.md § The record.
 */
import { AIM_QUANTUM, type RightMouseAction, type TicInput } from '../input.ts';
import type { CameraPose, TopDownCamera } from '../../render/camera.ts';
import type { Pos2 } from '../../types.ts';
import { BUTTON_FIRE, BUTTON_RIGHT_EDGE, POSE_QUANTUM, type TicColumns } from './defs.ts';
import { heldMask, maskHas, pressedMask } from './keys.ts';

/** One tic of `TicColumns`, in the same units, and what it typed (`''` for nothing). */
export type TicRow = { [K in keyof TicColumns]: TicColumns[K][number] } & { typed: string };

/**
 * One tic's row as it travels: the twelve `TicColumns` of a tic in order. What was typed is not
 * carried — cheats stay out of a network game (`ST_Responder`'s `!netgame`).
 * docs/multiplayer-net.md § Protocol.
 */
export type WireRow = [
  held: number,
  pressed: number,
  buttons: number,
  wheel: number,
  aimX: number | null,
  aimY: number | null,
  poseYaw: number,
  poseX: number,
  poseY: number,
  poseZ: number,
  poseDistance: number,
  poseTilt: number,
];

/** Columns holding no tic yet, in the field order the stored JSON has. */
export function emptyColumns(): TicColumns {
  return {
    held: [],
    pressed: [],
    buttons: [],
    wheel: [],
    aimX: [],
    aimY: [],
    poseYaw: [],
    poseX: [],
    poseY: [],
    poseZ: [],
    poseDistance: [],
    poseTilt: [],
  };
}

/** A row holding, pressing, typing and aiming at nothing — what `readRow` answers past the end. */
export function emptyRow(): TicRow {
  return {
    held: 0,
    pressed: 0,
    buttons: 0,
    wheel: 0,
    aimX: null,
    aimY: null,
    poseYaw: 0,
    poseX: 0,
    poseY: 0,
    poseZ: 0,
    poseDistance: 0,
    poseTilt: 0,
    typed: '',
  };
}

/**
 * The keys, buttons and typed characters `live` answers this tic, into `row` — the half a recording
 * samples at the tic's end. The right-button edge is asked under `rightMouse`, the binding in
 * force. The wheel and the aim point are written by whoever read them during the tic, the pose by
 * `writeRowPose`.
 */
export function sampleInput(live: TicInput, rightMouse: RightMouseAction, row: TicRow): void {
  row.buttons = (live.mouseDown ? BUTTON_FIRE : 0) | (live.rightMousePressed(rightMouse) ? BUTTON_RIGHT_EDGE : 0);
  row.typed = live.typed();
  row.held = heldMask(live);
  row.pressed = pressedMask(live);
}

/** `pose` on the record's lattice, into `row`'s pose fields. */
export function writeRowPose(row: TicRow, pose: CameraPose): void {
  row.poseYaw = poseUnits(pose.yaw);
  row.poseX = poseUnits(pose.point[0]);
  row.poseY = poseUnits(pose.point[1]);
  row.poseZ = poseUnits(pose.point[2]);
  row.poseDistance = poseUnits(pose.distance);
  row.poseTilt = poseUnits(pose.tilt);
}

/** A scroll's sign alone into `row` — what `WeaponSystem.handleSwitching` reads of it. */
export function writeRowWheel(row: TicRow, delta: number): void {
  row.wheel = delta > 0 ? 1 : delta < 0 ? -1 : 0;
}

/** The aim point on `AIM_QUANTUM`'s lattice into `row`; null is the pointer above the horizon. */
export function writeRowAim(row: TicRow, point: Pos2 | null): void {
  row.aimX = point ? Math.round(point.x / AIM_QUANTUM) : null;
  row.aimY = point ? Math.round(point.y / AIM_QUANTUM) : null;
}

/** `row` appended as the next tic of `tics`, its characters to `typed` where it typed any. */
export function appendRow(tics: TicColumns, typed: [tic: number, text: string][], row: TicRow): void {
  if (row.typed !== '') typed.push([tics.held.length, row.typed]);
  tics.held.push(row.held);
  tics.pressed.push(row.pressed);
  tics.buttons.push(row.buttons);
  tics.wheel.push(row.wheel);
  tics.aimX.push(row.aimX);
  tics.aimY.push(row.aimY);
  tics.poseYaw.push(row.poseYaw);
  tics.poseX.push(row.poseX);
  tics.poseY.push(row.poseY);
  tics.poseZ.push(row.poseZ);
  tics.poseDistance.push(row.poseDistance);
  tics.poseTilt.push(row.poseTilt);
}

/** `from`'s every field into `into` — a row served from another row rather than from columns. */
export function copyRow(from: TicRow, into: TicRow): void {
  into.held = from.held;
  into.pressed = from.pressed;
  into.buttons = from.buttons;
  into.wheel = from.wheel;
  into.aimX = from.aimX;
  into.aimY = from.aimY;
  into.poseYaw = from.poseYaw;
  into.poseX = from.poseX;
  into.poseY = from.poseY;
  into.poseZ = from.poseZ;
  into.poseDistance = from.poseDistance;
  into.poseTilt = from.poseTilt;
  into.typed = from.typed;
}

/** `writeRowPose` undone: the pose a row was read at. */
export function rowPose(row: TicRow): CameraPose {
  return {
    yaw: row.poseYaw * POSE_QUANTUM,
    point: [row.poseX * POSE_QUANTUM, row.poseY * POSE_QUANTUM, row.poseZ * POSE_QUANTUM],
    distance: row.poseDistance * POSE_QUANTUM,
    tilt: row.poseTilt * POSE_QUANTUM,
  };
}

export function rowToWire(row: TicRow): WireRow {
  return [
    row.held,
    row.pressed,
    row.buttons,
    row.wheel,
    row.aimX,
    row.aimY,
    row.poseYaw,
    row.poseX,
    row.poseY,
    row.poseZ,
    row.poseDistance,
    row.poseTilt,
  ];
}

/** `wire` as a row of its own; the typed column is empty by construction. */
export function rowFromWire(wire: WireRow): TicRow {
  const row = emptyRow();
  [
    row.held,
    row.pressed,
    row.buttons,
    row.wheel,
    row.aimX,
    row.aimY,
    row.poseYaw,
    row.poseX,
    row.poseY,
    row.poseZ,
    row.poseDistance,
    row.poseTilt,
  ] = wire;
  return row;
}

export function isWireRow(v: unknown): v is WireRow {
  if (!Array.isArray(v) || v.length !== 12) return false;
  for (let i = 0; i < 12; i++) {
    const value = v[i];
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    // Only the aim pair may be null: the pointer above the horizon.
    if (value === null && (i === 4 || i === 5)) continue;
    return false;
  }
  return true;
}

/** Tic `tic` of `tics` into `row`, rewritten in place; past the end, an idle row. */
export function readRow(tics: TicColumns, typedAt: ReadonlyMap<number, string>, tic: number, row: TicRow): void {
  row.held = tics.held[tic] ?? 0;
  row.pressed = tics.pressed[tic] ?? 0;
  row.buttons = tics.buttons[tic] ?? 0;
  row.wheel = tics.wheel[tic] ?? 0;
  row.aimX = tics.aimX[tic] ?? null;
  row.aimY = tics.aimY[tic] ?? null;
  row.poseYaw = tics.poseYaw[tic] ?? 0;
  row.poseX = tics.poseX[tic] ?? 0;
  row.poseY = tics.poseY[tic] ?? 0;
  row.poseZ = tics.poseZ[tic] ?? 0;
  row.poseDistance = tics.poseDistance[tic] ?? 0;
  row.poseTilt = tics.poseTilt[tic] ?? 0;
  row.typed = typedAt.get(tic) ?? '';
}

export interface RowInputOptions {
  /** The binding the row's right-button edge answers for — the slot's own, not the stored setting. */
  rightMouse: RightMouseAction;
}

/** A row served as a tic's input. The owner rewrites `row` before each tic; `endTic` does nothing. */
export class RowInput implements TicInput {
  readonly row: TicRow = emptyRow();
  rightMouse: RightMouseAction;

  constructor(options: RowInputOptions) {
    this.rightMouse = options.rightMouse;
  }

  held(...codes: string[]): boolean {
    for (const code of codes) {
      if (maskHas(this.row.held, code)) return true;
    }
    return false;
  }

  pressed(code: string): boolean {
    return maskHas(this.row.pressed, code);
  }

  typed(): string {
    return this.row.typed;
  }

  get mouseDown(): boolean {
    return (this.row.buttons & BUTTON_FIRE) !== 0;
  }

  rightMousePressed(action: RightMouseAction): boolean {
    return (this.row.buttons & BUTTON_RIGHT_EDGE) !== 0 && this.rightMouse === action;
  }

  consumeWheel(): number {
    return this.row.wheel;
  }

  aim(_camera: TopDownCamera, _planeZ: number): Pos2 | null {
    const { aimX, aimY } = this.row;
    if (aimX === null || aimY === null) return null;
    return { x: aimX * AIM_QUANTUM, y: aimY * AIM_QUANTUM };
  }

  endTic(): void {}
}

/** A pose component on the record's lattice. */
function poseUnits(v: number): number {
  return Math.round(v / POSE_QUANTUM);
}
