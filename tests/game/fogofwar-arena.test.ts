import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { loadMap } from '../../src/wad/map.ts';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';

/**
 * A deathmatch explores the whole level and draws all of it but the backstage and the islands no
 * player stands in. With the fog simply off, GoingDown MAP01's sector 77 — raised by W1 line 412
 * across the map — lay open beside the arena, as did every monster closet and control sector.
 * docs/fogofwar.md § Arena, docs/multiplayer-deathmatch.md § Fog.
 */
describe('Fog of war · a deathmatch arena', () => {
  test('a room only a walk line elsewhere opens is explored and not drawn', () => {
    const { world, start, leaf } = doorway('walk');
    const fog = new FogOfWar(world, [], [start], 0, { mode: 'arena' });
    for (const col of [1, 2, 3]) assert.equal(fog.isDrawn(leaf(col)), true, `corridor ${col}`);
    for (const col of [4, 5, 6, 7]) {
      assert.equal(fog.isVisible(leaf(col)), true, `cell ${col} is explored`);
      assert.equal(fog.isDrawn(leaf(col)), false, `cell ${col} is not drawn`);
    }
  });

  test('a door the player opens, or a pickup behind a walk-line door, puts the room on stage', () => {
    for (const [label, parts] of [
      ['a door opened by hand', doorway('use')],
      ['a pickup in the room', doorway('walk', true)],
    ] as const) {
      const fog = new FogOfWar(parts.world, [], [parts.start], 0, { mode: 'arena' });
      for (const col of [4, 5, 6, 7]) assert.equal(fog.isDrawn(parts.leaf(col)), true, `${label}: ${col}`);
    }
  });

  test('the room is drawn once the door opens and a player sees in', () => {
    const { map, world, door, start, leaf } = doorway('walk');
    const fog = new FogOfWar(world, [], [start], 0, { mode: 'arena' });
    fog.tick([start]);
    assert.equal(fog.isDrawn(leaf(6)), false, 'shut, a tic changes nothing');
    map.sectors[door].ceilHeight = 128;
    fog.tick([start]);
    for (const col of [4, 5, 6, 7]) assert.equal(fog.isDrawn(leaf(col)), true, `cell ${col}`);
  });

  test('a player teleporter puts its landing on stage, a monster-only one does not', () => {
    for (const [special, drawn] of [
      [39, true],
      [125, false],
    ] as const) {
      const grid = gridMap(['#######', '#..#..#', '#######']);
      const { map } = grid;
      const line = map.linedefs[grid.westEdge(2, 1)];
      line.special = special;
      line.tag = 7;
      map.sectors[grid.index(5, 1)].tag = 7;
      map.things.push(thingAt(grid, 5, 1, ThingType.teleportDest));
      const world = new World(map);
      const fog = new FogOfWar(world, [], [grid.centre(1, 1)], 0, { mode: 'arena' });
      for (const col of [4, 5]) {
        const at = grid.centre(col, 1);
        assert.equal(fog.isDrawn(world.subsectorAt(at.x, at.y)), drawn, `special ${special}: ${col}`);
      }
    }
  });

  test('a save keeps what is still backstage and draws what someone had seen into', () => {
    const { map, world, door, start, leaf } = doorway('walk');
    const seen = new FogOfWar(world, [], [start], 0, { mode: 'arena' });
    map.sectors[door].ceilHeight = 128;
    seen.tick([start]);
    const runs = seen.snapshotExplored();
    const undrawn = seen.snapshotUndrawn();
    map.sectors[door].ceilHeight = 0;

    const restored = new FogOfWar(world, [], [start], 0, { mode: 'arena' });
    restored.restoreExplored(runs, undrawn);
    assert.equal(restored.isDrawn(leaf(6)), true, 'seen into before the save');

    const older = new FogOfWar(world, [], [start], 0, { mode: 'arena' });
    older.restoreExplored(runs);
    assert.equal(older.isDrawn(leaf(6)), false, 'a save with no undrawn runs keeps the backstage');
  });

  test('a detached island is shootable from anywhere and drawn only while a slot stands in it', () => {
    const map = loadMap(new Wad(fixtureWad('boomedit.wad')), 'MAP01');
    const world = new World(map);
    const start = map.things.find((t) => t.type === 1)!;
    // The pool room: an island only the tag-50 teleporters reach (fogofwar-islands.test.ts).
    const poolRoom = world.subsectorAt(1240, -1060);
    const grass = world.subsectorAt(900, -300);
    const fog = new FogOfWar(world, [], [start], 0, { mode: 'arena' });
    assert.ok(fog.isVisible(poolRoom), 'no tic gates on an island');
    assert.ok(!fog.isDrawn(grass), 'not drawn while nobody stands in it');
    fog.tick([{ x: 1240, y: -1060 }]);
    assert.ok(fog.isDrawn(grass), 'drawn once a slot stands in it, as a teleporter reaches it');
    const sweeping = new FogOfWar(world, [], [start], 0);
    assert.ok(!sweeping.isVisible(poolRoom), 'the ordinary mode hides it from a tic too');
  });
});

/**
 * A corridor from the start at column 1 to a shut door at column 4 and a room past it, the door
 * opened by a W1 line in the corridor (`p_spec.c` case 2) or by hand (case 1, DR on its face).
 */
function doorway(opener: 'walk' | 'use', pickup = false) {
  const grid = gridMap(['#########', '#...+...#', '#########']);
  const { map } = grid;
  const door = grid.index(4, 1);
  if (opener === 'walk') {
    const line = map.linedefs[grid.westEdge(2, 1)];
    line.special = 2;
    line.tag = 5;
    map.sectors[door].tag = 5;
  } else {
    map.linedefs[grid.westEdge(4, 1)].special = 1;
  }
  if (pickup) map.things.push(thingAt(grid, 6, 1, ThingType.medikit));
  const world = new World(map);
  const leaf = (col: number): number => {
    const at = grid.centre(col, 1);
    return world.subsectorAt(at.x, at.y);
  };
  return { map, world, door, start: grid.centre(1, 1), leaf };
}
