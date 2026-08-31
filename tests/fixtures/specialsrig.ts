/**
 * Everything needed to get a real `SpecialsController` ticking over a `gridMap` in Node: the
 * `World`, mesh and sector scan its `SpecialsOptions` expects, built in one call. The controller
 * needs no GL context — only texture sizes and materials from its bank, a bare `THREE.Group` to
 * hang mover meshes on, and a real `FogOfWar` — which is what makes this the fixture rather than a
 * mock: everything below the stubs is the production object. docs/testing.md § The specials rig.
 */
import * as THREE from 'three';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { SpecialsController, type Occupancy, type TeleportDest } from '../../src/game/specials.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { scanSectors } from '../../src/game/specials/mapscan.ts';
import { buildMapMesh, type BuiltMap } from '../../src/render/mapmesh.ts';
import type { DoomMap } from '../../src/wad/map.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import type { Input } from '../../src/game/input.ts';
import type { SfxId, SoundEmitter } from '../../src/audio/sfx.ts';
import type { Pos2 } from '../../src/types.ts';
import type { CrossingBody } from '../../src/game/things/defs.ts';

/**
 * The one texture name `BANK` hands back a **masked** material for — a grate,
 * a fence, a barred window. `MaterialBank.get` marks those with a non-zero
 * `alphaTest`, and `WallFader` reads exactly that to tell a see-through screen
 * over an opening from a solid wall hung in one.
 */
export const MASKED_TEXTURE = 'GRATE';

/** `buildMapMesh`/`buildMoverMesh` only ask a bank for texture sizes and materials — neither needs a GPU. */
export const BANK = {
  size: () => ({ w: 64, h: 128 }),
  get: (_kind: string, name: string) =>
    new THREE.MeshBasicMaterial({ alphaTest: name.toUpperCase() === MASKED_TEXTURE ? 0.5 : 0 }),
} as unknown as MaterialBank;

/** Nothing held, nothing clicked — the input a test that isn't about the use key wants. */
export const NO_INPUT = { pressed: () => false, rightMousePressed: () => false } as unknown as Input;

/** The use key held — what a test drives a switch or manual door with. */
export const USE_INPUT = { pressed: (k: string) => k === 'Space', rightMousePressed: () => false } as unknown as Input;

/** One vanilla tic, the step `game.ts` drives specials at and this rig's default. */
export const TIC = 1 / 35;

/**
 * A `CrossingBody` for `SpecialsController.crossMonster`, which wants a whole
 * monster where a test usually only cares about the position it walked to.
 * `angle` matters only to Boom's silent teleports, which rotate relative to it.
 */
export function crossingBody(pos: Pos2, angle = 0): CrossingBody {
  return { ...pos, id: 1, type: 3004, blockRadius: 20, angle };
}

export interface SpecialsRigOptions {
  /** `G_ExitLevel`. */
  onExit?: (secret: boolean) => void;
  onTeleport?: (dest: TeleportDest) => void;
  /** Whether a body is under the closing ceiling, and the hook for counting crush damage pulses. */
  onCrush?: Occupancy['crush'];
  /**
   * Whether a body would be left without headroom at `floorHeight`. Defaults
   * to "nothing is ever in the way"; a test that wants a mover refused
   * supplies its own, without needing a real body anywhere near the sector.
   */
  blocksFloorRise?: Occupancy['blocksFloorRise'];
  /** Where the controller's sounds go. Defaults to `SILENT`; `soundLog()` is the recorder a test that asserts on them wants. */
  sfx?: SoundEmitter;
}

/**
 * A `SoundEmitter` that just remembers what it was asked to play, for a test
 * whose subject is which sound an event makes — or, as often, that it makes
 * none (`EV_VerticalDoor`'s silent reversal, docs/specials.md § Retriggering a
 * door). Pass it as `sfx` and read the array.
 */
export function soundLog(): { sfx: SoundEmitter; played: SfxId[] } {
  const played: SfxId[] = [];
  return { sfx: { play: (id) => played.push(id) }, played };
}

export interface SpecialsRig {
  specials: SpecialsController;
  /**
   * The `World` the controller was built over. Handed back because it must be *this* instance —
   * anything the controller mutates through it (`soundAlerted`, sector state) is invisible to a
   * second `new World(map)`.
   */
  world: World;
  /** The group the controller hangs its mover meshes on, for a test that reads them back. */
  scene: THREE.Group;
  /** The static batches, for a test that reads a fan or quad back off them. */
  built: BuiltMap;
  movableSectors: Set<number>;
  /**
   * One tic of the player standing at (`x`, `y`) facing `angle` — the same call `game.ts` makes, in
   * `update`'s own argument order. Defaults to one `TIC` at the rig's start position facing east, so
   * a test that moves nobody writes `tick()` and one that moves the player writes `tick(TIC, x, y)`.
   * The facing only matters to Boom's silent teleports, which rotate the body relative to it.
   */
  tick(dt?: number, x?: number, y?: number, angle?: number): void;
}

/**
 * A `SpecialsController` over `map`, with the player starting at `at`. Only the callbacks a test
 * actually watches need naming; the rest default to no-ops.
 */
export function specialsRig(map: DoomMap, at: Pos2, options: SpecialsRigOptions = {}): SpecialsRig {
  const world = new World(map);
  // Both sets, as `game.ts` computes them: a rig test that only carries a
  // switch must see its geometry diced the way the session would dice it.
  const { moving: movingSectors, movable: movableSectors } = scanSectors(map);
  // The same table `game.ts` hands both builders, so a rig test sees the Boom
  // render transfers the real session would (docs/specials.md § Render transfers).
  const transfers = transfersOf(map);
  const built = buildMapMesh(map, BANK, { movableSectors, movingSectors, transfers });
  const scene = new THREE.Group();
  const fog = new FogOfWar(world, built.occluders, at);
  const specials = new SpecialsController(world, {
    bank: BANK,
    scene,
    fog,
    built,
    meshOptions: { transfers, movingSectors },
    onExit: options.onExit ?? (() => {}),
    onTeleport: options.onTeleport ?? (() => {}),
    // Stands in for the level's bodies, of which the rig has none: nothing is ever in the way
    // unless a test says so. No test drives a *ceiling* into the player yet, so that one is fixed.
    occupancy: {
      blocksCeilingLower: () => false,
      blocksFloorRise: options.blocksFloorRise ?? (() => false),
      crush: options.onCrush ?? (() => false),
    },
    playerAt: at,
    movableSectors,
    sfx: options.sfx,
  });
  return {
    specials,
    world,
    scene,
    built,
    movableSectors,
    /** `angle` is the player's facing in radians — what Boom's silent teleports rotate relative to. */
    tick: (dt = TIC, x = at.x, y = at.y, angle = 0) => specials.update(dt, { x, y, angle }, NO_INPUT, new Set()),
  };
}
