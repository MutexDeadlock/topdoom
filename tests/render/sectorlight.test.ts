import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DIMINISH_SCALE,
  DISTANCE_LIGHT_GLSL,
  MAX_DIMINISH_ROWS,
  REFERENCE_STEPS,
  beginViewDepth,
  diminishRows,
  diminishUniform,
  lightSegment,
  lightToColor,
  litColor,
  setDistanceFlattened,
  viewDepthAt,
} from '../../src/render/sectorlight.ts';
import { BRIGHTNESS_LIFT } from '../../src/constants.ts';

/**
 * The distance term against vanilla's own table build, and the two consumers of it — the CPU
 * sample a sprite takes and the GLSL twin the geometry takes — against each other.
 * See docs/render.md § Distance lighting.
 */

/** `applyBrightnessLift`'s `BRIGHTNESS_LIFT` half, which the shader's `liftedGain` reproduces. */
function lift(gain: number): number {
  return gain + BRIGHTNESS_LIFT * (1 - gain);
}

/**
 * `R_ExecuteSetViewSize` (`r_main.c`) in integer arithmetic: `scalelight` is indexed by
 * `rw_scale >> LIGHTSCALESHIFT`, i.e. `floor(2560 / d)` at 320 wide, capped at `MAXLIGHTSCALE - 1`
 * (47), and the row taken off `startmap` is that index over `DISTMAP` (2), truncated.
 */
function vanillaRows(depth: number): number {
  const index = Math.min(47, Math.floor(2560 / depth));
  return Math.floor(index / 2);
}

describe('Rendering · the distance term', () => {
  test('matches vanilla scalelight row for row across every depth the camera frames', () => {
    // Floored, since this engine's term is the same quotient left continuous — a fractional row is
    // read between two `COLORMAP` rows. docs/render.md § The term is continuous, the ramp is not.
    for (let depth = 1; depth <= 4000; depth++) {
      assert.equal(Math.floor(diminishRows(depth)), vanillaRows(depth), `depth ${depth}`);
    }
  });

  test('saturates: nothing is subtracted from DIMINISH_SCALE out, and never more than the cap', () => {
    assert.equal(diminishRows(DIMINISH_SCALE), 1);
    assert.ok(diminishRows(DIMINISH_SCALE * 4) < 0.3, 'and keeps shrinking rather than snapping to 0');
    assert.equal(diminishRows(1), MAX_DIMINISH_ROWS);
    assert.equal(diminishRows(0), MAX_DIMINISH_ROWS, 'a depth under one unit reads as one');
  });

  test('the reference sample is the term at a 320-unit depth', () => {
    assert.equal(diminishRows(320), REFERENCE_STEPS);
  });

  test('crosses a row boundary continuously, so no depth draws a visible edge', () => {
    // The bug this rules out: `floor`ing the term drew its row boundaries as lines across a floor,
    // at the fixed depths where it stepped. docs/render.md § The term is continuous, the ramp is not.
    for (const boundary of [DIMINISH_SCALE / 4, DIMINISH_SCALE / 3, DIMINISH_SCALE / 2]) {
      const before = litColor(160, 0, boundary - 0.5);
      const after = litColor(160, 0, boundary + 0.5);
      assert.ok(before > after, `darkens through ${boundary}`);
      assert.ok(before - after < 0.005, `by no step at ${boundary}: ${before - after}`);
    }
  });

  test('an integer row is still exactly the table entry vanilla would have read', () => {
    // Segment 10 (light 160) starts at row 20, so these are rows 20, 16 and 24 of the lump's ramp.
    assert.ok(Math.abs(lightToColor(160, 0, 0) - 0.1312) < 1e-12);
    assert.ok(Math.abs(lightToColor(160, 0, REFERENCE_STEPS) - 0.2317) < 1e-12);
    assert.ok(Math.abs(lightToColor(160, 0, -REFERENCE_STEPS) - 0.0621) < 1e-12);
    // And a half row is halfway between two of them, which is the whole of the change.
    assert.ok(Math.abs(lightToColor(160, 0, 0.5) - (0.1312 + 0.1526) / 2) < 1e-12);
  });
});

describe('Rendering · a sprite sampled at its depth', () => {
  test('is the reference colour at the reference depth and only darkens beyond it', () => {
    assert.equal(litColor(160, 0, 320), litColor(160));
    let previous = litColor(160, 0, 64);
    for (const depth of [128, 256, 320, 480, 720, 1000, 1280, 2000]) {
      const at = litColor(160, 0, depth);
      assert.ok(at <= previous, `depth ${depth} is no brighter than the one before`);
      previous = at;
    }
    assert.ok(litColor(160, 0, 2000) < litColor(160), 'the far end is darker than the reference');
    assert.ok(litColor(160, 0, 64) > litColor(160), 'the near end is brighter');
  });

  test('a fullbright frame never diminishes: its startmap is row 0', () => {
    for (const depth of [1, 64, 320, 2000]) assert.equal(litColor(255, 0, depth), litColor(255));
    assert.equal(lightToColor(255, 0, MAX_DIMINISH_ROWS), 1);
  });

  test('a sector too dark to reach the table stays at the last row past the reference', () => {
    // Segment 4's startmap is row 44: every depth from the reference out clamps to row 31.
    assert.equal(litColor(64, 0, 5000), litColor(64));
    assert.ok(litColor(64, 0, 64) > litColor(64), 'but the near steps still lift it');
  });


  test('the visor flattens it: every depth reads as the reference sample', () => {
    // Vanilla's `fixedcolormap` leaves depth selecting nothing (`r_main.c`), so both halves fall
    // back to the one fixed sample. docs/render.md § The light-amplification visor flattens it.
    try {
      setDistanceFlattened(true);
      assert.equal(diminishUniform.value, 0);
      for (const depth of [40, 64, 320, 480, 4000]) assert.equal(litColor(160, 0, depth), litColor(160));
      // The shader's half: `uDiminish` picks between the two samples, so 0 is the reference one.
      assert.ok(
        DISTANCE_LIGHT_GLSL.fragmentApply.includes('mix(liftedGain(atReference), liftedGain(atDepth), uDiminish)'),
      );
    } finally {
      setDistanceFlattened(false);
    }
    assert.equal(diminishUniform.value, 1);
    assert.notEqual(litColor(160, 0, 4000), litColor(160), 'and the falloff is back afterwards');
  });

  test('what the shader draws is the ramp at the fragment’s own depth, nothing rescaled', () => {
    // The vertex carries only its segment, so the fragment's multiply *is* the answer — there is
    // no baked brightness left to divide back out. This pins the GPU half against the CPU one that
    // lights the sprites beside it. docs/render.md § Distance lighting.
    for (const light of [0, 64, 128, 160, 224, 255]) {
      for (const depth of [40, 285, 320, 480, 1280, 3000]) {
        const drawn = lift(lightToColor(light, 0, diminishRows(depth)));
        assert.ok(Math.abs(drawn - litColor(light, 0, depth)) < 1e-12, `light ${light} depth ${depth}`);
      }
    }
  });

  test('the contrast offset moves the segment before the term applies', () => {
    assert.equal(lightSegment(160, 16), 11);
    assert.equal(lightSegment(160, -16), 9);
    assert.equal(lightSegment(255, 16), 15, 'clamped to the table');
    assert.equal(litColor(160, 16, 480), litColor(176, 0, 480));
  });
});

describe('Rendering · the view depth a sprite is lit at', () => {
  test('reads the distance along the camera axis, not to the eye', () => {
    // The default framing: 480 units back, 60° off vertical (docs/camera.md).
    const tilt = (60 * Math.PI) / 180;
    const camera = new THREE.PerspectiveCamera(55, 1, 8, 16000);
    camera.position.set(0, 480 * Math.cos(tilt), 480 * Math.sin(tilt));
    camera.lookAt(0, 0, 0);
    // `beginViewDepth` reads `matrixWorldInverse` rather than refreshing it, since the game's
    // camera is always posed by `applyToCamera` first; a test posing its own has to do that here.
    camera.updateMatrixWorld();
    beginViewDepth(camera);
    assert.ok(Math.abs(viewDepthAt(0, 0, 0) - 480) < 1e-3, 'the followed point is the camera distance away');
    // A point off to the side at the same depth: the same answer, where a Euclidean distance grows.
    const side = viewDepthAt(300, 0, 0);
    assert.ok(Math.abs(side - 480) < 1e-3, `side ${side}`);
    assert.ok(viewDepthAt(0, 0, 200) < 480, 'nearer along the axis');
  });
});

describe('Rendering · the distance term in GLSL', () => {
  test('interpolates the CPU constants rather than repeating them by hand', () => {
    // No GLSL runs here, so this only guards the one thing it can: that the shader's numbers are
    // generated from the constants above, and so cannot drift from the CPU sample beside them.
    const apply = DISTANCE_LIGHT_GLSL.fragmentApply;
    assert.ok(apply.includes(`${DIMINISH_SCALE}.0 / max(1.0, vViewDepth)`));
    assert.ok(apply.includes(`min(${MAX_DIMINISH_ROWS}.0, ${DIMINISH_SCALE}.0`), 'capped, not floored');
    assert.ok(apply.includes(`startmap - ${REFERENCE_STEPS}.0`));
  });
});
