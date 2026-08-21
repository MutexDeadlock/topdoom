/**
 * Press-and-hold confirm: a destructive button that fills over `HOLD_MS` and only acts when the
 * fill lands. Shared by the save list's Delete and Overwrite and the WAD Library's Forget folder.
 * See docs/menu.md § Save and Load tabs.
 */

/**
 * How long a destructive button has to be held. Tuned by feel: long enough that a stray click can't
 * destroy anything, short enough that nobody wonders whether the button is broken.
 */
const HOLD_MS = 750;

/**
 * Turns `button` into a press-and-hold confirm. The action fires when the fill lands; letting go
 * early cancels it and puts `hint` in the status line. An inline confirm, so the changelog stays
 * the menu's only popup (docs/menu.md § Changelog).
 *
 * The label moves into a `.label` span so the `.fill` bar can sit behind it, and the fill's own
 * duration is handed to CSS as `--hold-time` — one number, so the bar can't finish at a different
 * moment than the timer.
 */
export function confirmOnHold(
  button: HTMLButtonElement,
  hint: string,
  setStatus: (text: string) => void,
  action: () => void,
): void {
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = button.textContent;
  const fill = document.createElement('span');
  fill.className = 'fill';
  // Fill first: both are positioned, so DOM order is what paints the label on top.
  button.replaceChildren(fill, label);
  button.classList.add('hold');
  button.style.setProperty('--hold-time', `${HOLD_MS}ms`);

  let timer = 0;
  const cancel = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
    button.classList.remove('holding');
    setStatus(hint);
  };
  const start = () => {
    // Not every browser suppresses pointer events on a disabled control, and a press that got
    // through would print the hold hint for a dead button.
    if (timer || button.disabled) return;
    button.classList.add('holding');
    timer = window.setTimeout(() => {
      timer = 0;
      button.classList.remove('holding');
      setStatus('');
      action();
    }, HOLD_MS);
  };

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Keeps the press from starting a text selection or a drag of the row.
    e.preventDefault();
    start();
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
    button.addEventListener(type, cancel);
  }
  // A button also activates on Space/Enter, so holding the key holds the button — `repeat` keeps
  // auto-repeat from restarting anything.
  button.addEventListener('keydown', (e) => {
    if (!e.repeat && (e.key === ' ' || e.key === 'Enter')) start();
  });
  button.addEventListener('keyup', cancel);
}
