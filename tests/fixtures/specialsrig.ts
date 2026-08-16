import * as THREE from 'three';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { SpecialsController } from '../../src/game/specials.ts';
import { computeMovableSectors } from '../../src/game/specials/mapscan.ts';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import type { DoomMap } from '../../src/wad/map.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import type { Input } from '../../src/game/input.ts';
import type { Placement, Pos2 } from '../../src/types.ts';

/**
 * Everything needed to get a real `SpecialsController` ticking over a `gridMap` in Node, in one
 * call instead of its sixteen positional arguments. The controller needs no GL context — only
 * texture sizes and materials from its bank, a bare `THREE.Group` to hang mover meshes on, and a
 * real `FogOfWar` — which is what makes this the fixture rather than a mock: everything below the
 * stubs is the production object. docs/testing.md § The specials rig.
 */

/** `buildMapMesh`/`buildMoverMesh` only ask a bank for texture sizes and materials — neither needs a GPU. */
export const BANK = {
  size: () => ({ w: 64, h: 128 }),
  get: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialBank;

/** Nothing held, nothing clicked — the input a test that isn't about the use key wants. */
export const NO_INPUT = { pressed: () => false, rightMousePressed: () => false } as unknown as Input;

/** The use key held — what a test drives a switch or manual door with. */
export const USE_INPUT = { pressed: (k: string) => k === 'Space', rightMousePressed: () => false } as unknown as Input;

/** One vanilla tic, the step `game.ts` drives specials at and this rig's default. */
export const TIC = 1 / 35;

export interface SpecialsRigOptions {
  /** `G_ExitLevel`. */
  onExit?: (secret: boolean) => void;
  onTeleport?: (dest: Placement) => void;
  /** Whether a body is under the closing ceiling, and the hook for counting crush damage pulses. */
  onCrush?: (sectorIndex: number, dealDamage: boolean) => boolean;
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
  movableSectors: Set<number>;
  /**
   * One tic of the player standing at (`x`, `y`) — the same call `game.ts` makes, in `update`'s own
   * argument order. Defaults to one `TIC` at the rig's start position, so a test that moves nobody
   * writes `tick()` and one that moves the player writes `tick(TIC, x, y)`.
   */
  tick(dt?: number, x?: number, y?: number): void;
}

/**
 * A `SpecialsController` over `map`, with the player starting at `at`. Only the callbacks a test
 * actually watches need naming; the rest default to no-ops.
 */
export function specialsRig(map: DoomMap, at: Pos2, options: SpecialsRigOptions = {}): SpecialsRig {
  const world = new World(map);
  const movableSectors = computeMovableSectors(map);
  const built = buildMapMesh(map, BANK, { movableSectors });
  const scene = new THREE.Group();
  const fog = new FogOfWar(world, built.occluders, at.x, at.y);
  const specials = new SpecialsController(
    map,
    world,
    BANK,
    scene,
    fog,
    built.polys,
    built,
    {},
    options.onExit ?? (() => {}),
    options.onTeleport ?? (() => {}),
    options.onCrush ?? (() => false),
    // The two "is the player in the way" predicates. No test drives a mover into
    // the player yet, so both stand at "nothing ever blocks one".
    () => false,
    () => false,
    at.x,
    at.y,
    movableSectors,
  );
  return {
    specials,
    world,
    scene,
    movableSectors,
    tick: (dt = TIC, x = at.x, y = at.y) => specials.update(dt, x, y, 0, NO_INPUT, new Set()),
  };
}
