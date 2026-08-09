import type { GraphicsBank } from '../wad/graphics.ts';
import { formatClock, percentOf, LEVEL_STATS_GREEN, type LevelStats } from './hud.ts';
import { WadFont, COLOR_YELLOW } from './wadfont.ts';

/** What the player has to press to leave the popup — see `Game.frame`'s intermission branch. */
const CONTINUE_HINT = 'Press SPACE to continue';

/**
 * The end-of-level popup: the same three counts the HUD strip carries, as vanilla's percentages
 * this time, plus the frozen level time. Shown when a level's exit fires and dismissed by a key,
 * with the world frozen behind it — see docs/items.md § Intermission.
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
  private hintCanvas = this.root.querySelector<HTMLCanvasElement>('.line-hint')!;
  private redFont: WadFont;
  private yellowFont: WadFont;
  private greenFont: WadFont;
  private labelColumnWidth: number;

  constructor(gfx: GraphicsBank) {
    this.redFont = new WadFont(gfx);
    this.yellowFont = new WadFont(gfx, COLOR_YELLOW);
    this.greenFont = new WadFont(gfx, LEVEL_STATS_GREEN);
    this.labelColumnWidth = Math.max(
      this.redFont.measure('Kills  '),
      this.redFont.measure('Items  '),
      this.redFont.measure('Secrets  '),
    );
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

  /** One `<label>  <n>%` line, its number switching to green at 100% like the HUD strip's does. */
  private drawStatLine(canvas: HTMLCanvasElement, label: string, found: number, total: number): void {
    const percent = percentOf(found, total);
    const valueText = `${percent}%`;
    const valueFont = percent >= 100 ? this.greenFont : this.yellowFont;
    canvas.width = this.labelColumnWidth + valueFont.measure(valueText);
    canvas.height = Math.max(this.redFont.height, valueFont.height);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.redFont.draw(ctx, 0, 0, label);
    valueFont.draw(ctx, this.labelColumnWidth, 0, valueText);
  }

  show(stats: LevelStats): void {
    this.drawStatLine(this.killsCanvas, 'Kills', stats.kills, stats.totalKills);
    this.drawStatLine(this.itemsCanvas, 'Items', stats.items, stats.totalItems);
    this.drawStatLine(this.secretsCanvas, 'Secrets', stats.secrets, stats.totalSecrets);
    this.drawText(this.timeCanvas, this.yellowFont, formatClock(stats.elapsedSeconds));
    this.root.classList.remove('hidden');
  }

  /** Drops the popup. Like the other overlays, the element outlives any one `Game`, so `dispose` clears it too. */
  clear(): void {
    this.root.classList.add('hidden');
  }
}
