/**
 * Everything needed to get a real `SpecialsController` ticking over a `gridMap` in Node: the
 * `World`, mesh and sector scan its `SpecialsOptions` expects, built in one call. The controller
 * needs no GL context — only texture sizes and materials from its bank, a bare `THREE.Group` to
 * hang mover meshes on, and a real `FogOfWar` — which is what makes this the fixture rather than a
 * mock: everything below the stubs is the production object. docs/testing.md § The specials rig.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DOOM_TIC } from '../../src/constants.ts';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { SpecialsController, type Occupancy, type TeleportDest } from '../../src/game/specials.ts';
import type { Activator } from '../../src/game/specials/defs.ts';
import type { KeySlot } from '../../src/game/inventory.ts';
import type { OccupancySources } from '../../src/game/specials/moverblocking.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { scanSectors } from '../../src/game/specials/mapscan.ts';
import { buildMapMesh, type BuiltMap } from '../../src/render/mapmesh.ts';
import type { DoomMap } from '../../src/wad/map.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import type { SfxId, SoundEmitter } from '../../src/audio/sfx.ts';
import type { Pos2, Pos3 } from '../../src/types.ts';
import type { CrossingBody } from '../../src/game/things/defs.ts';
import { NO_INPUT } from './input.ts';

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

/**
 * Far enough from every sector under test that the player is nobody's business in it — the
 * position a crush test gives the player when the subject is somebody else.
 */
export const AWAY = { x: -1000, y: -1000, z: 0 };

/** A player slot as `OccupancySources.slots` reads one, uncrushed; mutable so a test can kill it. */
export function occupant(player: Pos3, dead = false): { player: Pos3; dead: boolean; crushed: boolean } {
  return { player, dead, crushed: false };
}

/**
 * The `OccupancySources` an `applyCrushDamage`/`MoverOccupancy` test needs, with the members it
 * isn't about defaulted to "nobody there, and nothing should reach me". Override only what the
 * test is actually saying.
 */
export function crushSources(over: Partial<OccupancySources> = {}): OccupancySources {
  return {
    things: () => null,
    slots: [occupant(AWAY)],
    dolls: [],
    damageSlot: () => assert.fail('nothing in this test should damage the player'),
    squashSlot: () => {},
    sprayBlood: () => {},
    ...over,
  };
}

/** Empty-handed: the keys a `trigger` caller holds unless it says otherwise. */
const NO_KEYS: ReadonlySet<KeySlot> = new Set();

/** One vanilla tic, the step `game.ts` drives specials at and this rig's default. */
export const TIC = DOOM_TIC;

/**
 * Every drawn vertex height in the meshes whose batch key `wanted` accepts — how a test reads a
 * mover's geometry back off the rig's `scene` (only mover meshes hang there). Key it with
 * `'flat:'`/`'wall:'` prefixes or an exact `'wall:TEXTURE'` name.
 */
export function vertexHeights(scene: THREE.Object3D, wanted: (key: string) => boolean): number[] {
  const out: number[] = [];
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !wanted(obj.name)) return;
    const pos = obj.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) out.push(pos.getY(i));
  });
  return out;
}

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
  /**
   * The whole `Occupancy`, built over the `World` the rig owns — for a test whose subject is the
   * controller's *binding* to a level's bodies rather than one answer, i.e. a real
   * `MoverOccupancy`. A factory because that `World` doesn't exist until the rig builds it.
   * Overrides the three stubs above.
   */
  occupancy?: (world: World) => Occupancy;
  /** Where the controller's sounds go. Defaults to `SILENT`; `soundLog()` is the recorder a test that asserts on them wants. */
  sfx?: SoundEmitter;
}

/**
 * A `SoundEmitter` that just remembers what it was asked to play, for a test
 * whose subject is which sound an event makes — or, as often, that it makes
 * none (`EV_VerticalDoor`'s silent reversal, docs/specials-movers.md § Retriggering a
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
   * `update`'s own argument order. Defaults to one `TIC` at the rig's start position facing east,
   * so a test that moves nobody writes `tick()` and one that moves the player writes
   * `tick(TIC, x, y)`. The facing only matters to Boom's silent teleports, which rotate the body
   * relative to it.
   */
  tick(dt?: number, x?: number, y?: number, angle?: number): void;
  /**
   * Fires one line's special the way a press or crossing would, keys in hand — the one place the
   * cast onto the controller's private `trigger` lives, instead of once per test file. `activator`
   * is who set it off, for the specials that only some may work (docs/specials.md § Trigger
   * dispatch); `keys` are the ones in hand, for a locked door.
   */
  trigger(lineIndex: number, activator?: Activator, keys?: ReadonlySet<KeySlot>): void;
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
  // render transfers the real session would (docs/specials-transfers.md § Render transfers).
  const transfers = transfersOf(map);
  const built = buildMapMesh(map, BANK, { movableSectors, movingSectors, transfers });
  const scene = new THREE.Group();
  const fog = new FogOfWar(world, built.occluders, [at], 0);
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
    occupancy: options.occupancy?.(world) ?? {
      blocksCeilingLower: () => false,
      blocksFloorRise: options.blocksFloorRise ?? (() => false),
      crush: options.onCrush ?? (() => false),
      // The rig has no bodies of its own, so it has no corpses to crunch either.
      squash: () => {},
    },
    playersAt: [at],
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
    tick: (dt = TIC, x = at.x, y = at.y, angle = 0) => {
      specials.update(dt, { x, y, angle }, NO_INPUT, new Set());
      // The frame's own follow-up, at alpha 1: mover geometry is brought up to date on the draw
      // path now (docs/frameloop.md § Interpolation), and these tests assert tic-exact meshes.
      specials.drawMovers(1);
    },
    trigger: (lineIndex, activator = 'player', keys = NO_KEYS) =>
      (
        specials as unknown as {
          trigger(line: number, keys: ReadonlySet<KeySlot>, activator: Activator): unknown;
        }
      ).trigger(lineIndex, keys, activator),
  };
}
