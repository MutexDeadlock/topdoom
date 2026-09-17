import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFadeTargets } from '../../src/render/occlusion.ts';
import { World } from '../../src/game/world.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK as SPRITE_BANK, MATERIALS as SPRITE_MATERIALS, thingLayer } from '../fixtures/spritestubs.ts';

/**
 * Who the fade aims at, and how tall each one's wedge is: a target is centred in its own body, so
 * a species' `mobjinfo.height` reaches the fade through `ThingLayer.awakeMonsters` rather than
 * every body borrowing the player's band. What the fade then *does* with them is
 * `tests/render/occlusion-fade.test.ts`.
 * See docs/render-occlusion.md § The target is the billboard.
 */

/**
 * An awake monster in the shape `collectFadeTargets` takes it — `z` its feet, `height` its own
 * `mobjinfo.height`. Player-height unless a case is about the difference.
 */
function awake(x: number, y: number, z: number, height = PLAYER_HEIGHT) {
  return { x, y, z, height };
}

describe('Rendering · fade targets', () => {
  test('every target is centred in its own body, not in a shared one', () => {
    // A monster brings its `mobjinfo.height`, so its wedge spans exactly the
    // body: feet to crown, centre halfway. docs/render-occlusion.md § The target is the
    // billboard.
    const cyberdemon = 110;
    const targets = collectFadeTargets({ x: 0, y: 0, z: 16 }, [awake(64, 0, 48, cyberdemon)]);
    assert.equal(targets[0].z, 16 + PLAYER_HEIGHT / 2);
    assert.equal(targets[0].halfHeight, PLAYER_HEIGHT / 2);
    assert.equal(targets[1].z, 48 + cyberdemon / 2);
    assert.equal(targets[1].halfHeight, cyberdemon / 2);
    // The whole point: a tall one reaches higher than the player's band would.
    assert.ok(targets[1].z + targets[1].halfHeight > 48 + PLAYER_HEIGHT);
  });

  test('a short body gets a shorter wedge than a tall one at the same spot', () => {
    const imp = 56;
    const [, small] = collectFadeTargets({ x: 0, y: 0, z: 0 }, [awake(64, 0, 0, imp)]);
    const [, big] = collectFadeTargets({ x: 0, y: 0, z: 0 }, [awake(64, 0, 0, 110)]);
    assert.ok(small.halfHeight < big.halfHeight, 'the imp does not borrow the cyberdemon’s reach');
    assert.equal(small.z - small.halfHeight, big.z - big.halfHeight, 'both stand on the same floor');
  });

  test('the live thing layer hands out each species’ own mobjinfo height', () => {
    // The end of the wiring: `bodyHeight` is seeded from `MONSTER_STATS`
    // (DEHACKED-patched, so a patch that retunes a height moves the fade with
    // it), and `awakeMonsters` is what carries it to `collectFadeTargets`.
    const grid = gridMap(['#'.repeat(8), `#${'.'.repeat(6)}#`, '#'.repeat(8)], { cell: 128 });
    const map = grid.map;
    map.things.push(
      thingAt(grid, 1, 1, 1),
      thingAt(grid, 3, 1, ThingType.imp, 180),
      thingAt(grid, 5, 1, ThingType.baronOfHell, 180),
    );
    const layer = thingLayer(new World(map), { bank: SPRITE_BANK, materials: SPRITE_MATERIALS });
    const player = { ...grid.centre(1, 1), z: 0 };
    // Long enough for `A_Look` to wake both and for the fog to mark them drawn.
    for (let i = 0; i < 60; i++) layer.update(DOOM_TIC, [player]);

    const awakened = layer.awakeMonsters();
    assert.ok(awakened.length >= 2, `both monsters awake and drawn, got ${awakened.length}`);
    const heights = new Set(awakened.map((m) => m.height));
    assert.ok(heights.has(MONSTER_STATS[ThingType.imp].height), 'the imp reports its own height');
    assert.ok(heights.has(MONSTER_STATS[ThingType.baronOfHell].height), 'and the baron its own');
    assert.equal(heights.size, 2, 'two species, two heights — not one shared band');

    for (const m of awakened) {
      const target = collectFadeTargets(player, [m])[1];
      assert.equal(target.halfHeight, m.height / 2, 'the wedge is that body’s own half-height');
      assert.equal(target.z - target.halfHeight, m.z, 'and its underside sits at the body’s feet');
    }
  });
});
