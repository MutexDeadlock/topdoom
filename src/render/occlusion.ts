/**
 * Fades the walls (and overhanging flats) that sit between the camera and the player, as a
 * dithered discard rather than alpha blending. See docs/render-occlusion.md.
 */
import { PLAYER_HEIGHT } from '../game/player.ts';
import type { StandingBody } from '../game/things/defs.ts';
import type { Pos3 } from '../types.ts';
import { vecLength } from '../util/geom.ts';
import {
  FADE_ALPHA,
  FADE_RADIUS,
  FadeCrossings,
  MONSTER_FADE_RADIUS,
  MONSTER_FADE_RANGE,
  type ChangedQuads,
  type FadeFrame,
  type FadeTarget,
} from './occlusion/defs.ts';
import { WallFader } from './occlusion/walls.ts';
import { FlatFader } from './occlusion/flats.ts';

/** The directory's own surface, handed out here so no importer names an inner file. */
export { WallFader } from './occlusion/walls.ts';
export { FlatFader } from './occlusion/flats.ts';
export {
  boxesOverlap,
  FADE_ALPHA,
  FADE_CORE,
  FADE_RADIUS,
  FadeCrossings,
  fadeReach,
  MONSTER_FADE_RADIUS,
  MONSTER_FADE_RANGE,
  stretchBox,
  type ChangedQuads,
  type FadeBox,
  type FadeFrame,
  type FadeTarget,
} from './occlusion/defs.ts';

/**
 * Most awake monsters that can be fade targets at once, nearest first. Purely
 * a cost bound (`WallFader` cost is quads × targets): past a couple of dozen
 * nearby monsters, every wall any of them stands behind is already faded by a
 * nearer one. See docs/monster-ai.md § Spatial indexing.
 */
const MAX_FADE_TARGETS = 48;

/**
 * The player plus the awake monsters near enough to fade walls for, nearest first and capped at
 * `MAX_FADE_TARGETS` — alerted ones only, since an unseen sleeping monster is supposed to stay
 * hidden. **Each target's wedge is its own body**, built from the same `height` field `shotPath`
 * locks onto. docs/render-occlusion.md § The target is the billboard.
 */
export function collectFadeTargets(player: Pos3, awakeMonsters: readonly StandingBody[]): FadeTarget[] {
  const nearby = awakeMonsters
    .map((m) => ({ m, d: vecLength(m.x - player.x, m.y - player.y) }))
    .filter((e) => e.d <= MONSTER_FADE_RANGE);
  nearby.sort((a, b) => a.d - b.d);
  return [
    {
      x: player.x,
      y: player.y,
      z: player.z + PLAYER_HEIGHT / 2,
      halfHeight: PLAYER_HEIGHT / 2,
      fadeFloor: FADE_ALPHA,
      fadeRadius: FADE_RADIUS,
    },
    ...nearby.slice(0, MAX_FADE_TARGETS).map((e) => ({
      x: e.m.x,
      y: e.m.y,
      z: e.m.z + e.m.height / 2,
      halfHeight: e.m.height / 2,
      // Full strength beside the player, easing to no fade at all by the range
      // cap: a monster the player can barely make out shouldn't cost a wall,
      // and a fade that reached the cap at full strength would pop as the
      // monster crossed it. Linear, **tuned by feel**.
      fadeFloor: FADE_ALPHA + (1 - FADE_ALPHA) * (e.d / MONSTER_FADE_RANGE),
      fadeRadius: MONSTER_FADE_RADIUS,
    })),
  ];
}

/**
 * The faders a frame runs besides the static batches: the per-sector meshes
 * movable geometry is drawn from, which live behind `game/specials.ts`.
 * Declared structurally, so the render layer keeps no import edge into the game
 * layer (the `ScrollOffsets` rule above) — and so `FadePass` needs to know only
 * that the two halves exist and which order they run in.
 */
export interface FadeParticipant {
  collectFadeHits(frame: FadeFrame, walls: FadeCrossings, flats: FadeCrossings): void;
  updateFading(frame: FadeFrame, walls: FadeCrossings, flats: FadeCrossings): void;
}

/**
 * What the commit combines the fade with: fog of war's reveal. Structural for
 * the reason above — `FogOfWar` satisfies it as it stands.
 */
export interface FadeReveal {
  wallAlpha(occluderIndex: number): number;
  alphaOf(subsector: number): number;
  changedWalls(): ChangedQuads | null;
}

/**
 * The frame's whole fade, in the one order it is allowed to run: **every** fader on the map files
 * what stopped a sightline before **any** of them dissolves anything, so the bags are the frame's
 * rather than each fader's — docs/render-occlusion.md § One hole, whichever mesh it lands in.
 *
 * Owning the bags is why this is a class: they are scratch shared by faders none of which owns
 * them, and the reset that arms them belongs with the pass that fills them rather than with a
 * caller who must remember it.
 */
export class FadePass {
  readonly walls: WallFader;
  readonly flats: FlatFader;
  /** Refilled from scratch every `run`, and reused across frames and levels. */
  private readonly wallHits = new FadeCrossings();
  private readonly flatHits = new FadeCrossings();

  constructor(walls: WallFader, flats: FlatFader) {
    this.walls = walls;
    this.flats = flats;
  }

  /**
   * Pass one for the static batches and `movers` alike, then pass two over what
   * they all filed, then the commit that folds in the reveal.
   *
   * `movers`' own pass two runs here rather than at its own call site: it reads
   * `changedBounds`, whose fallback flag is separate from the `changedWalls`
   * one the wall commit consumes (game/fogofwar.ts), so the two are order-free
   * — and keeping them together is what makes the ordering a property of this
   * method instead of a comment somewhere else.
   */
  run(frame: FadeFrame, reveal: FadeReveal, movers?: FadeParticipant): void {
    const { wallHits, flatHits } = this;
    wallHits.reset();
    flatHits.reset();
    this.walls.collectCrossings(frame, wallHits);
    this.flats.collectPierces(frame, flatHits);
    movers?.collectFadeHits(frame, wallHits, flatHits);

    this.walls.applyCrossings(frame, wallHits);
    this.flats.applyPierces(frame, flatHits);
    movers?.updateFading(frame, wallHits, flatHits);

    // Walls resolve their own subsector inside FogOfWar (see `wallAlpha`); flats
    // already know theirs, so they go through `alphaOf` directly. Only what
    // moved: this frame's fade knows its own quads, and the reveal names the
    // ones it touched (`FogOfWar.changedWalls`). The mover meshes commit their
    // own inside `updateFading`, against the same reveal.
    this.walls.commit((i) => reveal.wallAlpha(i), reveal.changedWalls());
    this.flats.commit((i) => reveal.alphaOf(i));
  }
}
