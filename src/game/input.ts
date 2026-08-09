/** What clicking the right mouse button does — a menu setting, see docs/menu.md. */
export type RightMouseAction = 'none' | 'previousweapon' | 'use';

const RIGHT_MOUSE_STORAGE_KEY = 'topdoom.rightMouse';
const RIGHT_MOUSE_ACTIONS: readonly RightMouseAction[] = ['none', 'previousweapon', 'use'];

/**
 * The right button's binding. Module-level for the same reason `player.ts`'s
 * `autorunEnabled` is: it's a session preference set from the menu's Settings
 * tab that must apply immediately mid-level, while the systems reading it
 * (`WeaponSystem`, `SpecialsController`) are recreated every map load.
 */
let rightMouseAction: RightMouseAction = readStoredRightMouseAction();

function readStoredRightMouseAction(): RightMouseAction {
  const stored = globalThis.localStorage?.getItem(RIGHT_MOUSE_STORAGE_KEY);
  return RIGHT_MOUSE_ACTIONS.find((a) => a === stored) ?? 'previousweapon';
}

export function getRightMouseAction(): RightMouseAction {
  return rightMouseAction;
}

export function setRightMouseAction(action: RightMouseAction): void {
  rightMouseAction = action;
  globalThis.localStorage?.setItem(RIGHT_MOUSE_STORAGE_KEY, action);
}

/** Keyboard and pointer state, sampled by the game loop rather than event-driven. */
export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  /** Pointer position in normalised device coordinates (-1..1). */
  readonly pointer = { x: 0, y: 0 };
  mouseDown = false;

  private rightDown = false;
  private rightPressedThisFrame = false;
  private wheelDelta = 0;

  private element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    // The right button is a gameplay action (see `RightMouseAction`), so the
    // browser menu must never open over the canvas — including when it's bound
    // to 'none', where a menu popping up mid-fight would still be a surprise.
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    element.addEventListener('wheel', this.onWheel, { passive: true });
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
    this.rightDown = false;
  };

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.element.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) {
      if (!this.rightDown) this.rightPressedThisFrame = true;
      this.rightDown = true;
    } else if (e.button === 0) {
      this.mouseDown = true;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button === 2) {
      this.rightDown = false;
    } else if (e.button === 0) {
      this.mouseDown = false;
    }
  };

  private onWheel = (e: WheelEvent) => {
    this.wheelDelta += e.deltaY;
  };

  held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True only on the first frame a key went down. */
  pressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  /**
   * True only on the first frame the right button went down, and only if it is
   * currently bound to `action` — so every consumer asks for the action it
   * implements rather than reading the setting itself.
   */
  rightMousePressed(action: RightMouseAction): boolean {
    return this.rightPressedThisFrame && rightMouseAction === action;
  }

  /** Accumulated scroll-wheel `deltaY` since the last call: positive is "down" (next weapon). */
  consumeWheel(): number {
    const delta = this.wheelDelta;
    this.wheelDelta = 0;
    return delta;
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.rightPressedThisFrame = false;
  }

  /** Forget everything currently held, e.g. when the menu takes over. */
  reset(): void {
    this.down.clear();
    this.pressedThisFrame.clear();
    this.mouseDown = false;
    this.rightDown = false;
    this.rightPressedThisFrame = false;
    this.wheelDelta = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('wheel', this.onWheel);
  }
}
