/**
 * The mouse cursor doubles as the aim reticle, its color reporting player health — TopDoom's own
 * convention, tuned by feel rather than sourced from vanilla, whose aim is keyboard/auto-aim only.
 * See docs/hud.md § The crosshair.
 */
import { COLOR_BLUE } from './wadfont.ts';

/**
 * Reticle geometry in CSS pixels, all tuned by feel like the rest of the crosshair above.
 * {@link SIZE} stays at or under 32 because that's the largest cursor bitmap every platform
 * accepts. {@link HALO} is how far the black outline pass stands proud of the colored one —
 * docs/hud.md § The crosshair.
 */
const SIZE = 28;
const CENTER = SIZE / 2;
const HALO = 1.25;
const STROKE = 2;
const ARM_INNER = 6;
const ARM_OUTER = 12;
const DOT_R = 1.5;

/**
 * Sets the game canvas's OS cursor to a health-colored reticle; skips the rebuild when the color
 * hasn't changed.
 */
export class Crosshair {
  private canvas: HTMLCanvasElement;
  private lastColor: string | null = null;
  private detached = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /** The reticle image for `health`, as a CSS `url()` — what a replay's reticle element shows. */
  static image(health: number): string {
    return `url("data:image/svg+xml,${encodeURIComponent(crosshairSvg(colorForHealth(health)))}")`;
  }

  update(health: number): void {
    const color = colorForHealth(health);
    if (color === this.lastColor) return;
    this.lastColor = color;
    if (!this.detached) this.canvas.style.cursor = cursorFor(color);
  }

  /**
   * Takes the reticle off the pointer — a replay draws it where the recording aimed instead, and
   * the pointer goes back to the ordinary arrow, which is what the bar's controls are clicked
   * with (docs/replays.md § Playback) — or puts it back on.
   */
  detach(on: boolean): void {
    if (on === this.detached) return;
    this.detached = on;
    if (on) this.canvas.style.cursor = 'default';
    else if (this.lastColor !== null) this.canvas.style.cursor = cursorFor(this.lastColor);
  }
}

/**
 * The over-100 blue, as CSS — the HUD's own `ARM2A0`-sampled blue ({@link COLOR_BLUE}), so the
 * reticle and the health number cross into it as one cue rather than in two different blues.
 */
const OVER_HUNDRED = `rgb(${COLOR_BLUE.join(', ')})`;

function cursorFor(color: string): string {
  const uri = `data:image/svg+xml,${encodeURIComponent(crosshairSvg(color))}`;
  return `url("${uri}") ${CENTER} ${CENTER}, crosshair`;
}

/** Health → CSS color. `health <= 100` maps linearly onto hue 120 (green) down to 0 (red). */
function colorForHealth(health: number): string {
  if (health > 100) return OVER_HUNDRED;
  const hue = (Math.max(0, Math.min(100, health)) / 100) * 120;
  return `hsl(${hue}, 100%, 50%)`;
}

/** The four arms of the plus, as `<line>`s spanning `inner`..`outer` pixels from the center. */
function arms(inner: number, outer: number): string {
  return [
    [CENTER, CENTER - outer, CENTER, CENTER - inner],
    [CENTER, CENTER + inner, CENTER, CENTER + outer],
    [CENTER - outer, CENTER, CENTER - inner, CENTER],
    [CENTER + inner, CENTER, CENTER + outer, CENTER],
  ]
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
    .join('');
}

/**
 * Plus-shaped reticle with a gap at the center, outlined in solid black so it reads against any
 * background.
 */
function crosshairSvg(color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<g fill="black" stroke="black" stroke-width="${STROKE + HALO * 2}">` +
    `${arms(ARM_INNER - HALO, ARM_OUTER + HALO)}` +
    `<circle cx="${CENTER}" cy="${CENTER}" r="${DOT_R + HALO}" stroke="none"/></g>` +
    `<g fill="${color}" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round">` +
    `${arms(ARM_INNER, ARM_OUTER)}` +
    `<circle cx="${CENTER}" cy="${CENTER}" r="${DOT_R}" stroke="none"/></g></svg>`
  );
}
