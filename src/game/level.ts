/**
 * {@link Level}: what one loaded map is while it plays — the geometry, every system built over it,
 * the clock — held whole, so nothing ever reads a level half-built. `Game.buildLevel` builds the
 * parts in the order docs/savegames.md § Apply order fixes and hands them over in one go.
 */
import * as THREE from 'three';
import type { ColorTint } from '../wad/colormaps.ts';
import type { BuiltMap } from '../render/mapmesh.ts';
import type { VoidFloor } from '../render/voidfloor.ts';
import type { FadePass } from '../render/occlusion.ts';
import type { SurfaceScroller } from '../render/scroller.ts';
import type { LevelStats } from '../ui/hud/hud.ts';
import type { World } from './world.ts';
import type { ThingLayer } from './things.ts';
import type { SectorEffects, SpecialsController } from './specials.ts';
import type { Forces } from './specials/forces.ts';
import type { Transfers } from './specials/transfers.ts';
import type { VoodooDolls } from './specials/voodoo.ts';
import type { FogOfWar } from './fogofwar.ts';
import type { IconOfSin } from './monsters/iconofsin.ts';
import { snapshotSectors, type GameSnapshot, type SectorSnapshot } from './snapshot.ts';
import type { Placement } from '../types.ts';

/** The level's share of a {@link GameSnapshot} — what {@link Level.snapshot} fills. */
export type LevelSnapshot = Pick<
  GameSnapshot,
  | 'levelTime'
  | 'sectors'
  | 'specials'
  | 'sectorEffects'
  | 'fog'
  | 'fogUndrawn'
  | 'soundAlerted'
  | 'things'
  | 'icon'
  | 'voodoo'
  | 'scrollers'
>;

/** Everything a {@link Level} is made of, as `Game.buildLevel` hands it over — and its fields. */
export interface LevelParts {
  /** The map lump's name, and its index in the set's map list. */
  readonly name: string;
  readonly index: number;
  /**
   * Whether a *monster* arriving on a teleport pad telefrags rather than being turned back by what
   * stands there — `monstersTelefrag`, a map-identity gate.
   */
  readonly monsterStomps: boolean;
  /**
   * The sectors as the WAD authored them, taken before anything has touched them — what a capture
   * diffs against so only sectors a special has changed are saved ({@link snapshotSectors}).
   */
  readonly sectorBaseline: SectorSnapshot[];
  /** The map's geometry and queries; the map itself is `world.map`. */
  readonly world: World;
  /** Boom's render transfers (game/specials/transfers.ts) — read per frame for the view colormap. */
  readonly transfers: Transfers;
  /**
   * The colour cast of each 242 control sector's colormaps, resolved once since `R_SetupFrame`
   * picks one of them per frame. Empty on the maps with none. The third, underwater colormap is not
   * kept — `Presenter.viewColormap` never applies it.
   */
  readonly colormapTints: Map<number, { mid: ColorTint | null; top: ColorTint | null }>;
  /** Damage floors and the secret counter — see game/specials/sectoreffects.ts. */
  readonly sectorEffects: SectorEffects;
  readonly built: BuiltMap;
  /** The ground the level stands in. docs/render.md § The void floor. */
  readonly voidFloor: VoidFloor;
  /**
   * The static wall/flat faders and the bags every fader on the map files into — see
   * {@link FadePass}, which owns the order the frame runs them in.
   */
  readonly fadePass: FadePass;
  /** The always-on parameter lines — scrollers and conveyors (game/specials/forces.ts). */
  readonly forces: Forces;
  readonly surfaceScroller: SurfaceScroller;
  /** The voodoo dolls, if the map places any (game/specials/voodoo.ts). */
  readonly voodoo: VoodooDolls;
  /** The player starts by slot (`coopStarts`). */
  readonly starts: (Placement | null)[];
  /** The deathmatch starts (`deathmatchStarts`), read only by a deathmatch. */
  readonly dmStarts: Placement[];
  readonly fogOfWar: FogOfWar;
  readonly specials: SpecialsController;
  readonly things: ThingLayer;
  /**
   * The Icon of Sin's cube spitter — inert on every map with no `MT_BOSSSPIT` thing, which is all
   * of them but MAP30. See game/monsters/iconofsin.ts.
   */
  readonly icon: IconOfSin;
  /**
   * Seconds spent in the level, shown on the HUD as hh:mm:ss — 0 fresh, a save's own restored.
   * Advanced by `Game.tic` while any player lives, and never on the tic an exit is consumed, which
   * returns before the increment.
   */
  time: number;
}

/** The fields are {@link LevelParts}', declared once there and merged in. */
export interface Level extends LevelParts {}

export class Level {
  constructor(parts: LevelParts) {
    Object.assign(this, parts);
  }

  /**
   * The level as a save holds it. The restore is not this class's: `Game.buildLevel` interleaves
   * it with the build, in the order docs/savegames.md § Apply order fixes.
   */
  snapshot(): LevelSnapshot {
    return {
      levelTime: this.time,
      sectors: snapshotSectors(this.world.map, this.sectorBaseline),
      specials: this.specials.snapshot(),
      sectorEffects: this.sectorEffects.snapshot(),
      fog: this.fogOfWar.snapshotExplored(),
      fogUndrawn: this.fogOfWar.snapshotUndrawn(),
      soundAlerted: this.world.snapshotSoundAlerted(),
      things: this.things.snapshot(),
      icon: this.icon.snapshot(),
      voodoo: this.voodoo.snapshot(),
      scrollers: this.forces.snapshot(),
    };
  }

  /**
   * The kill/item/secret counts and the clock, for the HUD strip every frame and for the
   * intermission on the frame the level ends. Cheap integer reads, assembled fresh rather than
   * cached — see docs/hud.md § Level stats.
   */
  stats(): LevelStats {
    const { stats } = this.things;
    return {
      kills: stats.kills,
      totalKills: stats.totalKills,
      items: stats.items,
      totalItems: stats.totalItems,
      secrets: this.sectorEffects.secretsFound,
      totalSecrets: this.sectorEffects.totalSecrets,
      elapsedSeconds: this.time,
    };
  }

  /**
   * Releases the level's scene content: the mover-owned meshes ({@link LevelParts.specials}), the
   * static batches, the thing sprites and the void floor. The batched sprite meshes/materials are
   * per-level; the geometry and textures behind them belong to `SpriteMaterialCache`, which
   * outlives a level.
   */
  dispose(scene: THREE.Scene): void {
    this.specials.dispose();
    scene.remove(this.built.group);
    this.built.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    scene.remove(this.things.group);
    this.things.dispose();
    scene.remove(this.voidFloor.mesh);
    this.voidFloor.dispose();
  }
}
