/**
 * The profiling overlay: per-category frame-time bars against the 60fps budget.
 * See docs/menu.md § Profiling overlay.
 */
import type { FrameProfiler } from '../../util/profiler.ts';
import { DEVMODE } from '../../constants.ts';

/**
 * A category's bar fills its row at this many ms — one whole 60fps frame budget, so a bar reaching
 * full width means that category alone would miss it.
 */
const BAR_BUDGET_MS = 1000 / 60;
/**
 * Bar turns amber once a category alone eats a quarter of the frame budget — still fine, but worth
 * a glance.
 */
const WARN_FRACTION = 0.25;
/** Bar turns red once a category alone would miss the frame budget by itself. */
const HOT_FRACTION = 1;

const PROFILER_STORAGE_KEY = 'topdoom.profiler';

/** `getProfilerVisible`'s memo of the stored setting; null until first read. */
let visible: boolean | null = null;

/**
 * Whether the overlay is wanted. Defaults to `DEVMODE` — a dev build shows it
 * as it did before the checkbox existed, a release build starts hidden — and a
 * stored choice overrides that either way. See docs/menu.md § Profiling overlay.
 */
export function getProfilerVisible(): boolean {
  // Memoized because `Game.draw` asks every frame to decide whether to run the GPU timer, and the
  // setting only ever moves through `setProfilerVisible` below — so the read stays inside the
  // `null` check rather than running ahead of a `??=`.
  if (visible === null) {
    const stored = globalThis.localStorage?.getItem(PROFILER_STORAGE_KEY);
    visible = stored == null ? DEVMODE : stored === '1';
  }
  return visible;
}

export function setProfilerVisible(on: boolean): void {
  visible = on;
  globalThis.localStorage?.setItem(PROFILER_STORAGE_KEY, on ? '1' : '0');
  applyProfilerVisible();
}

/**
 * The per-category timing overlay (top-right — see profiler.css). Renders `FrameProfiler`'s
 * smoothed samples as bars sized against one 60fps frame's budget rather than against each other,
 * so bar *length* alone says whether a category is the reason a frame is being missed.
 * docs/menu.md § Profiling overlay.
 *
 * Rows are created lazily and reused, the same "build once, update every frame" shape `Hud` uses,
 * and re-sorted worst-first on each update (`appendChild` on an existing child just moves it).
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
    // The menu's checkbox owns the setting and toggles the same class live, so
    // this only has to seed it for the level starting now.
    applyProfilerVisible();
  }

  /**
   * Takes the `FrameProfiler` rather than its `samples()`, so the array and its
   * per-label objects are only built once past the early return below — a
   * hidden panel is the default outside dev mode, and this runs every frame.
   */
  update(profiler: FrameProfiler, gpuMs: number | null): void {
    // Toggled off in the menu: nothing on screen to update, and the panel's own
    // class is the single source of that (`applyProfilerVisible`).
    if (!this.root.classList.contains('visible')) return;
    const totalMs = profiler.totalMs;
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

    const sorted = profiler.samples().sort((a, b) => b.ms - a.ms);
    for (const s of sorted) {
      let entry = this.rows.get(s.label);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'profiler-row';
        const label = document.createElement('span');
        label.className = 'profiler-label truncate';
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

/**
 * One of the two total rows: the milliseconds and the frame rate they alone would allow. Shared so
 * the pair stays formatted alike — they are meant to be read against each other.
 */
function msRow(label: string, ms: number): string {
  return `${label} ${ms.toFixed(1)} ms  (${Math.round(1000 / Math.max(ms, 0.001))} fps eq.)`;
}

/**
 * Puts the setting on `#profiler-hud`'s class, which is both what
 * profiler.css shows the panel by and what `ProfilerHud.update` reads to
 * skip its work — so the two can't disagree about whether the overlay is up.
 * Safe to call before any `ProfilerHud` exists: the element is static markup.
 */
function applyProfilerVisible(): void {
  document.getElementById('profiler-hud')?.classList.toggle('visible', getProfilerVisible());
}
