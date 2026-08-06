import * as THREE from 'three';
import { TopDownCamera } from './camera.ts';
import { Input } from '../game/input.ts';

/**
 * Renderer, canvas, camera and input live for the whole session — a new level
 * must not cost a new WebGL context.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: TopDownCamera;
  readonly input: Input;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Set once, here, rather than switched on and off with the light visor:
    // changing `toneMapping` itself recompiles every material's shader, while
    // `toneMappingExposure` is a plain uniform. `LinearToneMapping` at the
    // default exposure of 1 is `saturate(color)` — bit-identical to
    // `NoToneMapping` for anything already in range, so this costs nothing
    // until `ui/screeneffects.ts`'s light visor actually turns it up.
    this.renderer.toneMapping = THREE.LinearToneMapping;
    container.appendChild(this.renderer.domElement);

    this.camera = new TopDownCamera(window.innerWidth / window.innerHeight);
    this.input = new Input(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.setAspect(window.innerWidth / window.innerHeight);
    });
  }
}
