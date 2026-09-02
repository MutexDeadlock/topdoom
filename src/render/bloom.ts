/**
 * The frame's compositing: the scene rendered into a high-range target so dynamic light may pass
 * white, and whatever passed it blurred back over the picture as a glow.
 * See docs/lights.md § Bloom.
 */
import * as THREE from 'three';
import { readStorage, writeStorage } from '../util/storage.ts';

const STORAGE_KEY = 'bloom';

/**
 * Where the glow starts, per channel and in **linear** light. **Tuned by feel**, and 1 is the value
 * it must not be; per channel rather than on luminance for the same reason.
 * docs/lights.md § Bloom.
 */
const THRESHOLD = 0.7;

/** How much of the blurred overbright lands back on the frame. Tuned by feel. */
const STRENGTH = 0.35;

/**
 * Resolution of the first blur level, as a divisor of the drawing buffer, and how many halvings
 * follow it. Tuned by feel against cost: the glow is blurred past any detail the first divisor
 * throws away, and the levels are what set how wide it spreads.
 *
 * **`DOWNSCALE` above 4 needs more taps in the bright pass**, whose four cover a 4x4 block and no
 * more — docs/lights.md § Why the bright pass is four taps.
 */
const DOWNSCALE = 4;
const LEVELS = 4;

/**
 * The upsample tent's reach, in fractions of the screen. Tuned by feel — it, not `LEVELS`, is the
 * dial for how tight or how hazy the glow reads.
 */
const FILTER_RADIUS = 0.008;

/** MSAA samples on the scene target, matched to what the canvas would have had — see `Viewport`. */
const SAMPLES = 4;

/**
 * Whether the glow is drawn at all. **Off by default**, alone among the visual settings, because of
 * what it costs. Shaped like the rest — docs/menu.md § Persisted settings
 * (docs/lights.md § Turning it on).
 */
let enabled = readStorage(STORAGE_KEY, false);

export function getBloom(): boolean {
  return enabled;
}

export function setBloom(on: boolean): void {
  enabled = on;
  writeStorage(STORAGE_KEY, on);
}

/**
 * What passed the threshold, and by how much. Nothing else reaches the blur chain.
 *
 * Four taps rather than one, and that is what stops the glow flickering: a single bilinear tap
 * averages 2x2 source texels however far this pass reduces, so at `DOWNSCALE` 4 it reads 4 of every
 * 16 and *which* 4 shifts as the camera moves. The threshold is applied per tap, before the
 * average, so a lone bright texel still contributes instead of being diluted under it and popping
 * back over. docs/lights.md § Why the bright pass is four taps.
 */
const BRIGHT_FRAGMENT = /* glsl */ `
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  uniform float uThreshold;
  varying vec2 vUv;
  vec3 overThreshold(vec2 uv) {
    return max(texture2D(tSource, uv).rgb - uThreshold, vec3(0.0));
  }
  void main() {
    vec3 sum = overThreshold(vUv + vec2(-uTexel.x, -uTexel.y));
    sum += overThreshold(vUv + vec2(uTexel.x, -uTexel.y));
    sum += overThreshold(vUv + vec2(-uTexel.x, uTexel.y));
    sum += overThreshold(vUv + vec2(uTexel.x, uTexel.y));
    gl_FragColor = vec4(sum * 0.25, 1.0);
  }
`;

/** Halving: four bilinear taps a source texel out, so each covers a 2x2 and the four a 4x4. */
const DOWN_FRAGMENT = /* glsl */ `
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 sum = texture2D(tSource, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
    sum += texture2D(tSource, vUv + vec2(uTexel.x, -uTexel.y)).rgb;
    sum += texture2D(tSource, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
    sum += texture2D(tSource, vUv + vec2(uTexel.x, uTexel.y)).rgb;
    gl_FragColor = vec4(sum * 0.25, 1.0);
  }
`;

/** The 3x3 tent the levels are summed back through, its reach set in screen fractions. */
const UP_FRAGMENT = /* glsl */ `
  uniform sampler2D tSource;
  uniform float uRadius;
  varying vec2 vUv;
  void main() {
    float r = uRadius;
    vec3 sum = texture2D(tSource, vUv + vec2(-r, -r)).rgb;
    sum += texture2D(tSource, vUv + vec2(0.0, -r)).rgb * 2.0;
    sum += texture2D(tSource, vUv + vec2(r, -r)).rgb;
    sum += texture2D(tSource, vUv + vec2(-r, 0.0)).rgb * 2.0;
    sum += texture2D(tSource, vUv).rgb * 4.0;
    sum += texture2D(tSource, vUv + vec2(r, 0.0)).rgb * 2.0;
    sum += texture2D(tSource, vUv + vec2(-r, r)).rgb;
    sum += texture2D(tSource, vUv + vec2(0.0, r)).rgb * 2.0;
    sum += texture2D(tSource, vUv + vec2(r, r)).rgb;
    gl_FragColor = vec4(sum / 16.0, 1.0);
  }
`;

/**
 * Scene plus glow, then the tone mapping and the encoding three applies per material when it draws
 * at the canvas itself — so the picture that reaches the screen is the one it always was, with the
 * glow added while the sum is still in linear light.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tSource;
  uniform sampler2D tBloom;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(tSource, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * The post chain, owned by `Viewport` because it outlives every level. While the setting is off it
 * holds no targets at all and `render` is the plain call it replaced: the scene target is the whole
 * cost of this feature, and a player who does not want the glow should not pay it. The one
 * exception is a session that *started* with the glow on, where the canvas has no MSAA of its own
 * to fall back to — docs/lights.md § Bloom and the canvas's MSAA.
 *
 * Nothing here decides *what* glows. That is `textures.ts`'s light term passing 1 and the threshold
 * above, so a material added later glows only if it deliberately exceeds white
 * (docs/lights.md § Bloom).
 */
export class Bloom {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.WebGLRenderTarget | null = null;
  private levels: THREE.WebGLRenderTarget[] = [];

  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.Camera();

  private brightPass: THREE.ShaderMaterial;
  private downPass: THREE.ShaderMaterial;
  private upPass: THREE.ShaderMaterial;
  private compositePass: THREE.ShaderMaterial;

  private size = new THREE.Vector2();
  /**
   * Whether the canvas gave up its own MSAA for this chain, so the scene target is the only thing
   * supplying it. Fixed for the session: the context's `antialias` cannot be changed after it is
   * created, so switching the glow off has to keep the target even though nothing blurs.
   */
  private ownsAntialias: boolean;

  constructor(renderer: THREE.WebGLRenderer, ownsAntialias: boolean) {
    this.renderer = renderer;
    this.ownsAntialias = ownsAntialias;
    this.brightPass = fullScreenMaterial(BRIGHT_FRAGMENT, {
      uThreshold: { value: THRESHOLD },
      uTexel: { value: new THREE.Vector2() },
    });
    this.downPass = fullScreenMaterial(DOWN_FRAGMENT, { uTexel: { value: new THREE.Vector2() } });
    this.upPass = fullScreenMaterial(UP_FRAGMENT, { uRadius: { value: FILTER_RADIUS } });
    this.compositePass = fullScreenMaterial(COMPOSITE_FRAGMENT, {
      tBloom: { value: null },
      uStrength: { value: STRENGTH },
    });
    // The composite is the one pass that reaches the canvas, so it is the one that tone maps and
    // encodes — three does neither while a render target is bound, and does both here.
    this.compositePass.toneMapped = true;

    // One triangle rather than two, so nothing is shaded twice along the diagonal. Its clip-space
    // corners are the geometry, so the camera is an identity one and never moves.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geometry, this.brightPass);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Draws one frame, through the chain or straight at the canvas. Every `renderer.render` in the
   * engine goes through here (`Viewport.present`), including the still frame a pause redraws and
   * the one a savegame thumbnail is read out of.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!enabled && !this.ownsAntialias) {
      if (this.scene) this.release();
      this.renderer.render(scene, camera);
      return;
    }
    this.resize();
    this.renderer.setRenderTarget(this.scene);
    this.renderer.render(scene, camera);

    // With the glow off there is nothing to blur and no levels to blur into: the composite still
    // runs, because the multisampled target is what the frame was drawn into and the resolve back
    // to the canvas is the whole reason it exists here.
    if (enabled) {
      this.pass(this.brightPass, this.scene!.texture, this.levels[0]);
      for (let i = 1; i < this.levels.length; i++) {
        const from = this.levels[i - 1];
        this.downPass.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
        this.pass(this.downPass, from.texture, this.levels[i]);
      }
      // Back up the chain, each level adding itself to the one above: a tent upsample summed this
      // way is a wide, ring-free blur for the cost of the small levels only.
      for (let i = this.levels.length - 1; i > 0; i--) {
        this.pass(this.upPass, this.levels[i].texture, this.levels[i - 1], true);
      }
    }
    // The glow's own texture, at a strength of zero where there is none — cheaper than a second
    // composite shader, and the sampler still needs something bound.
    this.compositePass.uniforms.tBloom.value = (this.levels[0] ?? this.scene!).texture;
    this.compositePass.uniforms.uStrength.value = enabled ? STRENGTH : 0;
    this.pass(this.compositePass, this.scene!.texture, null);
  }

  /**
   * Builds or re-sizes the targets for the drawing buffer as it is now. `release` deliberately
   * leaves `size` alone: it is the size just read here, and the rebuild below is what consumes it.
   */
  private resize(): void {
    const wasX = this.size.x;
    const wasY = this.size.y;
    this.renderer.getDrawingBufferSize(this.size);
    const sized = this.scene !== null && this.size.x === wasX && this.size.y === wasY;
    // The blur levels come and go with the setting, so a mid-session switch rebuilds even at the
    // same size — see the antialiasing-only path in `render`.
    const blurred = this.levels.length > 0;
    if (sized && blurred === enabled) return;
    this.release();
    // Multisampled here rather than on the canvas: with a target bound the canvas's own buffer is
    // never what the scene lands in, so its `antialias` does nothing. `Viewport` sets the same
    // condition on the context for the path that skips this chain entirely.
    const samples = this.renderer.getPixelRatio() < 2 ? SAMPLES : 0;
    // Clamped for the same reason `blurTarget` clamps: a window resized to nothing hands back a
    // zero drawing buffer, and a zero-sized target is an incomplete framebuffer every later frame
    // draws into, since the size then matches and nothing rebuilds it.
    this.scene = new THREE.WebGLRenderTarget(Math.max(1, this.size.x), Math.max(1, this.size.y), {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
      stencilBuffer: false,
    });
    // Nothing below is reached on the antialiasing-only path: the target above is the whole of it.
    if (!enabled) return;
    for (let i = 0; i < LEVELS; i++) {
      const divisor = DOWNSCALE * 2 ** i;
      this.levels.push(blurTarget(this.size.x / divisor, this.size.y / divisor));
    }
    // A quarter of the reduction, in source texels: each of the bright pass's four bilinear taps
    // then covers a quarter of the block its output texel stands for, and the four cover it whole.
    this.brightPass.uniforms.uTexel.value.set(
      DOWNSCALE / 4 / this.size.x,
      DOWNSCALE / 4 / this.size.y,
    );
  }

  private release(): void {
    this.scene?.dispose();
    this.scene = null;
    for (const level of this.levels) level.dispose();
    this.levels.length = 0;
  }

  /** One full-screen pass, added onto its target rather than replacing it when `add` is set. */
  private pass(
    material: THREE.ShaderMaterial,
    source: THREE.Texture,
    target: THREE.WebGLRenderTarget | null,
    add = false,
  ): void {
    material.uniforms.tSource.value = source;
    material.blending = add ? THREE.AdditiveBlending : THREE.NoBlending;
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    // A pass that adds must not wipe what it is adding to; every other one covers the target whole.
    this.renderer.autoClear = !add;
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.autoClear = true;
  }
}

/** What a level of the blur chain is: linear-filtered, clamped, and no mip of its own. */
function blurTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;
  return target;
}

/** The shared shell of every pass: the triangle's own vertex stage, and no depth. */
function fullScreenMaterial(fragment: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { tSource: { value: null }, ...uniforms },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: fragment,
    depthTest: false,
    depthWrite: false,
    // Off by default: the scene's own tone mapping and encoding belong to the composite alone, and
    // applying either to an intermediate pass would do it twice.
    toneMapped: false,
  });
}
