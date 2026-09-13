/**
 * The message feed over the status bar — pickups, who joined or left, who killed whom, a save — a
 * few lines of WAD-font text that fade out on their own, and the setting that says which games show
 * them. See docs/hud.md § HUD messages.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import { readStorage, writeStorage } from '../../util/storage.ts';
import { WadFont, type WadFontRecolor } from './wadfont.ts';

/** Which games show the feed: none, only a game with more than one player, or every game. */
export type HudMessageMode = 'off' | 'multiplayer' | 'all';

const MODE_STORAGE_KEY = 'hudMessages';
const MODES: readonly HudMessageMode[] = ['all', 'multiplayer', 'off'];

/**
 * How many lines are up at once, the newest at the bottom; a fourth pushes the oldest out. Vanilla
 * shows one (`hu_stuff.h`'s `HU_MSGHEIGHT`); three is **tuned by feel** — a pickup and a frag land
 * in the same second often enough that one line loses one of them.
 */
const MAX_LINES = 3;

/**
 * How long a line stands at full strength before it starts to fade, and how long the fade takes.
 * Together they are vanilla's `HU_MSGTIMEOUT` (`4*TICRATE`, `hu_stuff.h`), which cuts a message
 * off at four seconds; the split between the two is **tuned by feel**.
 */
const HOLD_SECONDS = 2;
const FADE_SECONDS = 1.5;

/**
 * Read per message rather than once, so a change in the menu applies to the level already running.
 * Shaped like every persisted setting — docs/menu.md § Persisted settings.
 */
let hudMessageMode = readMode();

export function getHudMessageMode(): HudMessageMode {
  return hudMessageMode;
}

export function setHudMessageMode(mode: HudMessageMode): void {
  hudMessageMode = mode;
  writeStorage(MODE_STORAGE_KEY, mode);
}

/**
 * The feed's line for a player's death, in the third person everyone on the level reads it in —
 * the death overlay speaks to the victim alone (docs/death.md § Who killed the player). This
 * engine's own: vanilla has no obituaries.
 *
 * @param killer  the killing player's name, or null where no other player did it
 */
export function deathLine(victim: string, killer: string | null): string {
  return killer === null ? `${victim} died` : `${killer} killed ${victim}`;
}

/**
 * What follows a line that came in `count` times while up, drawn in the status amber (`base.css`'s
 * `--caution`): nothing the first time.
 */
export function countSuffix(count: number): string {
  return count > 1 ? ` (x${count})` : '';
}

/** One line up: what it says, how often it came in, its canvas, and how long it has left. */
interface FeedLine {
  text: string;
  count: number;
  canvas: HTMLCanvasElement;
  secondsLeft: number;
}

/**
 * The feed itself: up to {@link MAX_LINES} lines of STCFN text stacked over `#hud-bar`, the newest
 * at the bottom, each fading out on its own clock. Drawn in STCFN's own red, the colour vanilla
 * prints its messages in (`hu_stuff.c`), which also keeps it apart from the yellow the center
 * message announces in. Same "canvas sized to its content, CSS scales it" pattern the rest of the
 * HUD uses. See docs/hud.md § HUD messages.
 */
export class HudMessages {
  private font: WadFont;
  private countFont: WadFont;
  private root = document.getElementById('hud-messages')!;
  /** Oldest first; the DOM order is this order. */
  private lines: FeedLine[] = [];
  /** Whether this level is a game with more than one player — what `multiplayer` mode asks. */
  private multiplayer: boolean;

  /**
   * @param multiplayer  whether the level runs with more than one player, `Game.netgame`'s
   *                     answer
   */
  constructor(gfx: GraphicsBank, multiplayer: boolean) {
    this.font = new WadFont(gfx);
    // The line's own red where the token can't be read, rather than a copy of its value here.
    this.countFont = new WadFont(gfx, cssColor('--caution') ?? undefined);
    this.multiplayer = multiplayer;
  }

  /**
   * Adds `text` as the newest line, dropping the oldest once {@link MAX_LINES} are up. A line still
   * up with the same text is not repeated: it moves to the bottom, counts up ({@link countSuffix})
   * and starts its clock again. Nothing happens under a mode that hides this game's feed.
   */
  show(text: string): void {
    if (!this.shown()) return;
    const at = this.lines.findIndex((line) => line.text === text);
    const line = at < 0 ? { text, count: 0, canvas: document.createElement('canvas'), secondsLeft: 0 } : this.lines[at];
    if (at >= 0) this.lines.splice(at, 1);
    line.count++;
    line.secondsLeft = HOLD_SECONDS + FADE_SECONDS;
    const suffix = countSuffix(line.count);
    line.canvas.width = Math.max(1, this.font.measure(text) + this.countFont.measure(suffix));
    line.canvas.height = Math.max(1, this.font.height);
    line.canvas.style.opacity = '1';
    const ctx = line.canvas.getContext('2d')!;
    this.countFont.draw(ctx, this.font.draw(ctx, 0, 0, text), 0, suffix);
    this.lines.push(line);
    while (this.lines.length > MAX_LINES) this.lines.shift();
    this.root.replaceChildren(...this.lines.map((up) => up.canvas));
  }

  /**
   * Ticks every line's clock down and fades each over its last {@link FADE_SECONDS}. Not called
   * while the game is paused, so the menu doesn't eat a line's display time — and a mode switched
   * to `off` there takes what is up down on return.
   */
  update(dt: number): void {
    if (this.lines.length === 0) return;
    if (!this.shown()) {
      this.clear();
      return;
    }
    let expired = 0;
    for (const line of this.lines) {
      line.secondsLeft -= dt;
      if (line.secondsLeft <= 0) {
        expired++;
        continue;
      }
      line.canvas.style.opacity = String(Math.min(1, line.secondsLeft / FADE_SECONDS));
    }
    // The oldest expire first, so what is gone is a prefix.
    if (expired > 0) {
      this.lines.splice(0, expired);
      this.root.replaceChildren(...this.lines.map((line) => line.canvas));
    }
  }

  /**
   * Drops every line. Every level (re)load goes through here, so a line can't outlive its level;
   * the element is static markup outliving any one `Game`.
   */
  clear(): void {
    this.lines.length = 0;
    this.root.replaceChildren();
  }

  /** Whether the current mode shows this game's feed. */
  private shown(): boolean {
    const mode = getHudMessageMode();
    return mode === 'all' || (mode === 'multiplayer' && this.multiplayer);
  }
}

/**
 * A colour token from `base.css` as the recolor takes it, so the canvas and the stylesheet read one
 * value.
 *
 * @returns null for a token that is unset or not a `#rrggbb` hex
 */
function cssColor(token: string): WadFontRecolor | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return hex ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)] : null;
}

function readMode(): HudMessageMode {
  const stored = readStorage(MODE_STORAGE_KEY, 'all');
  return (MODES as readonly string[]).includes(stored) ? (stored as HudMessageMode) : 'all';
}
