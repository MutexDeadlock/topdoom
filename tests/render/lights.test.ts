import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseGldefs } from '../../src/wad/gldefs.ts';
import {
  DynamicLights,
  MAX_DYN_LIGHTS,
  RADIUS_SCALE,
  getDynamicLights,
  setDynamicLights,
  type Tint,
} from '../../src/render/lights.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { LightVisibility } from '../../src/render/lightvis.ts';
import { World } from '../../src/game/world.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { gridMap } from '../fixtures/gridmap.ts';

const tint = (): Tint => ({ r: 0, g: 0, b: 0 });

/** Runs one frame: open, offer each emitter, close. Returns the controller for inspection. */
function frame(
  lights: DynamicLights,
  dt: number,
  offers: [key: string, x: number, y: number, z: number, id: number][],
  camX = 0,
  camY = 0,
  view?: THREE.Frustum,
): DynamicLights {
  lights.beginFrame(dt, camX, camY, view);
  for (const [key, x, y, z, id] of offers) lights.offer(key, x, y, z, id);
  lights.commit();
  return lights;
}

/**
 * The view volume of a camera `height` units above the DOOM origin looking straight down — the
 * same three-space derivation `TopDownCamera.applyToCamera` does, built here from three's own
 * camera rather than by hand so the test can't agree with a wrong convention.
 */
function lookingDown(height: number): THREE.Frustum {
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 8, 16000);
  camera.up.set(0, 1, 0);
  camera.position.set(0, height, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return new THREE.Frustum().setFromProjectionMatrix(m);
}

const DEFS = parseGldefs(`
  pointlight PT { color 1.0 0.5 0.25  size 50 }
  pulselight PU { color 1 1 1  size 100  secondarySize 50  interval 2.0 }
  flickerlight FL { color 1 1 1  size 100  secondarySize 50  chance 0.75 }
  flickerlight2 F2 { color 1 1 1  size 50  secondarySize 100  interval 0.5 }
  pointlight SELF { color 1 1 1  size 50  dontlightself 1 }
  pointlight HIGH { color 1 1 1  size 50  offset 0 40 0 }
  pointlight WIDE { color 1 1 1  size 1000 }
  object A { frame AAAA { light PT } }
  object B { frame BBBB { light PU } }
  object C { frame CCCC { light FL } }
  object D { frame DDDD { light F2 } }
  object E { frame EEEE { light SELF } }
  object F { frame FFFF { light HIGH } }
  object G { frame GGGG { light WIDE } }
`);

/** The radius the uniform buffer reports for light `i` — `pos.w`. */
const radiusOf = (l: DynamicLights, i = 0): number => l.uniforms.uLightPos.value[i * 4 + 3];

/**
 * That radius back in GLDEFS `size` units. Every assertion about an animated size goes through
 * this rather than dividing by a mirrored constant: `RADIUS_SCALE` is a feel dial, and a test that
 * reddens when it is retuned is pinning the dial (CLAUDE.md § Constants).
 */
const sizeOf = (l: DynamicLights, i = 0): number => radiusOf(l, i) / RADIUS_SCALE;

/**
 * `DynamicLights` animates GLDEFS radii on the render clock, uploads what fits, and samples the
 * same falloff back for sprites. docs/lights.md.
 */
describe('DynamicLights · what reaches the uniforms', () => {
  test('an offered frame with a light lands in the buffer; one without does not', () => {
    const l = frame(new DynamicLights(DEFS), 0, [
      ['AAAA', 100, 200, 0, 1],
      ['ZZZZ', 0, 0, 0, 2],
    ]);
    assert.equal(l.uniforms.uLightCount.value, 1);
    // three's (x, y, z) is DOOM's (x, z, -y) — docs/render.md § Mesh building.
    assert.deepEqual([...l.uniforms.uLightPos.value.slice(0, 3)], [100, 0, -200]);
    assert.deepEqual([...l.uniforms.uLightColor.value.slice(0, 3)], [1.0, 0.5, 0.25]);
  });

  test('the radius a light reaches is its GLDEFS size scaled by the dial', () => {
    const l = frame(new DynamicLights(DEFS), 0, [['AAAA', 0, 0, 0, 1]]);
    assert.equal(radiusOf(l), 50 * RADIUS_SCALE);
  });

  test("a GLDEFS offset raises the light off the thing's feet", () => {
    const l = frame(new DynamicLights(DEFS), 0, [['FFFF', 0, 0, 10, 1]]);
    assert.equal(l.uniforms.uLightPos.value[1], 50);
  });

  test('an empty frame clears the count rather than leaving the last one up', () => {
    const l = new DynamicLights(DEFS);
    frame(l, 0, [['AAAA', 0, 0, 0, 1]]);
    assert.equal(l.uniforms.uLightCount.value, 1);
    frame(l, 0.016, []);
    assert.equal(l.uniforms.uLightCount.value, 0);
  });

  test('past the cap, the lights whose reach comes nearest the camera win', () => {
    const offers: [string, number, number, number, number][] = [];
    // MAX + 8 identical lights strung out along +x, the furthest first.
    for (let i = MAX_DYN_LIGHTS + 8; i > 0; i--) offers.push(['AAAA', i * 1000, 0, 0, i]);
    const l = frame(new DynamicLights(DEFS), 0, offers);
    assert.equal(l.uniforms.uLightCount.value, MAX_DYN_LIGHTS);
    // The nearest of them all is at x = 1000 and must have survived.
    const xs = [];
    for (let i = 0; i < MAX_DYN_LIGHTS; i++) xs.push(l.uniforms.uLightPos.value[i * 4]);
    assert.equal(Math.min(...xs), 1000);
    assert.equal(Math.max(...xs), MAX_DYN_LIGHTS * 1000);
  });

  test('a big light further off outranks a small one nearer, covering more of the view', () => {
    const defs = parseGldefs(`
      pointlight SMALL { color 1 1 1  size 10 }
      pointlight BIG { color 1 1 1  size 1000 }
      object S { frame SSSS { light SMALL } }
      object G { frame GGGG { light BIG } }
    `);
    const offers: [string, number, number, number, number][] = [];
    for (let i = 0; i < MAX_DYN_LIGHTS; i++) offers.push(['SSSS', 500 + i, 0, 0, i]);
    offers.push(['GGGG', 1500, 0, 0, 999]);
    const l = frame(new DynamicLights(defs), 0, offers);
    const sizes = [];
    for (let i = 0; i < MAX_DYN_LIGHTS; i++) sizes.push(sizeOf(l, i));
    assert.ok(sizes.includes(1000), 'the far big light should have been kept');
  });
});

describe('DynamicLights · animation', () => {
  test('a point light never moves', () => {
    const l = new DynamicLights(DEFS);
    frame(l, 0, [['AAAA', 0, 0, 0, 1]]);
    const first = radiusOf(l);
    frame(l, 1.234, [['AAAA', 0, 0, 0, 1]]);
    assert.equal(radiusOf(l), first);
  });

  test('a pulse light stays within its two sizes and comes back round its interval', () => {
    const l = new DynamicLights(DEFS);
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      frame(l, 2.0 / 200, [['BBBB', 0, 0, 0, 7]]);
      seen.push(sizeOf(l));
    }
    assert.ok(Math.min(...seen) >= 50 - 1e-6, `min ${Math.min(...seen)}`);
    assert.ok(Math.max(...seen) <= 100 + 1e-6, `max ${Math.max(...seen)}`);
    // A full interval of travel visits both ends of the cycle, not a sliver of it.
    assert.ok(Math.max(...seen) - Math.min(...seen) > 45);
    // One interval later it is back where it started.
    const start = seen[0];
    assert.ok(Math.abs(seen[seen.length - 1] - start) < 2, `${seen[seen.length - 1]} vs ${start}`);
  });

  test('two emitters on one pulse light are out of phase with each other', () => {
    const l = new DynamicLights(DEFS);
    frame(l, 0.3, [
      ['BBBB', 0, 0, 0, 1],
      ['BBBB', 10, 0, 0, 2],
    ]);
    assert.notEqual(radiusOf(l, 0), radiusOf(l, 1));
  });

  test('a flicker light is only ever at one size or the other, roughly `chance` of the time', () => {
    const l = new DynamicLights(DEFS);
    let primary = 0;
    const runs = 2000;
    for (let i = 0; i < runs; i++) {
      // A whole tic per frame, since `flicker` rerolls per tic.
      frame(l, DOOM_TIC, [['CCCC', 0, 0, 0, 3]]);
      // Compared with a tolerance, not exactly: the round trip through `RADIUS_SCALE` is only
      // lossless while the dial happens to be binary-exact.
      const size = sizeOf(l);
      assert.ok(Math.abs(size - 100) < 1e-9 || Math.abs(size - 50) < 1e-9, `off-size radius ${size}`);
      if (Math.abs(size - 100) < 1e-9) primary++;
    }
    // chance 0.75, so about three quarters — a wide band, this only has to catch a broken roll.
    assert.ok(primary / runs > 0.6 && primary / runs < 0.9, `${primary / runs}`);
  });

  test('a flicker2 light holds one blend for an interval, then rerolls to another', () => {
    const l = new DynamicLights(DEFS);
    // interval 0.5: three samples well inside one bucket, then one well into the next.
    frame(l, 0.05, [['DDDD', 0, 0, 0, 5]]);
    const a = radiusOf(l);
    frame(l, 0.1, [['DDDD', 0, 0, 0, 5]]);
    assert.equal(radiusOf(l), a);
    frame(l, 0.6, [['DDDD', 0, 0, 0, 5]]);
    assert.notEqual(radiusOf(l), a);
    assert.ok(sizeOf(l) >= 50 - 1e-9 && sizeOf(l) <= 100 + 1e-9);
  });

  test('the animation is a pure function of emitter and clock, not of accumulated state', () => {
    // Two controllers stepped the same way agree exactly — which is what lets a light survive a
    // save/load, or a frame where its sprite was not drawn, with no state of its own.
    const a = new DynamicLights(DEFS);
    const b = new DynamicLights(DEFS);
    for (let i = 0; i < 40; i++) {
      frame(a, 0.037, [['BBBB', 0, 0, 0, 11]]);
      frame(b, 0.037, [['BBBB', 0, 0, 0, 11]]);
      assert.equal(radiusOf(a), radiusOf(b));
    }
    // b skips a frame's offer entirely, then resumes: same clock, same radius.
    frame(a, 0.037, [['BBBB', 0, 0, 0, 11]]);
    frame(b, 0.037, []);
    frame(a, 0.037, [['BBBB', 0, 0, 0, 11]]);
    frame(b, 0.037, [['BBBB', 0, 0, 0, 11]]);
    assert.equal(radiusOf(a), radiusOf(b));
  });
});

describe('DynamicLights · the sprite tint', () => {
  test('falloff is linear from the centre and gone at the radius', () => {
    const l = new DynamicLights(DEFS);
    // Committed on the frame before the one that samples it — the tint is a frame behind.
    frame(l, 0, [['AAAA', 0, 0, 0, 1]]);
    l.beginFrame(0.016, 0, 0);
    const t = tint();
    l.tintAt(0, 0, 0, 99, t);
    assert.deepEqual([t.r, t.g, t.b], [1.0, 0.5, 0.25]);
    // Halfway out is half strength, and it is gone at the radius itself — measured from the
    // light's own reach rather than a mirrored number.
    const radius = 50 * RADIUS_SCALE;
    l.tintAt(radius / 2, 0, 0, 99, t);
    assert.ok(Math.abs(t.r - 0.5) < 1e-6, `${t.r}`);
    l.tintAt(radius, 0, 0, 99, t);
    assert.deepEqual([t.r, t.g, t.b], [0, 0, 0]);
    l.tintAt(radius * 10, 0, 0, 99, t);
    assert.deepEqual([t.r, t.g, t.b], [0, 0, 0]);
  });

  test('two lights on one sprite add up', () => {
    const l = new DynamicLights(DEFS);
    frame(l, 0, [
      ['AAAA', 0, 0, 0, 1],
      ['AAAA', 0, 0, 0, 2],
    ]);
    l.beginFrame(0.016, 0, 0);
    const t = tint();
    l.tintAt(0, 0, 0, 99, t);
    assert.equal(t.r, 2.0);
  });

  test('a dontlightself light skips the sprite emitting it, and nothing else', () => {
    const l = new DynamicLights(DEFS);
    frame(l, 0, [['EEEE', 0, 0, 0, 42]]);
    l.beginFrame(0.016, 0, 0);
    const t = tint();
    l.tintAt(0, 0, 0, 42, t);
    assert.deepEqual([t.r, t.g, t.b], [0, 0, 0]);
    l.tintAt(0, 0, 0, 43, t);
    assert.equal(t.r, 1);
  });

  test('the committed set survives the next frame overwriting the offer pool', () => {
    // The pool is reused in place, so a tint sampled mid-draw must not read the frame being built.
    const l = new DynamicLights(DEFS);
    frame(l, 0, [['AAAA', 0, 0, 0, 1]]);
    l.beginFrame(0.016, 0, 0);
    l.offer('AAAA', 5000, 5000, 0, 2);
    const t = tint();
    l.tintAt(0, 0, 0, 99, t);
    assert.equal(t.r, 1, 'the previous frame\'s light at the origin should still be sampled');
  });

  test('tintAt zeroes its output before sampling, so a scratch object can be reused', () => {
    const l = new DynamicLights(DEFS);
    frame(l, 0, [['AAAA', 0, 0, 0, 1]]);
    l.beginFrame(0.016, 0, 0);
    const t = { r: 9, g: 9, b: 9 };
    l.tintAt(1000, 0, 0, 99, t);
    assert.deepEqual([t.r, t.g, t.b], [0, 0, 0]);
  });
});

describe('DynamicLights · the toggle', () => {
  test('switched off, nothing is uploaded and nothing is tinted', () => {
    const was = getDynamicLights();
    try {
      setDynamicLights(false);
      const l = frame(new DynamicLights(DEFS), 0, [['AAAA', 0, 0, 0, 1]]);
      assert.equal(l.uniforms.uLightCount.value, 0);
      const t = tint();
      l.tintAt(0, 0, 0, 99, t);
      assert.deepEqual([t.r, t.g, t.b], [0, 0, 0]);
      // And switching back on takes effect on the very next frame — no reload.
      setDynamicLights(true);
      frame(l, 0.016, [['AAAA', 0, 0, 0, 1]]);
      assert.equal(l.uniforms.uLightCount.value, 1);
    } finally {
      setDynamicLights(was);
    }
  });
});

/**
 * A bound level gates every light on what it can reach, both halves of the split: the mask the
 * geometry shader fetches, and `tintAt`'s reading of the same bits. docs/lights.md § Light stops
 * at walls.
 */
describe('DynamicLights · a light bound to a level', () => {
  /** Two closets either side of a solid cell, with a light standing in the left one. */
  function walled(): { lights: DynamicLights; here: number; there: number; at: { x: number; y: number } } {
    const grid = gridMap(['#####', '#.#.#', '#####'], { cell: 128 });
    const world = new World(grid.map);
    const lights = new DynamicLights(DEFS);
    lights.bindLevel(new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world));
    const at = grid.centre(1, 1);
    const across = grid.centre(3, 1);
    return {
      lights,
      here: world.subsectorAt(at.x, at.y),
      there: world.subsectorAt(across.x, across.y),
      at,
    };
  }

  test('the list is sized to the level and names the emitter\'s own leaf, not the one across the wall', () => {
    const { lights, here, there, at } = walled();
    assert.ok(lights.uniforms.uLightVisWidth.value > 0, 'a bound level must switch the gate on');
    frame(lights, 0, [['BBBB', at.x, at.y, 0, 1]]);
    // The texel is a compacted list of committed-light indices, 0xFF past the last — the sole
    // committed light is index 0, so a lit leaf leads with 0x00 and an unlit one stays all-empty.
    const slots = lights.uniforms.uLightVis.value.image.data as Uint32Array;
    assert.equal(slots[here * 4] & 0xff, 0, 'the light did not reach its own leaf');
    assert.equal(slots[there * 4] & 0xff, 0xff, 'the light reached through a wall');
  });

  test('a sprite behind the wall is untinted while one beside the light is not', () => {
    const { lights, here, there, at } = walled();
    frame(lights, 0, [['BBBB', at.x, at.y, 0, 1]]);
    // Sampled at the light's own position both times, so only the leaf differs — the tint is the
    // mask's doing and not the falloff's.
    const near = tint();
    lights.tintAt(at.x, at.y, 0, 99, near, here);
    assert.ok(near.r > 0, 'a sprite in the lit leaf must be tinted');
    const behind = tint();
    lights.tintAt(at.x, at.y, 0, 99, behind, there);
    assert.deepEqual([behind.r, behind.g, behind.b], [0, 0, 0]);
  });

  test('every committed light\'s index fits a slot byte', () => {
    // A slot is one byte with 0xFF as the empty marker, so a light index reaching 0xFF would be
    // read back as the end of every list it is in.
    assert.ok(MAX_DYN_LIGHTS < 0xff, `MAX_DYN_LIGHTS ${MAX_DYN_LIGHTS} collides with the empty-slot marker`);
  });

  test('with no level bound nothing is gated, so a bank built without one lights everything', () => {
    // What tests and tools get, and what `uLightVisWidth` 0 means to the shader.
    const lights = new DynamicLights(DEFS);
    assert.equal(lights.uniforms.uLightVisWidth.value, 0);
    frame(lights, 0, [['BBBB', 0, 0, 0, 1]]);
    const t = tint();
    lights.tintAt(10, 10, 0, 99, t);
    assert.ok(t.r > 0);
  });
});

/**
 * What the camera cannot see never becomes a light. A sprite is offered wherever fog of war has
 * revealed it — most of a level — while the camera holds a few hundred units of it, so without
 * this a map like E1M1 sits at `MAX_DYN_LIGHTS` every frame and pays a full fragment loop for
 * lights nowhere near the view. docs/lights.md § What reaches the shader.
 */
describe('DynamicLights · the frustum cull', () => {
  test('a light under the camera survives and one outside the view does not', () => {
    const view = lookingDown(500);
    const lights = new DynamicLights(DEFS);
    frame(lights, 0, [['AAAA', 0, 0, 0, 1]], 0, 0, view);
    assert.equal(lights.uniforms.uLightCount.value, 1, 'a light in plain view was culled');
    frame(lights, 0, [['AAAA', 0, 40000, 0, 1]], 0, 0, view);
    assert.equal(lights.uniforms.uLightCount.value, 0, 'a light off the far side of the map was kept');
  });

  test('it is the light\'s sphere that is tested, not its centre', () => {
    // The load-bearing half: a torch just off the edge of the screen still lights the floor that
    // is on it, so culling by the emitter's own point would darken the screen edge as it moved.
    const view = lookingDown(500);
    const lights = new DynamicLights(DEFS);
    const far = 1200;
    frame(lights, 0, [['AAAA', 0, far, 0, 1]], 0, 0, view);
    assert.equal(lights.uniforms.uLightCount.value, 0, 'a 50-unit light 1200 units out reaches nothing');
    frame(lights, 0, [['GGGG', 0, far, 0, 1]], 0, 0, view);
    assert.equal(lights.uniforms.uLightCount.value, 1, 'a 1000-unit light at the same point reaches the view');
  });

  test('no view volume culls nothing', () => {
    // What a bank built without a camera gets (tests, tools) — the same fail-open `uLightVisWidth`
    // 0 means for the visibility mask.
    const lights = new DynamicLights(DEFS);
    frame(lights, 0, [['AAAA', 0, 40000, 0, 1]]);
    assert.equal(lights.uniforms.uLightCount.value, 1);
  });
});
