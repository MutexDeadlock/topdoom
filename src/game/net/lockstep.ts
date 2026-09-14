/**
 * {@link LockstepScheduler}: every slot's rows by tic, and whether the tic about to run has every
 * row it needs. Pure bookkeeping — the session feeds it what arrives and asks it what to serve;
 * nothing here knows a message or a clock. docs/multiplayer-net.md § Lockstep.
 */
import type { PlayerSettings } from '../replay/defs.ts';
import type { TicRow } from '../replay/row.ts';

export interface LockstepOptions {
  /** `INPUT_DELAY`: a row sampled at tic `t` drives tic `t + delay`. */
  delay: number;
  slots: number;
  /** The first tic to run — 0 for a game starting, the snapshot's tic for a joiner. */
  startTic?: number;
}

/** What {@link LockstepScheduler.push} did with a row. */
export type PushResult = 'stored' | 'late' | 'ignored';

/** One slot's stream: the rows and settings changes that have arrived, and which tics need none. */
interface SlotStream {
  rows: Map<number, TicRow>;
  settings: Map<number, PlayerSettings>;
  /** Tics before this read as idle and are never waited for — the first `delay` of a game. */
  idleBefore: number;
  /** Tics from this one on read as idle and are never waited for — a dropped peer. */
  leftAt: number;
  /** The highest tic a row arrived for, -1 while none has. */
  latest: number;
}

export class LockstepScheduler {
  readonly delay: number;
  /** The tic about to run. */
  tic: number;
  private streams: SlotStream[] = [];

  constructor(options: LockstepOptions) {
    this.delay = options.delay;
    this.tic = options.startTic ?? 0;
    for (let slot = 0; slot < options.slots; slot++) this.addSlot(this.tic + this.delay);
  }

  get slotCount(): number {
    return this.streams.length;
  }

  /**
   * A slot joining at `idleBefore - delay`: its rows read as idle until then. Grows the table to
   * hold it; a slot already there — a dropped one being reused — starts afresh.
   */
  ensureSlot(slot: number, idleBefore: number): void {
    // A slot between the table's end and this one belongs to a player already running.
    while (this.streams.length <= slot) this.addSlot(this.tic);
    const stream = this.streams[slot];
    stream.rows.clear();
    stream.settings.clear();
    stream.idleBefore = idleBefore;
    stream.leftAt = Infinity;
    stream.latest = -1;
  }

  /**
   * A row for `tic` from `slot`. `late` is one for a tic already run — the peer sent what nothing
   * can use any more; `ignored` is one for a tic the slot is idle at, or from a slot that is not
   * there.
   */
  push(slot: number, tic: number, row: TicRow, settings?: PlayerSettings): PushResult {
    // A slot not announced yet is a joiner's view of the players already running: their rows
    // arrive before the snapshot that names them, and count from the tic the table starts at.
    if (slot >= this.streams.length) this.ensureSlot(slot, this.tic);
    const stream = this.streams[slot];
    if (tic >= stream.leftAt) return 'ignored';
    if (tic < this.tic) return 'late';
    if (tic < stream.idleBefore) return 'ignored';
    stream.rows.set(tic, row);
    if (settings) stream.settings.set(tic, settings);
    if (tic > stream.latest) stream.latest = tic;
    return 'stored';
  }

  /** Whether every slot that is waited for has its row for `tic`. */
  readyFor(tic = this.tic): boolean {
    // Asked every rendered frame, so it allocates nothing: `missingAt` is the stall notice's.
    for (const stream of this.streams) {
      if (!this.idleAt(stream, tic) && !stream.rows.has(tic)) return false;
    }
    return true;
  }

  /** The slots whose row for `tic` has not arrived — the stall notice's names. */
  missingAt(tic = this.tic): number[] {
    const missing: number[] = [];
    for (let slot = 0; slot < this.streams.length; slot++) {
      const stream = this.streams[slot];
      if (this.idleAt(stream, tic) || stream.rows.has(tic)) continue;
      missing.push(slot);
    }
    return missing;
  }

  /** `slot`'s row for `tic`, or null where the slot is idle there — nothing to pose or press. */
  rowAt(slot: number, tic = this.tic): TicRow | null {
    const stream = this.streams[slot];
    if (!stream || this.idleAt(stream, tic)) return null;
    return stream.rows.get(tic) ?? null;
  }

  /** The settings `slot` changed to for tic `tic`, if that tic's row carried a change. */
  settingsAt(slot: number, tic = this.tic): PlayerSettings | undefined {
    return this.streams[slot]?.settings.get(tic);
  }

  /** The tic about to run is done: the cursor moves on and its rows are dropped. */
  advance(): void {
    for (const stream of this.streams) {
      stream.rows.delete(this.tic);
      stream.settings.delete(this.tic);
    }
    this.tic++;
  }

  /** `slot` is gone from `atTic` on: idle rows there, and nothing waited for. */
  markLeft(slot: number, atTic: number): void {
    const stream = this.streams[slot];
    if (!stream) return;
    stream.leftAt = atTic;
    for (const tic of [...stream.rows.keys()]) {
      if (tic >= atTic) {
        stream.rows.delete(tic);
        stream.settings.delete(tic);
      }
    }
  }

  hasLeft(slot: number): boolean {
    return this.streams[slot]?.leftAt !== Infinity;
  }

  /**
   * The first tic a dropped `slot` can be idle from without anyone having run a real row of its
   * past it: one past the highest row that arrived, and no earlier than the tics it was idle for
   * anyway.
   */
  dropTicFor(slot: number): number {
    const stream = this.streams[slot];
    return Math.max(stream.latest + 1, stream.idleBefore);
  }

  /**
   * Puts the cursor at `tic` — a snapshot landing — dropping what came before it. Rows for later
   * tics stay: they were sent for the run that continues from the snapshot.
   */
  seek(tic: number): void {
    this.tic = tic;
    for (const stream of this.streams) {
      for (const at of [...stream.rows.keys()]) {
        if (at < tic) {
          stream.rows.delete(at);
          stream.settings.delete(at);
        }
      }
    }
  }

  private idleAt(stream: SlotStream, tic: number): boolean {
    return tic < stream.idleBefore || tic >= stream.leftAt;
  }

  private addSlot(idleBefore: number): void {
    this.streams.push({ rows: new Map(), settings: new Map(), idleBefore, leftAt: Infinity, latest: -1 });
  }
}
