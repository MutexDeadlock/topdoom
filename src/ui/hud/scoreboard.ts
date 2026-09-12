/**
 * The scoreboard of a game of more than one player: every slot's name in its armour colour, its
 * kills this level and its ping — held up with Tab, and above the intermission's panel. `Game`
 * says what the rows are; this draws them. docs/hud.md § Scoreboard.
 */
import { PLAYER_COLORS, PLAYER_COLOR_RAMPS, type PlayerColor } from '../../wad/playercolor.ts';

/** One player's line on the board. */
export interface ScoreRow {
  name: string;
  color: PlayerColor;
  /** The player's own kills this level — `PlayerSlot.kills`, in a deathmatch `PlayerSlot.netFrags`. */
  kills: number;
  /** The round trip to the relay in milliseconds, or null where there is none to show. */
  pingMs: number | null;
  /** The player this browser plays. */
  local: boolean;
  /** False for a network game's slot whose player has left. */
  present: boolean;
}

/** The shade of a colour's ramp a name starts from: the sixth, the one the menu's swatches show. */
const NAME_SHADE = 5;

/**
 * The least HSL lightness a name is drawn at, lifting the dark ramps (red's sixth shade is
 * `#7f1b1b`) to where they read as text on the board; hue and saturation stay the ramp's. Tuned by
 * feel.
 */
const NAME_MIN_LIGHTNESS = 0.55;

export class Scoreboard {
  private readonly root: HTMLElement;
  private readonly rowsEl: HTMLTableSectionElement;
  /** Each colour's CSS colour for a name, read off the loaded palette once. */
  private readonly nameColors: Record<PlayerColor, string>;
  /** The rows last drawn, serialized, so a frame that changes nothing touches no DOM. */
  private drawn = '';

  /**
   * @param palette  the loaded set's PLAYPAL, which the armour is drawn through
   * @param root  the board's element, wearing `.scoreboard`: `#scoreboard`, the one Tab holds up,
   *              unless given
   */
  constructor(palette: Uint8Array, root: HTMLElement = document.getElementById('scoreboard')!) {
    this.root = root;
    // The columns are written here beside `rowFor` rather than in each board's markup, so the two
    // boards' headings cannot drift from their rows.
    const table = document.createElement('table');
    const headings = document.createElement('tr');
    headings.append(cell('th', 'name', 'Player'), cell('th', 'kills', 'Kills'), cell('th', 'ping', 'Ping'));
    table.createTHead().append(headings);
    this.rowsEl = table.createTBody();
    root.replaceChildren(table);
    this.nameColors = Object.fromEntries(PLAYER_COLORS.map((color) => [color, nameColor(palette, color)])) as Record<
      PlayerColor,
      string
    >;
  }

  /**
   * The board showing `rows`, or taken down for null. Every frame.
   *
   * @param rows  one per slot, in slot order
   */
  update(rows: readonly ScoreRow[] | null): void {
    if (!rows) {
      this.clear();
      return;
    }
    const key = JSON.stringify(rows);
    if (key !== this.drawn) {
      this.drawn = key;
      this.rowsEl.replaceChildren(...rows.map((row) => this.rowFor(row)));
    }
    // Every frame: `toggle` with a force writes no attribute when the class already matches.
    this.root.classList.toggle('hidden', false);
  }

  /** Takes the board down: the element is static markup that outlives the `Game` driving it. */
  clear(): void {
    this.root.classList.toggle('hidden', true);
  }

  private rowFor(row: ScoreRow): HTMLTableRowElement {
    const line = document.createElement('tr');
    line.classList.toggle('local', row.local);
    line.classList.toggle('gone', !row.present);
    const name = document.createElement('span');
    name.className = 'truncate';
    name.style.color = this.nameColors[row.color];
    name.textContent = row.name;
    line.append(
      cell('td', 'name', name),
      cell('td', 'kills', String(row.kills)),
      cell('td', 'ping', row.pingMs === null ? '—' : `${row.pingMs} ms`),
    );
    return line;
  }
}

function cell(tag: 'th' | 'td', className: string, content: string | HTMLElement): HTMLTableCellElement {
  const el = document.createElement(tag);
  el.className = className;
  el.append(content);
  return el;
}

/**
 * A name's CSS colour: its ramp's {@link NAME_SHADE}, lifted to {@link NAME_MIN_LIGHTNESS}.
 *
 * @param palette  PLAYPAL, three bytes per index
 */
function nameColor(palette: Uint8Array, color: PlayerColor): string {
  const at = (PLAYER_COLOR_RAMPS[color] + NAME_SHADE) * 3;
  const r = palette[at] / 255;
  const g = palette[at + 1] / 255;
  const b = palette[at + 2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (chroma > 0 && max === r) {
    hue = ((g - b) / chroma + 6) % 6;
  } else if (chroma > 0 && max === g) {
    hue = (b - r) / chroma + 2;
  } else if (chroma > 0) {
    hue = (r - g) / chroma + 4;
  }
  const lifted = Math.max(lightness, NAME_MIN_LIGHTNESS);
  return `hsl(${(hue * 60).toFixed(1)} ${(saturation * 100).toFixed(1)}% ${(lifted * 100).toFixed(1)}%)`;
}
