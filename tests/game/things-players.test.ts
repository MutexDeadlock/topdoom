import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { slotOfTarget, targetOfSlot } from '../../src/game/things/defs.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { MONSTER_FIELD_DEFAULTS } from '../../src/game/snapshot.ts';
import { ProjectileLayer } from '../../src/game/projectiles.ts';
import type { CombatContext } from '../../src/game/combat.ts';
import type { Player } from '../../src/game/player.ts';
import type { ProjectileShot } from '../../src/game/weapons.ts';
import type { MonsterAttackEvent } from '../../src/game/monsters/defs.ts';
import { SILENT } from '../../src/audio/sfx.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { clearRandom, getRandomCursors } from '../../src/util/random.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS, ROT0_BANK, fxLayer } from '../fixtures/spritestubs.ts';

/**
 * The player-slot refactor changed nothing a tic does and nothing a save holds: the thing layer
 * takes every slot's body where it took the one player, and `targetId` names a slot as
 * `targetOfSlot` where it held `null`. The run below is pinned against the literals the
 * single-player code produced before the change — the random cursor every 50 tics, the final
 * cursor, and two `ThingsSnapshot`s byte for byte. docs/multiplayer.md § Player slots,
 * § Slot addressing.
 */

/** The random cursor after every 50th tic of the three-monster run, as the one-player code drew it. */
const TRACE = [54, 100, 147, 183, 216, 237, 245, 23, 52, 76, 104, 129, 139, 150];
/** The cursor after the two-monster run's 200 tics. */
const INFIGHT_CURSOR = 111;
/** `layer.snapshot()` after the run: two corpses, a drop, and every `targetId` back at its default. */
const END = '{"clock":19.999999999999936,"stats":{"totalKills":3,"kills":2,"totalItems":0,"items":0},"changed":[[0,{"type":3004,"x":280.16241555550334,"y":311.0094978463168,"z":0,"facingDeg":174.17730019571033,"monster":{"homingBias":false,"health":17,"spawnX":704,"spawnY":448,"spawnAngle":180,"alerted":true,"attackPause":0.48571428571428565,"burstLeft":1,"burstTimer":0.028571428571428522,"movedir":2,"justAttacked":true}}],[1,{"type":3001,"x":237.49999999999812,"y":320,"z":0,"facingDeg":180,"monster":{"homingBias":false,"health":0,"spawnX":704,"deadTime":5.68571428571427,"alerted":true,"attackPause":0.3999999999999999,"burstLeft":1,"burstTimer":0.22857142857142848,"swinging":true,"reactionTicks":2}}],[2,{"type":9,"x":246.49401337142635,"y":330.7213189714275,"z":0,"facingDeg":-168.86961101369786,"monster":{"homingBias":false,"health":0,"spawnX":704,"spawnY":192,"spawnAngle":180,"deadTime":2.8285714285714225,"alerted":true,"attackPause":0.31428571428571406,"movedir":1,"justAttacked":true}}],[3,{"type":2001,"x":246.49401337142635,"y":330.7213189714275,"z":0,"facingDeg":-168.86961101369786,"dropped":true}]]}';
/** The same at tic 200 of a two-monster run, the zombieman still hunting the imp (`targetId: 1`). */
const INFIGHT = '{"clock":5.714285714285698,"stats":{"totalKills":2,"kills":0,"totalItems":0,"items":0},"changed":[[0,{"type":3004,"x":486.83420573613853,"y":384.8930326663284,"z":0,"facingDeg":135,"monster":{"homingBias":false,"health":17,"spawnX":704,"spawnY":448,"spawnAngle":180,"alerted":true,"targetId":1,"movedir":3,"movecount":2,"chaseTimer":0.05714285714285714,"threshold":83}}],[1,{"type":3001,"x":320.1371428571406,"y":320,"z":0,"facingDeg":180,"monster":{"homingBias":true,"spawnX":704,"alerted":true,"movedir":4,"movecount":11,"chaseTimer":0.02857142857142857}}]]}';

/** The room every run below stands in: three monsters facing a player across it. */
function arena(...types: number[]) {
  const grid = gridMap(['#######', '#.....#', '#.....#', '#.....#', '#######'], { cell: 128 });
  types.forEach((type, i) => grid.map.things.push(thingAt(grid, 5, 1 + i, type, 180)));
  const world = new World(grid.map);
  const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
  const start = grid.centre(1, 2);
  const player = { x: start.x, y: start.y, z: world.floorAt(start.x, start.y) };
  return { layer, player };
}

describe('Player slots · the one-slot run is the single-player run', () => {
  test('tic for tic: the same draws, the same final state, byte for byte', () => {
    clearRandom();
    const { layer, player } = arena(ThingType.zombieman, ThingType.imp, ThingType.shotgunGuy);
    const trace: number[] = [];
    for (let i = 0; i < 700; i++) {
      // The imp hits the zombieman, which turns on it (an infight); the player is dead for 50
      // tics (every slot null); then the imp dies under it and its attention falls back to the
      // player.
      if (i === 100) layer.damage(0, 3, { source: { id: 1, type: ThingType.imp }, from: player });
      layer.update(DOOM_TIC, [i >= 300 && i < 350 ? null : player]);
      if (i === 500) layer.damage(1, MONSTER_HEALTH[ThingType.imp]);
      if (i === 600) layer.damage(2, MONSTER_HEALTH[ThingType.shotgunGuy]);
      if (i % 50 === 49) trace.push(getRandomCursors().p);
    }
    assert.deepEqual(trace, TRACE, 'the P_Random cursor at every 50th tic');
    assert.equal(JSON.stringify(layer.snapshot()), END);
  });

  test('a monster hunting another saves its id; one hunting the player saves nothing', () => {
    clearRandom();
    const { layer, player } = arena(ThingType.zombieman, ThingType.imp);
    for (let i = 0; i < 200; i++) {
      if (i === 100) layer.damage(0, 3, { source: { id: 1, type: ThingType.imp }, from: player });
      layer.update(DOOM_TIC, [player]);
    }
    assert.equal(getRandomCursors().p, INFIGHT_CURSOR);
    assert.equal(JSON.stringify(layer.snapshot()), INFIGHT);
  });
});

describe('Player slots · slot addressing', () => {
  test('a slot encodes below every thing id and reads back', () => {
    for (const slot of [0, 1, 2, 3]) {
      assert.ok(targetOfSlot(slot) < 0);
      assert.equal(slotOfTarget(targetOfSlot(slot)), slot);
    }
    assert.equal(targetOfSlot(0), MONSTER_FIELD_DEFAULTS.targetId, 'player 1 is the spawn default, elided from a save');
  });
});

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

/** A `ProjectileLayer` over a two-cell corridor, its one slot standing in the south cell. */
function projectileRig() {
  const grid = gridMap(['.', '.'], { cell: 128 });
  const world = new World(grid.map);
  const at = grid.centre(0, 1);
  const player = { x: at.x, y: at.y, z: 0 } as Player;
  const effects = fxLayer({ fogVisible: () => true });
  effects.beginLevel(world);
  const ctx = {
    world,
    things: null,
    slots: [{ player, dead: false }],
    damageSlot: () => false,
    triggerShot: () => {},
    triggerShotPath: () => {},
  } as unknown as CombatContext;
  const projectiles = new ProjectileLayer(ctx, { effects, spriteBank: ROT0_BANK, spriteMaterials: MATERIALS, audio: SILENT });
  projectiles.beginLevel();
  return { projectiles, at };
}

describe('Player slots · a projectile saves player 1 as null', () => {
  test("the player's own shot: sourceId null on the wire, and back again", () => {
    const { projectiles } = projectileRig();
    projectiles.spawnPlayerShot(ROCKET, null, null, 0);
    const [saved] = projectiles.snapshot();
    assert.equal(saved.sourceId, null, 'the encoding every save has carried');
    projectiles.restore([saved]);
    assert.equal(projectiles.snapshot()[0].sourceId, null, 'and the round trip keeps it');
  });

  test("a revenant's tracer at the player: homing targetId null on the wire", () => {
    const { projectiles, at } = projectileRig();
    const atk: MonsterAttackEvent = {
      kind: 'ranged',
      damage: 0,
      bullets: [],
      angleRad: NORTH,
      x: at.x,
      y: at.y - 40,
      z: 32,
      sourceId: 0,
      sourceType: ThingType.revenant,
      sourceRadius: 20,
      targetId: targetOfSlot(0),
      projectiles: [{ sprite: 'FATB', speed: 700, angleRad: NORTH, homing: true }],
    };
    projectiles.spawnMonsterShot(atk);
    const [saved] = projectiles.snapshot();
    assert.equal(saved.sourceId, 0, "a monster's id is written as it is");
    assert.equal(saved.homing?.targetId, null);
    projectiles.restore([saved]);
    assert.equal(projectiles.snapshot()[0].homing?.targetId, null);
  });
});
