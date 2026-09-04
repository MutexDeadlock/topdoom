/**
 * What the Save, Load and Replays tabs' rows share: the refusal contract every store call runs
 * under, the warning line beside a row, the download and delete icon buttons, and handing an
 * export file to the browser. Pure DOM; each tab keeps what differs — the store call and the noun.
 * docs/menu.md § Save and Load tabs.
 */

/** The menu's status line, as the tabs are handed it. */
export type StatusLine = (text: string, isError?: boolean) => void;

/**
 * Runs one store or hook call under the tabs' single refusal contract: anything thrown becomes the
 * status line, and the caller learns whether to go on — the store's calls all being async, the
 * action is awaited and so is the verdict.
 */
export async function attempt(setStatus: StatusLine, action: () => void | Promise<void>, done?: string): Promise<boolean> {
  try {
    await action();
  } catch (err) {
    setStatus((err as Error).message, true);
    return false;
  }
  if (done !== undefined) setStatus(done);
  return true;
}

/**
 * One reason a row is not what it should be: red for fatal, amber for a cosmetic loss. `full` is
 * the tooltip where `label` is the short form of it.
 */
export function noteLine(kind: 'warning' | 'caution', label: string, full?: string): HTMLSpanElement {
  const line = document.createElement('span');
  line.className = kind;
  line.textContent = label;
  if (full !== undefined) line.title = full;
  return line;
}

/**
 * A download or delete button: its meaning is in the tooltip, so it gets a glyph-sized box. Both
 * glyphs are asked to render in the menu's own colour rather than pre-coloured from a system emoji
 * font — U+2913 is a plain arrow-to-bar rather than an emoji, and the wastebasket carries the
 * text-presentation selector U+FE0E.
 */
export function iconButton(kind: 'download' | 'delete', label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'icon';
  button.textContent = kind === 'download' ? '⤓' : '🗑︎';
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

/** Hands `text` to the browser as a file named `filename` — the export path of every tab. */
export function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
