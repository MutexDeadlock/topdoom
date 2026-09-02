/**
 * Renderer, canvas, camera and input, bundled because all four live for the whole session — a new
 * level must not cost a new WebGL context. See docs/menu.md § Session lifecycle.
 */
import * as THREE from 'three';
import { TopDownCamera } from './camera.ts';
import { Bloom, getBloom } from './bloom.ts';
import { GpuTimer } from './gputimer.ts';
import { Input } from '../game/input.ts';

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: TopDownCamera;
  readonly input: Input;
  /**
   * GPU time for the profiler overlay, measured around the render call — see docs/menu.md §
   * Profiling overlay.
   */
  readonly gpuTimer: GpuTimer;
  /** The post chain every draw goes through — see `present`. */
  private bloom: Bloom;

  constructor(container: HTMLElement) {
    // Capped at 2 because the cost of this frame is per fragment almost end to end
    // (docs/render.md § What a frame costs), and a ratio of 3 would triple it for pixels no panel
    // this runs on can show apart.
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    // MSAA only where the pixel ratio is not already supersampling. At a ratio of 2 there are four
    // device pixels per CSS pixel before MSAA adds a sample, and the only thing it can still smooth
    // is a geometry silhouette: the textures are point-sampled (`NearestFilter`,
    // `render/textures.ts`) and the occlusion fade discards whole fragments, so neither gets
    // anything from a coverage mask. It is not a small saving — 38% of the frame's GPU time,
    // measured on an integrated GPU at every ratio. docs/render.md § What a frame costs.
    const wantsAntialias = pixelRatio < 2;
    // Behind the bloom chain the canvas's own MSAA smooths nothing: the scene lands in a render
    // target and the only thing reaching the default framebuffer is one triangle covering it whole.
    // So the context gives it up where the chain is already on, and `Bloom` supplies it instead —
    // for as long as this session lasts, whatever the setting does next.
    // docs/lights.md § Bloom and the canvas's MSAA.
    const bloomOwnsAntialias = wantsAntialias && getBloom();
    this.renderer = new THREE.WebGLRenderer({
      antialias: wantsAntialias && !bloomOwnsAntialias,
      powerPreference: 'high-performance',
    });
    this.bloom = new Bloom(this.renderer, bloomOwnsAntialias);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Set once, here, rather than switched on and off with the light visor:
    // changing `toneMapping` itself recompiles every material's shader, while
    // `toneMappingExposure` is a plain uniform. `LinearToneMapping` at the
    // default exposure of 1 is `saturate(color)` — bit-identical to
    // `NoToneMapping` for anything already in range, so this costs nothing
    // until `ui/hud/screeneffects.ts`'s light visor actually turns it up.
    this.renderer.toneMapping = THREE.LinearToneMapping;
    container.appendChild(this.renderer.domElement);

    // three has been WebGL2-only since r163, so the context is one whatever the declared union
    // says.
    this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext);
    this.camera = new TopDownCamera(window.innerWidth / window.innerHeight);
    this.input = new Input(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.setAspect(window.innerWidth / window.innerHeight);
    });
  }

  /**
   * Draws a frame. The one call the engine renders through, so the post chain is either in front of
   * every frame or of none — including the pause redraw and the savegame thumbnail, which read the
   * canvas and would otherwise read a frame composited differently from the one on screen.
   * docs/lights.md § Bloom.
   */
  present(scene: THREE.Scene, camera: THREE.Camera): void {
    this.bloom.render(scene, camera);
  }
}
