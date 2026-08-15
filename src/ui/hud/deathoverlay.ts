/**
 * The full-screen panel raised a moment after the player dies: the killer line and
 * what `R` will do. See docs/death.md § Player death.
 */
import { PLAYER_DEATH_FRAMES, PLAYER_DEATH_FRAME_SECONDS } from '../../game/things/tables.ts';

/**
 * How long a death waits before its overlay appears — `PLAY`'s DIE sequence end to end, so the
 * text arrives as the corpse settles rather than on the killing frame. Presentation only: vanilla
 * has no such overlay, and `R` answers throughout the delay, so nothing is gated behind it. It is
 * also what keeps a death the level's own ending is about to overtake from flashing an overlay up
 * for a few tics — see docs/death.md § Dying on the way out.
 */
const DEATH_OVERLAY_DELAY = PLAYER_DEATH_FRAMES.length * PLAYER_DEATH_FRAME_SECONDS;

/**
 * The overlay's bottom line, in the two things `R` can do: reload the savegame
 * this level is being played out of, or reload the level itself (its checkpoint
 * where there is one, a plain restart otherwise — a distinction the player has
 * no reason to care about). Which one applies is the game layer's to know, so
 * `show` is told that and this layer keeps the wording.
 * docs/death.md § Player death.
 */
const RESTART_HINT = 'press R to restart';
const RELOAD_SAVE_HINT = 'press R to reload last savegame';

export class DeathOverlay {
  private rootEl = document.getElementById('death-overlay')!;
  private killerEl = document.querySelector<HTMLElement>('#death-overlay .killer')!;
  private hintEl = document.querySelector<HTMLElement>('#death-overlay .hint')!;
  /** Seconds until the armed overlay is raised; negative once it is up, or when none is armed. */
  private delay = -1;
  /** The killer line the armed overlay will carry — see `show`. */
  private killer = '';
  /** Which hint the armed overlay will carry — see `show` and `RESTART_HINT`. */
  private hint = RESTART_HINT;

  /** Counts the arming delay down and raises the overlay when it runs out. */
  update(dt: number): void {
    if (this.delay < 0) return;
    this.delay -= dt;
    if (this.delay < 0) {
      this.killerEl.textContent = this.killer;
      this.hintEl.textContent = this.hint;
      this.rootEl.classList.remove('hidden');
    }
  }

  /**
   * Arms the overlay, with `killer` as its middle line — an already-composed
   * sentence (`things/tables.ts`'s `obituary`), since what killed the player is the
   * game layer's to know, not this one's. `''` leaves the line out entirely.
   * `reloadsSave` says which of the two hints applies (`RESTART_HINT`).
   * `update` raises it `DEATH_OVERLAY_DELAY` later, so a `clear` inside that
   * window means it is never seen at all.
   */
  show(killer: string, reloadsSave: boolean): void {
    this.killer = killer;
    this.hint = reloadsSave ? RELOAD_SAVE_HINT : RESTART_HINT;
    this.delay = DEATH_OVERLAY_DELAY;
  }

  /** Takes the overlay down — armed or already up. Every map (re)load starts from here. */
  clear(): void {
    this.delay = -1;
    this.killer = '';
    this.hint = RESTART_HINT;
    this.rootEl.classList.add('hidden');
    this.killerEl.textContent = '';
  }
}
