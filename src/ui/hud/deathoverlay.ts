/**
 * The full-screen panel raised a moment after the player dies: the killer line and
 * what `R` will do. See docs/death.md § Player death.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import { PLAYER_DEATH_FRAME_SECONDS } from '../../game/things/tables.ts';
import { drawText } from './hud.ts';
import { WadFont, COLOR_YELLOW } from './wadfont.ts';

/** The heading; the two lines under it are what {@link DeathOverlay.show} is told. */
const TITLE = 'You died';

/**
 * What the overlay's bottom line says: the two things `R` can do — reload the savegame this level
 * is being played out of, or reload the level itself (its checkpoint where there is one, a plain
 * restart otherwise — a distinction the player has no reason to care about) — and `none`, for a
 * death nobody in front of the screen can answer: a replay's, where `R` belongs to the record.
 * Which applies is the game layer's to know, so {@link DeathOverlay.show} is told that and this
 * layer keeps the wording. docs/death.md § Player death.
 */
export type DeathHint = 'restart' | 'reload-save' | 'respawn' | 'none';

const HINTS: Record<DeathHint, string> = {
  restart: 'press R to restart',
  'reload-save': 'press R to reload last savegame',
  // A netgame's: `R`, like use, brings the player back in the level (docs/multiplayer-coop.md §
  // Respawn).
  respawn: 'press R to respawn',
  none: '',
};

export class DeathOverlay {
  private rootEl = document.getElementById('death-overlay')!;
  private titleCanvas = this.rootEl.querySelector<HTMLCanvasElement>('.title')!;
  private killerCanvas = this.rootEl.querySelector<HTMLCanvasElement>('.killer')!;
  private hintCanvas = this.rootEl.querySelector<HTMLCanvasElement>('.hint')!;
  private redFont: WadFont;
  private yellowFont: WadFont;
  /** Seconds until the armed overlay is raised; negative once it is up, or when none is armed. */
  private delay = -1;
  /** The killer line the armed overlay will carry — see {@link DeathOverlay.show}. */
  private killer = '';
  /** Which hint the armed overlay will carry — see {@link DeathOverlay.show} and {@link DeathHint}. */
  private hint: DeathHint = 'restart';

  /**
   * The IWAD's own `STCFN*` type, the same three-canvas arrangement `EndCard` uses: the heading in
   * the font's native HUD red, the killer line in the yellow this UI reads as "the thing you came
   * here to know" ({@link COLOR_YELLOW}, as on the intermission's values), the hint dimmed by
   * `deathoverlay.css`. The title never changes, so it is drawn once here.
   */
  constructor(gfx: GraphicsBank) {
    this.redFont = new WadFont(gfx);
    this.yellowFont = new WadFont(gfx, COLOR_YELLOW);
    drawText(this.titleCanvas, this.redFont, TITLE);
  }

  /** Counts the arming delay down and raises the overlay when it runs out. */
  update(dt: number): void {
    if (this.delay < 0) return;
    this.delay -= dt;
    if (this.delay < 0) {
      drawText(this.killerCanvas, this.yellowFont, this.killer);
      this.killerCanvas.classList.toggle('blank', this.killer === '');
      drawText(this.hintCanvas, this.redFont, HINTS[this.hint]);
      this.hintCanvas.classList.toggle('blank', this.hint === 'none');
      this.rootEl.classList.remove('hidden');
    }
  }

  /**
   * Arms the overlay: {@link DeathOverlay.update} raises it once the corpse's chain has played end
   * to end, so the text arrives as the corpse settles rather than on the killing frame, and a
   * {@link DeathOverlay.clear} inside that window means it is never seen at all. Presentation only:
   * vanilla has no such overlay, and `R` answers throughout the delay, so nothing is gated behind
   * it. It is also what keeps a death the level's own ending is about to overtake from flashing an
   * overlay up for a few tics — see docs/death.md § Dying on the way out.
   *
   * @param killer  the middle line, already composed (`things/tables.ts`'s `obituary`): what killed
   *                the player is the game layer's to know, not this one's; `''` leaves the line out
   * @param hint    which bottom line applies
   * @param chain   the frames the corpse plays (`PlayerSlot.deathFrames`), each
   *                {@link PLAYER_DEATH_FRAME_SECONDS} long
   */
  show(killer: string, hint: DeathHint, chain: readonly string[]): void {
    this.killer = killer;
    this.hint = hint;
    this.delay = chain.length * PLAYER_DEATH_FRAME_SECONDS;
  }

  /**
   * Swaps the hint on an overlay already armed or up: taking a replay over hands `R` back to the
   * viewer while their corpse is on screen. An armed one is left to {@link DeathOverlay.update},
   * which draws it. docs/replays.md § Playback.
   */
  setHint(hint: DeathHint): void {
    if (hint === this.hint) return;
    this.hint = hint;
    if (this.rootEl.classList.contains('hidden')) return;
    drawText(this.hintCanvas, this.redFont, HINTS[hint]);
    this.hintCanvas.classList.toggle('blank', hint === 'none');
  }

  /** Takes the overlay down — armed or already up. Every map (re)load starts from here. */
  clear(): void {
    this.delay = -1;
    this.killer = '';
    this.hint = 'restart';
    this.rootEl.classList.add('hidden');
  }
}
