import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Skill } from '../../src/game/skill.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { stepFor } from '../fixtures/tics.ts';

/**
 * Nightmare's respawning monsters: `P_MobjThinker`'s respawn branch and `P_NightmareRespawn`
 * (`p_mobj.c`). See docs/monster-ai.md § Respawning monsters.
 */

/** A wide open room with one imp in it, and the player far enough east to be worth walking toward. */
function arena(skill: Skill, fogs: [Pos3, Pos3][] = []) {
  const grid = gridMap(['##########', '#........#', '##########'], { cell: 128 });
  const map = grid.map;
  map.things.push(thingAt(grid, 1, 1, 1), thingAt(grid, 2, 1, ThingType.imp));
  const world = new World(map);
  const layer = buildThingSprites(world, {
    bank: BANK,
    materials: MATERIALS,
    skill,
    onRespawn: (from, to) => fogs.push([{ ...from }, { ...to }]),
  });
  return { grid, map, world, layer, player: { ...grid.centre(8, 1), z: 0 } };
}

/** The imp's saved state. It is `posed` index 0: the player start is not a thing that spawns. */
const IMP_ID = 0;
const imp = (layer: ReturnType<typeof arena>['layer']) => layer.snapshot().things[IMP_ID];

/**
 * Whether the imp is alive, read off the sparse block: once it has respawned its health is back at
 * the spawn default and so is *elided* from the save — an absent `health` means a healthy monster,
 * not a dead one (docs/savegames.md § The format and its version).
 */
const alive = (layer: ReturnType<typeof arena>['layer']) =>
  (imp(layer).monster?.health ?? MONSTER_HEALTH[ThingType.imp]) > 0;

/** Runs `seconds` of simulation at the fixed tic, stopping early once `done` holds. */
function run(layer: ReturnType<typeof arena>['layer'], player: Pos3, seconds: number, done?: () => boolean): number {
  return stepFor(seconds, () => layer.update(DOOM_TIC, player), done);
}

describe('Monster AI · nightmare respawn', () => {
  test('a corpse comes back at its spawn point, not where it fell', () => {
    clearRandom();
    const fogs: [Pos3, Pos3][] = [];
    const { layer, player } = arena(5, fogs);
    const spawn = { x: imp(layer).x, y: imp(layer).y };

    // Let it wake and walk a good way toward the player before killing it, so the spot it dies on
    // is nowhere near the spot it started on.
    run(layer, player, 4);
    const walked = { x: imp(layer).x, y: imp(layer).y };
    assert.ok(Math.hypot(walked.x - spawn.x, walked.y - spawn.y) > 64, 'the imp actually moved');

    layer.damage(IMP_ID, MONSTER_HEALTH[ThingType.imp]);
    assert.equal(alive(layer), false, 'dead');
    assert.equal(imp(layer).monster?.spawnX, spawn.x, 'the spawn point rides along with the corpse');

    const waited = run(layer, player, 300, () => alive(layer));
    assert.ok(waited < 300, 'it came back inside five minutes');
    assert.ok(waited >= 12, `vanilla waits 12*35 tics before even rolling (waited ${waited.toFixed(2)}s)`);

    const back = imp(layer);
    assert.equal(back.x, spawn.x, 'back at the spawn point');
    assert.equal(back.y, spawn.y);
    assert.equal(back.monster?.health, undefined, 'at full health, so the save elides it again');
    // `alerted` is a `MONSTER_FIELD_DEFAULTS` key: absent from the sparse block means false.
    assert.notEqual(back.monster?.alerted, true, 'dormant again, not still chasing');

    assert.equal(fogs.length, 1, 'one respawn, one pair of teleport fogs');
    const [from, to] = fogs[0];
    assert.equal(Math.round(from.x), Math.round(walked.x), 'a fog where the corpse lay');
    assert.equal(to.x, spawn.x, 'and one where it reappears');
  });

  test('on any other skill the corpse stays down', () => {
    for (const skill of [1, 3, 4] as Skill[]) {
      clearRandom();
      const { layer, player } = arena(skill);
      run(layer, player, 4);
      layer.damage(IMP_ID, MONSTER_HEALTH[ThingType.imp]);
      run(layer, player, 300);
      assert.equal(alive(layer), false, `skill ${skill} does not respawn`);
    }
  });

  test('the spawn point survives a savegame round-trip', () => {
    clearRandom();
    const { layer, player, world } = arena(5);
    const spawn = { x: imp(layer).x, y: imp(layer).y };
    run(layer, player, 4);
    layer.damage(IMP_ID, MONSTER_HEALTH[ThingType.imp]);

    const saved = layer.snapshot();
    const restored = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 5, restore: saved });
    // The imp walked east, so only `spawnX` differs from where it lies and only `spawnX` is
    // written; `spawnY` is elided and stands for the saved `y`, which is still the spawn row.
    assert.equal(imp(restored).monster?.spawnX, spawn.x);
    assert.equal(imp(restored).monster?.spawnY ?? imp(restored).y, spawn.y);

    const waited = run(restored, player, 300, () => alive(restored));
    assert.ok(waited < 300, 'a restored corpse still respawns');
    assert.equal(imp(restored).x, spawn.x, 'and still at the point the map placed it');
  });

  test('a thing that never moved carries no spawn fields at all', () => {
    clearRandom();
    const { layer } = arena(5);
    // Nothing has run, so the imp sits exactly where the map put it — the elision baseline.
    assert.equal(imp(layer).monster, undefined, 'a pristine monster needs no block whatsoever');
  });
});
