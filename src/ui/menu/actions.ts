/**
 * What the Save, Load, Replays and Multiplayer tabs share: the refusal contract, the lines beside
 * a row and in place of rows, the filter field, facts and chips, the icon buttons and the export
 * download. Pure DOM; each tab keeps the store call, the noun and its filter's fields.
 * docs/menu-saves.md § Save and Load tabs.
 */

/**
 * What a status line message is, which is its colour: `info` for what happened as asked, `caution`
 * for a notice that blocks nothing, `error` for what failed. docs/menu-wads.md § The status line.
 */
export type StatusKind = 'info' | 'caution' | 'error';

/**
 * The menu's status line, as the tabs are handed it; a message given no {@link StatusKind} is
 * `info`.
 */
export type StatusLine = (text: string, kind?: StatusKind) => void;

/**
 * Runs one store or hook call under the tabs' single refusal contract: anything thrown becomes the
 * status line's error.
 * @param done  what the status line says once `action` has succeeded; omitted, nothing
 * @returns whether `action` succeeded
 */
export async function attempt(setStatus: StatusLine, action: () => void | Promise<void>, done?: string): Promise<boolean> {
  try {
    await action();
  } catch (err) {
    setStatus((err as Error).message, 'error');
    return false;
  }
  if (done !== undefined) setStatus(done);
  return true;
}

/**
 * One reason a row is not what it should be: red for fatal, amber for a cosmetic loss.
 * @param full  the tooltip where `label` is the short form of it
 */
export function noteLine(kind: 'warning' | 'caution', label: string, full?: string): HTMLSpanElement {
  const line = document.createElement('span');
  line.className = kind;
  line.textContent = label;
  if (full !== undefined) line.title = full;
  return line;
}

/**
 * Wires a list heading's filter field. ESC clears a filter that has something in it and stops
 * there; an already empty field lets the key through to `main.ts`, which closes the menu with it.
 * @param onChange  handed the text on every keystroke, already trimmed and lowercased, so the
 *                  comparison {@link matchesFilter} makes is done once per keystroke rather than
 *                  once per row
 */
export function installFilter(input: HTMLInputElement, onChange: (filter: string) => void): void {
  input.addEventListener('input', () => onChange(input.value.trim().toLowerCase()));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || input.value === '') return;
    e.stopPropagation();
    input.value = '';
    onChange('');
  });
}

/**
 * Whether a row survives the filter above its list: a plain substring over the fields that tab
 * decided are worth searching.
 * @param filter  what {@link installFilter} handed over
 */
export function matchesFilter(filter: string, fields: readonly string[]): boolean {
  return filter === '' || fields.some((field) => field.toLowerCase().includes(filter));
}

/**
 * The line a list shows in place of rows: nothing stored yet, or nothing its filter kept. A
 * rendered child rather than the add-on list's `:empty::after`: only the renderer knows which.
 */
export function emptyLine(text: string): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'empty';
  line.textContent = text;
  return line;
}

/**
 * `facts` as read-only label/value lines in `block`, replacing what it held — menu.css's
 * `.fact-grid`. A value too long for its line ellipsizes and says itself whole in its tooltip.
 */
export function fillFacts(block: HTMLElement, facts: readonly [label: string, value: string][]): void {
  block.replaceChildren();
  for (const [label, value] of facts) {
    const term = document.createElement('span');
    term.className = 'label';
    term.textContent = label;
    const text = document.createElement('span');
    text.className = 'value';
    text.textContent = value;
    text.title = value;
    block.append(term, text);
  }
}

/**
 * A quiet chip beside a name — menu.css's `.mark`: a stock replay's `included`, a room's `host`.
 */
export function markChip(text: string, title = ''): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'mark';
  chip.textContent = text;
  chip.title = title;
  return chip;
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
