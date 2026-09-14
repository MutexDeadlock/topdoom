/**
 * The ground the level stands in: one plane under everything carrying a slow drift of fog, so the
 * space around the map geometry reads as unlit depth rather than as a hole.
 * See docs/render.md § The void floor.
 */
import * as THREE from 'three';
import type { DoomMap } from '../wad/map.ts';
import { smoothstep } from '../util/damping.ts';
import { glslFloat } from '../util/glsl.ts';
import { readStorage, writeStorage } from '../util/storage.ts';
import { doomToWorld } from './mapmesh.ts';
import { VIEW_DISTANCE } from '../constants.ts';

/** How far below the map's lowest sector floor the plane sits, in map units. Tuned by feel. */
const DROP = 96;

/**
 * The two ends of the density ramp, and the dials that decide how much of this reads at all.
 * Tuned by feel — docs/render.md § The void floor for what each end has to clear.
 */
const THIN = 0x080604;
const THICK = 0x121014;

/** Map units one tile of the base density layer covers. Tuned by feel — the size of a wisp. */
const TILE = 1400;

/** The second density layer's scale, relative to the first, and how the two are mixed. Tuned by feel. */
const SCALE_B = 0.47;
const MIX_A = 0.55;

/**
 * The warp field's scale relative to the base layer, and how far it drags the lookup, in tiles.
 * Tuned by feel; the domain warp is what makes this read as fog rather than blobs.
 */
const WARP_SCALE = 0.32;
const WARP_STRENGTH = 0.69;

/** Drift of the warp field and of the two density layers, in tiles per second. Tuned by feel. */
const DRIFT_WARP: [number, number] = [0.012, 0.0088];
const DRIFT_A: [number, number] = [0.022, -0.014];
const DRIFT_B: [number, number] = [-0.0096, 0.018];

/**
 * What replaces `MeshBasicMaterial`'s own `map_fragment`: the domain-warped density lookup, skipped
 * entirely past `fogFar` where three's `fog_fragment` overwrites the result anyway.
 * docs/render.md § The void floor for why this is a patch rather than a `ShaderMaterial`.
 */
const DENSITY_PATCH = /* glsl */ `
  diffuseColor.rgb = uThin;
  #ifdef USE_FOG
  if ( vFogDepth < fogFar ) {
  #endif
    vec2 warpUv = vMapUv * ${glslFloat(WARP_SCALE)} + uTime * vec2(${glslFloat(DRIFT_WARP[0])}, ${glslFloat(DRIFT_WARP[1])});
    vec2 warp = (texture2D(map, warpUv).rg - 0.5) * ${glslFloat(WARP_STRENGTH)};
    float layerA = texture2D(map, vMapUv + warp + uTime * vec2(${glslFloat(DRIFT_A[0])}, ${glslFloat(DRIFT_A[1])})).b;
    float layerB = texture2D(map, vMapUv * ${glslFloat(SCALE_B)} - warp * 0.6 + uTime * vec2(${glslFloat(DRIFT_B[0])}, ${glslFloat(DRIFT_B[1])})).a;
    diffuseColor.rgb = mix(uThin, uThick, layerA * ${glslFloat(MIX_A)} + layerB * ${glslFloat(1 - MIX_A)});
  #ifdef USE_FOG
  }
  #endif
`;

const STORAGE_KEY = 'voidFog';

/** Whether the fog is drawn at all. On by default. docs/menu.md § Persisted settings. */
let enabled = readStorage(STORAGE_KEY, true);

export function getVoidFog(): boolean {
  return enabled;
}

export function setVoidFog(on: boolean): void {
  enabled = on;
  writeStorage(STORAGE_KEY, on);
}

/**
 * The height the plane sits at: below every authored sector floor, so nothing the level draws can
 * ever be under it. Exported for the test — a map with no sectors answers `-DROP`.
 */
export function voidFloorHeight(map: DoomMap): number {
  let lowest = map.sectors[0]?.floorHeight ?? 0;
  for (const sector of map.sectors) {
    if (sector.floorHeight < lowest) lowest = sector.floorHeight;
  }
  return lowest - DROP;
}

/**
 * The plane's footprint: `map.bounds` grown by {@link VIEW_DISTANCE} on every side, so it reaches
 * past the horizon from a camera in the level's far corner. Exported for the test.
 *
 * @returns `[minX, minY, maxX, maxY]`, in DOOM map units.
 */
export function voidFloorBounds(map: DoomMap): [number, number, number, number] {
  const { minX, minY, maxX, maxY } = map.bounds;
  // `boundsOf` (`wad/map.ts`) answers ±Infinity for a map with no vertexes, and the plane still
  // needs a finite quad to build one from.
  if (!Number.isFinite(minX)) return [-VIEW_DISTANCE, -VIEW_DISTANCE, VIEW_DISTANCE, VIEW_DISTANCE];
  return [minX - VIEW_DISTANCE, minY - VIEW_DISTANCE, maxX + VIEW_DISTANCE, maxY + VIEW_DISTANCE];
}

/**
 * The plane itself, built per level because only its footprint and height depend on the map. Its
 * material and texture are its own, so the level teardown that drops the map's meshes drops these
 * with them.
 */
export class VoidFloor {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshBasicMaterial;
  /**
   * Held rather than looked up per frame: `onBeforeCompile` hands this same object to the compiled
   * program, so advancing it here is what moves the fog.
   */
  private time = { value: 0 };

  constructor(map: DoomMap) {
    const [minX, minY, maxX, maxY] = voidFloorBounds(map);
    const width = maxX - minX;
    const depth = maxY - minY;
    const texture = noiseTexture();
    texture.repeat.set(width / TILE, depth / TILE);
    this.material = new THREE.MeshBasicMaterial({ map: texture });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.uniforms.uThin = { value: new THREE.Color(THIN) };
      shader.uniforms.uThick = { value: new THREE.Color(THICK) };
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float uTime;\nuniform vec3 uThin;\nuniform vec3 uThick;\nvoid main() {')
        .replace('#include <map_fragment>', DENSITY_PATCH);
    };
    const geometry = new THREE.PlaneGeometry(width, depth);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'voidfloor';
    // Drawn after the level, so its near-fullscreen fill is early-Z rejected wherever the map
    // covers it. three's opaque sort keys on `material.id` before depth, so without this the
    // ordering would depend on which materials happened to be created first.
    this.mesh.renderOrder = 1;
    doomToWorld((minX + maxX) / 2, (minY + maxY) / 2, voidFloorHeight(map), this.mesh.position);
  }

  /**
   * Advances the drift, and picks up the setting: read here rather than captured at construction so
   * switching it reaches the level already running. On the frame clock, like the animated textures
   * it is updated beside. docs/render.md § The toggle.
   */
  update(dt: number): void {
    this.mesh.visible = enabled;
    this.time.value += dt;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

/** Noise tile resolution, and the coarse grid it is smoothed up from. Power of two, for mipmaps. */
const NOISE_SIZE = 64;
const NOISE_CELLS = 8;

/**
 * A local integer hash rather than `util/random.ts`, which is the simulation's own entropy.
 * `channel` seeds the four independent fields one tile carries.
 */
function hash01(x: number, y: number, channel: number): number {
  const i = (wrap(y) * NOISE_CELLS + wrap(x)) * 4 + channel;
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** The grid coordinate one step past the last, folded back onto the first — what makes it seamless. */
function wrap(n: number): number {
  return ((n % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS;
}

/**
 * One seamless tile carrying four independent value-noise fields, wrapping on both axes: `rg` is
 * the warp vector, `b` and `a` the two density layers.
 */
function noiseTexture(): THREE.DataTexture {
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  const cell = NOISE_SIZE / NOISE_CELLS;
  for (let y = 0; y < NOISE_SIZE; y++) {
    for (let x = 0; x < NOISE_SIZE; x++) {
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      const fx = smoothstep(x / cell - gx);
      const fy = smoothstep(y / cell - gy);
      for (let channel = 0; channel < 4; channel++) {
        const top = hash01(gx, gy, channel) * (1 - fx) + hash01(gx + 1, gy, channel) * fx;
        const bottom = hash01(gx, gy + 1, channel) * (1 - fx) + hash01(gx + 1, gy + 1, channel) * fx;
        data[(y * NOISE_SIZE + x) * 4 + channel] = Math.round(255 * (top * (1 - fy) + bottom * fy));
      }
    }
  }
  const tex = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  // Mask data, not colour: leaving it linear keeps the shader's arithmetic meaning what it says,
  // and the two tint uniforms are the only things three has to colour-manage.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
