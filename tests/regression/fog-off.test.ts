import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { loadMap } from '../../src/wad/map.ts';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';

/**
 * A deathmatch runs with no fog of war: the `'off'` mode shows everything, a detached island
 * included, and sweeps nothing. docs/fogofwar.md § Off, docs/multiplayer-deathmatch.md § Fog.
 */
describe('Regressions · fog of war off', () => {
  const map = loadMap(new Wad(fixtureWad('boomedit.wad')), 'MAP01');
  const world = new World(map);
  const start = map.things.find((t) => t.type === 1)!;
  const at = (x: number, y: number): number => world.subsectorAt(x, y);
  /** The pool room, an island joined to the map only by a teleporter (fog-islands.test.ts). */
  const poolRoom = at(1240, -1060);

  test('everything is visible and drawn, the detached island included, and nothing changes', () => {
    const fog = new FogOfWar(world, [], [start], 0, undefined, 'off');
    assert.ok(fog.isVisible(poolRoom));
    assert.ok(fog.isDrawn(poolRoom));
    assert.equal(fog.alphaOf(poolRoom), 1);
    assert.ok(fog.changedBounds(), 'the constructor’s one wholesale snap');
    fog.tick([start]);
    fog.updateFade(0.5);
    assert.equal(fog.changedBounds(), null, 'the sweep runs nothing');
    fog.restoreExplored([0, 3]);
    assert.ok(fog.isDrawn(poolRoom), 'a save’s runs are ignored');
    const sweeping = new FogOfWar(world, [], [start], 0);
    assert.ok(!sweeping.isDrawn(poolRoom), 'the ordinary mode hides it');
  });
});
