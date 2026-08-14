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

/**
 * Whether the overlay is wanted, DEVMODE permitting. Defaults **on**, so a dev
 * build behaves as it did before the checkbox existed; only an explicit `'0'`
 * hides it. See docs/menu.md § Profiling overlay.
 */
export function getProfilerVisible(): boolean {
  return globalThis.localStorage?.getItem(PROFILER_STORAGE_KEY) !== '0';
}

export function setProfilerVisible(on: boolean): void {
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
  private totalEl: HTMLElement;
  private rows = new Map<string, { row: HTMLElement; fill: HTMLElement; value: HTMLElement }>();

  constructor() {
    // A new Game (and with it, a new ProfilerHud) is constructed every time
    // the player returns from ESC's menu and hits Start again, but
    // `#profiler-hud` itself is static markup in index.html, reused across
    // instances — without clearing it first, the previous instance's rows
    // stay put underneath this one's, reading as a second stacked overlay.
    this.root.replaceChildren();
    this.totalEl = document.createElement('div');
    this.totalEl.className = 'profiler-total';
    this.root.appendChild(this.totalEl);
  }

  update(samples: ProfileSample[], totalMs: number): void {
    // Toggled off in the menu: nothing on screen to update, and the panel's own
    // class is the single source of that (`applyProfilerVisible`).
    if (!this.root.classList.contains('visible')) return;
    this.totalEl.textContent = `frame ${totalMs.toFixed(1)} ms  (${Math.round(1000 / Math.max(totalMs, 0.001))} fps eq.)`;

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
      this.root.appendChild(entry.row);
    }
  }
}
