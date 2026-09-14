/**
 * The welcome popup over the menu: what this is, the basic controls and where a WAD goes, shown to
 * a new player at every boot until they tick "Don't bug me again". Owned by `Menu`, which opens it
 * from `main.ts`'s boot and closes it with everything else. See docs/menu.md § Welcome popup.
 */
import { readStorage, writeStorage } from '../../util/storage.ts';
import { OverlayShell, type MenuOverlay } from './overlay.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The persisted field: `false` once the player has ticked "Don't bug me again". Stored as the
 * *showing* flag, so a browser with no storage at all reads the default and keeps showing the popup
 * — docs/menu.md § Persisted settings.
 */
const SHOW_WELCOME_STORAGE_KEY = 'showWelcome';

export class WelcomeUi implements MenuOverlay {
  private shell = new OverlayShell(el('welcome'), el('welcome-close'), () => this.close());
  private muteCheckbox = el<HTMLInputElement>('welcome-mute');

  constructor() {
    // Written on every change like the settings checkboxes, so unticking it before closing counts
    // too — there is no "apply" here.
    this.muteCheckbox.addEventListener('change', () => {
      writeStorage(SHOW_WELCOME_STORAGE_KEY, !this.muteCheckbox.checked);
    });
  }

  /**
   * Brings the popup up unless the player has asked not to see it again. The checkbox always
   * starts unticked: the popup being up at all means it hasn't been muted.
   */
  open(): void {
    if (!readStorage(SHOW_WELCOME_STORAGE_KEY, true)) return;
    this.muteCheckbox.checked = false;
    this.shell.show();
  }

  /**
   * Closes the popup, so one ESC dismisses it and leaves the menu alone.
   * @returns whether it *was* open
   */
  close(): boolean {
    return this.shell.hide();
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }
}
