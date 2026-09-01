/**
 * The About popup over the menu: what this is and what it's built on, with the repo's CHANGELOG as
 * its second tab. Owned by `Menu`, which opens it from the two links in the menu header and closes
 * it with everything else. See docs/menu.md § About.
 */
import { OverlayShell, type MenuOverlay } from './overlay.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The contact address, ROT13'd — the one thing on this page a harvester wants. Neither the markup
 * nor a plain text scrape of the bundle turns up anything mailable; only a scraper that runs the
 * page gets the address, which is the cheap 90% of the problem. Decoded into the link at
 * construction, so a reader sees it as ordinary text.
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
    const mail = el<HTMLAnchorElement>('about-mail');
    mail.textContent = rot13(MAIL);
    mail.href = `mailto:${rot13(MAIL)}`;
    this.setTab('about');
  }

  /** Brings the popup up on one tab — which one is the link the player clicked, not a memo. */
  open(tab: AboutTab): void {
    this.shell.show();
    this.setTab(tab);
  }

  /**
   * Closes the popup, reporting whether it *was* open — `main.ts`'s ESC handler asks this first
   * (through `Menu.closeTopOverlay`), so one ESC dismisses the popup and leaves the menu (and a
   * paused level) alone. The same explicit hand-off `LibraryUi.close` gets.
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
   * Fills the Changelog tab on first open. The file is a *dynamic* `import`, so the bundler
   * resolves it at build time (no `public/` copy, and nothing that can 404) but parks the text in
   * its own chunk, downloaded only by someone who actually opens the tab — docs/menu.md § About.
   *
   * A failed load is reported in the panel and leaves `changelogLoaded` false, so simply reopening
   * retries.
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
