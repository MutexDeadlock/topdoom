/**
 * The DEVMODE profiling overlay: per-category frame-time bars against the 60fps budget.
 * See docs/menu.md § Profiling overlay.
 */
import type { ProfileSample } from '../../util/profiler.ts';
import { DEVMODE } from '../../constants.ts';

/** A category's bar fills its row at this many ms — one whole 60fps frame budget, so a bar reaching full width means that category alone would miss it. */
const BAR_BUDGET_MS = 1000 / 60;
/** Bar turns amber once a category alone eats a quarter of the frame budget — still fine, but worth a glance. */
const WARN_FRACTION = 0.25;
/** Bar turns red once a category alone would miss the frame budget by itself. */
const HOT_FRACTION = 1;

const PROFILER_STORAGE_KEY = 'topdoom.profiler';

/** `getProfilerVisible`'s memo of the stored setting; null until first read. */
let visible: boolean | null = null;

/**
 * Whether the overlay is wanted, DEVMODE permitting. Defaults **on**, so a dev
 * build behaves as it did before the checkbox existed; only an explicit `'0'`
 * hides it. See docs/menu.md § Profiling overlay.
 */
export function getProfilerVisible(): boolean {
  // Memoized because `Game.draw` asks every frame to decide whether to run the GPU timer, and the
  // setting only ever moves through `setProfilerVisible` below.
  visible ??= globalThis.localStorage?.getItem(PROFILER_STORAGE_KEY) !== '0';
  return visible;
}

export function setProfilerVisible(on: boolean): void {
  visible = on;
  globalThis.localStorage?.setItem(PROFILER_STORAGE_KEY, on ? '1' : '0');
  applyProfilerVisible();
}

/**
 * Puts the setting on `#profiler-hud`'s class, which is both what devmode.css
 * shows the panel by and what `ProfilerHud.update` reads to skip its work — so
 * the two can't disagree about whether the overlay is up. Safe to call before
 * any `ProfilerHud` exists: the element is static markup.
 */
export function applyProfilerVisible(): void {
  document.getElementById('profiler-hud')?.classList.toggle('visible', DEVMODE && getProfilerVisible());
}

/**
 * One of the two total rows: the milliseconds and the frame rate they alone would allow. Shared so
 * the pair stays formatted alike — they are meant to be read against each other.
 */
function msRow(label: string, ms: number): string {
  return `${label} ${ms.toFixed(1)} ms  (${Math.round(1000 / Math.max(ms, 0.001))} fps eq.)`;
}

/**
 * DEVMODE's per-category timing overlay (top-right — see devmode.css). Renders
 * `FrameProfiler`'s smoothed samples as horizontal bars sized against one
 * 60fps frame's budget rather than against each other, so a glance at bar
 * *length* (not just the ms text) says whether a category is comfortably
 * cheap or the actual reason a frame is being missed — the stated goal being
 * to spot bottlenecks quickly, not just log numbers.
 *
 * Rows are created lazily, the first time a label is seen, and reused after
 * that (matching `Hud`'s "draw icons once, update fields every frame"
 * approach) — cheaper than rebuilding the DOM every frame, and avoids the
 * flicker that would cause. Rows are re-sorted worst-first on every update
 * (`appendChild` on an existing child just moves it, no new node) so the
 * biggest cost is always the first thing the eye lands on.
 */
export class ProfilerHud {
  private root = document.getElementById('profiler-hud')!;
  private cpuEl = document.getElementById('profiler-cpu')!;
  private gpuEl = document.getElementById('profiler-gpu')!;
  private rowsEl = document.getElementById('profiler-rows')!;
  private rows = new Map<string, { row: HTMLElement; fill: HTMLElement; value: HTMLElement }>();

  constructor() {
    // A new Game (and with it, a new ProfilerHud) is constructed every time
    // the player returns from ESC's menu and hits Start again, but the panel
    // itself is static markup in index.html, reused across instances —
    // without clearing the row container first, the previous instance's rows
    // stay put above this one's, reading as a second stacked overlay.
    this.rowsEl.replaceChildren();
  }

  update(samples: ProfileSample[], totalMs: number, gpuMs: number | null): void {
    // Toggled off in the menu: nothing on screen to update, and the panel's own
    // class is the single source of that (`applyProfilerVisible`).
    if (!this.root.classList.contains('visible')) return;
    // Named `cpu`, not `frame`: every row here is main-thread wall clock inside the rAF callback,
    // which cannot see the GPU — a scene whose fragment work takes 20 ms still reports a few
    // milliseconds and a four-figure "fps eq." while the game runs at 50. The HUD's own FPS
    // counter is the real rate; this is the ceiling the CPU alone would allow.
    // docs/menu.md § Profiling overlay.
    this.cpuEl.textContent = msRow('cpu', totalMs);
    // The two totals are concurrent, not cumulative: the larger one is what sets the frame rate,
    // and a frame that is GPU-bound shows a small `cpu` beside a large `gpu`. `n/a` is the honest
    // reading where the browser withholds `EXT_disjoint_timer_query_webgl2`, which is common.
    this.gpuEl.textContent = gpuMs === null ? 'gpu n/a' : msRow('gpu', gpuMs);

    const sorted = [...samples].sort((a, b) => b.ms - a.ms);
    for (const s of sorted) {
      let entry = this.rows.get(s.label);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'profiler-row';
        const label = document.createElement('span');
        label.className = 'profiler-label';
        label.textContent = s.label;
        const bar = document.createElement('span');
        bar.className = 'profiler-bar';
        const fill = document.createElement('span');
        fill.className = 'profiler-fill';
        bar.appendChild(fill);
        const value = document.createElement('span');
        value.className = 'profiler-value';
        row.append(label, bar, value);
        entry = { row, fill, value };
        this.rows.set(s.label, entry);
      }
      const fraction = s.ms / BAR_BUDGET_MS;
      entry.fill.style.width = `${Math.min(100, fraction * 100)}%`;
      entry.fill.classList.toggle('warn', fraction >= WARN_FRACTION && fraction < HOT_FRACTION);
      entry.fill.classList.toggle('hot', fraction >= HOT_FRACTION);
      entry.value.textContent = s.ms.toFixed(2);
      this.rowsEl.appendChild(entry.row);
    }
  }
}
