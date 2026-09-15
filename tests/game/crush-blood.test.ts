import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { applyCrushDamage } from '../../src/game/specials/moverblocking.ts';
import { BLOOD_FRAMES, CRUSH_BLOOD_SPEED } from '../../src/game/spritefx/tables.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom, getRandomCursors } from '../../src/util/random.ts';
import type { Pos3 } from '../../src/types.ts';
import type { SpriteBank } from '../../src/wad/sprites.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS, ROT0_BANK, drawnLumps, drawnSprites, fxLayer } from '../fixtures/spritestubs.ts';
import { AWAY, crushSources, occupant } from '../fixtures/specialsrig.ts';
import { stepFor } from '../fixtures/tics.ts';

/**
 * `PIT_ChangeSector`'s other half: every crush pulse also sprays `MT_BLOOD` out of the body it
 * damaged, at that body's middle. docs/specials-crushers.md § Crushers.
 */

const DEMON = MONSTER_STATS[ThingType.demon];

/** A one-cell room with its ceiling already down far enough to catch anything standing in it. */
function crushingRoom(type?: number) {
  const grid = gridMap(['###', '#.#', '###'], { cell: 128 });
  if (type !== undefined) grid.map.things.push(thingAt(grid, 1, 1, type));
  const sectorIndex = grid.index(1, 1);
  grid.map.sectors[sectorIndex].ceilHeight = 8;
  const world = new World(grid.map);
  const things = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
  const sprayed: Pos3[] = [];
  const pulse = (dealDamage = true, player = AWAY, dead = false) =>
    applyCrushDamage(
      world,
      crushSources({
        things: () => things,
        slots: [occupant(player, dead)],
        damageSlot: () => {},
        sprayBlood: (at) => void sprayed.push(at),
      }),
      sectorIndex,
      dealDamage,
    );
  return { sprayed, pulse, centre: grid.centre(1, 1) };
}

describe('Death · a crusher sprays blood', () => {
  test('out of the middle of the body it caught, once a pulse', () => {
    const room = crushingRoom(ThingType.demon);
    assert.ok(room.pulse(), 'the demon is caught');
    assert.equal(room.sprayed.length, 1, 'one splash for one pulse');
    // `thing->x`, `thing->y`, `thing->z + thing->height/2` — the splash is thrown from the body's
    // own middle and carries itself outwards from there (§ The crusher's splash itself, below).
    assert.deepEqual(room.sprayed[0], { x: room.centre.x, y: room.centre.y, z: DEMON.height / 2 });

    room.pulse();
    assert.equal(room.sprayed.length, 2, 'and again on the next pulse');
  });

  test('but not on a tic that only measures whether anything is caught', () => {
    const room = crushingRoom(ThingType.demon);
    assert.ok(room.pulse(false), 'still caught — `nofit` is reported every tic');
    assert.deepEqual(room.sprayed, [], 'the spray rides the damage, not the tic');
  });

  test('never out of a barrel, which carries MF_NOBLOOD', () => {
    const room = crushingRoom(ThingType.barrel);
    assert.ok(room.pulse(), 'the barrel is caught and takes the damage');
    assert.deepEqual(room.sprayed, [], 'a barrel takes a puff elsewhere and nothing here');
  });

  test('and out of the player as readily as out of a monster', () => {
    const room = crushingRoom();
    const player = { ...room.centre, z: 0 };
    assert.ok(room.pulse(true, player), 'the player is caught');
    assert.equal(room.sprayed.length, 1);
    assert.equal(room.sprayed[0].z, PLAYER_HEIGHT / 2);
  });

  test('but never out of a dead player, whose corpse is no longer shootable', () => {
    const room = crushingRoom();
    const corpse = { ...room.centre, z: 0 };
    // `P_KillMobj` strips `MF_SHOOTABLE`, and `PIT_ChangeSector` returns for a corpse before
    // `nofit`.
    assert.equal(room.pulse(true, corpse, true), false, 'not caught, so no slowdown either');
    assert.deepEqual(room.sprayed, []);
  });
});

/** A splash thrown into a room with its floor at 0, and where it is drawn after `dt`. */
function thrown(from: Pos3) {
  clearRandom();
  const grid = gridMap(['####', '#..#', '####'], { cell: 128 });
  const world = new World(grid.map);
  assert.equal(grid.map.sectors[grid.index(1, 1)].floorHeight, 0, 'the floor this splash lands on');
  const layer = fxLayer({ fogVisible: () => true });
  layer.beginLevel(world);
  layer.spawnCrushBlood(from);
  return {
    layer,
    /** Where the one splash is drawn, in DOOM space — `drawnSprites` hands back three.js axes. */
    at() {
      const drawn = drawnSprites(layer);
      assert.equal(drawn.length, 1, 'one splash');
      return { x: drawn[0].x, z: drawn[0].y };
    },
    run(seconds: number) {
      stepFor(seconds, () => layer.updateImpacts(DOOM_TIC));
    },
  };
}

describe('Death · the crusher’s splash itself', () => {
  test('starts at S_BLOOD1, where a damage-scaled P_SpawnBlood would skip ahead', () => {
    const fx = thrown({ x: 100, y: 100, z: 20 });
    assert.deepEqual(drawnLumps(fx.layer), [`BLUD${BLOOD_FRAMES[0]}0`], 'the whole chain, C first');
  });

  test('flies out of the body and falls to the floor instead of hanging where it spawned', () => {
    const fx = thrown({ x: 100, y: 100, z: DEMON.height / 2 });
    const spawn = fx.at();
    assert.equal(spawn.z, DEMON.height / 2, 'it starts at the body’s middle');

    fx.run(2 * DOOM_TIC);
    const airborne = fx.at();
    assert.ok(airborne.z < spawn.z, `falling (${airborne.z} under ${spawn.z})`);
    assert.notEqual(airborne.x, spawn.x, 'and carrying itself sideways as it goes');
    // Nothing here approaches the extreme of the draw, but nothing may pass it either.
    const reach = CRUSH_BLOOD_SPEED * 2 * DOOM_TIC;
    assert.ok(Math.abs(airborne.x - spawn.x) <= reach, `within two tics of travel (${airborne.x})`);
  });

  test('draws its two pairs even where the set has no BLUD to spawn', () => {
    // `P_SpawnMobj` cannot fail, so vanilla draws either way and a set missing the sprite must
    // still move the cursor — docs/specials-crushers.md § Crushers.
    const after = (bank: SpriteBank) => {
      clearRandom();
      const grid = gridMap(['####', '#..#', '####'], { cell: 128 });
      const layer = fxLayer({ fogVisible: () => true, spriteBank: bank });
      layer.beginLevel(new World(grid.map));
      layer.spawnCrushBlood({ x: 100, y: 100, z: 20 });
      return getRandomCursors().p;
    };
    const noBlood = { lookup: (sprite: string, frame: string) =>
      sprite === 'BLUD' ? null : ROT0_BANK.lookup(sprite, frame, 0) } as unknown as SpriteBank;

    assert.equal(after(ROT0_BANK), 4, 'two triangular draws, four entries off the table');
    assert.equal(after(noBlood), 4, 'and the same four with nothing to draw them onto');
  });

  test('and sticks where it lands rather than sliding on for the rest of its animation', () => {
    const fx = thrown({ x: 100, y: 100, z: DEMON.height / 2 });
    // Well past the ~0.19 s a 28-unit drop takes under this engine's gravity, and inside the
    // splash's own 24-tic life.
    fx.run(0.4);
    const landed = fx.at();
    assert.equal(landed.z, 0, 'lying on the floor');

    fx.run(0.2);
    assert.deepEqual(fx.at(), landed, 'and not travelling any further');
  });
});
