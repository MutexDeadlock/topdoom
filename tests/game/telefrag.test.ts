import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, monstersTelefrag } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { targetOfSlot } from '../../src/game/things/defs.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { savedThing } from '../fixtures/snapshot.ts';

/**
 * `P_TeleportMove`/`PIT_StompThing` (`p_map.c`): what a body landing on a teleport pad does to
 * whatever is standing on it. See docs/death.md § Telefrag.
 */

/**
 * One wide room: an imp and a barrel share the first cell, a floor lamp stands on the second and a
 * second imp on the third — far enough apart (128 units between cell centres, against a 40-unit
 * stomp reach) that a landing on one cell can't touch the next. Every id below is the thing's
 * index in `map.things`; the player start is the only entry that spawns no body, and comes last.
 */
function arena(netgame = false) {
  const kills: number[] = [];
  const grid = gridMap(['######', '#....#', '######'], { cell: 128 });
  const map = grid.map;
  map.things.push(
    thingAt(grid, 1, 1, ThingType.imp),
    thingAt(grid, 1, 1, ThingType.barrel),
    thingAt(grid, 2, 1, ThingType.floorLamp),
    thingAt(grid, 3, 1, ThingType.imp),
    thingAt(grid, 4, 1, 1),
  );
  const world = new World(map);
  const onKill = (slot: number) => kills.push(slot);
  const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3, netgame, onKill });
  return { layer, kills, pad: grid.centre(1, 1), lamp: grid.centre(2, 1), away: grid.centre(3, 1) };
}

const IMP = 0;
const BARREL = 1;
const LAMP = 2;
const FAR_IMP = 3;

/** The radius vanilla stomps at is the arriving body's own; an imp's 20 is the stand-in here. */
const IMP_RADIUS = 20;

/**
 * Whether this body took the stomp, read off the save block: an absent `health` there is the spawn
 * default, i.e. untouched (docs/savegames.md § The format and its version). A thing that carries no
 * health at all — the lamp — can never read as hurt, which is the point.
 */
function telefragged(layer: ReturnType<typeof arena>['layer'], id: number): boolean {
  return (savedThing(layer.snapshot(), id)?.monster?.health ?? Infinity) <= 0;
}

describe('Death · telefrag', () => {
  test('a stomping arrival kills every shootable body on the pad', () => {
    const { layer, pad } = arena();

    assert.equal(layer.telefragAt(pad, IMP_RADIUS, true), true, 'a stomping arrival is never refused');
    assert.equal(telefragged(layer, IMP), true, 'the imp on the pad is telefragged');
    assert.equal(telefragged(layer, BARREL), true, 'so is the barrel — `MF_SHOOTABLE`, not "monster"');
    assert.equal(telefragged(layer, FAR_IMP), false, 'the imp a cell away is out of reach');
  });

  test('a solid decoration neither blocks the landing nor dies on it', () => {
    const { layer, lamp } = arena();

    // The floor lamp is `MF_SOLID` but not `MF_SHOOTABLE`, so `PIT_StompThing` skips it outright:
    // it is nothing to stomp, and nothing to be refused by either.
    assert.equal(layer.telefragAt(lamp, IMP_RADIUS, false), true, 'a lamp is not in the way');
    assert.equal(telefragged(layer, LAMP), false);
  });

  test('a non-stomping arrival is refused, and damages nothing on the way out', () => {
    const { layer, pad } = arena();

    assert.equal(layer.telefragAt(pad, IMP_RADIUS, false), false, 'the body on the pad blocks the landing');
    assert.equal(telefragged(layer, IMP), false, 'a refused landing kills nothing');
    assert.equal(telefragged(layer, BARREL), false);
  });

  test("an arriving player's stomp counts as its kills", () => {
    const { layer, kills, pad } = arena(true);

    assert.equal(layer.telefragAt(pad, IMP_RADIUS, true, targetOfSlot(1)), true);
    assert.deepEqual(kills, [1], 'the imp; a barrel is no kill');
  });

  test('the arriving body never stomps itself', () => {
    const { layer, away } = arena();

    assert.equal(layer.telefragAt(away, IMP_RADIUS, false, FAR_IMP), true, 'alone on its own spot');
    assert.equal(telefragged(layer, FAR_IMP), false);
  });
});

describe('Death · telefrag · which maps let a monster stomp', () => {
  test("map 30 only — `PIT_StompThing`'s own gamemap check", () => {
    assert.equal(monstersTelefrag('MAP30'), true);
    assert.equal(monstersTelefrag('MAP29'), false);
    assert.equal(monstersTelefrag('MAP01'), false);
    assert.equal(monstersTelefrag('E1M8'), false);
  });
});
