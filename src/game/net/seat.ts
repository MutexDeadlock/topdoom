/**
 * `NetSeat`: one browser's seat in a network game, as the level runs it — the local row sampled
 * and sent ahead, every slot posed from its row, the drawn camera ticked apart from the simulated
 * one, the frame held while a peer's rows are missing, the host's snapshot restored where a sync
 * lands. `Game` holds one while `GameOptions.net` is set and answers for it through `NetHost`.
 * docs/multiplayer-net.md § What a tic does.
 */
import type { NetSession, NetCapture } from './session.ts';
import type { NetRestore, SlotAssignment } from './defs.ts';
import type { PlayerSlot } from '../playerslot.ts';
import { IDLE_TIC_INPUT } from '../input.ts';
import { aimPlaneZ } from '../player.ts';
import {
  GLOBAL_PLAYER_SETTINGS,
  applySessionSettings,
  emptyRow,
  quantizePose,
  releaseSessionSettings,
  sampleInput,
  writeRowAim,
  writeRowPose,
  writeRowWheel,
  type TicRow,
} from '../replay.ts';
import { TopDownCamera } from '../../render/camera.ts';
import type { Viewport } from '../../render/viewport.ts';
import { handleHotkeys } from '../../ui/devmode/debughud.ts';
import { DOOM_TIC } from '../../constants.ts';
import type { Pos2 } from '../../types.ts';

/** What the seat asks of the level it sits in — `Game` answers with one object literal. */
export interface NetHost {
  /** Every player slot; the list is never replaced, only grown. */
  readonly slots: readonly PlayerSlot[];
  /** The slot this browser plays. */
  readonly local: PlayerSlot;
  readonly view: Viewport;
  /** Every slot's body as the fog sweeps from them, refilled for this tic — the check sample's. */
  bodies(): readonly Pos2[];
  /** Points every slot's input and source at the seat's rows. */
  rebindInputs(): void;
  /**
   * The level for a sync, or null on a moment no snapshot can carry. A function-valued property,
   * since `NetSession.pendingRestore` is handed it unbound every frame.
   */
  readonly captureState: (joining: SlotAssignment | null) => NetCapture | null;
  /** The level rebuilt from the host's snapshot; false when these WADs have no such map. */
  restoreLevel(restore: NetRestore): boolean;
  /** Center-screen text. */
  say(text: string): void;
}

export class NetSeat {
  readonly session: NetSession;
  /** The menu is up over the game, which runs on: the local rows are idle ones meanwhile. */
  menuUp = false;
  private readonly host: NetHost;
  /** The local slot's row being sampled, reused per tic. */
  private readonly row: TicRow = emptyRow();
  /** Where the live pointer aimed this tic, for the drawn camera's lead. */
  private liveAim: Pos2 | null = null;
  /** When the stall notice was last drawn, so a held frame redraws it about once a second. */
  private stallNoticeAt = 0;

  constructor(session: NetSession, host: NetHost) {
    this.session = session;
    this.host = host;
  }

  /**
   * Puts the session in charge of every slot: its rows as their input, its settings as theirs, and
   * the local slot's simulation camera cut loose from the drawn one, which the live keys keep
   * driving. A level load and a snapshot restore both come back through here.
   */
  bind(): void {
    const { local, view, slots } = this.host;
    if (local.simCamera === view.camera) {
      local.simCamera = new TopDownCamera(view.camera.aspect);
      local.simCamera.copyFrom(view.camera);
    }
    for (const slot of slots) {
      slot.settings = this.session.settingsOf(slot.index) ?? slot.settings;
      slot.color = this.session.colorOf(slot.index) ?? slot.color;
    }
    applySessionSettings(this.session.session);
    this.host.rebindInputs();
    this.session.attach();
  }

  /**
   * The level is torn down: the session settings pinned before every tic go back to the menu's.
   * Nothing plays a network game's level on alone — docs/multiplayer-net.md § Leaving.
   */
  dispose(): void {
    releaseSessionSettings();
  }

  /**
   * What goes between two tics: the local row sampled and sent, every slot's camera posed from its
   * row, the session settings pinned. The camera is an input here as under a playback: every slot's
   * tic runs at the pose its row was read at; an idle row poses nothing, and the camera stays where
   * it was.
   */
  beginTic(): void {
    this.sampleRow();
    for (const slot of this.host.slots) {
      const pose = this.session.poseAt(slot.index);
      if (pose) slot.simCamera.setPose(pose);
    }
    // Before every tic, as a playback pins its own: the menu's setter writes the same variable.
    applySessionSettings(this.session.session);
  }

  /**
   * The drawn camera's own tic: the live orbit and framing keys, the auto camera and the glide
   * toward where the pointer aims — presentation the next row's pose is read from, and nothing the
   * simulation sees before that row runs. The live edges are spent here, once the pose and the row
   * have both read them.
   */
  tickViewCamera(): void {
    const { local, view } = this.host;
    const live = view.input;
    const camera = view.camera;
    if (!this.menuUp) {
      camera.applyYawInput(live, DOOM_TIC);
      handleHotkeys(live, camera);
    }
    local.autoCamera.tick(local.player, camera);
    camera.tick(DOOM_TIC, local.player.followPoint(), this.liveAim);
    live.endTic();
  }

  /** Moves the session's cursor: every slot is served the next row. */
  endTic(): void {
    this.session.endTic();
  }

  /**
   * Whether the tic about to run may: every row in, and no snapshot due on it still on its way. A
   * sync landing here is carried out first — the host captures and sends, everyone restores — and
   * then the tic runs from the restored level. docs/multiplayer-net.md § Snapshots.
   *
   * @returns false as well when a restore ended the session, which tears the level down with it
   */
  ready(): boolean {
    const restore = this.session.pendingRestore(this.host.captureState);
    if (restore === 'wait') return false;
    if (restore !== null && !this.applyRestore(restore)) return false;
    return this.session.readyForTic();
  }

  /** A held frame keeps saying who it is waiting for, about once a second. */
  noticeStall(now: number): void {
    if (now - this.stallNoticeAt <= 1000) return;
    const notice = this.session.stallNotice();
    if (notice) {
      this.host.say(notice);
      this.stallNoticeAt = now;
    }
  }

  /**
   * The local slot's row for `delay` tics ahead, read off the live keyboard and pointer through the
   * drawn camera — the pose the player is looking through and the point they aim at on it — and
   * handed to the session with the menu's player settings. An idle row while the menu is up.
   * Nothing typed travels: cheats stay out of a network game (`ST_Responder`'s `!netgame`).
   */
  private sampleRow(): void {
    const { row } = this;
    const { view, local } = this.host;
    const camera = view.camera;
    const live = this.menuUp ? IDLE_TIC_INPUT : view.input;
    sampleInput(live, GLOBAL_PLAYER_SETTINGS.rightMouse, row);
    writeRowWheel(row, live.consumeWheel());
    // The aim plane the tic's player update will use, off the drawn camera's own follow height.
    const aim = live.aim(camera, aimPlaneZ(camera));
    writeRowAim(row, aim);
    writeRowPose(row, quantizePose(camera.pose()));
    this.session.beginTic(row, GLOBAL_PLAYER_SETTINGS, this.host.bodies());
    // A dead player aims nowhere, and the camera has nothing to lead toward.
    this.liveAim = local.dead ? null : aim;
  }

  /**
   * The host's snapshot, in place of whatever this browser had run to: a resync, or a joiner's
   * arrival. A map these WADs do not have ends the session instead, and the level with it.
   * docs/multiplayer-net.md § Snapshots.
   *
   * @returns whether the level was restored
   */
  private applyRestore(restore: NetRestore): boolean {
    if (!this.host.restoreLevel(restore)) {
      this.session.end(`the host is on ${restore.map}, which these WADs do not have`);
      return false;
    }
    this.session.restoreApplied();
    this.bind();
    return true;
  }
}
