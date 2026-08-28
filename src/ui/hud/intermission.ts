/**
 * The end-of-level popup: kills/items/secrets percentages, a face for how that went, then the
 * level time against best and par. See docs/hud.md § Intermission.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import type { BestTimeResult } from '../../game/besttimes.ts';
import { drawIcon, drawText, formatClock, percentOf, LEVEL_STATS_GREEN, type LevelStats } from './hud.ts';
import { WadFont, COLOR_YELLOW } from './wadfont.ts';

/**
 * What the player has to press to leave the popup — see `Game.frame`'s intermission branch. Shared
 * with `ui/hud/endcard.ts`, the other half of that one continue-key flow (docs/hud.md § End card):
 * both popups are dismissed by the same key and must not describe it differently.
 */
export const CONTINUE_HINT = 'Press SPACE to continue';

/**
 * How long the popup ignores that key. `Space` both uses the exit switch and dismisses the popup,
 * so without this a mashed switch skips past it before it can be read. `game.ts` owns the timer
 * and gates on this. **Tuned by feel** — long enough to swallow a double tap, short enough not to
 * feel stuck.
 */
export const INTERMISSION_INPUT_DELAY = 0.6;

const RECORD_TEXT = 'NEW BEST TIME!';

/**
 * What a run that used a cheat code gets instead of the whole popup — no percentages, no clock, no
 * comparison to a best time, because none of it means anything once the run was cheated
 * (docs/cheats.md § Saves and best times). Red like the labels it replaces, over the one face in
 * the status bar's roster that isn't about how the level went.
 */
const CHEATED_TEXT = 'You cheated';
const CHEATED_FACE = 'STFKILL3';

/**
 * The status-bar face shown over the time block, picked by how the level went: the three
 * percentages summed, so 300 is a clean sweep (and kills alone can push past it). Highest
 * `minScore` at or below the sum wins.
 *
 * Vanilla's intermission has no face at all, and `st_stuff.c`'s `ST_updateFaceWidget` drives these
 * lumps from damage taken and where the player is firing — neither of which this screen knows
 * about. Both the idea and the thresholds are this engine's own, **tuned by feel**.
 */
const FACE_TIERS: readonly { minScore: number; lump: string }[] = [
  { minScore: 300, lump: 'STFGOD0' },
  { minScore: 250, lump: 'STFEVL1' },
  { minScore: 50, lump: 'STFST21' },
  { minScore: 0, lump: 'STFOUCH1' },
];

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
  private statsBlock = this.root.querySelector<HTMLElement>('.stats')!;
  private cheatedCanvas = this.root.querySelector<HTMLCanvasElement>('.line-cheated')!;
  private faceCanvas = this.root.querySelector<HTMLCanvasElement>('.face')!;
  private timeCanvas = this.root.querySelector<HTMLCanvasElement>('.line-time')!;
  private parCanvas = this.root.querySelector<HTMLCanvasElement>('.line-par')!;
  private recordCanvas = this.root.querySelector<HTMLCanvasElement>('.line-record')!;
  private bestCanvas = this.root.querySelector<HTMLCanvasElement>('.line-best')!;
  private hintCanvas = this.root.querySelector<HTMLCanvasElement>('.line-hint')!;
  private gfx: GraphicsBank;
  private redFont: WadFont;
  private yellowFont: WadFont;
  private greenFont: WadFont;
  private labelColumnWidth: number;
  private percentColumnWidth: number;
  private timeLabelColumnWidth: number;
  private timeColumnWidth: number;

  constructor(gfx: GraphicsBank) {
    this.gfx = gfx;
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
    // The four time lines share one label and one value column, so they line up as a block the way
    // the stat lines do. `formatClock` is fixed-width, so any clock measures the same.
    this.timeLabelColumnWidth = Math.max(
      this.redFont.measure('Your time  '),
      this.redFont.measure('Previous  '),
      this.redFont.measure('Best time  '),
      this.redFont.measure('Par  '),
    );
    this.timeColumnWidth = this.yellowFont.measure(formatClock(0));
    // Doesn't depend on the level, so it's drawn once per Game rather than per exit.
    drawText(this.hintCanvas, this.redFont, CONTINUE_HINT);
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
   * The level's par time, hidden when nothing knows one — Ultimate Doom's episode 4, an
   * unrecognised IWAD, or a PWAD map with no `[PARS]` entry (docs/wad.md § Par times).
   *
   * Green at or under par and yellow over it. That colouring is this engine's, not vanilla's:
   * `WI_drawStats` prints par in one font however the run went. Same call as `LEVEL_STATS_GREEN`
   * makes for the stat lines — the popup already speaks in green for "you got it".
   */
  private drawParLine(parSeconds: number | null, elapsedSeconds: number): void {
    this.parCanvas.classList.toggle('hidden', parSeconds === null);
    if (parSeconds === null) return;
    const font = elapsedSeconds <= parSeconds ? this.greenFont : this.yellowFont;
    this.drawTimeLine(this.parCanvas, 'Par', formatClock(parSeconds), font);
  }

  /** One `<label>  <clock>` line of the time block, in the columns every line of it shares. */
  private drawTimeLine(canvas: HTMLCanvasElement, label: string, clock: string, font: WadFont): void {
    this.drawPair(canvas, label, clock, font, this.timeLabelColumnWidth, this.timeColumnWidth);
  }

  /**
   * The face over the time block. Hidden when the WAD set has no such lump, the same fallback every
   * other WAD graphic here takes.
   */
  private drawFace(lump: string): void {
    this.faceCanvas.classList.toggle('hidden', !drawIcon(this.faceCanvas, this.gfx, lump));
  }

  /** Which face this run earned, by the summed percentages — see `FACE_TIERS`. */
  private faceFor(stats: LevelStats): string {
    const score =
      percentOf(stats.kills, stats.totalKills) +
      percentOf(stats.items, stats.totalItems) +
      percentOf(stats.secrets, stats.totalSecrets);
    const tier = FACE_TIERS.find((t) => score >= t.minScore) ?? FACE_TIERS[FACE_TIERS.length - 1];
    return tier.lump;
  }

  /**
   * The time-to-beat block. `record` is null for a run that can't set one (see docs/hud.md
   * § Best times), and both lines stay hidden then — a player who started somewhere other than the
   * level's own start is better told nothing than shown a record they can't touch.
   */
  private drawBestLines(record: BestTimeResult | null): void {
    this.recordCanvas.classList.toggle('hidden', !record?.isNewBest);
    if (record?.isNewBest) drawText(this.recordCanvas, this.greenFont, RECORD_TEXT);

    // With no previous time there is nothing to show: the run that just ended *is* the record, and
    // the line above already says so.
    if (record === null || record.previous === null) {
      this.bestCanvas.classList.add('hidden');
      return;
    }
    this.bestCanvas.classList.remove('hidden');
    const label = record.isNewBest ? 'Previous' : 'Best time';
    this.drawTimeLine(this.bestCanvas, label, formatClock(record.previous), this.yellowFont);
  }

  /**
   * The whole popup replaced by one line (see `CHEATED_TEXT`) — every canvas the run's numbers
   * would have gone on is hidden here, and only here, so each `draw*` below stays the sole owner
   * of its own line's visibility. The continue hint stays, since it is still what dismisses this.
   */
  private showCheated(): void {
    this.statsBlock.classList.add('hidden');
    for (const line of [this.timeCanvas, this.recordCanvas, this.bestCanvas, this.parCanvas]) {
      line.classList.add('hidden');
    }
    this.cheatedCanvas.classList.remove('hidden');
    drawText(this.cheatedCanvas, this.redFont, CHEATED_TEXT);
    this.drawFace(CHEATED_FACE);
    this.root.classList.remove('hidden');
  }

  /**
   * `cheated` is `game.ts`'s `recordsEligible` inverted — the same flag that already decides
   * whether a completion may set a record, rather than a second account of what happened this run.
   */
  show(stats: LevelStats, record: BestTimeResult | null, parSeconds: number | null, cheated: boolean): void {
    if (cheated) return this.showCheated();
    this.cheatedCanvas.classList.add('hidden');
    this.statsBlock.classList.remove('hidden');
    // The one line below with no `draw*` of its own to un-hide it: every run that gets here has a
    // time, so nothing but `showCheated` ever hides it.
    this.timeCanvas.classList.remove('hidden');
    this.drawStatLine(this.killsCanvas, 'Kills', stats.kills, stats.totalKills);
    this.drawStatLine(this.itemsCanvas, 'Items', stats.items, stats.totalItems);
    this.drawStatLine(this.secretsCanvas, 'Secrets', stats.secrets, stats.totalSecrets);
    this.drawFace(this.faceFor(stats));
    // Always yellow, records included — the green `NEW BEST TIME!` line below is what announces
    // one.
    this.drawTimeLine(this.timeCanvas, 'Your time', formatClock(stats.elapsedSeconds), this.yellowFont);
    this.drawParLine(parSeconds, stats.elapsedSeconds);
    this.drawBestLines(record);
    this.root.classList.remove('hidden');
  }

  /**
   * Drops the popup. Like the other overlays, the element outlives any one `Game`, so `dispose`
   * clears it too.
   */
  clear(): void {
    this.root.classList.add('hidden');
  }
}
