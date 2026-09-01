/**
 * The text-file popup over the menu: the `.txt` a WAD ships beside it, opened from the info column
 * of either WAD list. Owned by `Menu`, which opens it and closes it with everything else.
 * See docs/menu.md § The text file popup.
 */
import type { WadSource } from '../../wad/library.ts';
import { OverlayShell, type MenuOverlay } from './overlay.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class WadInfoUi implements MenuOverlay {
  private shell = new OverlayShell(el('wadinfo'), el('wadinfo-close'), () => this.close());
  private titleEl = el<HTMLHeadingElement>('wadinfo-title');
  private sourceEl = el<HTMLSpanElement>('wadinfo-source');
  private textEl = el<HTMLPreElement>('wadinfo-text');
  /**
   * Which open the reader is filling for. A read is a fetch or a disk read, so a second file opened
   * while the first is still in flight would otherwise be overwritten by it when it lands.
   */
  private token = 0;

  /**
   * Brings the popup up on one WAD's text file and starts reading it. A source with none is not
   * offered one — the info column is a spacer then (`labels.ts: infoColumn`) — so this is a no-op
   * rather than an empty reader.
   */
  open(source: WadSource): void {
    const text = source.textFile;
    if (!text) return;
    this.titleEl.textContent = text.name;
    this.sourceEl.textContent = source.label;
    this.textEl.textContent = 'Loading …';
    this.shell.show();
    const token = ++this.token;
    void text.read().then(
      (content) => {
        if (token === this.token) this.textEl.textContent = content.trimEnd();
      },
      (err: Error) => {
        if (token === this.token) this.textEl.textContent = `Could not read ${text.name}: ${err.message}`;
      },
    );
  }

  /**
   * Closes the popup, reporting whether it *was* open — the same explicit hand-off `AboutUi.close`
   * and `LibraryUi.close` get, so one ESC dismisses one thing (docs/menu.md § WAD Library).
   */
  close(): boolean {
    if (!this.shell.hide()) return false;
    // Nothing in flight may land in a closed popup and be there, stale, at the next open.
    this.token++;
    return true;
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }
}
