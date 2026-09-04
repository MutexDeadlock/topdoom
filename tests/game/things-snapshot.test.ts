import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { MONSTER_FIELD_DEFAULTS } from '../../src/game/snapshot.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom, getRandomCursors, setRandomCursors } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { changedThing, savedThing } from '../fixtures/snapshot.ts';

/**
 * The thing layer's savegame round-trip: a snapshot rebuilt through
 * `buildThingSprites`' restore parameter must both *look* the same (every
 * field, in `posed` order) and *behave* the same (lockstep AI stepping with the
 * RNG cursors restored). See docs/savegames.md § Apply order.
 */

/** An arena with two imps, a demon, a barrel and a stimpack. */
function arena() {
  const grid = gridMap(['######', '#....#', '#....#', '######'], { cell: 128 });
  const map = grid.map;
  map.things.push(
    thingAt(grid, 1, 1, 1), // player start
    thingAt(grid, 2, 1, ThingType.imp),
    thingAt(grid, 3, 1, ThingType.imp),
    thingAt(grid, 2, 2, ThingType.demon),
    thingAt(grid, 3, 2, ThingType.barrel),
    thingAt(grid, 4, 1, ThingType.stimpack),
  );
  const world = new World(map);
  return { grid, map, world };
}

const build = (world: World) => buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });

describe('Savegames · things round-trip', () => {
  test('a battle-scarred layer restores field for field and steps identically', () => {
    clearRandom();
    const { grid, world } = arena();
    const layer = build(world);
    assert.equal(layer.count, 5, 'everything but the player start spawned');

    const player: Pos3 = { ...grid.centre(1, 1), z: 0 };
    // Wound one imp (wakes it and rolls pain/homing dice), kill the other, and
    // consume the stimpack, so the save holds an alerted monster, a corpse
    // mid-death-animation and a picked item all at once.
    layer.damage(0, 20, { from: player });
    layer.damage(1, 1000);
    layer.update(DOOM_TIC, player);
    const at = { ...grid.centre(4, 1), z: 0 };
    layer.tryPickup(at, at, 24, (type) => type === ThingType.stimpack);
    for (let i = 0; i < 10; i++) layer.update(DOOM_TIC, player);

    const saved = JSON.parse(JSON.stringify(layer.snapshot()));
    const cursors = getRandomCursors();

    const fresh = arena();
    const restored = buildThingSprites(fresh.world, { bank: BANK, materials: MATERIALS, skill: 3, restore: saved });
    setRandomCursors(cursors);
    assert.deepEqual(restored.snapshot(), layer.snapshot(), 'the rebuilt layer snapshots identically');
    assert.deepEqual(restored.stats, layer.stats);
    assert.equal(restored.monsterById(1), null, 'the corpse is still dead');
    assert.ok(restored.monsterById(0), 'the wounded imp is still alive');

    // Behavioral half: step the original from the save point, then rewind the
    // cursors and step the restored copy — every monster must land on exactly
    // the same spot, which is what the RNG-cursors-restored-last rule buys.
    const walk = (l: typeof layer) => {
      for (let i = 0; i < 35; i++) l.update(DOOM_TIC, player);
      return [0, 2, 3].map((id) => l.monsterById(id)).map((m) => (m ? [m.x, m.y, m.z, m.angle] : null));
    };
    setRandomCursors(cursors);
    const originalPath = walk(layer);
    const cursorsAfter = getRandomCursors();
    setRandomCursors(cursors);
    assert.deepEqual(walk(restored), originalPath, 'both layers walk the same path');
    assert.deepEqual(getRandomCursors(), cursorsAfter, 'and draw the same random numbers');
  });

  test('a save stores only the things the run moved on from, and re-spawns the rest', () => {
    clearRandom();
    const { grid, world } = arena();
    const layer = build(world);
    const player: Pos3 = { ...grid.centre(1, 1), z: 0 };

    assert.deepEqual(layer.snapshot().changed, [], 'nothing has happened yet');
    layer.damage(0, 20, { from: player });
    const at = { ...grid.centre(4, 1), z: 0 };
    layer.tryPickup(at, at, 24, (type) => type === ThingType.stimpack);
    for (let i = 0; i < 5; i++) layer.update(DOOM_TIC, player);

    const saved = JSON.parse(JSON.stringify(layer.snapshot()));
    assert.deepEqual(
      saved.changed.map(([id]: [number]) => id),
      [0, 4],
      'the wounded imp and the taken stimpack, and nothing else',
    );

    const fresh = arena();
    const restored = buildThingSprites(fresh.world, { bank: BANK, materials: MATERIALS, skill: 3, restore: saved });
    assert.deepEqual(restored.snapshot(), layer.snapshot(), 'the re-spawned layer matches, field for field');
    assert.deepEqual(restored.stats, layer.stats);
  });

  test('an undisturbed monster is not saved at all, and a scratched one brings its AI block', () => {
    clearRandom();
    const { world } = arena();
    const layer = build(world);
    assert.equal(savedThing(layer.snapshot(), 2), undefined, 'the untouched demon is not in the save');

    layer.damage(2, 5);
    assert.notEqual(changedThing(layer.snapshot(), 2).monster, undefined, 'one scratch and the block appears');
  });

  test('a disturbed monster saves only its off-default fields', () => {
    clearRandom();
    const { grid, world } = arena();
    const layer = build(world);
    const player = { ...grid.centre(1, 1), z: 0 };
    layer.damage(0, 20, { from: player }); // wound one imp
    layer.damage(1, 1000); // gib the other

    const saved = layer.snapshot();
    const wounded = changedThing(saved, 0).monster!;
    assert.equal(wounded.health, MONSTER_HEALTH[ThingType.imp] - 20, 'damaged health is saved');
    assert.equal(wounded.alerted, true);
    assert.ok('homingBias' in wounded, 'the coin flip is always saved — its spawn default is a random draw');
    for (const key of ['deadTime', 'burstLeft', 'chargeTimer', 'targetId', 'movecount'] as const) {
      assert.ok(!(key in wounded), `default-valued ${key} is elided`);
    }
    assert.ok(!('dead' in wounded) && !('deathFrameCount' in wounded), 'the two derived fields are never saved');

    const corpse = changedThing(saved, 1).monster!;
    assert.ok(!('dead' in corpse), 'dead is derived from health on restore');
    assert.ok(corpse.health! <= 0, 'the overkill health the gib rule re-reads is intact');
  });

  test('a fully-populated pre-sparse monster block still restores the same', () => {
    clearRandom();
    const { grid, world } = arena();
    const layer = build(world);
    const player = { ...grid.centre(1, 1), z: 0 };
    layer.damage(0, 20, { from: player });
    layer.damage(1, 1000);
    layer.update(DOOM_TIC, player);
    const saved = JSON.parse(JSON.stringify(layer.snapshot()));
    const cursors = getRandomCursors();

    // Rewrite each sparse block the way the pre-sparse writer laid it out:
    // every key present, defaults included, plus the since-removed `dead` and
    // `deathFrameCount` (the latter deliberately stale to prove it is ignored).
    const padded = JSON.parse(JSON.stringify(saved));
    for (const [, t] of padded.changed) {
      if (!t.monster) continue;
      t.monster = {
        ...MONSTER_FIELD_DEFAULTS,
        health: MONSTER_HEALTH[t.type],
        angle: (t.facingDeg * Math.PI) / 180,
        dead: false,
        deathFrameCount: 99,
        ...t.monster,
      };
      t.monster.dead = t.monster.health <= 0;
    }

    const fresh = arena();
    const restored = buildThingSprites(fresh.world, { bank: BANK, materials: MATERIALS, skill: 3, restore: padded });
    setRandomCursors(cursors);
    assert.deepEqual(restored.snapshot(), saved, 'the padded block round-trips to the same sparse snapshot');
    assert.equal(restored.monsterById(1), null, 'the corpse is still dead');
    assert.ok(restored.monsterById(0), 'the wounded imp is still alive');
  });

  test('the same in-memory snapshot restores identically however often it is applied', () => {
    // What `R` after a death does: `Game.savedState` is one snapshot object,
    // re-applied on every death of that level, so the restore must treat it as
    // read-only (docs/savegames.md § Apply order, docs/death.md § Player death).
    clearRandom();
    const { grid, world } = arena();
    const layer = build(world);
    const player: Pos3 = { ...grid.centre(1, 1), z: 0 };
    layer.damage(0, 20, { from: player });
    layer.damage(1, 1000);
    for (let i = 0; i < 10; i++) layer.update(DOOM_TIC, player);

    // Deliberately *not* JSON round-tripped: this is the live object, the way
    // a savegame held in memory is handed back to `loadMapByIndex`.
    const saved = layer.snapshot();
    const cursors = getRandomCursors();

    const first = arena();
    const once = buildThingSprites(first.world, { bank: BANK, materials: MATERIALS, skill: 3, restore: saved });
    setRandomCursors(cursors);
    const afterFirst = once.snapshot();
    // Run the restored level on, which is what would corrupt a snapshot the
    // restore had kept a reference into.
    for (let i = 0; i < 35; i++) once.update(DOOM_TIC, player);
    once.damage(2, 30, { from: player });

    const second = arena();
    const twice = buildThingSprites(second.world, { bank: BANK, materials: MATERIALS, skill: 3, restore: saved });
    setRandomCursors(cursors);
    assert.deepEqual(twice.snapshot(), afterFirst, 'the second restore lands on the same state as the first');
  });

  test('a save naming a type this WAD set cannot draw refuses to restore', () => {
    clearRandom();
    const { world } = arena();
    const saved = build(world).snapshot();
    // Past the spawn count, so the restore has to push it rather than find it on the map — which
    // is the only way a save can name a type at all now that the map's own things come from the map.
    saved.changed.push([99, { type: 99999, x: 0, y: 0, z: 0, facingDeg: 0 }]);
    const fresh = arena();
    assert.throws(
      () => buildThingSprites(fresh.world, { bank: BANK, materials: MATERIALS, skill: 3, restore: saved }),
      /no art for thing 99999/,
    );
  });
});
