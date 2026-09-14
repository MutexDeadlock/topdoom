/**
 * The About popup over the menu: what this is and what it's built on, with the repo's CHANGELOG as
 * its second tab. Owned by `Menu`, which opens it from the two links in the menu header and closes
 * it with everything else. See docs/menu.md § About.
 */
import { OverlayShell, type MenuOverlay } from './overlay.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The contact address, ROT13'd so neither the markup nor a text scrape of the bundle turns up
 * anything mailable — docs/menu.md § About. Decoded into the link's `href` at construction; the
 * link reads "E-Mail", so the address is never on the page as text either.
 */
const MAIL = 'zngmr-g-aej@jro.qr';

const rot13 = (text: string) =>
  text.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 84) % 26) + 97));

/** The popup's tabs; `Menu` names one when it opens, since each header link opens its own. */
export type AboutTab = 'about' | 'changelog';

export class AboutUi implements MenuOverlay {
  private shell = new OverlayShell(el('about'), el('about-close'), () => this.close());
  private changelogText = el<HTMLPreElement>('changelog-text');
  private changelogLoaded = false;
  private tabButtons = {
    about: el<HTMLButtonElement>('about-tab-button-about'),
    changelog: el<HTMLButtonElement>('about-tab-button-changelog'),
  };
  private tabPanels = {
    about: el<HTMLDivElement>('about-tab-about'),
    changelog: el<HTMLDivElement>('about-tab-changelog'),
  };

  constructor() {
    for (const tab of Object.keys(this.tabButtons) as AboutTab[]) {
      this.tabButtons[tab].addEventListener('click', () => this.setTab(tab));
    }
    el<HTMLAnchorElement>('about-mail').href = `mailto:${rot13(MAIL)}`;
    this.setTab('about');
  }

  /** Brings the popup up on one tab — which one is the link the player clicked, not a memo. */
  open(tab: AboutTab): void {
    this.shell.show();
    this.setTab(tab);
  }

  /**
   * Closes the popup, so one ESC dismisses it and leaves the menu (and a paused level) alone —
   * docs/menu.md § The overlays over the menu.
   * @returns whether it *was* open
   */
  close(): boolean {
    return this.shell.hide();
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  private setTab(tab: AboutTab): void {
    for (const key of Object.keys(this.tabButtons) as AboutTab[]) {
      this.tabButtons[key].classList.toggle('active', key === tab);
      this.tabPanels[key].classList.toggle('inactive', key !== tab);
    }
    if (tab === 'changelog') {
      // Reopening always starts at the newest entry rather than where the last read left off.
      this.tabPanels.changelog.scrollTop = 0;
      void this.loadChangelog();
    }
  }

  /**
   * Fills the Changelog tab on first open, from a *dynamic* `import` that parks the text in its own
   * chunk. A failed load leaves {@link AboutUi.changelogLoaded} false, so reopening retries —
   * docs/menu.md § About.
   */
  private async loadChangelog(): Promise<void> {
    if (this.changelogLoaded) return;
    this.changelogText.textContent = 'Loading …';
    try {
      const { default: text } = await import('../../../CHANGELOG?raw');
      this.changelogText.textContent = text.trimEnd();
      this.changelogLoaded = true;
    } catch (err) {
      this.changelogText.textContent = `Could not load the changelog: ${(err as Error).message}`;
    }
  }
}
