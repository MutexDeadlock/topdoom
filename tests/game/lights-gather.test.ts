import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { TFOG_FRAMES, TFOG_FRAME_SECONDS } from '../../src/game/spritefx/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { THING_SPRITES } from '../../src/game/things/tables.ts';
import { DynamicLights } from '../../src/render/lights.ts';
import { parseGldefs } from '../../src/wad/gldefs.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { MATERIALS, ROT0_BANK, fxLayer } from '../fixtures/spritestubs.ts';

/**
 * Which draw funnels hand the light pass its emitters — the thing sprites and the transient
 * effects — and what each one contributes.
 * See docs/lights.md § What emits.
 */


/** What `offer` was called with, in draw order. */
interface Offer {
  key: string;
  x: number;
  y: number;
  z: number;
  id: number;
}

/**
 * A `DynamicLights` that records every offer. It stays a real controller — the draw sites also
 * call `tintAt` on it, and a stub that only recorded would not answer that.
 */
class RecordingLights extends DynamicLights {
  readonly offers: Offer[] = [];

  override offer(key: string, x: number, y: number, z: number, id: number): void {
    this.offers.push({ key, x, y, z, id });
    super.offer(key, x, y, z, id);
  }
}

/** Every frame in the fixture binds a light, so an offer's arrival is what is being measured. */
const DEFS = parseGldefs(`
  pointlight ANY { color 1 1 1  size 40 }
  object Torch { frame ${THING_SPRITES[ThingType.tallRedTorch]} { light ANY } }
  object Fog { frame TFOG { light ANY } }
`);

const GRID = gridMap(['#####', '#.#.#', '#####'], { cell: 128 });
const ROOM = { col: 1, row: 1 };
const CLOSET = { col: 3, row: 1 };

/**
 * The three sprite draw funnels each offer what they draw as a possible light emitter, inside the
 * fog-of-war gate they already had. docs/lights.md § What emits.
 */
describe('Dynamic lights · gathering emitters from the draw funnels', () => {
  test('a map thing offers its frame key, its position and its own id', () => {
    const grid = gridMap(['####', '#..#', '####'], { cell: 128 });
    const map = grid.map;
    map.things.push(thingAt(grid, 1, 1, ThingType.tallRedTorch));
    const at0 = grid.centre(1, 1);
    const lights = new RecordingLights(DEFS);
    const layer = buildThingSprites(new World(map), {
      bank: ROT0_BANK,
      materials: MATERIALS,
      skill: 3,
      lights,
    });
    // `update` is what settles `visible`; the draw loop skips anything it has not.
    layer.update(DOOM_TIC, { x: at0.x, y: at0.y, z: 0 });
    lights.beginFrame(0, 0, 0);
    layer.draw(1, 0);
    lights.commit();

    assert.equal(lights.offers.length, 1);
    const at = at0;
    assert.equal(lights.offers[0].key, `${THING_SPRITES[ThingType.tallRedTorch]}A`);
    assert.equal(lights.offers[0].x, at.x);
    assert.equal(lights.offers[0].y, at.y);
    assert.ok(lights.offers[0].id >= 0, 'a thing id is a plain array index');
    assert.equal(lights.uniforms.uLightCount.value, 1);
  });

  test('a one-shot effect offers through batchSprite, under an id of its own', () => {
    const lights = new RecordingLights(DEFS);
    const revealed = new Set([GRID.index(ROOM.col, ROOM.row)]);
    const layer = fxLayer({ fogVisible: (subsector) => revealed.has(subsector), lights });
    layer.beginLevel(new World(GRID.map));
    const at = GRID.centre(ROOM.col, ROOM.row);
    layer.spawnTeleportFog({ x: at.x, y: at.y, z: 0 });

    lights.beginFrame(0, 0, 0);
    layer.beginFrame(0);
    layer.draw(1);
    layer.endFrame();
    lights.commit();

    assert.deepEqual(
      lights.offers.map((o) => o.key),
      [`TFOG${TFOG_FRAMES[0]}`],
    );
    // Effect ids are negative, so they can never collide with a thing's array index.
    assert.ok(lights.offers[0].id < 0, `expected a negative effect id, got ${lights.offers[0].id}`);
  });

  test('one effect keeps the same id across frames, and two effects get different ones', () => {
    // The id is what a light's flicker phase and its `dontlightself` key off, so it has to be
    // stable for an effect's whole life.
    const lights = new RecordingLights(DEFS);
    const layer = fxLayer({ fogVisible: () => true, lights });
    layer.beginLevel(new World(GRID.map));
    const a = GRID.centre(ROOM.col, ROOM.row);
    const b = GRID.centre(CLOSET.col, CLOSET.row);
    layer.spawnTeleportFog({ x: a.x, y: a.y, z: 0 });
    layer.spawnTeleportFog({ x: b.x, y: b.y, z: 0 });

    const drawFrame = (): number[] => {
      lights.offers.length = 0;
      lights.beginFrame(TFOG_FRAME_SECONDS, 0, 0);
      layer.beginFrame(0);
      layer.draw(1);
      layer.endFrame();
      lights.commit();
      return lights.offers.map((o) => o.id);
    };

    const first = drawFrame();
    assert.equal(first.length, 2);
    assert.notEqual(first[0], first[1], 'two effects must not share an id');
    layer.updateTeleportFogs(TFOG_FRAME_SECONDS);
    assert.deepEqual(drawFrame(), first, 'an effect keeps its id across frames');
  });

  test('fog of war is inherited: an effect in an unseen room offers nothing', () => {
    // The gather sits inside the existing `fogVisible` gate rather than beside it, so a room the
    // player has never seen lights nothing — docs/fogofwar.md § How reveal reaches the geometry.
    const lights = new RecordingLights(DEFS);
    const revealed = new Set([GRID.index(ROOM.col, ROOM.row)]);
    const layer = fxLayer({ fogVisible: (subsector) => revealed.has(subsector), lights });
    layer.beginLevel(new World(GRID.map));
    const hidden = GRID.centre(CLOSET.col, CLOSET.row);
    layer.spawnTeleportFog({ x: hidden.x, y: hidden.y, z: 0 });

    lights.beginFrame(0, 0, 0);
    layer.beginFrame(0);
    layer.draw(1);
    layer.endFrame();
    lights.commit();

    assert.deepEqual(lights.offers, []);
    assert.equal(lights.uniforms.uLightCount.value, 0);
  });

  test('a session with no lights draws exactly as before', () => {
    // Every hook is behind an optional parameter, so a caller that supplies none — the tests
    // around this one, and any tool — runs the unmodified path.
    const grid = gridMap(['####', '#..#', '####'], { cell: 128 });
    const map = grid.map;
    map.things.push(thingAt(grid, 1, 1, ThingType.tallRedTorch));
    const layer = buildThingSprites(new World(map), { bank: ROT0_BANK, materials: MATERIALS, skill: 3 });
    assert.doesNotThrow(() => layer.draw(1, 0));
  });
});
