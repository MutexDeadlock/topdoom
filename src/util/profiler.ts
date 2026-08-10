/** One profiled category's smoothed per-frame cost, in milliseconds. */
export interface ProfileSample {
  label: string;
  ms: number;
}

/** EMA weight applied to each new frame's measurement — see FrameProfiler's doc for why raw per-frame numbers aren't shown directly. */
const SMOOTHING = 0.12;

/**
 * Per-frame wall-clock breakdown DEVMODE's profiler overlay reads from
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
  private smoothedTotal = 0;
  private smoothedOther = 0;

  beginFrame(): void {
    this.currentByLabel.clear();
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
   * Finalizes the frame: smooths every measured label, plus an "Other"
   * bucket — whatever of the real total frame time (measured from
   * `beginFrame` to here) isn't covered by any `time()`/`add()` call, e.g.
   * input handling, HUD text updates, or a single small sprite pose that
   * isn't worth its own category — so the panel's bars always sum to the
   * true frame time instead of silently under-reporting it.
   */
  endFrame(): void {
    const total = performance.now() - this.frameStart;
    let measured = 0;
    for (const label of this.labels) {
      const prev = this.smoothedByLabel.get(label)!;
      const now = this.currentByLabel.get(label) ?? 0;
      measured += now;
      this.smoothedByLabel.set(label, prev + (now - prev) * SMOOTHING);
    }
    const other = Math.max(0, total - measured);
    this.smoothedOther += (other - this.smoothedOther) * SMOOTHING;
    this.smoothedTotal += (total - this.smoothedTotal) * SMOOTHING;
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
