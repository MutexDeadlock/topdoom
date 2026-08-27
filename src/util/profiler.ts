/**
 * The per-frame timing `game.ts` feeds and the profiler overlay reads back — the measuring side
 * only, with no UI of its own. See docs/menu.md § Profiling overlay.
 */

/** One profiled category's smoothed per-frame cost, in milliseconds. */
export interface ProfileSample {
  label: string;
  ms: number;
}

/**
 * EMA weight applied to each new frame's measurement — see FrameProfiler's doc for why raw
 * per-frame numbers aren't shown directly. Exported because `render/gputimer.ts` smooths the
 * GPU row on the same weight, and two rates in one overlay would read as one number lagging.
 */
export const PROFILE_SMOOTHING = 0.12;

/**
 * Fraction of the pending off-frame pool charged into each frame — see
 * `offFrame`. **Tuned by feel**: at 60fps this spreads a burst over roughly the
 * music pump's own 150 ms interval, so the charge per frame converges on the
 * per-frame average the bursts amount to instead of spiking whichever frame
 * happened to follow one.
 */
const OFF_FRAME_SPREAD = 0.12;

/**
 * Ceiling on the pending off-frame pool, in ms — a couple of 60fps frames'
 * worth. **Tuned by feel.** Live play never accrues more than a pump interval's
 * chunks between two frames; anything bigger is a stall's backlog (a tab hidden
 * without the menu open keeps the synth timer running with no frame to drain
 * it), and is dropped the way the frame loop drops its own accumulator debt
 * rather than replayed against frames that didn't do the work.
 */
const OFF_FRAME_PENDING_CAP = 32;

/**
 * Per-frame wall-clock breakdown the profiler overlay reads from
 * (`ui/devmode/profilerhud.ts`). A single frame's timing is noisy (GC pauses, OS
 * scheduling, browser compositing) — showing it raw would make the overlay's
 * bars flicker too fast to read anything useful out of them, so every label
 * is smoothed with a plain exponential moving average instead, the same
 * `dampen`-style approach used elsewhere in this codebase for visual
 * smoothing, just inlined here since this isn't a `dampen(prev, target, ...)`
 * per-value call site but an accumulate-then-smooth-many-labels loop.
 *
 * Usage is `beginFrame()` once, any number of `time()`/`add()` calls through
 * the frame (the same label can be used more than once per frame — e.g. two
 * non-contiguous blocks of "Player" work — and accumulates), then
 * `endFrame()` once. Labels are registered in first-seen order and that
 * order is preserved by `samples()`, so a caller that always instruments the
 * same sections in the same order gets a stable category list to render.
 */
export class FrameProfiler {
  private labels: string[] = [];
  private smoothedByLabel = new Map<string, number>();
  private currentByLabel = new Map<string, number>();
  private frameStart = 0;
  /** Off-frame work reported but not yet charged into a frame — drained a fraction per frame by `endFrame`. */
  private offFramePending = new Map<string, number>();
  /** What `endFrame` charged out of that pool this frame, added to the frame's own wall clock. */
  private offFrameMs = 0;
  private smoothedTotal = 0;
  private smoothedOther = 0;

  beginFrame(): void {
    this.currentByLabel.clear();
    this.offFrameMs = 0;
    this.frameStart = performance.now();
  }

  /** Times `fn` and adds its wall-clock duration under `label`. */
  time<T>(label: string, fn: () => T): T {
    const t0 = performance.now();
    const result = fn();
    this.add(label, performance.now() - t0);
    return result;
  }

  /** Adds `ms` under `label` directly, for a span that isn't a single contiguous function call. */
  add(label: string, ms: number): void {
    if (!this.smoothedByLabel.has(label)) {
      this.labels.push(label);
      this.smoothedByLabel.set(label, 0);
    }
    this.currentByLabel.set(label, (this.currentByLabel.get(label) ?? 0) + ms);
  }

  /**
   * Adds main-thread work that happened **between** frames, in the gap
   * `beginFrame`/`endFrame` doesn't span — the music synth's chunk rendering,
   * which a timer drives rather than the frame loop (docs/music.md § Getting it
   * to the speakers). It counts towards the frame total as well as its own
   * label, so the bars still sum to the total instead of quietly eating
   * `Other`, and a zero costs nothing: a label is only registered once it has
   * actually spent time, so a category that never runs never takes a row.
   *
   * The work arrives in bursts (a chunk every pump interval, a whole lookahead
   * at track start), so it is pooled and charged into frames a fraction at a
   * time (`OFF_FRAME_SPREAD`) rather than dumped on the frame that follows —
   * dumped, every burst spiked the total and with it the "fps eq." readout,
   * which divides by it. A stall's oversized backlog is capped away entirely
   * (`OFF_FRAME_PENDING_CAP`). docs/menu.md § Profiling overlay.
   */
  offFrame(label: string, ms: number): void {
    if (ms <= 0) return;
    const pending = this.offFramePending.get(label) ?? 0;
    this.offFramePending.set(label, Math.min(OFF_FRAME_PENDING_CAP, pending + ms));
  }

  /**
   * Finalizes the frame: smooths every measured label, plus an "Other"
   * bucket — whatever of the real total frame time (measured from
   * `beginFrame` to here, plus whatever `offFrame` reported) isn't covered by
   * any `time()`/`add()` call, e.g. input handling, HUD text updates, or a
   * single small sprite pose that isn't worth its own category — so the
   * panel's bars always sum to the true frame time instead of silently
   * under-reporting it.
   */
  endFrame(): void {
    for (const [label, pending] of this.offFramePending) {
      // Below display resolution: charge the tail whole instead of decaying forever.
      const charge = pending < 0.01 ? pending : pending * OFF_FRAME_SPREAD;
      this.add(label, charge);
      this.offFrameMs += charge;
      if (charge === pending) this.offFramePending.delete(label);
      else this.offFramePending.set(label, pending - charge);
    }
    const total = performance.now() - this.frameStart + this.offFrameMs;
    let measured = 0;
    for (const label of this.labels) {
      const prev = this.smoothedByLabel.get(label)!;
      const now = this.currentByLabel.get(label) ?? 0;
      measured += now;
      this.smoothedByLabel.set(label, prev + (now - prev) * PROFILE_SMOOTHING);
    }
    const other = Math.max(0, total - measured);
    this.smoothedOther += (other - this.smoothedOther) * PROFILE_SMOOTHING;
    this.smoothedTotal += (total - this.smoothedTotal) * PROFILE_SMOOTHING;
  }

  samples(): ProfileSample[] {
    return [
      ...this.labels.map((label) => ({ label, ms: this.smoothedByLabel.get(label) ?? 0 })),
      { label: 'Other', ms: this.smoothedOther },
    ];
  }

  get totalMs(): number {
    return this.smoothedTotal;
  }
}
