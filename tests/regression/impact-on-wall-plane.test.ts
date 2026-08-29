import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../../src/game/world.ts';
import { SpriteFxLayer } from '../../src/game/spritefx.ts';
import { ProjectileLayer } from '../../src/game/projectiles.ts';
import { IMPACT_EFFECTS, PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';
import { MATERIALS, ROT0_BANK, drawnLumps } from '../fixtures/spritestubs.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { CombatContext } from '../../src/game/combat.ts';
import type { Player } from '../../src/game/player.ts';
import type { ProjectileShot } from '../../src/game/weapons.ts';
import type { AudioEngine } from '../../src/audio/audio.ts';

/**
 * `shotPath` ends a missile *on* the wall plane, and a one-shot effect spawned there resolves its
 * subsector by which side of the BSP splitter the point falls on — the far one, for half the walls
 * on a map. Fog of war then skips the explosion outright, so a rocket, plasma bolt or BFG ball
 * fired at that wall detonated invisibly (DOOM2 MAP01, the start room's north wall: every impact
 * along it lands in subsector 184, behind the wall, which the player has never seen). The arrival
 * is backed off the plane by the missile's own radius, which is where vanilla's `P_XYMovement`
 * stops it. See docs/combat.md § Where an impact sits.
 */

const SILENT = { play: () => {} } as unknown as AudioEngine;

/** North wall over an open cell — the orientation whose plane point falls in the *wall's* leaf. */
const GRID = gridMap(['#', '.'], { cell: 128 });
const SHOOTER = GRID.index(0, 1);
const WALL = GRID.index(0, 0);
const NORTH = Math.PI / 2;

const ROCKET: ProjectileShot = {
  kind: 'projectile',
  angleRad: NORTH,
  speed: 700,
  sprite: 'MISL',
  damage: 0,
  splash: null,
  spray: null,
};

/** The first frame of the rocket's own explosion, as `drawnLumps` reports it. */
const BLAST = `${IMPACT_EFFECTS.MISL.sprite}${IMPACT_EFFECTS.MISL.frames[0]}0`;

/** A layer pair on `GRID`, with only the shooter's own cell revealed. */
function rig(): { effects: SpriteFxLayer; projectiles: ProjectileLayer; world: World; fireFrom: { x: number; y: number } } {
  const world = new World(GRID.map);
  const at = GRID.centre(0, 1);
  const player = { x: at.x, y: at.y, z: 0 } as Player;
  const effects = new SpriteFxLayer(
    new THREE.Scene(),
    ROT0_BANK,
    MATERIALS,
    SILENT,
    () => null,
    (subsector) => subsector === SHOOTER,
  );
  effects.beginLevel(world);
  const ctx = {
    world,
    things: null,
    player,
    playerDead: false,
    damagePlayer: () => false,
    triggerShot: () => {},
    triggerShotPath: () => {},
  } as unknown as CombatContext;
  const projectiles = new ProjectileLayer(ctx, effects, ROT0_BANK, MATERIALS, SILENT);
  projectiles.beginLevel();
  return { effects, projectiles, world, fireFrom: at };
}

/** Fires one rocket north and advances until it has arrived. */
function fireIntoTheWall(rigged: ReturnType<typeof rig>): void {
  rigged.projectiles.spawnPlayerShot(ROCKET, 41, null, null);
  for (let i = 0; i < 60; i++) rigged.projectiles.update(DOOM_TIC);
  rigged.effects.updateImpacts(0);
}

describe('Regressions · a missile impact sits off the wall, not on it', () => {
  test('the plane point itself lands in the leaf behind the wall', () => {
    const { world, fireFrom } = rig();
    const path = world.shotPath({ x: fireFrom.x, y: fireFrom.y, z: 41 }, NORTH, null, 1000);
    assert.notEqual(path.lineIndex, null, 'the wall stopped it');
    assert.equal(world.subsectorAt(path.x, path.y), WALL, 'the raw arrival is on the far side');
  });

  test('the explosion is drawn from a room the player has seen', () => {
    const rigged = rig();
    fireIntoTheWall(rigged);
    assert.deepEqual(drawnLumps(rigged.effects), [BLAST]);
  });

  test('it is backed off by the missile’s own radius, along its flight', () => {
    const rigged = rig();
    fireIntoTheWall(rigged);
    const impacts = (rigged.effects as unknown as { impacts: { x: number; y: number }[] }).impacts;
    assert.equal(impacts.length, 1);
    // The wall plane is the north edge of the shooter's cell.
    assert.equal(impacts[0].x, rigged.fireFrom.x, 'straight up the flight line');
    assert.equal(impacts[0].y, GRID.cell - PROJECTILE_RADIUS.MISL);
  });
});
