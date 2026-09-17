import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { loadMap } from '../../src/wad/map.ts';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { buildIslands, buildSubSectorPolys, islandCount } from '../../src/render/bsp.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';

/**
 * Reveal is sticky and the camera reaches `VIEW_DISTANCE` in every direction, so a region joined to
 * the level only by a teleporter stayed lit beside it once visited: BOOMEDIT MAP01's pool room,
 * seen floating east of the map after a trip through the tag-50 silent teleport on line 244.
 * The fog draws only the island the player stands in — see docs/fogofwar.md § Islands and
 * docs/render-bsp.md § Islands.
 */
describe('Fog of war · detached regions', () => {
  const map = loadMap(new Wad(fixtureWad('boomedit.wad')), 'MAP01');
  const world = new World(map);
  const polys = buildSubSectorPolys(map);
  const island = buildIslands(map);
  const start = map.things.find((t) => t.type === 1)!;
  const at = (x: number, y: number): number => world.subsectorAt(x, y);

  /** In the main map, at the foot of the underwater stair the pool room teleports to. */
  const mainPool = at(-660, -990);
  /** The pool room's own end of that teleport, and the grass around its pool. */
  const poolRoom = at(1240, -1060);
  const sector92 = at(900, -300);

  test('the fixture holds the geometry the tests assume', () => {
    assert.equal(polys[mainPool].physicalSector, 100, 'the main map’s underwater tunnel');
    assert.equal(polys[poolRoom].physicalSector, 100, 'the pool room’s copy of that sector');
    assert.equal(polys[sector92].physicalSector, 92, 'the grass around the pool');
    // The two ends of the tag-50 pair, which is all that joins the two regions.
    assert.equal(map.linedefs[589].special, 244);
    assert.equal(map.linedefs[652].special, 244);
  });

  test('the pool room is its own island, and the player start is not in it', () => {
    const startIsland = island[at(start.x, start.y)];
    assert.equal(island[mainPool], startIsland, 'the underwater tunnel is part of the main map');
    assert.notEqual(island[poolRoom], startIsland, 'the pool room is not');
    assert.equal(island[sector92], island[poolRoom], 'the pool room is one island, not several');
  });

  test('the island count is how many regions the partition found', () => {
    // What `game.ts` puts on the level-load line; the ids are dense, so it is the highest plus one.
    assert.equal(islandCount(map), new Set(island).size);
    assert.equal(islandCount(map), 27, 'BOOMEDIT MAP01, as docs/render-bsp.md § Islands records');
  });

  test('a sight ray never reaches another island', () => {
    // Sight cannot cross a one-sided wall, so a leaf explored from a vantage in another island
    // would be a partition error rather than a fog one.
    for (const [x, y] of [
      [start.x, start.y],
      [-660, -990],
      [1240, -1060],
    ] as const) {
      const fog = new FogOfWar(world, [], [{ x, y }], 0);
      const here = island[at(x, y)];
      for (let ss = 0; ss < polys.length; ss++) {
        if (!fog.isVisible(ss) || island[ss] === here) continue;
        assert.fail(`leaf ${ss} (island ${island[ss]}) revealed from island ${here} at (${x}, ${y})`);
      }
    }
  });

  test('the pool room goes dark again on the way back, and takes the main map’s place', () => {
    const fog = new FogOfWar(world, [], [start], 0);
    for (let i = 0; i < 40; i++) fog.tick([{ x: -660, y: -990 }]);
    assert.equal(fog.isVisible(mainPool), true, 'the tunnel the player is standing in');
    assert.equal(fog.isVisible(sector92), false, 'the pool room, never visited');

    // Arriving in the pool room: it is drawn and the main map is not.
    for (let i = 0; i < 40; i++) fog.tick([{ x: 1240, y: -1060 }]);
    assert.equal(fog.isVisible(sector92), true);
    assert.equal(fog.isVisible(mainPool), false);
    // The map left behind cuts to black rather than fading out, the way the camera cuts on a
    // teleport; what is revealed after arriving fades in as it always does.
    assert.equal(fog.alphaOf(mainPool), 0);
    assert.ok(fog.alphaOf(sector92) < 1, 'the arrival is still fading in');
    for (let i = 0; i < 30; i++) fog.updateFade(0.1);
    assert.equal(fog.alphaOf(sector92), 1);

    // And back: the reported bug is `sector92` still being visible here.
    for (let i = 0; i < 40; i++) fog.tick([{ x: -660, y: -990 }]);
    assert.equal(fog.isVisible(mainPool), true);
    assert.equal(fog.isVisible(sector92), false);
  });

  test('two players apart: what a tic may shoot is the same whichever of them is drawn', () => {
    // Two browsers of one network game each draw their own player, and a replay's camera picker
    // draws either: neither may move what auto-aim can lock onto.
    const home = at(start.x, start.y);
    const pool = { x: 1240, y: -1060 };
    for (const drawn of [0, 1]) {
      const fog = new FogOfWar(world, [], [start, pool], drawn);
      assert.equal(fog.isVisible(home), true, `drawing player ${drawn + 1}`);
      assert.equal(fog.isVisible(poolRoom), true, `drawing player ${drawn + 1}`);
      assert.equal(fog.isDrawn(home), drawn === 0, 'only the drawn player’s island is drawn');
      assert.equal(fog.isDrawn(poolRoom), drawn === 1, 'only the drawn player’s island is drawn');
    }
  });

  test('drawing the other player cuts to their island', () => {
    const home = at(start.x, start.y);
    const fog = new FogOfWar(world, [], [start, { x: 1240, y: -1060 }], 0);
    assert.equal(fog.alphaOf(home), 1);
    assert.equal(fog.alphaOf(poolRoom), 0);
    fog.setDrawn(1);
    assert.equal(fog.alphaOf(home), 0, 'no fade out of the island left');
    assert.equal(fog.alphaOf(poolRoom), 1, 'no fade into the one arrived in');
  });

  test('the computer area map reveals the island the player is in, not the pool room', () => {
    const fog = new FogOfWar(world, [], [start], 0);
    fog.revealAll();
    assert.equal(fog.isVisible(mainPool), true);
    assert.equal(fog.isVisible(sector92), false);
  });

  test('an ordinary level is one island, so nothing of it is ever hidden', () => {
    const e1m1 = loadMap(new Wad(fixtureWad('doom1_e1m1.wad')), 'E1M1');
    assert.equal(new Set(buildIslands(e1m1)).size, 1);
  });
});
