/**
 * What every popup over the menu shares: a root shown and hidden with `.hidden`, a close button and
 * a backdrop click that dismiss it, and a close that reports whether it *was* up. Named for the
 * behavior rather than an element, the way `hold.ts` is — the three popups keep their own markup,
 * content and lifecycle and hold one of these for the dismissing.
 * See docs/menu.md § The overlays over the menu.
 */

/**
 * What `Menu` needs of a popup that can cover it. `close` reports whether it *was* up, which is what
 * lets `closeTopOverlay` dismiss exactly one thing per `ESC`; `Menu.overlays` holds them in one
 * ordered list rather than naming them at each of the three sites that walk them.
 */
export interface MenuOverlay {
  close(): boolean;
  readonly isOpen: boolean;
}

export class OverlayShell {
  private root: HTMLElement;

  /**
   * Takes the **elements**, not their IDs: each popup still looks its own markup up in its field
   * initializers, so an ID renamed in the HTML fails at construction rather than lazily
   * (docs/menu.md § One screen, two jobs).
   *
   * `onClose` rather than hiding directly, because what a dismissal *means* belongs to the popup —
   * the reader drops its pending read, the WAD Library throws its draft away — and both routes in
   * here have to reach that one answer.
   */
  constructor(root: HTMLElement, closeButton: HTMLElement, onClose: () => void) {
    this.root = root;
    closeButton.addEventListener('click', onClose);
    // Guarded on the target: only the backdrop itself dismisses, or every click inside the panel
    // would.
    root.addEventListener('click', (e) => {
      if (e.target === root) onClose();
    });
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  /** Hides it, reporting whether it *was* up — `MenuOverlay.close`'s answer. */
  hide(): boolean {
    if (!this.isOpen) return false;
    this.root.classList.add('hidden');
    return true;
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }
}
