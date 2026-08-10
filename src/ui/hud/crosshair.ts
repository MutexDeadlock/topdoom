/**
 * The mouse cursor doubles as the aim reticle (see `game.ts`'s mouse-aim
 * raycast) — vanilla has no equivalent since its aim is keyboard/auto-aim
 * only, so this is TopDoom's own convention, tuned by feel rather than
 * sourced from vanilla. Its color reports player health at a glance without
 * spending any HUD space: blue above 100 (soulsphere/megasphere territory),
 * green at exactly 100, sliding through yellow down to red as health drops
 * to 0.
 */

/** Reticle size in CSS pixels. Tuned by feel, like the rest of the crosshair above. */
const SIZE = 24;
const CENTER = SIZE / 2;

/** Health → CSS color. `health <= 100` maps linearly onto hue 120 (green) down to 0 (red). */
function colorForHealth(health: number): string {
  if (health > 100) return 'hsl(210, 100%, 60%)';
  const hue = (Math.max(0, Math.min(100, health)) / 100) * 120;
  return `hsl(${hue}, 100%, 50%)`;
}

/** Plus-shaped reticle with a gap at the center, dark-outlined so it reads against any background. */
function crosshairSvg(color: string): string {
  const arms = [
    [CENTER, 2, CENTER, 8],
    [CENTER, 16, CENTER, 22],
    [2, CENTER, 8, CENTER],
    [16, CENTER, 22, CENTER],
  ]
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<g fill="none" stroke="black" stroke-width="4" stroke-opacity="0.55">${arms}` +
    `<circle cx="${CENTER}" cy="${CENTER}" r="1.5"/></g>` +
    `<g fill="${color}" stroke="${color}" stroke-width="2">${arms}` +
    `<circle cx="${CENTER}" cy="${CENTER}" r="1.5"/></g></svg>`
  );
}

/** Sets the game canvas's OS cursor to a health-colored reticle; skips the rebuild when the color hasn't changed. */
export class Crosshair {
  private canvas: HTMLCanvasElement;
  private lastColor: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  update(health: number): void {
    const color = colorForHealth(health);
    if (color === this.lastColor) return;
    this.lastColor = color;
    const uri = `data:image/svg+xml,${encodeURIComponent(crosshairSvg(color))}`;
    this.canvas.style.cursor = `url("${uri}") ${CENTER} ${CENTER}, crosshair`;
  }
}
