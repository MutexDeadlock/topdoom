/**
 * `Input`: the keyboard and pointer state the game loop samples each frame, latched to the tic
 * cadence the simulation runs on, plus the right mouse button's binding — the one menu setting
 * that belongs here. See docs/frameloop.md § Input runs on the tic and docs/menu.md § Right mouse
 * button.
 */
import { readStorage, writeStorage } from '../util/storage.ts';

/** What clicking the right mouse button does — a menu setting, see docs/menu.md. */
export type RightMouseAction = 'none' | 'previousweapon' | 'use';

const RIGHT_MOUSE_STORAGE_KEY = 'rightMouse';
const RIGHT_MOUSE_ACTIONS: readonly RightMouseAction[] = ['none', 'previousweapon', 'use'];

/**
 * The right button's binding, read by `WeaponSystem` and `SpecialsController`.
 * Shaped like every persisted setting — docs/menu.md § Persisted settings.
 */
let rightMouseAction: RightMouseAction = readStoredRightMouseAction();

export function getRightMouseAction(): RightMouseAction {
  return rightMouseAction;
}

export function setRightMouseAction(action: RightMouseAction): void {
  rightMouseAction = action;
  writeStorage(RIGHT_MOUSE_STORAGE_KEY, action);
}

/**
 * How many characters one tic may collect. A tic clears the buffer, so this only ever caps a
 * burst nothing consumed — a keyboard macro, or keys arriving while the loop is stalled.
 */
const TYPED_LIMIT = 32;

/**
 * Keyboard and pointer state, sampled by the game loop rather than event-driven.
 *
 * The edge latches (`pressed`, `rightMousePressed`) hold "went down since the
 * last **tic**", not since the last rendered frame, and `endTic` is what clears
 * them. Rendering runs far more often than the simulation, so a frame-cadence
 * clear would drop most presses before a tic ever saw them.
 * docs/frameloop.md § Input runs on the tic.
 */
export class Input {
  private down = new Set<string>();
  private pressedThisTic = new Set<string>();
  private typedThisTic = '';
  /** Pointer position in normalised device coordinates (-1..1). */
  readonly pointer = { x: 0, y: 0 };
  mouseDown = false;

  private rightDown = false;
  private rightPressedThisTic = false;
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
    // `onKeyUp` stays unguarded on purpose — see `isTyping`.
    if (isTyping(e.target)) return;
    if (!this.down.has(e.code)) this.pressedThisTic.add(e.code);
    this.down.add(e.code);
    // A cheat code is *typed*, so it reads the character rather than the physical key — a `Z` on
    // a QWERTZ keyboard is a `z`, where `e.code` would say `KeyY`. Never with a modifier down:
    // Ctrl+D is a browser shortcut, not a letter of `iddqd`.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && this.typedThisTic.length < TYPED_LIMIT) {
      this.typedThisTic += e.key.toLowerCase();
    }
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
      if (!this.rightDown) this.rightPressedThisTic = true;
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

  /** True only on the first tic a key went down. */
  pressed(code: string): boolean {
    return this.pressedThisTic.has(code);
  }

  /**
   * The printable characters typed since the last tic, lowercased and in order — what
   * `game/cheats.ts` matches its codes against. Auto-repeat counts, since the accumulation sits
   * below the first-press guard: a held movement key puts a character here on most tics, so this
   * is empty far less often than "nothing was typed" suggests.
   */
  typed(): string {
    return this.typedThisTic;
  }

  /**
   * True only on the first tic the right button went down, and only if it is
   * currently bound to `action` — so every consumer asks for the action it
   * implements rather than reading the setting itself.
   */
  rightMousePressed(action: RightMouseAction): boolean {
    return this.rightPressedThisTic && rightMouseAction === action;
  }

  /** Accumulated scroll-wheel `deltaY` since the last call: positive is "down" (next weapon). */
  consumeWheel(): number {
    const delta = this.wheelDelta;
    this.wheelDelta = 0;
    return delta;
  }

  /**
   * Call once at the end of every simulation tic — never per rendered frame,
   * and never on a frame that ran no tics, or the edge is lost.
   */
  endTic(): void {
    this.pressedThisTic.clear();
    this.typedThisTic = '';
    this.rightPressedThisTic = false;
  }

  /** Forget everything currently held, e.g. when the menu takes over. */
  reset(): void {
    this.down.clear();
    this.pressedThisTic.clear();
    this.typedThisTic = '';
    this.mouseDown = false;
    this.rightDown = false;
    this.rightPressedThisTic = false;
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

function readStoredRightMouseAction(): RightMouseAction {
  const stored = readStorage(RIGHT_MOUSE_STORAGE_KEY, 'previousweapon');
  return RIGHT_MOUSE_ACTIONS.find((a) => a === stored) ?? 'previousweapon';
}

/**
 * Whether a key belongs to a focused form control rather than to the game — the
 * menu's name fields, its sliders, checkboxes and dropdowns. The listeners below
 * are on `window`, and they preventDefault `Space` and the arrows, which without
 * this leaves a save name unable to contain a space, a caret unable to move and
 * a dropdown unable to be arrowed through. Only ever true while the menu is up:
 * nothing else here takes focus, and `Menu.close` drops what it holds.
 *
 * Only `keydown` asks: a key held from the canvas into a field must still see
 * its `keyup`, and clearing one that was never latched costs nothing.
 */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
}
