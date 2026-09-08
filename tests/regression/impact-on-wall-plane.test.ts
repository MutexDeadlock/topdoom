import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT } from '../../src/audio/sfx.ts';
import type { SpriteFxLayer } from '../../src/game/spritefx.ts';
import { World } from '../../src/game/world.ts';
import { ProjectileLayer } from '../../src/game/projectiles.ts';
import { IMPACT_EFFECTS, PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';
import { MATERIALS, ROT0_BANK, drawnLumps, fxLayer } from '../fixtures/spritestubs.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { CombatContext } from '../../src/game/combat.ts';
import type { Player } from '../../src/game/player.ts';
import type { ProjectileShot } from '../../src/game/weapons.ts';
import type { MonsterAttackEvent } from '../../src/game/monsters/defs.ts';

/**
 * `shotPath` ends a missile *on* the wall plane, and a one-shot effect spawned there resolves its
 * subsector by which side of the BSP splitter the point falls on — the far one, for half the walls
 * on a map. Fog of war then skips the explosion outright, so a rocket, plasma bolt or BFG ball
 * fired at that wall detonated invisibly (DOOM2 MAP01, the start room's north wall: every impact
 * along it lands in subsector 184, behind the wall, which the player has never seen). The flight
 * ends a radius short of the plane instead, which is where vanilla's `P_XYMovement` stops one: its
 * `P_TryMove` is atomic and `PIT_CheckLine` refuses the line as soon as the radius-inflated
 * `tmbbox` crosses it. See docs/combat.md § Where an impact sits.
 *
 * Both flights have to do it, and they resolve their wall in different places: a straight shot gets
 * the standoff at launch (`missileFlight`), a revenant's tracer when `projectileStepBlocker`
 * reports the plane mid-flight (`advanceHoming`). Only the straight one was covered when the
 * standoff moved out of a shared post-hoc correction, and the homing one silently went back to
 * exploding on the plane. docs/monster-attacks.md § The revenant's homing missile.
 */


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
  const effects = fxLayer({ fogVisible: (subsector) => subsector === SHOOTER });
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
  const projectiles = new ProjectileLayer(ctx, {
    effects,
    spriteBank: ROT0_BANK,
    spriteMaterials: MATERIALS,
    audio: SILENT,
  });
  projectiles.beginLevel();
  return { effects, projectiles, world, fireFrom: at };
}

/** Fires one rocket north and advances until it has arrived. */
function fireIntoTheWall(rigged: ReturnType<typeof rig>): void {
  rigged.projectiles.spawnPlayerShot(ROCKET, null, null);
  for (let i = 0; i < 60; i++) rigged.projectiles.update(DOOM_TIC);
  rigged.effects.updateImpacts(0);
}

/**
 * The same wall, hit by a revenant's tracer instead. Its homing target is the player, so the player
 * is placed north beyond the wall to aim the flight at it; the wall stops the tracer long before it
 * gets there.
 */
function fireTracerIntoTheWall(): { x: number; y: number } {
  const world = new World(GRID.map);
  const at = GRID.centre(0, 1);
  const player = { x: at.x, y: 400, z: 0 } as Player;
  const effects = fxLayer({ fogVisible: () => true });
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
  const projectiles = new ProjectileLayer(ctx, {
    effects,
    spriteBank: ROT0_BANK,
    spriteMaterials: MATERIALS,
    audio: SILENT,
  });
  projectiles.beginLevel();
  const atk: MonsterAttackEvent = {
    kind: 'ranged',
    damage: 0,
    bullets: [],
    angleRad: NORTH,
    x: at.x,
    y: at.y,
    z: 41,
    sourceId: 0,
    sourceType: 0,
    sourceRadius: 20,
    targetId: null,
    projectiles: [{ sprite: 'FATB', speed: 700, angleRad: NORTH, homing: true }],
  };
  projectiles.spawnMonsterShot(atk);
  for (let i = 0; i < 60; i++) projectiles.update(DOOM_TIC);
  effects.updateImpacts(0);
  const impacts = (effects as unknown as { impacts: { x: number; y: number }[] }).impacts;
  assert.equal(impacts.length, 1, 'one explosion, and no smoke puff to confuse it');
  return impacts[0];
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

  test('a homing tracer stops short of the plane too, not on it', () => {
    const blast = fireTracerIntoTheWall();
    assert.equal(blast.x, GRID.centre(0, 1).x, 'straight up the flight line');
    // Exactly the tracer's own radius short of the plane at y = GRID.cell, the same standoff the
    // straight shot above gets — `advanceHoming` applies it where the wall is actually met.
    assert.equal(blast.y, GRID.cell - PROJECTILE_RADIUS.FATB);
  });
});
