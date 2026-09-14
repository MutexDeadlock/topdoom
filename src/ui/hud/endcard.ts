/**
 * The card that ends a campaign: what comes up after the intermission when the exit taken was the
 * last one — DOOM's `E<x>M8` or DOOM II's MAP30. See docs/hud.md § End card.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import { drawIcon, drawText } from './hud.ts';
import { CONTINUE_HINT } from './intermission.ts';
import { WadFont, COLOR_YELLOW } from './wadfont.ts';

/** The two headings, by what actually ended — an episode of DOOM, or the whole map set. */
const TITLES = { episode: 'Episode complete', campaign: 'Game complete' } as const;

/**
 * Which of the two it was, `NextLevel`'s own pair — what `Game` holds on to until the card is due.
 */
export type EndScope = keyof typeof TITLES;

/** The other thing the continue key can do here, where the intermission's own hint is the first. */
const MENU_HINT = 'Press SPACE to return to the menu';

/** Everything the card shows, assembled by `Game` on the frame the last exit is consumed. */
export interface EndCardInfo {
  /** `E<x>M8` ends an episode; MAP30 (and a MAPINFO finale) ends the whole campaign. */
  scope: EndScope;
  /** The episode's own menu graphic (`M_EPI<x>`), where the loaded set has one for this map. */
  episodeGraphic?: string;
  /** Second line when there is no graphic to draw: the WAD set's label, as the HUD names it. */
  subtitle: string;
  /**
   * Whether a level follows (the next episode's `E<x+1>M1`) — decides the hint, not the wording
   * above.
   */
  continues: boolean;
  /**
   * Whether that key is the viewer's to press at all: under a playback it is the record's, so the
   * card carries no hint (docs/replays.md § Playback).
   */
  canContinue: boolean;
}

/**
 * The campaign-over popup, raised by the intermission's continue key rather than by the exit
 * itself: the level's own stats come first, this says the run is over. Same shape as
 * `Intermission` — a panel of native-size {@link WadFont} canvases that `endcard.css` scales — and
 * the same freeze/continue-key handling in `game.ts`, where one `Game.popup` field covers both.
 *
 * Deliberately not vanilla's `f_finale.c`: no `E1TEXT` crawl, no episode picture, no cast call.
 * docs/hud.md § End card names what that leaves out.
 */
export class EndCard {
  private gfx: GraphicsBank;
  private root = document.getElementById('end-card')!;
  private titleCanvas = this.root.querySelector<HTMLCanvasElement>('.title')!;
  private subjectCanvas = this.root.querySelector<HTMLCanvasElement>('.subject')!;
  private hintCanvas = this.root.querySelector<HTMLCanvasElement>('.hint')!;
  private redFont: WadFont;
  private yellowFont: WadFont;

  constructor(gfx: GraphicsBank) {
    this.gfx = gfx;
    this.redFont = new WadFont(gfx);
    this.yellowFont = new WadFont(gfx, COLOR_YELLOW);
  }

  show(info: EndCardInfo): void {
    drawText(this.titleCanvas, this.yellowFont, TITLES[info.scope]);
    // The episode's name as the WAD's own artist drew it, exactly as `LevelCard` prefers `CWILV`
    // over its text — and falling back the same way when the set carries no such lump.
    if (!info.episodeGraphic || !drawIcon(this.subjectCanvas, this.gfx, info.episodeGraphic)) {
      drawText(this.subjectCanvas, this.redFont, info.subtitle);
    }
    this.setContinueHint(info.canContinue);
    drawText(this.hintCanvas, this.redFont, info.continues ? CONTINUE_HINT : MENU_HINT);
    this.root.classList.remove('hidden');
  }

  /** `Intermission.setContinueHint`'s twin — the take-over reaches whichever popup is up. */
  setContinueHint(shown: boolean): void {
    this.hintCanvas.classList.toggle('hidden', !shown);
  }

  /** Drops the card. The element outlives any one `Game`, so `dispose` clears it too. */
  clear(): void {
    this.root.classList.add('hidden');
  }
}
