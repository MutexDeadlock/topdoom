import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { Player } from '../../src/game/player.ts';
import { WeaponSystem } from '../../src/game/weapons.ts';
import { createInventory } from '../../src/game/inventory.ts';
import { scanSectors } from '../../src/game/specials/mapscan.ts';
import { applySectors, sectorBaseline, snapshotSectors } from '../../src/game/snapshot.ts';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { NO_SIDE } from '../../src/wad/map.ts';
import type { Input } from '../../src/game/input.ts';
import type { AudioEngine } from '../../src/audio/audio.ts';
import type { Pos2 } from '../../src/types.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, specialsRig, TIC } from '../fixtures/specialsrig.ts';

/**
 * Savegame round-trips for the headless-constructible subsystems: a specials
 * controller saved mid-lift must continue over a fresh map exactly as the
 * original would have, and the leaf snapshot/restore pairs must be lossless.
 * See docs/savegames.md § Apply order.
 */

/** Right-clicking with the button bound to "switch to previous weapon", nothing else pressed. */
const PREV_CLICK = {
  pressed: () => false,
  rightMousePressed: (a: string) => a === 'previousweapon',
} as unknown as Input;

const ART = ['####', '#.L#', '####'] as const;
const LIFT_FLOOR = 64;

/** A walk-triggered one-shot lift (special 10), untriggered. */
function liftMap() {
  const grid = gridMap([...ART], { heights: { L: { floor: LIFT_FLOOR, ceil: 128 } } });
  const map = grid.map;
  map.things.push(thingAt(grid, 1, 1, 1)); // player start, for the Player round-trip below
  const walk = grid.index(1, 1);
  const lift = grid.index(2, 1);
  const li = map.linedefs.findIndex((l) => {
    if (l.left === NO_SIDE) return false;
    const a = map.sidedefs[l.right].sector;
    const b = map.sidedefs[l.left].sector;
    return (a === walk && b === lift) || (a === lift && b === walk);
  });
  assert.ok(li >= 0, 'the walk/lift boundary line exists');
  map.linedefs[li].special = 10; // W1 lift: lower, wait, raise — and a one-shot, so `usedOnce` is exercised too
  map.linedefs[li].tag = 1;
  map.sectors[lift].tag = 1;
  return { grid, map, lift };
}

function controllerOver(map: ReturnType<typeof liftMap>['map'], at: Pos2) {
  const rig = specialsRig(map, at);
  return { specials: rig.specials, tick: (x: number, y: number) => rig.tick(TIC, x, y) };
}

describe('Savegames · specials round-trip', () => {
  test('a lift saved mid-motion continues exactly as the original over a fresh map', () => {
    const { grid, map, lift } = liftMap();
    // Taken before anything runs, exactly as `Game` does on level load — the
    // sparse sector format is a diff against it.
    const baseline = sectorBaseline(map);
    const y = grid.centre(1, 1).y;
    const before = { x: 2 * grid.cell - 6, y };
    const after = { x: 2 * grid.cell + 6, y };

    const original = controllerOver(map, before);
    original.tick(after.x, after.y); // crosses the line: the lift starts lowering
    for (let i = 0; i < 5; i++) original.tick(after.x, after.y);
    const midMotion = map.sectors[lift].floorHeight;
    assert.ok(midMotion < LIFT_FLOOR && midMotion > 0, `saved mid-motion (floor at ${midMotion})`);

    // Serialize through real JSON, exactly as the store will.
    const saved = JSON.parse(
      JSON.stringify({ sectors: snapshotSectors(map, baseline), specials: original.specials.snapshot() }),
    );
    // The sparse format carries the moved sector and skips the untouched ones.
    assert.ok(
      saved.sectors.some(([index]: [number]) => index === lift),
      'the lift sector is in the saved diff',
    );
    assert.ok(saved.sectors.length < map.sectors.length, 'untouched sectors are left out');

    const fresh = liftMap();
    applySectors(fresh.map, saved.sectors);
    assert.equal(fresh.map.sectors[fresh.lift].floorHeight, midMotion, 'the fresh map starts at the saved height');
    const restored = controllerOver(fresh.map, after);
    restored.specials.restore(saved.specials);

    // Lockstep through the rest of the cycle: lowering, the hold, the raise, the rest.
    for (let tic = 0; tic < 300; tic++) {
      original.tick(after.x, after.y);
      restored.tick(after.x, after.y);
      assert.equal(
        fresh.map.sectors[fresh.lift].floorHeight,
        map.sectors[lift].floorHeight,
        `floor heights agree at tic ${tic}`,
      );
    }
    assert.equal(map.sectors[lift].floorHeight, LIFT_FLOOR, 'the cycle actually completed');
  });

  test('the player snapshot restores every field, private velocities included', () => {
    const { map } = liftMap();
    const world = new World(map);
    const player = new Player(world);
    player.restore({ x: 200, y: 190, z: 24, angle: 1.25, velX: 3, velY: -4, velZ: 5, knockVelX: -6, knockVelY: 7 });
    const fresh = new Player(world);
    fresh.restore(JSON.parse(JSON.stringify(player.snapshot())));
    assert.deepEqual(fresh.snapshot(), player.snapshot());
    assert.equal(fresh.prevX, 200, 'restore collapsed the interpolation window');
  });

  test('the weapon system snapshot round-trips every field it carries', () => {
    const inv = createInventory();
    inv.currentWeapon = 'chaingun';
    const ws = new WeaponSystem();
    ws.restore(
      {
        cooldownTics: 3,
        previousWeapon: 'shotgun',
        sawIdleTimer: 0.5,
        refire: 4,
        refireWeapon: 'chaingun',
      },
      inv,
    );
    const fresh = new WeaponSystem();
    fresh.restore(JSON.parse(JSON.stringify(ws.snapshot())), inv);
    assert.deepEqual(fresh.snapshot(), ws.snapshot());
    fresh.beginLevel(createInventory());
    assert.equal(fresh.snapshot().cooldownTics, 0, 'beginLevel still resets a restored system');
  });

  /**
   * `weaponLastFrame` is derived from the restored inventory rather than saved,
   * because `beginLevel` runs against the *outgoing* one long before the save's
   * inventory lands — docs/savegames.md § Apply order. Left stale, the first
   * frame after a load reads a switch that never happened: the chainsaw
   * announces itself and the restored `previousWeapon` is overwritten.
   */
  test('restoring a saved weapon does not read as a switch on the next frame', () => {
    const inv = createInventory();
    inv.currentWeapon = 'chainsaw';
    inv.weapons.add('chainsaw').add('shotgun');
    const ws = new WeaponSystem();
    // The load order: beginLevel against the outgoing inventory (a pistol),
    // then the save's own inventory and weapon state.
    ws.beginLevel(createInventory());
    ws.restore({ cooldownTics: 0, previousWeapon: 'shotgun', sawIdleTimer: 0, refire: 0, refireWeapon: null }, inv);

    const played: string[] = [];
    const audio = { play: (id: string) => played.push(id) } as unknown as AudioEngine;
    ws.update(0.016, false, inv, audio, { x: 0, y: 0, z: 0 });

    // `sawidl` is expected and correct — the saw is the ready weapon with a
    // restored timer of 0. Only the bring-up would be a phantom switch.
    assert.ok(!played.includes('sawup'), 'a restored chainsaw is not brought up again');
    ws.handleSwitching(PREV_CLICK, inv, 0);
    assert.equal(inv.currentWeapon, 'shotgun', 'the restored previousWeapon survived the first frame');
  });

  test('fog of war restores the explored bitmap wholesale and recounts pending', () => {
    const { grid, map } = liftMap();
    const world = new World(map);
    const built = buildMapMesh(map, BANK, { movableSectors: scanSectors(map).movable });
    const at = grid.centre(1, 1);
    const fog = new FogOfWar(world, built.occluders, at.x, at.y);
    const runs = JSON.parse(JSON.stringify(fog.snapshotExplored()));

    const fresh = new FogOfWar(world, built.occluders, at.x, at.y);
    fresh.restoreExplored(runs);
    assert.deepEqual(fresh.snapshotExplored(), fog.snapshotExplored());
  });
});
