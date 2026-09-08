import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameProfiler } from '../../src/util/profiler.ts';

/**
 * The panel's one structural promise is that its bars sum to the total it reports, which is what
 * makes `Other` mean "everything unmeasured" rather than "whatever is left over after the
 * bookkeeping" — and the off-frame category (`Music`) is the case that can break it, since that
 * work happens in the gap between two frames. See docs/devmode.md § Profiling overlay.
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

/**
 * `FrameProfiler` reads the clock in three places and nowhere else, so a stated clock is what
 * makes a frame's wall time exact — the smoothed figures below converge on the stated numbers to
 * within 1e-11 rather than on whatever a busy machine happened to hand out. Node runs one process
 * per test file (docs/testing.md § Layout and suite names), so the patch reaches nothing else, and
 * it goes back afterwards so the runner's own reporting is unaffected.
 */
const realNow = performance.now.bind(performance);
let clock = 0;
performance.now = () => clock;
after(() => {
  performance.now = realNow;
});

/** Moves the frame's wall clock on by `ms`, in place of doing `ms` of real work. */
function elapse(ms: number): void {
  clock += ms;
}

describe('Profiling · the frame breakdown', () => {
  test('the bars sum to the reported total', () => {
    const profiler = settle((p) => {
      p.time('A', () => elapse(0.5));
      p.time('A', () => elapse(0.2)); // the same label twice in a frame accumulates
      elapse(0.3); // nothing measures this
    });
    const bars = byLabel(profiler);
    assert.ok(Math.abs(bars.A - 0.7) < 1e-9, `A settled at ${bars.A}, expected both blocks`);
    assert.ok(Math.abs(bars.Other - 0.3) < 1e-9, `Other picked up the unmeasured work, got ${bars.Other}`);
    assert.ok(Math.abs(barSum(profiler) - profiler.totalMs) < 1e-9, `bars ${barSum(profiler)} vs ${profiler.totalMs}`);
  });

  test('work reported from between frames counts towards the total, not against Other', () => {
    const measured = settle((p) => {
      p.time('A', () => elapse(0.5));
      p.offFrame('Music', 2);
    });
    const bars = byLabel(measured);
    assert.ok(Math.abs(bars.Music - 2) < 1e-6, `Music settled at ${bars.Music}`);
    // The 2ms happened outside `beginFrame`/`endFrame`, so without the total
    // following it along, `Other` would have gone negative and clamped to zero
    // — under-reporting the frame by exactly the music's cost.
    assert.ok(Math.abs(measured.totalMs - 2.5) < 1e-6, `total ${measured.totalMs} covers the 0.5 frame and the 2ms`);
    assert.equal(bars.Other, 0, 'and nothing is left over for Other');
    assert.ok(Math.abs(barSum(measured) - measured.totalMs) < 1e-9, `bars ${barSum(measured)} vs ${measured.totalMs}`);
  });

  test('a burst of off-frame work is spread over frames, not charged to the next one', () => {
    const profiler = settle((p) => p.time('A', () => elapse(0.5)));
    const before = profiler.totalMs;
    profiler.beginFrame();
    elapse(0.5);
    profiler.offFrame('Music', 24); // a track start's whole lookahead in one report
    profiler.endFrame();
    // Charged whole, the total would have jumped by ~24ms * SMOOTHING ≈ 2.9;
    // spread, the first frame carries only a fraction of that.
    assert.ok(profiler.totalMs < before + 1, `total jumped from ${before} to ${profiler.totalMs}`);
    // The burst is still reported, just over the following frames.
    for (let i = 0; i < 5; i++) {
      profiler.beginFrame();
      elapse(0.5);
      profiler.endFrame();
    }
    const bars = byLabel(profiler);
    assert.ok(bars.Music > 0.3, `Music still draining, got ${bars.Music}`);
    assert.ok(bars.Music < 5, `Music never spiked to the burst, got ${bars.Music}`);
    assert.ok(Math.abs(barSum(profiler) - profiler.totalMs) < 1e-9, `bars ${barSum(profiler)} vs ${profiler.totalMs}`);
  });

  test('a stall-sized off-frame backlog is dropped, not replayed', () => {
    const profiler = settle((p) => p.time('A', () => elapse(0.5)));
    const before = profiler.totalMs;
    profiler.offFrame('Music', 5000); // a hidden tab's worth of synth time
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      profiler.beginFrame();
      elapse(0.5);
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
