import type { GraphicsBank } from '../wad/graphics.ts';
import type { BestTimeResult } from '../game/besttimes.ts';
import { formatClock, percentOf, LEVEL_STATS_GREEN, type LevelStats } from './hud.ts';
import { WadFont, COLOR_YELLOW } from './wadfont.ts';

/** What the player has to press to leave the popup — see `Game.frame`'s intermission branch. */
const CONTINUE_HINT = 'Press SPACE to continue';

const RECORD_TEXT = 'NEW BEST TIME!';

/**
 * The end-of-level popup: the same three counts the HUD strip carries, as vanilla's percentages
 * this time, then the frozen level time and how it compares to the level's best. Shown when a
 * level's exit fires and dismissed by a key, with the world frozen behind it — see docs/hud.md
 * § Intermission and § Best times.
 *
 * One canvas per line (static markup in index.html), each drawn like `Hud.drawStatLine`: a red
 * label run, then a value run starting at a shared column so the numbers line up rather than
 * drifting with each label's width.
 */
export class Intermission {
  private root = document.getElementById('intermission')!;
  private killsCanvas = this.root.querySelector<HTMLCanvasElement>('.line-kills')!;
  private itemsCanvas = this.root.querySelector<HTMLCanvasElement>('.line-items')!;
  private secretsCanvas = this.root.querySelector<HTMLCanvasElement>('.line-secrets')!;
  private timeLabelCanvas = this.root.querySelector<HTMLCanvasElement>('.line-timelabel')!;
  private timeCanvas = this.root.querySelector<HTMLCanvasElement>('.line-time')!;
  private recordCanvas = this.root.querySelector<HTMLCanvasElement>('.line-record')!;
  private bestCanvas = this.root.querySelector<HTMLCanvasElement>('.line-best')!;
  private hintCanvas = this.root.querySelector<HTMLCanvasElement>('.line-hint')!;
  private redFont: WadFont;
  private yellowFont: WadFont;
  private greenFont: WadFont;
  private labelColumnWidth: number;
  private percentColumnWidth: number;

  constructor(gfx: GraphicsBank) {
    this.redFont = new WadFont(gfx);
    this.yellowFont = new WadFont(gfx, COLOR_YELLOW);
    this.greenFont = new WadFont(gfx, LEVEL_STATS_GREEN);
    this.labelColumnWidth = Math.max(
      this.redFont.measure('Kills  '),
      this.redFont.measure('Items  '),
      this.redFont.measure('Secrets  '),
    );
    // The widest a percentage normally gets. Recoloring doesn't touch glyph widths, so measuring
    // with either value font gives the same column.
    this.percentColumnWidth = this.yellowFont.measure('100%');
    // Neither of these depends on the level, so they're drawn once per Game rather than per exit.
    this.drawText(this.timeLabelCanvas, this.redFont, 'Your time');
    this.drawText(this.hintCanvas, this.redFont, CONTINUE_HINT);
  }

  private drawText(canvas: HTMLCanvasElement, font: WadFont, text: string): void {
    canvas.width = Math.max(1, font.measure(text));
    canvas.height = Math.max(1, font.height);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    font.draw(ctx, 0, 0, text);
  }

  /**
   * A red label with its value starting at `valueX`. Given a `columnWidth`, the value is instead
   * right-aligned inside that column — which also makes every line that shares one the same total
   * width, so a run of them lines up on the numbers' right edge. A value wider than the column
   * (a kill count past 100%) widens it rather than being clipped or pushed back over the label.
   */
  private drawPair(
    canvas: HTMLCanvasElement,
    label: string,
    valueText: string,
    valueFont: WadFont,
    valueX: number,
    columnWidth?: number,
  ): void {
    const valueWidth = valueFont.measure(valueText);
    const column = Math.max(columnWidth ?? valueWidth, valueWidth);
    canvas.width = valueX + column;
    canvas.height = Math.max(this.redFont.height, valueFont.height);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.redFont.draw(ctx, 0, 0, label);
    valueFont.draw(ctx, valueX + (columnWidth === undefined ? 0 : column - valueWidth), 0, valueText);
  }

  /**
   * One `<label>  <n>%` line: the number right-aligned against the other two, and switching to
   * green at 100% like the HUD strip's does.
   */
  private drawStatLine(canvas: HTMLCanvasElement, label: string, found: number, total: number): void {
    const percent = percentOf(found, total);
    const valueFont = percent >= 100 ? this.greenFont : this.yellowFont;
    this.drawPair(canvas, label, `${percent}%`, valueFont, this.labelColumnWidth, this.percentColumnWidth);
  }

  /**
   * The time-to-beat block. `record` is null for a run that can't set one (see docs/hud.md
   * § Best times), and both lines stay hidden then — a player who started somewhere other than the
   * level's own start is better told nothing than shown a record they can't touch.
   */
  private drawBestLines(record: BestTimeResult | null): void {
    this.recordCanvas.classList.toggle('hidden', !record?.isNewBest);
    if (record?.isNewBest) this.drawText(this.recordCanvas, this.greenFont, RECORD_TEXT);

    // With no previous time there is nothing to show: the run that just ended *is* the record, and
    // the line above already says so.
    if (record === null || record.previous === null) {
      this.bestCanvas.classList.add('hidden');
      return;
    }
    this.bestCanvas.classList.remove('hidden');
    const label = record.isNewBest ? 'Previous' : 'Best';
    this.drawPair(this.bestCanvas, label, formatClock(record.previous), this.yellowFont, this.redFont.measure(`${label}  `));
  }

  show(stats: LevelStats, record: BestTimeResult | null): void {
    this.drawStatLine(this.killsCanvas, 'Kills', stats.kills, stats.totalKills);
    this.drawStatLine(this.itemsCanvas, 'Items', stats.items, stats.totalItems);
    this.drawStatLine(this.secretsCanvas, 'Secrets', stats.secrets, stats.totalSecrets);
    // Always yellow, records included — the green `NEW BEST TIME!` line below is what announces one.
    this.drawText(this.timeCanvas, this.yellowFont, formatClock(stats.elapsedSeconds));
    this.drawBestLines(record);
    this.root.classList.remove('hidden');
  }

  /** Drops the popup. Like the other overlays, the element outlives any one `Game`, so `dispose` clears it too. */
  clear(): void {
    this.root.classList.add('hidden');
  }
}
