/** Keyboard and pointer state, sampled by the game loop rather than event-driven. */
export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  /** Pointer position in normalised device coordinates (-1..1). */
  readonly pointer = { x: 0, y: 0 };
  mouseDown = false;

  private element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.down.has(e.code)) this.pressedThisFrame.add(e.code);
    this.down.add(e.code);
    // Keep the browser from scrolling the page with the movement keys.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onBlur = () => {
    this.down.clear();
    this.mouseDown = false;
  };

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.element.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  };

  private onPointerDown = () => {
    this.mouseDown = true;
  };

  private onPointerUp = () => {
    this.mouseDown = false;
  };

  held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True only on the first frame a key went down. */
  pressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  /** Forget everything currently held, e.g. when the menu takes over. */
  reset(): void {
    this.down.clear();
    this.pressedThisFrame.clear();
    this.mouseDown = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
  }
}
