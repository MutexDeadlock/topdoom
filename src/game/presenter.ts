/**
 * `Presenter`: what one rendered frame is — the camera posed `alpha` through the last tic, the
 * sprites, effects and movers drawn there, the fades and animators advanced on real time, the 2D
 * layers over it all, and the render call. Advances no gameplay state. `Game` holds one and hands
 * it what it draws through `PresentHost`. docs/frameloop.md § What runs in a frame.
 */
import * as THREE from 'three';
import type { Level } from './level.ts';
import type { PlayerSlot } from './playerslot.ts';
import { PLAYER_HEIGHT } from './player.ts';
import type { StandingBody } from './things/defs.ts';
import type { SpriteFxLayer } from './spritefx.ts';
import type { ProjectileLayer } from './projectiles.ts';
import type { ReplayPlayback } from './replay.ts';
import { getCameraMode } from './autocamera.ts';
import type { Opening } from './world.ts';
import type { Viewport } from '../render/viewport.ts';
import type { TopDownCamera } from '../render/camera.ts';
import { DynamicLights, playerEmitterId } from '../render/lights.ts';
import { beginViewDepth } from '../render/sectorlight.ts';
import { skyLitSector } from '../render/skytint.ts';
import { collectFadeTargets } from '../render/occlusion.ts';
import type { PlayerSkins } from '../render/playerskin.ts';
import type { AnimatedTextures } from '../render/textureanim.ts';
import type { Hud } from '../ui/hud/hud.ts';
import type { Crosshair } from '../ui/hud/crosshair.ts';
import type { ReplayBar } from '../ui/hud/replaybar.ts';
import type { CenterMessage } from '../ui/hud/message.ts';
import type { LevelCard } from '../ui/hud/levelcard.ts';
import type { DeathOverlay } from '../ui/hud/deathoverlay.ts';
import { invisibilityOpacity, type ScreenEffects } from '../ui/hud/screeneffects.ts';
import { getProfilerVisible, ProfilerHud } from '../ui/hud/profiler.ts';
import { DebugHud } from '../ui/devmode/debughud.ts';
import type { AudioEngine } from '../audio/audio.ts';
import type { FrameProfiler } from '../util/profiler.ts';
import type { ColorTint } from '../wad/colormaps.ts';
import { vecLength } from '../util/geom.ts';
import { atan2, cos, sin } from '../util/fdlibm.ts';
import type { Pos2 } from '../types.ts';

/** `replayAimNdc`'s projection scratch, so the per-frame reticle placement allocates nothing. */
const AIM_SCRATCH = new THREE.Vector3();

/** The 2D layers a frame updates over the level — `Game` builds them, and raises most itself. */
export interface Overlays {
  readonly hud: Hud;
  readonly crosshair: Crosshair;
  readonly replayBar: ReplayBar;
  readonly message: CenterMessage;
  readonly levelCard: LevelCard;
  readonly screenEffects: ScreenEffects;
  readonly deathOverlay: DeathOverlay;
}

/**
 * What a frame draws, as `Game` hands it over — one object literal; `level` and the two replay
 * reads are getters, since they change under it.
 */
export interface PresentHost {
  readonly view: Viewport;
  readonly scene: THREE.Scene;
  /** Every player slot; the list is never replaced, only grown. */
  readonly slots: readonly PlayerSlot[];
  /** The slot this browser plays and draws for. */
  readonly local: PlayerSlot;
  readonly level: Level;
  readonly playback: ReplayPlayback | null;
  readonly recording: boolean;
  /** The WAD set's label, for the debug block. */
  readonly title: string;
  readonly audio: AudioEngine;
  readonly lights: DynamicLights;
  readonly effects: SpriteFxLayer;
  readonly projectiles: ProjectileLayer;
  readonly animatedTextures: AnimatedTextures;
  readonly playerSkins: PlayerSkins;
  /** Whether the loaded set draws the player its own way — `setDrawsOwnPlayer`. */
  readonly setDrawsPlayer: boolean;
  readonly profiler: FrameProfiler;
  readonly overlays: Overlays;
}

export class Presenter {
  private readonly host: PresentHost;
  private readonly profilerHud = new ProfilerHud();
  private readonly debugHud = new DebugHud();
  /**
   * The fade's opening lookup. A field so the frame allocates none; it reads the level per call, so
   * a level change needs no rebind.
   */
  private readonly openingInto = (line: number, out: Opening) =>
    this.host.level.world.openingInto(line, out);

  constructor(host: PresentHost) {
    this.host = host;
  }

  /**
   * One rendered frame: poses everything `alpha` of the way from the last tic to
   * the current one, runs the presentation-only animators, and draws. Advances
   * no gameplay state whatsoever. docs/frameloop.md § What runs in a frame.
   */
  draw(alpha: number, rawDt: number, still: boolean): void {
    const { view, level, lights, profiler, slots } = this.host;
    const camera = view.camera;
    // Every sprite the CPU lights reads its depth from this, and the camera was posed on the line
    // above. docs/render-lighting.md § Distance lighting.
    camera.applyToCamera(alpha);
    beginViewDepth(camera.camera);
    this.updateOverlays(rawDt, alpha);
    level.fogOfWar.updateFade(rawDt);
    // Opened before anything draws: each draw pass below offers its sprites as emitters as it goes,
    // and `commit` closes the set once they all have (docs/lights.md § What reaches the shader).
    lights.beginFrame(rawDt, camera.followX, camera.followY, camera.viewFrustum);
    profiler.time('Sprites', () => level.things.draw(alpha, camera.viewAngleDeg));
    this.drawEffects(alpha, camera.viewAngleDeg);
    // Moving planes are drawn `alpha` through the last tic like everything else. Must land before
    // the fade pass below: the refresh rewrites the mover buffers its commits write into.
    profiler.time('Movers', () => level.specials.drawMovers(alpha));
    this.updatePresentation(rawDt, camera);
    // A still frame gives the player's own clock nothing: the sprite holds the frame it is on
    // rather than walking on the spot behind a paused replay or an intermission. Everything else
    // here is presentation the frozen scene still wants (the bar, the HUD, fading).
    for (const slot of slots) this.posePlayer(slot, alpha, still ? 0 : rawDt, camera.viewAngleDeg);
    profiler.time('Lights', () => lights.commit());

    // Measured only while the overlay is up: a timer query is cheap but not free, and nothing
    // reads the answer otherwise. docs/devmode.md § Profiling overlay.
    const gpu = getProfilerVisible() ? view.gpuTimer : null;
    profiler.time('Render', () => {
      gpu?.begin();
      view.present(this.host.scene, camera.camera);
      gpu?.end();
    });
    // The music synth runs off its own timer, in the gaps between frames, so it
    // reports what it spent instead of being timed here (docs/music.md
    // § Getting it to the speakers).
    profiler.offFrame('Music', this.host.audio.music.takeRenderMs());
    profiler.endFrame();

    this.profilerHud.update(profiler, gpu?.ms ?? null);
    this.debugHud.update(rawDt, (fps) => this.debugLines(fps));
  }

  /**
   * The timed overlays' clocks: the center message, the level card and the death overlay. Every
   * frame's, and a seek's catch-up tics', which draw no frame. docs/replays.md § Seeking.
   */
  tickOverlayClocks(dt: number): void {
    const { message, levelCard, deathOverlay } = this.host.overlays;
    message.update(dt);
    levelCard.update(dt);
    deathOverlay.update(dt);
  }

  /** The playback bar alone, with no reticle — what a seek draws on the frames it owns. */
  drawBar(): void {
    this.host.overlays.replayBar.update(this.host.playback, null, this.host.local.inventory.health);
  }

  /**
   * The 2D layers over the level: status bar, crosshair, center message, level card,
   * the screen tints and the death overlay.
   */
  private updateOverlays(dt: number, alpha: number): void {
    const { inventory } = this.host.local;
    const { hud, crosshair, replayBar, screenEffects } = this.host.overlays;
    hud.update(inventory, this.host.level.stats(), this.host.recording);
    crosshair.update(inventory.health);
    replayBar.update(this.host.playback, this.replayAimNdc(alpha), inventory.health);
    this.tickOverlayClocks(dt);
    screenEffects.update(dt, inventory);
    screenEffects.setColormapTint(this.viewColormap());
  }

  /**
   * Where the recording's aim point falls on screen this frame, in NDC: the aim interpolated
   * `alpha` into the tic being drawn, through the pose `draw` just set from the same `alpha` — what
   * the replay reticle is placed at. Null with no playback, no aim, or a dead player (nothing aims
   * then).
   */
  private replayAimNdc(alpha: number): Pos2 | null {
    const aim = this.host.playback?.aimAt(alpha);
    if (!aim || this.host.local.dead) return null;
    const projected = AIM_SCRATCH.set(aim.x, aim.z, -aim.y).project(this.host.view.camera.camera);
    return { x: projected.x, y: projected.y };
  }

  /**
   * The colour cast the whole view draws under, or null for none: the colormap
   * of the 242 control sector the player is standing in, chosen by eye height
   * against that sector's floor and ceiling as `R_SetupFrame` does — except
   * that the underwater (bottom) colormap is deliberately not applied here.
   * docs/specials-transfers.md § Deep water.
   */
  private viewColormap(): ColorTint | null {
    const { colormapTints, transfers, world } = this.host.level;
    if (colormapTints.size === 0) return null;
    const { player } = this.host.local;
    const control = transfers.heightSec(world.sectorIndexAt(player.x, player.y));
    const tints = control < 0 ? undefined : colormapTints.get(control);
    if (!tints) return null;
    const sector = world.map.sectors[control];
    const eye = player.eyeZ;
    // Below the surface vanilla would cast the whole view through the control
    // sector's bottom colormap; this camera stays above the water while the
    // player sinks, so that blue would recolour a view that is mostly still
    // dry land. docs/specials-transfers.md § Deep water.
    if (eye < sector.floorHeight) return null;
    return eye > sector.ceilHeight ? tints.top : tints.mid;
  }

  /**
   * The draw half of `Game.updateEffects`: one begin/end pair around every list that batches a
   * sprite.
   */
  private drawEffects(alpha: number, viewAngleDeg: number): void {
    const { effects, projectiles, level, profiler } = this.host;
    profiler.time('Effects', () => {
      effects.beginFrame(viewAngleDeg);
      projectiles.draw(alpha);
      level.icon.draw(alpha);
      effects.draw(alpha);
      effects.endFrame();
    });
  }

  /**
   * Everything riding the frame clock rather than the tic: occlusion fading of walls and flats,
   * the scrollers, the texture animators and the void floor's drift. See render/occlusion.ts.
   */
  private updatePresentation(dt: number, camera: TopDownCamera): void {
    const { level, local, profiler } = this.host;
    profiler.time('Fading', () => {
      const camPos = camera.camera.position;
      // Door/lift geometry lives in its own meshes (game/specials.ts) and so
      // carries its own faders; the pass runs them alongside the static batches
      // over one pair of bags, which is what lets a hole opened in a wall
      // dissolve a door standing in it.
      level.fadePass.run(
        {
          dt,
          // The camera in DOOM (x, y, height), not three.js space.
          camX: camPos.x,
          camY: -camPos.z,
          camZ: camPos.y,
          targets: collectFadeTargets(local.player, this.fadeBodies()),
          openingInto: this.openingInto,
        },
        level.fogOfWar,
        level.specials.fadeParticipant,
      );
      // Independent of camera/player position — a scrolling wall animates
      // whether or not it's currently faded or in view. The offsets advance on
      // the frame clock (`Forces.advanceOffsets`) rather than the tic, so this
      // stays as smooth as the rest of the presentation layer.
      if (level.forces.hasScrollers) {
        level.forces.advanceOffsets(dt);
        level.surfaceScroller.update();
      }
      // Same independence, and session-scoped rather than per-map (`Game` builds it once with the
      // materials) — an animated liquid/fire texture keeps cycling across a level transition
      // exactly as it does within one.
      this.host.animatedTextures.update(dt);
      // Same frame clock, same reason. docs/render.md § The void floor.
      level.voidFloor.update(dt);
    });
  }

  /** What walls fade for besides the local player: the awake monsters and every other living slot. */
  private fadeBodies(): StandingBody[] {
    const { level, slots, local } = this.host;
    const bodies = level.things.awakeMonsters();
    for (const slot of slots) {
      if (slot === local || slot.dead) continue;
      const { x, y, z } = slot.player;
      bodies.push({ x, y, z, height: PLAYER_HEIGHT });
    }
    return bodies;
  }

  /**
   * Places the player's own billboard: position, facing, sector light and which
   * animation is due. Positions are interpolated `alpha` through the last tic;
   * the animation advances on `dt`, since it is presentation and its own frame
   * chain is what times it — which is why `draw` hands it 0 on a still frame,
   * where the real one would walk the sprite on the spot (docs/frameloop.md
   * § Pausing).
   */
  private posePlayer(slot: PlayerSlot, alpha: number, dt: number, viewAngleDeg: number): void {
    const { playerSkins, setDrawsPlayer, lights } = this.host;
    // Chosen before the pose that reads it. The settings are read per frame rather than captured,
    // so the menu applies them to the level already running.
    slot.actor.setSkin(playerSkins.skinFor(slot.inventory.currentWeapon, slot.drawColor(), setDrawsPlayer));
    slot.setOpacity(invisibilityOpacity(slot.inventory));
    const p = slot.player;
    const x = p.prevX + (p.x - p.prevX) * alpha;
    const y = p.prevY + (p.y - p.prevY) * alpha;
    const z = p.prevZ + (p.z - p.prevZ) * alpha;
    // Cast on the ground under them, not on their feet — this tic's own `groundFloor` answer, kept
    // by `Player` rather than asked again here. docs/render.md § The player's shadow.
    slot.shadow.update(x, y, p.groundZ, z);
    // Shortest-arc, so a shot fired across the -pi/pi seam doesn't spin the
    // billboard the long way round between two tics.
    let dAngle = p.angle - p.prevAngle;
    dAngle = atan2(sin(dAngle), cos(dAngle));
    const facingDeg = ((p.prevAngle + dAngle * alpha) * 180) / Math.PI;
    const { world, transfers } = this.host.level;
    const sectorIndex = world.sectorIndexAt(x, y);
    // player.update (and with it, velX/velY) stops running once dead, so
    // this must not read possibly-stale velocity from the moment of death —
    // not that it would matter anyway, since setPose ignores `animating`
    // entirely once `die()` has been called (see SpriteActor's doc).
    const walking = !slot.dead && vecLength(p.velX, p.velY) > 1;
    const light = world.map.sectors[sectorIndex] ? transfers.spriteLight(sectorIndex) : 128;
    // A player is an emitter too — `PLAY F`, the firing frame, is the muzzle flash GLDEFS binds
    // `ZOMBIEATK` to, the same light the zombieman's own `POSS F` gets. `playerEmitterId` keeps
    // it clear of `PosedThing.id` (a plain array index) and of the effects' negative IDs.
    // The leaf is left to `DynamicLights` to resolve: both `offer` and `tintAt` fall back to the
    // same descent, and only once a light is actually live — so a WAD with no GLDEFS, or lights
    // switched off, pays nothing for it here.
    const tint = lights.offerAndTint(slot.actor.frameKey, x, y, z, playerEmitterId(slot.index));
    slot.actor.setPose(
      { x, y, z },
      {
        facingDeg,
        light,
        dt,
        // Left true while frozen on purpose: at `dt` 0 the sprite holds the stride it was in,
        // where `false` would snap it to standing — a pause is not a stop.
        animating: walking,
        viewerAngleDeg: viewAngleDeg,
        tint,
        sky: skyLitSector(world.map.sectors[sectorIndex]),
      },
    );
  }

  /**
   * The status text's debug block. Only ever called while it is shown, and with a null `fps` where
   * the counter beside it is switched off — see `DebugHud.update`, docs/devmode.md § FPS counter.
   */
  private debugLines(fps: number | null): string[] {
    const { view, local, level, audio, title } = this.host;
    const { camera } = view;
    const { player } = local;
    const sector = level.world.sectorIndexAt(player.x, player.y);
    const channels = audio.channelUsage;
    const cameraDeg = ((Math.round(camera.yawDeg) % 360) + 360) % 360;
    const counts = [`${level.built.triangles} tris`, `monsters awake ${level.things.awakeMonsterCount()}`];
    if (fps !== null) counts.unshift(`${fps} fps`);
    return [
      `${level.name}   ${title}`,
      counts.join('   '),
      `pos ${player.x.toFixed(0)}, ${player.y.toFixed(0)}   z ${player.z.toFixed(0)}   sector ${sector}`,
      `Sound channels: ${channels.playing}/${channels.total} (${channels.dropped} burst-dropped)`,
      `cam ${camera.distance.toFixed(0)}u ${camera.tiltDeg.toFixed(0)}°tilt ${cameraDeg}°yaw`,
      this.cameraReadout(),
    ];
  }

  /**
   * The camera line of `debugLines`. A playback's camera comes from the record, so the auto
   * camera's dials are standing still and reporting them would be a lie — the view in force is
   * what there is to say (docs/replays.md § Playback).
   */
  private cameraReadout(): string {
    const { playback, local } = this.host;
    if (playback) return `replay camera: ${playback.cameraView}`;
    return getCameraMode() === 'auto' ? local.autoCamera.readout() : 'manual';
  }
}
