/**
 * Every powerup or damage effect whose whole result is a *view* change: the
 * two full-screen tints, the red damage flash, the light visor's exposure
 * lift, the player sprite's translucency and the death overlay. See
 * docs/hud.md § Screen effects.
 */
import type * as THREE from 'three';
import { hasPower, type Inventory } from '../../game/inventory.ts';
import { PLAYER_DEATH_FRAMES, PLAYER_DEATH_FRAME_SECONDS } from '../../game/thingdefs.ts';
import { DOOM_TIC } from '../../constants.ts';

/**
 * How solid the player sprite draws under partial invisibility. Vanilla's
 * `fuzz` colormap is a software-renderer trick with no equivalent here; plain
 * translucency is the stand-in (docs/items.md § Powerups and the backpack).
 */
const INVISIBILITY_OPACITY = 0.35;

/**
 * `toneMappingExposure` while the light visor is held — a flat multiply, as
 * close as this gets to vanilla forcing the brightest colormap row without
 * rebuilding every surface's baked vertex lighting (docs/items.md § Powerups and the backpack).
 */
const LIGHT_VISOR_EXPOSURE = 2.5;

/**
 * The red damage flash, echoing `ST_doPaletteStuff`'s `damagecount`: raw damage
 * into a counter clamped to 100, ticked down 1/tic. `MAX_DAMAGE` is that clamp
 * and `FADE_SECONDS` is 100 tics over 35. `MAX_ALPHA` has no vanilla analogue
 * (there it's a palette swap, not an overlay) and is **tuned by feel**.
 */
const PAIN_FLASH_MAX_DAMAGE = 100;
const PAIN_FLASH_FADE_SECONDS = 100 * DOOM_TIC;
const PAIN_FLASH_MAX_ALPHA = 0.5;

/**
 * When a timed powerup's screen effect starts blinking as an expiry warning,
 * and how fast. **Tuned by feel** — vanilla blinks a HUD number (`cnt & 8` in
 * `ST_Ticker`), not a screen effect. See docs/hud.md § Screen effects.
 */
const POWER_BLINK_WARNING_SECONDS = 3;
const POWER_BLINK_HZ = 4;

/**
 * How long a death waits before its overlay appears — `PLAY`'s DIE sequence end to end, so the
 * text arrives as the corpse settles rather than on the killing frame. Presentation only: vanilla
 * has no such overlay, and `R` answers throughout the delay, so nothing is gated behind it. It is
 * also what keeps a death the level's own ending is about to overtake from flashing an overlay up
 * for a few tics — see docs/death.md § Dying on the way out.
 */
const DEATH_OVERLAY_DELAY = PLAYER_DEATH_FRAMES.length * PLAYER_DEATH_FRAME_SECONDS;

/**
 * Whether a powerup's screen effect should currently show, given its
 * remaining seconds (`Inventory.powers[id]`). Once inside the warning
 * window, `floor(secs * Hz) % 2` alternates every `1/Hz` seconds as `secs`
 * counts down — a plain on/off square wave ending exactly at 0, no separate
 * blink-phase timer to track.
 */
function powerBlinkVisible(secondsLeft: number): boolean {
  return (
    secondsLeft > 0 &&
    (secondsLeft > POWER_BLINK_WARNING_SECONDS || Math.floor(secondsLeft * POWER_BLINK_HZ) % 2 === 0)
  );
}

export class ScreenEffects {
  private renderer: THREE.WebGLRenderer;
  private setPlayerOpacity: (opacity: number) => void;
  private tintEl = document.getElementById('screen-tint')!;
  private painEl = document.getElementById('pain-flash')!;
  private deathEl = document.getElementById('death-overlay')!;
  private killerEl = document.querySelector<HTMLElement>('#death-overlay .killer')!;
  /** Current intensity of the damage flash, 0-1 — bumped by `addPain`, decayed by `update`. */
  private painFlash = 0;
  /** Seconds until the armed death overlay is raised; negative once it is up, or when none is armed. */
  private deathDelay = -1;
  /** The killer line the armed overlay will carry — see `showDeath`. */
  private deathKiller = '';

  /**
   * `setPlayerOpacity` writes partial invisibility to the player's own
   * `SpriteActor`, passed as a callback so this stays out of the render layer
   * — it's the one effect here that isn't a DOM overlay or a renderer uniform.
   */
  constructor(renderer: THREE.WebGLRenderer, setPlayerOpacity: (opacity: number) => void) {
    this.renderer = renderer;
    this.setPlayerOpacity = setPlayerOpacity;
  }

  /**
   * Drives every effect off inventory state each frame rather than toggling
   * them on pickup/expiry, so a level change or restart clearing the powers
   * needs no teardown path of its own.
   */
  update(dt: number, inv: Inventory): void {
    this.tintEl.classList.toggle('invulnerable', powerBlinkVisible(inv.powers.invulnerability));
    this.tintEl.classList.toggle('suited', powerBlinkVisible(inv.powers.radiationSuit));
    this.renderer.toneMappingExposure = hasPower(inv, 'lightVisor') ? LIGHT_VISOR_EXPOSURE : 1;
    this.setPlayerOpacity(powerBlinkVisible(inv.powers.invisibility) ? INVISIBILITY_OPACITY : 1);
    this.painFlash = Math.max(0, this.painFlash - dt / PAIN_FLASH_FADE_SECONDS);
    this.painEl.style.opacity = String(this.painFlash * PAIN_FLASH_MAX_ALPHA);
    if (this.deathDelay >= 0) {
      this.deathDelay -= dt;
      if (this.deathDelay < 0) {
        this.killerEl.textContent = this.deathKiller;
        this.deathEl.classList.remove('hidden');
      }
    }
  }

  /** Bumps the damage flash by a hit that actually landed — see `PAIN_FLASH_MAX_DAMAGE`. */
  addPain(amount: number): void {
    this.painFlash = Math.min(1, this.painFlash + amount / PAIN_FLASH_MAX_DAMAGE);
  }

  /**
   * Arms the overlay, with `killer` as its middle line — an already-composed
   * sentence (`thingdefs.ts`'s `obituary`), since what killed the player is the
   * game layer's to know, not this one's. `''` leaves the line out entirely.
   * `update` raises it `DEATH_OVERLAY_DELAY` later, so a `clearDeath` inside that
   * window means it is never seen at all.
   */
  showDeath(killer: string): void {
    this.deathKiller = killer;
    this.deathDelay = DEATH_OVERLAY_DELAY;
  }

  /** Clears the death overlay — armed or already up — and any lingering flash. Every map (re)load starts from here. */
  clearDeath(): void {
    this.deathDelay = -1;
    this.deathKiller = '';
    this.deathEl.classList.add('hidden');
    this.killerEl.textContent = '';
    this.painFlash = 0;
    this.painEl.style.opacity = '0';
  }

  /**
   * Turns everything back off. The renderer and the overlay elements outlive
   * the `Game` that drove them, so without this the menu — and the next level
   * started from it — inherits whatever powerup happened to be running.
   */
  reset(): void {
    this.tintEl.classList.remove('invulnerable', 'suited');
    this.painEl.style.opacity = '0';
    this.renderer.toneMappingExposure = 1;
  }
}
