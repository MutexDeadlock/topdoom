/**
 * The loading screen: the boot overlay, and what covers a WAD download or a level too big to build
 * between two frames. One instance per session, owned by `main.ts`.
 * See docs/menu.md § The loading screen.
 */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class LoadingScreen {
  private root = el('loading');
  private titleEl = el('loading-title');
  private detailEl = el('loading-detail');
  private barEl = el('loading-bar');
  private fillEl = el('loading-fill');
  /**
   * The last fraction actually written, in tenths of a percent — the resolution the bar and the
   * counter can show between them. A 28 MB download arrives in over a thousand chunks and would
   * otherwise rewrite the same width and the same text most of the time, which also restarts the
   * fill's CSS transition on every chunk so it never runs.
   */
  private shown = -1;

  /** Takes the screen, with the bar and detail line cleared — a caller that has neither shows neither. */
  show(title: string): void {
    this.titleEl.textContent = title;
    this.detailEl.textContent = '';
    this.barEl.classList.add('hidden');
    this.fillEl.style.width = '0';
    this.shown = -1;
    this.root.classList.remove('hidden');
  }

  /** The line under the bar: which file is downloading, or which map is being built. */
  detail(text: string): void {
    this.detailEl.textContent = text;
  }

  /**
   * Raises the bar and fills it. `total` of 0 leaves the bar down: a source whose size is unknown
   * (an uploaded file, a library file) reports no fraction rather than a lying one.
   */
  progress(loaded: number, total: number): void {
    if (total <= 0) return;
    const permille = Math.min(1000, Math.round((loaded / total) * 1000));
    if (permille === this.shown) return;
    if (this.shown < 0) this.barEl.classList.remove('hidden');
    this.shown = permille;
    this.fillEl.style.width = `${permille / 10}%`;
    this.detailEl.textContent = `${megabytes(loaded)} / ${megabytes(total)} MB`;
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  /**
   * Resolves after the browser has had a chance to paint what was just set. The level build that
   * follows a `show` runs in one synchronous block, so without this the overlay is put up and taken
   * down inside a single task and never reaches the screen.
   */
  painted(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }
}

/** MB with one decimal — the unit every WAD is comfortably in, so the counter never changes unit. */
function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
