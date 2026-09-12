import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT } from '../../src/audio/sfx.ts';
import { World } from '../../src/game/world.ts';
import { ProjectileLayer } from '../../src/game/projectiles.ts';
import { AIM_HEIGHT_OFFSET, PLAYER_HEIGHT, PLAYER_RADIUS, type Player } from '../../src/game/player.ts';
import { applyBarrelExplosion, raycastPlayers, type CombatContext, type PlayerHit } from '../../src/game/combat.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { targetOfSlot } from '../../src/game/things/defs.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { MATERIALS, ROT0_BANK, fxLayer } from '../fixtures/spritestubs.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import type { HitscanShot, ProjectileShot } from '../../src/game/weapons.ts';

/**
 * A player's shots and missiles reaching the other players, under the `pvp` gate.
 * docs/multiplayer-deathmatch.md § Player versus player.
 */

/** A corridor running east: the shooter in the first cell, the target four cells on. */
const GRID = gridMap(['#......#'], { cell: 128 });
const EAST = 0;
const ROCKET_SPEED = 20 * 35;

const ROCKET: ProjectileShot = {
  kind: 'projectile',
  angleRad: EAST,
  speed: ROCKET_SPEED,
  sprite: 'MISL',
  damage: 50,
  splash: { radius: 128, damage: 128, hitsPlayer: true },
  spray: null,
};

const PELLET: HitscanShot = { kind: 'hitscan', angleRad: EAST, slopeOffset: 0, damage: 10 };

function rig(pvp: boolean) {
  const world = new World(GRID.map);
  const body = (col: number) => ({ ...GRID.centre(col, 0), z: 0, angle: 0 }) as Player;
  const hits: [slot: number, amount: number, hit: PlayerHit | undefined][] = [];
  const ctx = {
    world,
    things: null,
    slots: [
      { player: body(1), dead: false },
      { player: body(5), dead: false },
    ],
    pvp,
    damageSlot: (slot: number, amount: number, hit?: PlayerHit) => {
      hits.push([slot, amount, hit]);
      return true;
    },
    triggerShot: () => {},
    triggerShotPath: () => {},
  } as unknown as CombatContext;
  const effects = fxLayer({ fogVisible: () => true });
  effects.beginLevel(world);
  const projectiles = new ProjectileLayer(ctx, { effects, spriteBank: ROT0_BANK, spriteMaterials: MATERIALS, audio: SILENT });
  projectiles.beginLevel();
  return { ctx, projectiles, hits };
}

describe('Player versus player · hitscan', () => {
  test('the trace finds the other player, never the shooter, and the fire height must cross the body', () => {
    const { ctx } = rig(true);
    const origin = { ...ctx.slots[0].player, z: AIM_HEIGHT_OFFSET };
    const hit = raycastPlayers(ctx, origin, EAST, 4000, 0);
    assert.ok(hit);
    assert.equal(hit.id, targetOfSlot(1));
    assert.equal(hit.radius, PLAYER_RADIUS);
    assert.equal(hit.height, PLAYER_HEIGHT);
    // `traceHitsBox` is vanilla's diagonal, which a trace through the centre crosses at the centre.
    assert.equal(hit.x, ctx.slots[1].player.x);
    const fromOther = { ...ctx.slots[1].player, z: AIM_HEIGHT_OFFSET };
    assert.equal(raycastPlayers(ctx, fromOther, EAST, 4000, 1), null, "slot 1's own shot passes itself");
    assert.equal(raycastPlayers(ctx, { ...origin, z: 500 }, EAST, 4000, 0, 0), null, 'a flat shot high over it');
  });

  test('a pellet lands on the other player only under the gate, blamed on the shooter', () => {
    const { projectiles, hits } = rig(true);
    projectiles.spawnPlayerShot(PELLET, null, null, 0);
    assert.equal(hits.length, 1);
    assert.deepEqual([hits[0][0], hits[0][1], hits[0][2]?.cause, hits[0][2]?.slot], [1, 10, targetOfSlot(0), 0]);
    const coop = rig(false);
    coop.projectiles.spawnPlayerShot(PELLET, null, null, 0);
    assert.equal(coop.hits.length, 0, 'passes through a teammate');
  });
});

describe('Player versus player · missiles', () => {
  test("a rocket strikes the other player, and its splash names the shooter to them and 'self' to itself", () => {
    const { projectiles, hits } = rig(true);
    projectiles.spawnPlayerShot(ROCKET, null, null, 0);
    for (let i = 0; i < 40 && hits.length === 0; i++) projectiles.update(DOOM_TIC);
    const direct = hits.find(([, amount]) => amount === 50);
    assert.ok(direct, 'the direct hit');
    assert.equal(direct[0], 1);
    assert.equal(direct[2]?.cause, targetOfSlot(0));
    assert.equal(direct[2]?.slot, 0);
    const splash = hits.find(([slot, amount]) => slot === 1 && amount !== 50);
    assert.ok(splash, 'the splash on the victim');
    assert.equal(splash[2]?.cause, targetOfSlot(0));
    assert.equal(splash[2]?.slot, 0);
    assert.ok(hits.every(([slot]) => slot === 1), 'the shooter is out of its own blast range here');
  });

  test('with the gate closed a rocket flies through the other player', () => {
    const { projectiles, hits } = rig(false);
    projectiles.spawnPlayerShot(ROCKET, null, null, 0);
    for (let i = 0; i < 40; i++) projectiles.update(DOOM_TIC);
    assert.ok(hits.every(([, amount]) => amount !== 50), 'no direct hit on a teammate');
  });
});

describe('Player versus player · whom a blast credits', () => {
  test("a barrel hands the player it hurts whoever set it off: a player's slot, a monster's source, or neither", () => {
    const { ctx, hits } = rig(true);
    const at = { ...ctx.slots[1].player, z: 0 };
    applyBarrelExplosion(ctx, { ...at });
    applyBarrelExplosion(ctx, { ...at, slot: 0 });
    applyBarrelExplosion(ctx, { ...at, source: { id: 7, type: ThingType.imp } });
    // Slot 0 stands four cells off, out of every blast; `fragCredit` reads the three apart.
    const onVictim = hits.map(([slot, , hit]) => [slot, hit?.cause, hit?.slot, hit?.source?.id]);
    assert.deepEqual(onVictim, [
      [1, ThingType.barrel, undefined, undefined],
      [1, ThingType.barrel, 0, undefined],
      [1, ThingType.barrel, undefined, 7],
    ]);
  });
});
