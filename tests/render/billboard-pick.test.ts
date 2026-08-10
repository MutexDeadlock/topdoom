import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BILLBOARD_MAX_REACH,
  intersectBillboard,
  VIEWER_ANGLE_DEG,
  type CachedSprite,
} from '../../src/render/sprites.ts';
import { SpriteBatch } from '../../src/render/spritebatch.ts';

/**
 * Auto-aim picks the monster under the cursor by intersecting the pointer ray
 * with each thing's billboard *analytically* — no mesh, no render state — so
 * the tic never has to re-pose the sprite batch. That only holds if
 * `intersectBillboard` reproduces the instance matrix `SpriteBatch.add`
 * writes exactly; the last test here is what holds the two together.
 * See docs/combat.md § Auto-aim and docs/frameloop.md § Posing for the aim ray.
 */

/**
 * A stand-in for a decoded lump, built the way `SpriteMaterialCache.get`
 * builds one: the plane is shifted by the hotspot and stood on its bottom
 * edge, so its geometry and its `quad` describe the same rectangle — which is
 * what lets the fuzz below raycast the geometry as a reference.
 */
function sprite(width: number, height: number, left = width / 2): CachedSprite {
  const offsetX = width / 2 - left;
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(offsetX, height / 2, 0);
  return {
    material: new THREE.MeshBasicMaterial(),
    geometry,
    quad: { minX: offsetX - width / 2, maxX: offsetX + width / 2, height },
  };
}

/** Centred 64×100 art, and the same art hung 16 units right of its hotspot. */
const CENTRED = sprite(64, 100);
const OFFSET = sprite(64, 100, 48);

/** Cos/sin of the yaw a billboard stands at, the pair both `SpriteBatch.begin` and `intersectBillboard` take. */
function yaw(viewerAngleDeg: number): { cos: number; sin: number } {
  const rad = ((viewerAngleDeg - VIEWER_ANGLE_DEG) * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

function rayFrom(origin: [number, number, number], towards: [number, number, number]): THREE.Ray {
  const from = new THREE.Vector3(...origin);
  const dir = new THREE.Vector3(...towards).sub(from).normalize();
  return new THREE.Ray(from, dir);
}

const ORIGIN = new THREE.Vector3(0, 0, 0);

describe('Sprites · analytic billboard pick', () => {
  test('a ray through the plane reports how far along it the crossing is', () => {
    const { cos, sin } = yaw(VIEWER_ANGLE_DEG);
    // Straight down -Z at chest height: the unrotated plane spans the XY axes.
    const hit = intersectBillboard(rayFrom([0, 50, 200], [0, 50, 0]), CENTRED, ORIGIN, 1, cos, sin);
    assert.ok(Math.abs(hit - 200) < 1e-9, `expected a hit 200 units out, got ${hit}`);
  });

  test('the quad ends where the art does — feet at z, top at its height, edges at the hotspot', () => {
    const { cos, sin } = yaw(VIEWER_ANGLE_DEG);
    const at = (x: number, y: number, s: CachedSprite = CENTRED) =>
      intersectBillboard(rayFrom([x, y, 200], [x, y, 0]), s, ORIGIN, 1, cos, sin);

    assert.ok(at(0, 1) > 0, 'just above the feet');
    assert.equal(at(0, -1), -1, 'below the feet — the plane is anchored there, not centred on it');
    assert.ok(at(0, 99) > 0, 'just under the top edge');
    assert.equal(at(0, 101), -1, 'over the top edge');
    assert.ok(at(31, 50) > 0, 'just inside the right edge');
    assert.equal(at(33, 50), -1, 'just outside the right edge');
    assert.ok(at(-31, 50) > 0, 'just inside the left edge');
    assert.equal(at(-33, 50), -1, 'just outside the left edge');

    // The hotspot shifts the quad sideways rather than resizing it: this lump
    // hangs 16 units right of the anchor, so it reaches 16 right and 48 left.
    assert.ok(at(15, 50, OFFSET) > 0, 'inside the shifted right edge');
    assert.equal(at(17, 50, OFFSET), -1, 'outside the shifted right edge');
    assert.ok(at(-47, 50, OFFSET) > 0, 'inside the shifted left edge');
    assert.equal(at(-49, 50, OFFSET), -1, 'outside the shifted left edge');
  });

  test('scale stretches the quad about the anchor', () => {
    const { cos, sin } = yaw(VIEWER_ANGLE_DEG);
    const corner = rayFrom([40, 150, 200], [40, 150, 0]);
    assert.equal(intersectBillboard(corner, CENTRED, ORIGIN, 1, cos, sin), -1, 'outside at native size');
    assert.ok(intersectBillboard(corner, CENTRED, ORIGIN, 2, cos, sin) > 0, 'inside at double size');
  });

  test('the plane turns with the viewer angle, and goes untargetable edge-on', () => {
    const { cos, sin } = yaw(VIEWER_ANGLE_DEG + 90);
    // A quarter turn puts the plane's own +x along world -Z, so the ray that
    // hit it head-on before now runs along it.
    assert.equal(
      intersectBillboard(rayFrom([0, 50, 200], [0, 50, 0]), CENTRED, ORIGIN, 1, cos, sin),
      -1,
      'edge-on',
    );
    const side = (z: number, s: CachedSprite) =>
      intersectBillboard(rayFrom([200, 50, z], [0, 50, z]), s, ORIGIN, 1, cos, sin);
    assert.ok(side(0, CENTRED) > 0, 'square on to the turned plane');
    assert.ok(side(20, CENTRED) > 0 && side(-20, CENTRED) > 0, 'both sides of a centred lump');
    // The turned plane's +x runs toward -Z, so the shifted lump's short side
    // is the one at -Z — the mirror image of the unturned case above.
    assert.ok(side(20, OFFSET) > 0, 'the long side of the shifted lump');
    assert.equal(side(-20, OFFSET), -1, 'past its short side');
  });

  /**
   * The broad phase in `ThingLayer.pickMonster` rejects a thing on this bound
   * *before* resolving which lump it draws, so a lump reaching further than
   * this would go unclickable around its edges. The stock IWADs' widest and
   * tallest world art is 130 across and 134 up (see the constant's own doc).
   */
  test('BILLBOARD_MAX_REACH covers the art it claims to', () => {
    assert.ok(BILLBOARD_MAX_REACH >= Math.hypot(130, 134), `${BILLBOARD_MAX_REACH} is too small a bound`);
  });

  /**
   * The analytic test replaced a `THREE.Raycaster` against real billboard
   * geometry, so the cheapest way to trust it is to keep asking three.js the
   * same question: random art, poses, viewer angles and rays, against a mesh
   * posed exactly as the batch would draw it. Boundary-grazing rays are the
   * one thing left out — the two disagree there only about which side of a
   * float an edge falls on.
   */
  test('it answers what a raycast against the drawn plane answers', () => {
    // Fixed multiplier-and-increment PRNG: this has to fail the same way twice.
    let seed = 0x2545f491;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const span = (n: number) => (rnd() - 0.5) * 2 * n;

    const raycaster = new THREE.Raycaster();
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      const width = 8 + Math.floor(rnd() * 250);
      const height = 8 + Math.floor(rnd() * 250);
      const art = sprite(width, height, Math.floor(rnd() * width));
      art.material.side = THREE.DoubleSide;
      const viewerAngleDeg = VIEWER_ANGLE_DEG + span(180);
      const { cos, sin } = yaw(viewerAngleDeg);
      const anchor = new THREE.Vector3(span(600), span(600), span(600));
      const scale = 0.5 + rnd() * 2;

      const mesh = new THREE.Mesh(art.geometry, art.material);
      mesh.position.copy(anchor);
      mesh.rotation.y = ((viewerAngleDeg - VIEWER_ANGLE_DEG) * Math.PI) / 180;
      mesh.scale.setScalar(scale);
      mesh.updateMatrixWorld();

      // Aimed at a point near the quad, in its own local units, so roughly
      // half the rays hit and the misses are near misses rather than wild.
      const target = new THREE.Vector3(
        (art.quad.minX + art.quad.maxX) / 2 + span(width),
        art.quad.height / 2 + span(height),
        0,
      ).applyMatrix4(mesh.matrixWorld);
      const from = new THREE.Vector3(span(900), span(900), span(900));
      if (from.distanceTo(target) < 1) continue;
      const ray = new THREE.Ray(from, target.clone().sub(from).normalize());

      const dist = intersectBillboard(ray, art, anchor, scale, cos, sin);
      raycaster.set(ray.origin, ray.direction);
      const reference = raycaster.intersectObject(mesh, false)[0];

      // How far the aim point sits inside the quad's edges, in world units:
      // inside the last thousandth of that the two are allowed to differ.
      const local = target.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
      const margin =
        Math.min(local.x - art.quad.minX, art.quad.maxX - local.x, local.y, art.quad.height - local.y) * scale;
      if (Math.abs(margin) < 1e-3) continue;

      assert.equal(dist >= 0, reference !== undefined, `case ${i}: hit/miss disagreement`);
      if (dist >= 0 && reference) {
        hits++;
        assert.ok(Math.abs(dist - reference.distance) < 1e-3, `case ${i}: ${dist} vs ${reference.distance}`);
      }
    }
    assert.ok(hits > 500, `only ${hits} of the fuzzed rays hit — the cases stopped being interesting`);
  });

  /**
   * The one that keeps the two implementations honest: the analytic plane has
   * to sit exactly where the batch's instance matrix puts the drawn quad.
   */
  test('the plane matches the instance matrix SpriteBatch writes', () => {
    for (const viewerAngleDeg of [VIEWER_ANGLE_DEG, VIEWER_ANGLE_DEG + 37, VIEWER_ANGLE_DEG + 180]) {
      const { cos, sin } = yaw(viewerAngleDeg);
      const anchor = new THREE.Vector3(120, -30, 260);
      const scale = 1.5;

      const batch = new SpriteBatch();
      batch.begin(viewerAngleDeg);
      batch.add(OFFSET, anchor.x, anchor.y, anchor.z, scale, 1);
      batch.end();
      const mesh = batch.group.children[0] as THREE.InstancedMesh;
      const matrix = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array);

      // A point well inside the drawn quad, in the plane's own local units.
      const local = new THREE.Vector3(OFFSET.quad.minX + 5, OFFSET.quad.height - 5, 0);
      const drawn = local.clone().applyMatrix4(matrix);
      // Come at it from somewhere with no axis in common with the plane, so a
      // sign slip in either implementation shows up.
      const ray = rayFrom([drawn.x + 300, drawn.y + 200, drawn.z + 400], [drawn.x, drawn.y, drawn.z]);

      const dist = intersectBillboard(ray, OFFSET, anchor, scale, cos, sin);
      assert.ok(dist > 0, `no hit at yaw ${viewerAngleDeg}`);
      const found = ray.at(dist, new THREE.Vector3());
      assert.ok(
        found.distanceTo(drawn) < 1e-3,
        `yaw ${viewerAngleDeg}: hit ${found.toArray()} but the batch draws that point at ${drawn.toArray()}`,
      );
      batch.dispose();
    }
  });
});
