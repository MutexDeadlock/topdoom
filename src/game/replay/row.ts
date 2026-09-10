/**
 * One tic's input as a row: `TicColumns` for a single tic plus the characters it typed, how a
 * recording appends one and a playback reads one back, and `RowInput`, the `TicInput` that serves
 * one. The one codec the recorder and the playback share. docs/replays.md § The record.
 */
import { AIM_QUANTUM, type RightMouseAction, type TicInput } from '../input.ts';
import type { CameraPose, TopDownCamera } from '../../render/camera.ts';
import type { Pos2 } from '../../types.ts';
import { BUTTON_FIRE, BUTTON_RIGHT_EDGE, POSE_QUANTUM, type TicColumns } from './defs.ts';
import { heldMask, maskHas, pressedMask } from './keys.ts';

/** One tic of `TicColumns`, in the same units, and what it typed (`''` for nothing). */
export type TicRow = { [K in keyof TicColumns]: TicColumns[K][number] } & { typed: string };

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
