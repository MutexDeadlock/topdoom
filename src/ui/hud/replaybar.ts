/**
 * {@link ReplayBar}: the playback bar under the HUD — a position track with level markers that is
 * also what a jump is dragged on, and on hover the pause, speed, camera and "take over" controls —
 * plus the reticle drawn where the recording aimed and the marker over a jump's frozen frame. Pure
 * DOM over a {@link ReplayPlayback}; `Game` owns what the take-over, the camera picker and the
 * track do, and whether the viewer's `Space` reaches it.
 * docs/replays.md § Playback and § Seeking.
 */
import {
  SPEED_STEPS,
  compatDrift,
  positionFraction,
  replaySeconds,
  replayTics,
  ticAtFraction,
  type ReplayPlayback,
} from '../../game/replay.ts';
import { isTyping } from '../../game/input.ts';
import type { Pos2 } from '../../types.ts';
import { Crosshair } from './crosshair.ts';
import { formatClock } from './hud.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** What the bar's actions need from the session — the same port shape as `SaveHooks`. */
export interface ReplayBarHooks {
  /** Ends the playback and hands the level to the player, which also stores a savegame. */
  takeOver(): void;
  /** The camera picker's player entries: watch slot `slot`'s player. docs/replays.md § Playback. */
  watch(slot: number): void;
  /** Jumps the playback to a tic — the track's click and drag. */
  seek(tic: number): void;
  /** The level card's name for a map, for the track's markers and the hover label. */
  levelName(map: string): string;
}

/** The `body` class the HUD bar reads to lift itself clear of the expanded panel. */
const EXPANDED_CLASS = 'replay-expanded';

/** How far the arrow keys jump, in seconds — the media-player step, tuned by feel. */
const SKIP_SECONDS = 5;

/**
 * How long a desync holds the panel open. Long enough to catch the eye of someone watching the
 * middle of the screen, short enough not to sit over the level for the rest of the run — tuned by
 * feel. The verdict itself stays in the status text either way; this is only what makes it
 * noticed. docs/replays.md § Playback.
 */
const DESYNC_ALERT_MS = 6000;

export class ReplayBar {
  private root = el<HTMLDivElement>('replay-bar');
  private track = el<HTMLDivElement>('replay-track');
  private fill = el<HTMLDivElement>('replay-fill');
  private scrub = el<HTMLDivElement>('replay-scrub');
  private hover = el<HTMLSpanElement>('replay-hover');
  private markers = el<HTMLDivElement>('replay-markers');
  private pauseButton = el<HTMLButtonElement>('replay-pause');
  private time = el<HTMLSpanElement>('replay-time');
  private speed = el<HTMLInputElement>('replay-speed');
  private speedValue = el<HTMLSpanElement>('replay-speed-value');
  private crosshairButton = el<HTMLButtonElement>('replay-crosshair');
  private cameraPicker = el<HTMLDivElement>('replay-camera-picker');
  private cameraButton = el<HTMLButtonElement>('replay-camera');
  private cameraLabel = el<HTMLSpanElement>('replay-camera-label');
  private cameraMenu = el<HTMLDivElement>('replay-camera-menu');
  private cameraPlayers = el<HTMLDivElement>('replay-camera-players');
  private manualItem = el<HTMLButtonElement>('replay-camera-manual');
  private takeOverButton = el<HTMLButtonElement>('replay-takeover');
  private status = el<HTMLSpanElement>('replay-status');
  private reticle = el<HTMLDivElement>('replay-reticle');
  private seekMark = el<HTMLDivElement>('replay-seek');
  private flashMark = el<HTMLDivElement>('replay-flash');

  private hooks: ReplayBarHooks;
  /** The playback the markers and notes were built for, so they are rebuilt once per replay. */
  private shown: ReplayPlayback | null = null;
  /** The replay's level markers with their names resolved, in tic order — built once per replay. */
  private levels: { tic: number; name: string }[] = [];
  /** The camera picker's entry for every player, by slot — built once per replay. */
  private playerItems: HTMLButtonElement[] = [];
  private notes: string[] = [];
  private reticleHealth: number | null = null;
  /**
   * Whether the reticle is drawn at all — the panel's own toggle, on for as long as the session.
   */
  private reticleShown = true;
  /** Where the track is being dragged, 0..1; null when it isn't. The jump lands on release. */
  private dragging: number | null = null;
  /** False while the menu owns the keyboard, so its own `Space` doesn't reach the playback. */
  private keysActive = true;
  /** The verdict the panel has already opened for, so a desync alerts once and not every frame. */
  private alertedDesync: number | null = null;
  /** When the desync alert stops holding the panel open, on `performance.now()`'s clock. */
  private alertUntil = 0;
  /** What every listener of this bar is registered under, aborted by {@link ReplayBar.dispose}. */
  private readonly listening = new AbortController();

  constructor(hooks: ReplayBarHooks) {
    this.hooks = hooks;
    // Every listener is registered under `listening`: a bar is built per `Game` over the same
    // elements, and a disposed one's must not stay on them.
    const { signal } = this.listening;
    this.speed.max = String(SPEED_STEPS.length - 1);
    this.pauseButton.addEventListener('click', () => this.pauseOrRestart(), { signal });
    this.speed.addEventListener(
      'input',
      () => {
        if (this.shown) this.shown.speedIndex = Number(this.speed.value);
      },
      { signal },
    );
    this.crosshairButton.addEventListener(
      'click',
      () => {
        this.reticleShown = !this.reticleShown;
      },
      { signal },
    );
    this.cameraButton.addEventListener(
      'click',
      () => this.openCameraMenu(this.cameraMenu.classList.contains('hidden')),
      { signal },
    );
    this.manualItem.addEventListener(
      'click',
      () => {
        if (!this.shown) return;
        this.shown.cameraView = this.shown.cameraView === 'recording' ? 'manual' : 'recording';
        this.openCameraMenu(false);
      },
      { signal },
    );
    this.takeOverButton.addEventListener('click', () => this.hooks.takeOver(), { signal });
    // Pressed, dragged, released: the jump is made once, on release. Seeking on every move would
    // reload and re-run the level under the pointer. docs/replays.md § Seeking.
    this.track.addEventListener(
      'pointerdown',
      (e) => {
        this.track.setPointerCapture(e.pointerId);
        this.dragging = this.fractionAt(e);
        this.showAt(this.dragging);
      },
      { signal },
    );
    this.track.addEventListener(
      'pointermove',
      (e) => {
        const at = this.fractionAt(e);
        if (this.dragging !== null) this.dragging = at;
        this.showAt(at);
      },
      { signal },
    );
    // Not while a drag is under way: the pointer may leave the track's few pixels and come back,
    // and the press still owns the jump until it is let go.
    this.track.addEventListener(
      'pointerleave',
      () => {
        if (this.dragging === null) this.hideMark();
      },
      { signal },
    );
    for (const type of ['pointerup', 'pointercancel']) {
      this.track.addEventListener(
        type,
        () => {
          const at = this.dragging;
          this.dragging = null;
          if (at !== null && this.shown) {
            this.hooks.seek(ticAtFraction(at, this.shown.ticCount));
          }
        },
        { signal },
      );
    }
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('pointerdown', this.onPointerDown, { signal });
  }

  /**
   * The bar's keyboard controls: pause, and the arrow skips. Nothing else here is a shortcut — a
   * replay's own keys are the record's, and these belong to the viewer. docs/replays.md § Playback.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    // A focused button is no exception: `Input` preventDefaults every `Space` that isn't in a
    // form field, so the browser's own activation of one never happens here anyway — `Enter` is
    // what presses a focused button. The speed slider keeps its own keys, arrows included.
    if (!this.keysActive || !this.shown || isTyping(e.target)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.pauseOrRestart();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      this.skip(e.code === 'ArrowLeft' ? -SKIP_SECONDS : SKIP_SECONDS);
    }
  };

  /**
   * A press on the level itself pauses and resumes, like clicking a video. Only the canvas: the
   * bar has its own controls, and the menu and the overlays over a replay have theirs.
   */
  private onPointerDown = (e: PointerEvent): void => {
    if (!this.keysActive || !this.shown) return;
    // A press anywhere else closes an open camera picker, and on the level that is all it does.
    if (!this.cameraMenu.classList.contains('hidden') && !this.cameraPicker.contains(e.target as Node)) {
      this.openCameraMenu(false);
      return;
    }
    if (!(e.target instanceof HTMLCanvasElement)) return;
    this.pauseOrRestart();
  };

  /**
   * Hides the bar and lets go of every listener — a bar is built per `Game`, the elements and
   * `window` are not.
   */
  dispose(): void {
    this.hide();
    this.listening.abort();
  }

  /**
   * Once per frame: the track, the clock, the controls' state, the seek marker and the reticle.
   *
   * @param aim     the recording's aim point in NDC for this frame, null while nothing is aimed (a
   *                catching-up seek passes null: the standing picture keeps no live reticle)
   * @param health  what colours the reticle, the way the pointer's own would be
   */
  update(playback: ReplayPlayback | null, aim: Pos2 | null, health: number): void {
    if (!playback) {
      this.hide();
      return;
    }
    if (playback !== this.shown) this.show(playback);
    // A jump leaves the level's picture standing, so this is what says the position is moving at
    // all — `Game` draws nothing until it lands. docs/replays.md § Seeking.
    const seeking = playback.seekTarget !== null;
    this.seekMark.classList.toggle('hidden', !seeking);
    this.seekMark.classList.toggle('back', seeking && playback.seekBack);
    this.fill.style.width = `${positionFraction(playback.cursor, playback.ticCount) * 100}%`;
    // Every text below is written only when it changed: an assignment of the same string still
    // rebuilds the text node, and this runs every frame.
    setText(this.time, `${formatClock(replaySeconds(playback.cursor))} / ${formatClock(replaySeconds(playback.ticCount))}`);
    // Spent, the same button starts the replay over — there is nothing left to pause.
    setText(this.pauseButton, playback.ended ? '↺' : playback.paused ? '▶' : '❚❚');
    setTitle(this.pauseButton, playback.ended ? 'Play the replay again' : 'Pause or resume the playback');
    if (this.speed.value !== String(playback.speedIndex)) this.speed.value = String(playback.speedIndex);
    setText(this.speedValue, `${playback.speed}×`);
    // Both named for the state in force, not for what pressing them would do — the record toggle's
    // rule, and both marked when that state is not the one a replay opens in.
    setText(this.crosshairButton, `Crosshair: ${this.reticleShown ? 'on' : 'off'}`);
    setAria(this.crosshairButton, 'aria-pressed', !this.reticleShown);
    // The recorded view is named for the player it watches; the viewer's own names that player too
    // only where there is more than one to follow.
    const manual = playback.cameraView === 'manual';
    const name = playback.slotNames[playback.viewSlot];
    let view = name;
    if (manual) view = playback.slotNames.length > 1 ? `manual (${name})` : 'manual';
    setText(this.cameraLabel, `Camera: ${view}`);
    this.cameraButton.classList.toggle('marked', manual || playback.viewSlot !== 0);
    for (let slot = 0; slot < this.playerItems.length; slot++) {
      setAria(this.playerItems[slot], 'aria-checked', slot === playback.viewSlot);
    }
    setAria(this.manualItem, 'aria-checked', manual);
    // Spent, the panel stays open with nothing to hover for; a jump backwards out of the end puts
    // the bar back to its ordinary hover behaviour. The `body` class the HUD lifts itself by is
    // read off the same three conditions the panel's own CSS is, every frame rather than from
    // enter/leave events — a restart from the keyboard fires none of those, and the HUD used to be
    // left standing clear of a panel that had closed.
    this.root.classList.toggle('ended', playback.ended);
    // A desync opens the panel by itself: it is the one thing about a playback the viewer has to
    // learn without having gone looking for it, and the status text below says it to a bar nobody
    // is hovering. docs/replays.md § Playback.
    const alerting = this.alerting(playback.desyncedAt);
    this.root.classList.toggle('alerting', alerting);
    const expanded = playback.ended || alerting || this.root.matches(':hover, :focus-within');
    document.body.classList.toggle(EXPANDED_CLASS, expanded);
    // A picker left open under a panel that closed would be standing open when it next expands.
    if (!expanded) this.openCameraMenu(false);
    const status = this.statusText(playback);
    setText(this.status, status);
    setTitle(this.status, status);
    this.placeReticle(aim, health);
  }

  hide(): void {
    if (this.shown === null) return;
    this.shown = null;
    this.root.classList.add('hidden');
    this.root.classList.remove('ended', 'alerting');
    this.reticle.classList.add('hidden');
    this.seekMark.classList.add('hidden');
    this.flashMark.classList.add('hidden');
    this.hideMark();
    this.openCameraMenu(false);
    document.body.classList.remove(EXPANDED_CLASS);
  }

  private show(playback: ReplayPlayback): void {
    this.shown = playback;
    this.alertedDesync = null;
    this.alertUntil = 0;
    this.root.classList.remove('hidden', 'ended', 'alerting');
    document.body.classList.remove(EXPANDED_CLASS);
    this.levels = playback.replay.levels.map((level) => ({ tic: level.tic, name: this.hooks.levelName(level.map) }));
    this.markers.replaceChildren();
    for (const level of this.levels) {
      if (level.tic === 0) continue;
      const tick = document.createElement('div');
      tick.style.left = `${positionFraction(level.tic, playback.ticCount) * 100}%`;
      tick.title = level.name;
      this.markers.append(tick);
    }
    // Who is in a recording never changes, so the picker's player entries are built once for it.
    this.playerItems = playback.slotNames.map((name, slot) => {
      const item = document.createElement('button');
      item.setAttribute('role', 'menuitemradio');
      item.textContent = name;
      item.addEventListener('click', () => {
        this.hooks.watch(slot);
        this.openCameraMenu(false);
      });
      return item;
    });
    this.cameraPlayers.replaceChildren(...this.playerItems);
    this.openCameraMenu(false);
    // The one standing note, about *this* playback being at risk rather than about which release
    // wrote it: the simulation epoch. Neither the build number nor the recording engine is one —
    // both differ on most kept replays and neither says the run will diverge, where `compat` does
    // (docs/replays.md § Compatibility). `desyncedAt` is the verdict either way; this is the
    // warning.
    const drift = compatDrift(playback.replay.compat);
    this.notes = [];
    if (drift !== null) this.notes.push(`${drift} game rules — may desync`);
  }

  /**
   * The pause button, `Space` and a press on the level: pause or resume, or start over once the
   * stream is spent. The flash over the middle of the view is what says it landed, since a press
   * on the level has no button to light up and a paused frame looks like a still one.
   */
  private pauseOrRestart(): void {
    if (!this.shown) return;
    if (this.shown.ended) {
      this.shown.paused = false;
      this.hooks.seek(0);
      this.flash(false);
      return;
    }
    this.shown.paused = !this.shown.paused;
    this.flash(this.shown.paused);
  }

  /** Jumps `seconds` from where the playback is heading — a second press adds to the first. */
  private skip(seconds: number): void {
    if (!this.shown) return;
    const from = this.shown.seekTarget ?? this.shown.cursor;
    this.hooks.seek(from + replayTics(seconds));
  }

  /** One swell of the glyph for the state a press just put the playback in. */
  private flash(paused: boolean): void {
    this.flashMark.classList.toggle('paused', paused);
    this.flashMark.classList.add('hidden');
    // Reading the layout between the two is what restarts the animation on a press that repeats.
    void this.flashMark.offsetWidth;
    this.flashMark.classList.remove('hidden');
  }

  /**
   * Whether the viewer's `Space` reaches the playback: false while the menu is up, whose own
   * `Space` presses (a focused control, the scrolled list) are not meant for the bar behind it.
   */
  setKeysActive(on: boolean): void {
    this.keysActive = on;
  }

  /** Opens or closes the camera picker, its button saying which. */
  private openCameraMenu(open: boolean): void {
    this.cameraMenu.classList.toggle('hidden', !open);
    setAria(this.cameraButton, 'aria-expanded', open);
  }

  /** The pointer's position along the track as a 0..1 fraction. */
  private fractionAt(e: PointerEvent): number {
    const rect = this.track.getBoundingClientRect();
    return rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
  }

  /** The line and the label where a jump would land — under the pointer, hovering or dragging. */
  private showAt(fraction: number): void {
    this.scrub.classList.remove('hidden');
    this.scrub.style.left = `${fraction * 100}%`;
    if (!this.shown) return;
    this.hover.classList.remove('hidden');
    setText(this.hover, this.hoverLabel(ticAtFraction(fraction, this.shown.ticCount)));
    // Placed in pixels and kept clear of both edges: the track spans the whole width, so a label
    // centred on either end would hang half off the screen — which a level name makes the common
    // case rather than a few clipped digits.
    const width = this.track.clientWidth;
    const half = this.hover.offsetWidth / 2;
    this.hover.style.left = `${Math.max(half, Math.min(width - half, fraction * width))}px`;
  }

  /**
   * What the hover marks: the clock a jump would land on, and — only where the recording spans
   * levels — which level that is. docs/replays.md § Seeking.
   */
  private hoverLabel(tic: number): string {
    const clock = formatClock(replaySeconds(tic));
    if (this.levels.length < 2) return clock;
    let name = this.levels[0].name;
    for (const level of this.levels) {
      if (level.tic > tic) break;
      name = level.name;
    }
    return `${clock} · ${name}`;
  }

  /**
   * Whether the desync alert is still holding the panel open. The deadline is set on the frame the
   * verdict *changes* — a fresh desync, or a seek that re-anchored and cleared one, which takes the
   * alert with it (docs/replays.md § Seeking).
   */
  private alerting(desyncedAt: number | null): boolean {
    if (desyncedAt !== this.alertedDesync) {
      this.alertedDesync = desyncedAt;
      this.alertUntil = desyncedAt === null ? 0 : performance.now() + DESYNC_ALERT_MS;
    }
    return performance.now() < this.alertUntil;
  }

  private hideMark(): void {
    this.scrub.classList.add('hidden');
    this.hover.classList.add('hidden');
  }

  private statusText(playback: ReplayPlayback): string {
    const parts = [...this.notes];
    if (playback.seekTarget !== null) parts.push('seeking …');
    if (playback.desyncedAt !== null) parts.push(`desynced at ${formatClock(replaySeconds(playback.desyncedAt))}`);
    if (playback.ended) parts.push('end of replay');
    return parts.join(' · ');
  }

  private placeReticle(aim: Pos2 | null, health: number): void {
    if (!aim || !this.reticleShown) {
      this.reticle.classList.add('hidden');
      return;
    }
    this.reticle.classList.remove('hidden');
    const rounded = Math.round(health);
    if (rounded !== this.reticleHealth) {
      this.reticleHealth = rounded;
      this.reticle.style.backgroundImage = Crosshair.image(rounded);
    }
    this.reticle.style.left = `${((aim.x + 1) / 2) * window.innerWidth}px`;
    this.reticle.style.top = `${((1 - aim.y) / 2) * window.innerHeight}px`;
  }
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setTitle(node: HTMLElement, text: string): void {
  if (node.title !== text) node.title = text;
}

/** A boolean ARIA state (`aria-pressed`, `aria-checked`, `aria-expanded`), written only on a change. */
function setAria(node: HTMLElement, name: string, on: boolean): void {
  const value = String(on);
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
