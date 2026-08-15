import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameProfiler } from '../../src/util/profiler.ts';

/**
 * The panel's one structural promise is that its bars sum to the total it reports, which is what
 * makes `Other` mean "everything unmeasured" rather than "whatever is left over after the
 * bookkeeping" — and the off-frame category (`Music`) is the case that can break it, since that
 * work happens in the gap between two frames. See docs/menu.md § Profiling overlay.
 */

/** Runs the same frame often enough for the exponential smoothing to settle on it. */
function settle(frame: (p: FrameProfiler) => void, frames = 200): FrameProfiler {
  const profiler = new FrameProfiler();
  for (let i = 0; i < frames; i++) {
    profiler.beginFrame();
    frame(profiler);
    profiler.endFrame();
  }
  return profiler;
}

const byLabel = (profiler: FrameProfiler) => Object.fromEntries(profiler.samples().map((s) => [s.label, s.ms]));
const barSum = (profiler: FrameProfiler) => profiler.samples().reduce((total, s) => total + s.ms, 0);

/** Real elapsed work, so a measured label and the frame's own wall clock agree about it. */
function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Deliberately busy: `time()` measures wall clock, so the work has to be real.
  }
}

describe('Profiling · the frame breakdown', () => {
  test('the bars sum to the reported total', () => {
    const profiler = settle((p) => {
      p.time('A', () => spin(0.5));
      p.time('A', () => spin(0.2)); // the same label twice in a frame accumulates
      spin(0.3); // nothing measures this
    });
    const bars = byLabel(profiler);
    assert.ok(bars.A > 0.6, `A settled at ${bars.A}`);
    assert.ok(bars.Other > 0.2, `Other picked up the unmeasured work, got ${bars.Other}`);
    assert.ok(Math.abs(barSum(profiler) - profiler.totalMs) < 0.1, `bars ${barSum(profiler)} vs ${profiler.totalMs}`);
  });

  test('work reported from between frames counts towards the total, not against Other', () => {
    const measured = settle((p) => {
      p.time('A', () => spin(0.5));
      p.offFrame('Music', 2);
    });
    const bars = byLabel(measured);
    assert.ok(Math.abs(bars.Music - 2) < 0.1, `Music settled at ${bars.Music}`);
    // The 2ms happened outside `beginFrame`/`endFrame`, so without the total
    // following it along, `Other` would have gone negative and clamped to zero
    // — under-reporting the frame by exactly the music's cost.
    assert.ok(profilerTotalCovers(measured, 2.5), `total ${measured.totalMs} covers both`);
    assert.ok(Math.abs(barSum(measured) - measured.totalMs) < 0.1, `bars ${barSum(measured)} vs ${measured.totalMs}`);
  });

  test('a burst of off-frame work is spread over frames, not charged to the next one', () => {
    const profiler = settle((p) => p.time('A', () => spin(0.5)));
    const before = profiler.totalMs;
    profiler.beginFrame();
    spin(0.5);
    profiler.offFrame('Music', 24); // a track start's whole lookahead in one report
    profiler.endFrame();
    // Charged whole, the total would have jumped by ~24ms * SMOOTHING ≈ 2.9;
    // spread, the first frame carries only a fraction of that.
    assert.ok(profiler.totalMs < before + 1, `total jumped from ${before} to ${profiler.totalMs}`);
    // The burst is still reported, just over the following frames.
    for (let i = 0; i < 5; i++) {
      profiler.beginFrame();
      spin(0.5);
      profiler.endFrame();
    }
    const bars = byLabel(profiler);
    assert.ok(bars.Music > 0.3, `Music still draining, got ${bars.Music}`);
    assert.ok(bars.Music < 5, `Music never spiked to the burst, got ${bars.Music}`);
    assert.ok(Math.abs(barSum(profiler) - profiler.totalMs) < 0.1, `bars ${barSum(profiler)} vs ${profiler.totalMs}`);
  });

  test('a stall-sized off-frame backlog is dropped, not replayed', () => {
    const profiler = settle((p) => p.time('A', () => spin(0.5)));
    const before = profiler.totalMs;
    profiler.offFrame('Music', 5000); // a hidden tab's worth of synth time
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      profiler.beginFrame();
      spin(0.5);
      profiler.endFrame();
      peak = Math.max(peak, profiler.totalMs);
    }
    assert.ok(peak < before + 8, `capped backlog still pushed the total to ${peak} (baseline ${before})`);
    // And it drains away entirely rather than inflating the total forever.
    assert.ok(profiler.totalMs < before + 0.5, `total settled back to ${profiler.totalMs} (baseline ${before})`);
  });

  test('a category that never spends time takes no row', () => {
    const profiler = settle((p) => {
      p.add('A', 1);
      p.offFrame('Music', 0);
    });
    assert.deepEqual(
      profiler.samples().map((s) => s.label),
      ['A', 'Other'],
    );
  });
});

/** Whether the smoothed total is at least `ms`, with the slack a busy machine needs. */
function profilerTotalCovers(profiler: FrameProfiler, ms: number): boolean {
  return profiler.totalMs >= ms - 0.1;
}
