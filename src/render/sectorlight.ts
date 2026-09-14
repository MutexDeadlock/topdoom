/**
 * What a sector's light level does to a surface: vanilla's `COLORMAP` ramp measured from the lump,
 * and the distance term (`r_main.c`'s `scale/DISTMAP`) that darkens a surface as it recedes from
 * the eye — applied per fragment for map geometry, through the GLSL below, and per draw on the CPU
 * for a sprite. Map vertices carry only a light segment, never a brightness.
 * See docs/render-lighting.md § Sector lighting and § Distance lighting.
 */
import type * as THREE from 'three';
import { BRIGHTNESS_LIFT } from '../constants.ts';
import { glslFloat } from '../util/glsl.ts';

/**
 * One fixed sample of `r_main.c`'s `scale/DISTMAP` term (4 ≈ 320 map units), for the two places
 * that need a depth and have none: what the light-amplification visor flattens the whole level to,
 * and what {@link litColor} answers when called without one. Not a brightness knob —
 * {@link BRIGHTNESS_LIFT} is that. docs/render-lighting.md § Sector lighting.
 */
export const REFERENCE_STEPS = 4;

/**
 * The distance term's numerator, in map units: how many `COLORMAP` rows nearer than `startmap` a
 * surface at depth `d` is drawn is `DIMINISH_SCALE / d`. Vanilla: `scalelight` is indexed by
 * `rw_scale >> LIGHTSCALESHIFT` where `rw_scale = FixedDiv(projection, rw_distance)` and
 * `projection = centerx << FRACBITS` = 160 at 320 wide, so the index is `2560 / d`, and
 * `R_ExecuteSetViewSize` divides it by `DISTMAP` (2) — `r_main.c`, `r_segs.c`. Tied to vanilla's
 * 320-wide view on purpose: a port at any resolution keeps this same index
 * (`SCREENWIDTH / viewwidth` in the table build), so the darkening is a property of the map, not
 * the window.
 */
export const DIMINISH_SCALE = 1280;

/**
 * The most rows the term subtracts: `MAXLIGHTSCALE - 1` (47, `r_main.h`) over `DISTMAP`. Reached
 * within 56 units of the eye, nearer than this camera ever hangs.
 */
export const MAX_DIMINISH_ROWS = 23;

/** Rows of `COLORMAP`, `NUMCOLORMAPS` in `r_main.h`. */
const COLORMAP_ROWS = 32;

/**
 * How much of the distance term applies: 1 normally, 0 while the light-amplification visor is held
 * (vanilla's `fixedcolormap`, `r_main.c`). One object shared by every map material, the
 * `LightUniforms` pattern, and the only copy of the bit — {@link litColor} reads it back for the
 * sprites. docs/render-lighting.md § The light-amplification visor flattens it.
 */
export const diminishUniform = { value: 1 };

/** Raises and drops the visor's flattening; `ui/hud/screeneffects.ts` drives it per frame. */
export function setDistanceFlattened(on: boolean): void {
  diminishUniform.value = on ? 0 : 1;
}

/**
 * What each of `COLORMAP`'s 32 rows does to brightness, as a **linear-light** multiplier —
 * measured from the real lump, one baked table for DOOM, DOOM2 and Freedoom.
 * docs/render-lighting.md § Sector lighting.
 */
const COLORMAP_GAIN = [
  1.0, 0.9662, 0.9055, 0.8253, 0.7552, 0.6956, 0.6437, 0.584,
  0.5366, 0.4949, 0.4492, 0.4067, 0.3632, 0.3282, 0.2946, 0.2627,
  0.2317, 0.2023, 0.1765, 0.1526, 0.1312, 0.1086, 0.0918, 0.0758,
  0.0621, 0.0492, 0.0383, 0.0288, 0.0202, 0.0142, 0.0082, 0.0034,
];

/**
 * The light segment a level falls in after fake contrast — DOOM's own `light >> LIGHTSEGSHIFT`
 * (`r_main.h`), so two levels under 16 apart are the same segment.
 */
export function lightSegment(light: number, contrast = 0): number {
  return Math.max(0, Math.min(255, light + contrast)) >> 4;
}

/**
 * How many rows nearer than `startmap` a surface is drawn: the term above as the shader computes
 * it, **not floored** — vanilla's is a table index, this one is read through
 * {@link colormapGain}'s interpolation.
 * docs/render-lighting.md § The term is continuous, the ramp is not.
 *
 * @param depth View depth, in map units along the camera's axis. Under one unit reads as one: the
 *   term is a division, and the eye never stands on a surface.
 */
export function diminishRows(depth: number): number {
  return Math.min(MAX_DIMINISH_ROWS, DIMINISH_SCALE / Math.max(1, depth));
}

/**
 * The fake-contrast offset for a wall running from (ax,ay) to (bx,by) — the one copy, so `addWall`
 * and `MoverGeometry.recolorSector` (redoing it per quad when a sector's light changes) can't drift
 * apart.
 */
export function wallContrast(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dy === 0 ? -16 : dx === 0 ? 16 : 0;
}

/**
 * {@link lightToColor} plus {@link BRIGHTNESS_LIFT} — what lights every sprite, the map shader's
 * `liftedGain` being the same sum for geometry. {@link lightToColor} itself stays pure and
 * vanilla-exact, so it can be verified in isolation.
 */
export function litColor(light: number, contrast = 0, depth?: number): number {
  const rows = depth === undefined || diminishUniform.value === 0 ? REFERENCE_STEPS : diminishRows(depth);
  return applyBrightnessLift(lightToColor(light, contrast, rows), BRIGHTNESS_LIFT);
}

/**
 * Sector light level (0..255) as a **linear-light** multiplier — not a display value, since the
 * renderer's `outputColorSpace` encodes it on output. docs/render-lighting.md § Sector lighting.
 *
 * @param contrast The fake-contrast offset in light units, of which ±16 is vanilla's ±1 segment.
 * @param rows The distance term, {@link REFERENCE_STEPS} unless a depth decided otherwise; may be
 *   fractional (§ The term is continuous, the ramp is not).
 */
export function lightToColor(light: number, contrast = 0, rows = REFERENCE_STEPS): number {
  return colormapGain(colormapRow(lightSegment(light, contrast), rows));
}

/**
 * The one row of the view matrix {@link viewDepthAt} needs. Four numbers rather than a matrix:
 * written once a frame, read once per drawn sprite. Untouched it is the identity, whose depth is a
 * plain `-z` — what a layer drawn headless reads.
 */
let viewX = 0;
let viewY = 0;
let viewZ = 1;
let viewW = 0;

/**
 * Opens a frame's depths. Takes the camera's `matrixWorldInverse` as it stands rather than
 * inverting: three's `Camera` refreshes it inside the `updateMatrixWorld` that
 * `TopDownCamera.applyToCamera` already ends with. docs/render-lighting.md § Distance lighting.
 */
export function beginViewDepth(camera: THREE.Camera): void {
  const e = camera.matrixWorldInverse.elements;
  viewX = e[2];
  viewY = e[6];
  viewZ = e[10];
  viewW = e[14];
}

/**
 * The view depth of a three.js-space point along the camera's axis — the `d` of the term above.
 * The map shader reads the same depth off `mvPosition`, so a sprite and the floor it stands on
 * darken together.
 */
export function viewDepthAt(x: number, y: number, z: number): number {
  return -(viewX * x + viewY * y + viewZ * z + viewW);
}

/**
 * The GLSL twin of {@link litColor}, spliced into every map material (`textures.ts`) as four
 * pieces: two declaration blocks, the vertex-stage capture, and the fragment-stage multiply. **The
 * whole ramp lives here** — a vertex carries only its light segment.
 * docs/render-lighting.md § Distance lighting.
 */
export const DISTANCE_LIGHT_GLSL = {
  vertexDeclarations: `
    attribute float aLightSeg;
    flat varying float vLightSeg;
    varying float vViewDepth;`,
  vertexCapture: `
    vLightSeg = aLightSeg;
    vViewDepth = -mvPosition.z;`,
  fragmentDeclarations: `
    flat varying float vLightSeg;
    varying float vViewDepth;
    uniform float uDiminish;
    const float COLORMAP_GAIN[${COLORMAP_ROWS}] = float[${COLORMAP_ROWS}](${COLORMAP_GAIN.map(glslFloat).join(', ')});
    float liftedGain(float row) {
      float lo = floor(row);
      float gain = mix(COLORMAP_GAIN[int(lo)], COLORMAP_GAIN[int(min(lo + 1.0, ${glslFloat(COLORMAP_ROWS - 1)}))], row - lo);
      return gain + ${glslFloat(BRIGHTNESS_LIFT)} * (1.0 - gain);
    }`,
  fragmentApply: `
    {
      float startmap = (15.0 - vLightSeg) * 4.0;
      float rows = min(${glslFloat(MAX_DIMINISH_ROWS)}, ${glslFloat(DIMINISH_SCALE)} / max(1.0, vViewDepth));
      float atDepth = clamp(startmap - rows, 0.0, ${glslFloat(COLORMAP_ROWS - 1)});
      float atReference = clamp(startmap - ${glslFloat(REFERENCE_STEPS)}, 0.0, ${glslFloat(COLORMAP_ROWS - 1)});
      diffuseColor.rgb *= mix(liftedGain(atReference), liftedGain(atDepth), uDiminish);
    }`,
};

/**
 * The `COLORMAP` row a light segment reads through with `rows` of the distance term taken off:
 * `startmap - rows`, where `startmap = ((LIGHTLEVELS - 1 - seg) * 2) * NUMCOLORMAPS / LIGHTLEVELS`
 * (`R_InitLightTables`, `r_main.c`) = `(15 - seg) * 4`, clamped to the table as vanilla clamps it.
 * Fractional where `rows` is — {@link colormapGain} reads between two rows.
 */
function colormapRow(segment: number, rows: number): number {
  const row = (15 - segment) * 4 - rows;
  return Math.max(0, Math.min(COLORMAP_ROWS - 1, row));
}

/**
 * {@link COLORMAP_GAIN} at a **fractional** row, linearly interpolated — the CPU twin of the
 * shader's `liftedGain`, and what keeps the distance term from drawing its row boundaries as lines
 * across a floor. An integer row is exactly the table's own entry.
 * docs/render-lighting.md § The term is continuous, the ramp is not.
 */
function colormapGain(row: number): number {
  const lo = Math.floor(row);
  return COLORMAP_GAIN[lo] + (row - lo) * (COLORMAP_GAIN[Math.min(lo + 1, COLORMAP_ROWS - 1)] - COLORMAP_GAIN[lo]);
}

/**
 * A "lift" toward full brightness: pushes `linear` up by a fraction `lift` of its remaining
 * headroom `(1 - linear)`, so the darker a surface already is the more it moves. `lift = 0` is a
 * no-op, `lift = 1` flattens everything to full bright. docs/render-lighting.md § Sector lighting.
 */
function applyBrightnessLift(linear: number, lift: number): number {
  const l = Math.max(0, Math.min(1, lift));
  return linear + l * (1 - linear);
}
