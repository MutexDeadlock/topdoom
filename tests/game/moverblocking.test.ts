import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { MoverOccupancy } from '../../src/game/specials/moverblocking.ts';
import { VoodooDolls } from '../../src/game/specials/voodoo.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { AWAY, crushSources } from '../fixtures/specialsrig.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * `MoverOccupancy` is the binding `SpecialsController` reaches a level's bodies through, and the
 * three functions under it have their own tests — so what this covers is the binding itself: that
 * the thing layer is read late, the player object live, and the dolls and damage sink the ones the
 * session passed. docs/specials-crushers.md § Crushers.
 */

const CELL = 128;

/** A one-cell room whose ceiling is already down far enough to catch a player-height body. */
function crushingRoom() {
  const grid = gridMap(['###', '#.#', '###'], { cell: CELL });
  const sector = grid.index(1, 1);
  grid.map.sectors[sector].ceilHeight = 8;
  return { grid, sector };
}

describe('Specials · the bodies a mover reaches', () => {
  test('the thing layer is read per call, so one built after the controller still counts', () => {
    const { grid, sector } = crushingRoom();
    const centre = grid.centre(1, 1);
    grid.map.things.push({ x: centre.x, y: centre.y, angle: 0, type: ThingType.hellKnight, flags: 7 });
    const world = new World(grid.map);
    // `game.ts`'s `loadMap` builds the thing layer *after* the `SpecialsController`, so the
    // getter starts out answering null exactly as it does for the level's first construction.
    let things: ThingLayer | null = null;
    const occupancy = new MoverOccupancy(world, crushSources({ things: () => things }));
    assert.equal(occupancy.crush(sector, true), false, 'no layer yet, so nobody is in the way');

    things = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
    assert.equal(occupancy.crush(sector, true), true, 'the knight built afterwards is caught');
  });

  test('a crusher over a doll spends the damage on the player it stands for', () => {
    const grid = gridMap(['#####', '#...#', '#####'], { cell: CELL });
    const sector = grid.index(1, 1);
    grid.map.sectors[sector].ceilHeight = 8;
    const doll = grid.centre(1, 1);
    const stands = grid.centre(3, 1);
    // Every player-1 start but the last is a doll, so the crushed one is the doll and the
    // untouched one is where the real player stands. docs/specials-forces.md § Voodoo dolls.
    grid.map.things.push({ x: doll.x, y: doll.y, angle: 0, type: ThingType.playerStart, flags: 0 });
    grid.map.things.push({ x: stands.x, y: stands.y, angle: 0, type: ThingType.playerStart, flags: 0 });
    const world = new World(grid.map);
    const dolls = new VoodooDolls(world);
    assert.equal(dolls.dolls.length, 1);
    let dealt = 0;
    const occupancy = new MoverOccupancy(
      world,
      crushSources({ players: [{ ...stands, z: 0 }], dolls: dolls.dolls, damageSlot: (_slot, amount) => (dealt += amount) }),
    );
    assert.equal(occupancy.crush(sector, true), true);
    assert.ok(dealt > 0, 'the doll’s crushing should have reached the real player');
  });

  test('the player is read live, so walking into a rising floor starts blocking it', () => {
    const grid = gridMap(['###', '#.#', '###'], { cell: CELL });
    const sector = grid.index(1, 1);
    grid.map.sectors[sector].ceilHeight = 64;
    const world = new World(grid.map);
    const player: Pos3 = { ...AWAY };
    const occupancy = new MoverOccupancy(world, crushSources({ players: [player] }));
    // A floor this high leaves a standing player less than `PLAYER_HEIGHT` under the ceiling.
    const tooHigh = 64 - PLAYER_HEIGHT + 1;
    assert.equal(occupancy.blocksFloorRise(sector, tooHigh), false, 'nobody is standing there yet');

    const centre = grid.centre(1, 1);
    player.x = centre.x;
    player.y = centre.y;
    assert.equal(occupancy.blocksFloorRise(sector, tooHigh), true);
    assert.equal(occupancy.blocksFloorRise(sector, 0), false, 'a rise the player still fits under');
    assert.equal(occupancy.blocksCeilingLower(sector, PLAYER_HEIGHT - 1), true);
    assert.equal(occupancy.blocksCeilingLower(sector, 64), false);
  });
});
