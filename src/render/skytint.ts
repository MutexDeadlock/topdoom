/**
 * The colour a sky ceiling lends what stands under it: every surface facing a sector roofed with
 * `F_SKY1` is tinted toward the level's own sky, so a courtyard reads as outdoors from a camera
 * that never shows the sky itself. See docs/render-lighting.md § Outdoor sky tint.
 */
import * as THREE from 'three';
import { SKY_FLAT } from '../wad/map.ts';
import type { Sector } from '../wad/map.ts';
import type { Bitmap } from '../wad/graphics.ts';
import { readStorage, writeStorage } from '../util/storage.ts';

const STORAGE_KEY = 'skyTint';

/**
 * How far a surface is carried toward the sky's colour, as a fraction of the way from its own.
 * Tuned by feel — outdoors has to read at a glance without the floor changing material.
 */
export const STRENGTH = 0.45;

/**
 * The furthest any channel may travel from neutral, whatever the sky. Tuned by feel, and it binds —
 * docs/render-lighting.md § Outdoor sky tint.
 */
const LIMIT = 0.3;

/**
 * What a sky with no colour of its own lends instead — a cool daylight, at luminance 1. **Tuned by
 * feel, and the one invented value here** — docs/render-lighting.md § Outdoor sky tint.
 */
const COLOURLESS_SKY: readonly [number, number, number] = [0.9, 0.99, 1.3];

/**
 * How much colour a sky needs before it speaks for itself rather than blending toward
 * `COLOURLESS_SKY`, as the spread between its strongest and weakest channel. Tuned by feel.
 */
const CHROMA_FULL = 0.25;

/** Rec. 709 luminance, the weighting the tint is held at so a sky only ever shifts colour. */
const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * Whether the tint is applied at all. On by default. Shaped like every persisted setting —
 * docs/menu.md § Persisted settings (docs/render-lighting.md § Turning the tint off).
 */
let enabled = readStorage(STORAGE_KEY, true);

/** What the level's own sky asks for, kept apart so the toggle can put it back without a rebuild. */
const levelTint = new THREE.Color(1, 1, 1);

/** What a surface indoors is multiplied by — shared, and never written. */
const NEUTRAL = new THREE.Color(1, 1, 1);

/**
 * What every map material multiplies a sky-lit vertex's colour by (`textures.ts`), white when the
 * tint is off or the level has no sky to read. One object shared by every program, the
 * `LightUniforms` pattern.
 */
export const skyTintUniform = { value: new THREE.Color(1, 1, 1) };

export function getSkyTint(): boolean {
  return enabled;
}

export function setSkyTint(on: boolean): void {
  enabled = on;
  applyTint();
  writeStorage(STORAGE_KEY, on);
}

/**
 * Reads the level's sky, or drops the tint where the WAD has no such texture. Called once per
 * level, since the sky is fixed for the whole of one (`game.ts`).
 */
export function setLevelSky(sky: Bitmap | null): void {
  const [r, g, b] = skyTintOf(sky);
  levelTint.setRGB(r, g, b);
  applyTint();
}

/**
 * Whether a sector is roofed with sky, and so takes the tint — what `aSkyLit` marks for a surface,
 * asked per sprite instead, since a sprite's colour is recomputed every frame anyway.
 */
export function skyLitSector(sector: Sector | undefined): boolean {
  return sector?.ceilTex === SKY_FLAT;
}

/**
 * What a sprite's own sector light is multiplied by, the shader's `uSkyTint` in the form the
 * unbatched and instanced sprite paths both take. A dynamic light's contribution is its own colour
 * and stays out of this, as it does on a surface. docs/render-lighting.md § Outdoor sky tint.
 */
export function skyScale(sky: boolean): THREE.Color {
  return sky ? skyTintUniform.value : NEUTRAL;
}

/**
 * The multiplier a sky lends, at luminance 1 so it shifts colour without brightening: the average
 * of the lump's opaque pixels, blended toward `COLOURLESS_SKY` by how little colour it has, carried
 * `STRENGTH` of the way from neutral and clamped to `LIMIT`. Exported for the test.
 */
export function skyTintOf(sky: Bitmap | null): [number, number, number] {
  const average = averageColor(sky);
  if (!average) return [1, 1, 1];
  const luminance = LUMA[0] * average[0] + LUMA[1] * average[1] + LUMA[2] * average[2];
  if (luminance <= 0) return [1, 1, 1];

  // The sky's own hue, at luminance 1. A mix of two such vectors keeps that luminance, since
  // luminance is linear in the channels — which is what lets the two blends below stack.
  const hue = average.map((c) => c / luminance) as [number, number, number];
  const own = Math.min(1, chromaOf(hue) / CHROMA_FULL);
  return hue.map((c, i) => {
    const lent = COLOURLESS_SKY[i] + (c - COLOURLESS_SKY[i]) * own;
    return Math.min(1 + LIMIT, Math.max(1 - LIMIT, 1 + (lent - 1) * STRENGTH));
  }) as [number, number, number];
}

/** The live uniform: the level's tint while the setting is on, neutral while it is off. */
function applyTint(): void {
  if (enabled) skyTintUniform.value.copy(levelTint);
  else skyTintUniform.value.setRGB(1, 1, 1);
}

/** Mean of every pixel the sky actually draws, or null where there are none. */
function averageColor(sky: Bitmap | null): [number, number, number] | null {
  if (!sky) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let seen = 0;
  for (let i = 0; i < sky.data.length; i += 4) {
    // A sky texture is opaque, but a PWAD's may be a patch that does not fill its own height.
    if (sky.data[i + 3] === 0) continue;
    r += sky.data[i];
    g += sky.data[i + 1];
    b += sky.data[i + 2];
    seen++;
  }
  return seen > 0 ? [r / seen, g / seen, b / seen] : null;
}

/** How much colour a hue carries: the spread between its strongest and weakest channel. */
function chromaOf(hue: readonly [number, number, number]): number {
  const high = Math.max(...hue);
  const low = Math.min(...hue);
  return high > 0 ? (high - low) / high : 0;
}
