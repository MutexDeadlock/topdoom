import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGeneralized, isGeneralized } from '../../src/game/specials/generalized.ts';
import { lookupSpecial } from '../../src/game/specials/tables.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, NO_INPUT, USE_INPUT, TIC } from '../fixtures/specialsrig.ts';

/**
 * Boom's generalized linedef bitfields (p_spec.h masks, p_genlin.c semantics),
 * decoded into SpecialDefs and run end-to-end through the controller.
 * Worked examples are hand-assembled from the field layout.
 * See docs/specials.md § Generalized linedefs.
 */
describe('specials · generalized decode', () => {
  test('the range boundaries', () => {
    assert.equal(decodeGeneralized(0x2f7f), null);
    assert.notEqual(decodeGeneralized(0x2f80), null);
    assert.notEqual(decodeGeneralized(0x7fff), null);
    assert.equal(decodeGeneralized(0x8000), null);
    assert.ok(isGeneralized(0x2f80) && !isGeneralized(0x2f7f) && !isGeneralized(0x8000));
  });

  test('SR fast open-wait-close door: 0x3D13', () => {
    // GenDoorBase | SwitchMany(3) | SpeedFast(2<<3) | OdC(0<<5) | delay VDOORWAIT(1<<8)
    const def = decodeGeneralized(0x3d13)!;
    assert.deepEqual(
      { trigger: def.trigger, repeatable: def.repeatable, effect: def.effect },
      {
        trigger: 'use',
        repeatable: true,
        effect: { kind: 'door', speed: 280, waitSeconds: 150 * DOOM_TIC, mode: 'openClose', closeWaitSeconds: undefined },
      },
    );
  });

  test('W1 slow crushing floor to next-higher, numeric type-copy change: 0x7D60', () => {
    // GenFloorBase | WalkOnce(0) | SpeedSlow(0) | numeric model (0x20) | up (0x40)
    // | FtoNnF(2<<7) | FChgTyp(3<<10) | crush (0x1000)
    const def = decodeGeneralized(0x7d60)!;
    assert.equal(def.trigger, 'walk');
    assert.equal(def.repeatable, false);
    assert.equal(def.monsterActivate, false, 'model bit is not "allow monsters" once a change is set');
    assert.deepEqual(def.effect, {
      kind: 'floor',
      speed: 35,
      target: 'nextHigherFloor',
      changeTexture: false,
      crush: true,
      change: { model: 'numeric', type: 'texAndType' },
    });
  });

  test('generalized locked doors: any/all/slot/color lock shapes', () => {
    // S1 slow locked door, AllKeys(7<<6), skulls distinct
    assert.deepEqual(decodeGeneralized(0x3800 | 2 | (7 << 6))!.lock, { kind: 'all', colorsSuffice: false });
    // same with the skulls-are-cards bit
    assert.deepEqual(decodeGeneralized(0x3800 | 2 | (7 << 6) | 0x200)!.lock, { kind: 'all', colorsSuffice: true });
    // RSkull(4<<6) exact vs color
    assert.deepEqual(decodeGeneralized(0x3800 | 2 | (4 << 6))!.lock, { kind: 'slot', slot: 'redSkull' });
    assert.deepEqual(decodeGeneralized(0x3800 | 2 | (4 << 6) | 0x200)!.lock, { kind: 'color', color: 'red' });
    // AnyKey
    assert.deepEqual(decodeGeneralized(0x3800 | 2)!.lock, { kind: 'any' });
    // never monster-activatable
    assert.notEqual(decodeGeneralized(0x3800 | 2)!.monsterActivate, true);
  });

  test('gen lift, stairs and crusher fields', () => {
    // WR turbo perpetual lift, monsters allowed, 5s delay:
    // GenLiftBase | WalkMany(1) | SpeedTurbo(3<<3) | monster(0x20) | delay 5s(2<<6) | LnF2HnF(3<<8)
    const lift = decodeGeneralized(0x3400 | 1 | (3 << 3) | 0x20 | (2 << 6) | (3 << 8))!;
    assert.equal(lift.monsterActivate, true);
    assert.deepEqual(lift.effect, { kind: 'lift', speed: 560, waitSeconds: 5, target: 'perpetual' });

    // W1 fast 16-unit stairs building down, ignoring texture
    const stairs = decodeGeneralized(0x3000 | (2 << 3) | (2 << 6) | 0x200)!;
    assert.deepEqual(stairs.effect, { kind: 'stairs', speed: 70, stepHeight: 16, direction: 'down', ignoreTexture: true });

    // SR slow silent crusher: slow tier slows when crushing, and is *fully* silent
    const crusher = decodeGeneralized(0x2f80 | 3 | 0x40)!;
    assert.deepEqual(crusher.effect, {
      kind: 'crusher',
      speed: 35,
      silent: true,
      slowsWhenCrushing: true,
      noEndClack: true,
    });
    // turbo tier never slows
    const turbo = decodeGeneralized(0x2f80 | 3 | (3 << 3))!;
    assert.equal(turbo.effect.kind === 'crusher' && turbo.effect.slowsWhenCrushing, false);
  });

  test('lookupSpecial memoizes decoded numbers and leaves vanilla alone', () => {
    assert.equal(lookupSpecial(0x3d13), lookupSpecial(0x3d13));
    assert.equal(lookupSpecial(1)?.manual, true);
    assert.equal(lookupSpecial(0x2f7f), null);
  });
});

describe('specials · generalized end-to-end', () => {
  test('a Push (manual) generalized door opens its back sector', () => {
    const grid = gridMap(['.+'], { cell: 64 });
    const { map } = grid;
    map.linedefs[grid.westEdge(1, 0)].special = 0x3c00 | 6; // PushOnce slow OdC
    const rig = specialsRig(map, { x: 32, y: 32 });
    rig.specials.update(TIC, 32, 32, 0, USE_INPUT, new Set());
    for (let i = 0; i < 10; i++) rig.tick();
    assert.ok(map.sectors[1].ceilHeight > 0);
  });

  test('numeric-model change copies texture and type from the neighbor at the destination', () => {
    const grid = gridMap(['a.b'], {
      heights: { a: { floor: 64, ceil: 192 }, b: { floor: 32, ceil: 192 } },
    });
    const { map } = grid;
    map.sectors[2].floorTex = 'NUKAGE1';
    map.sectors[2].special = 7;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = 0x7d60; // W1 slow crush floor to NnF, numeric FChgTyp
    map.linedefs[line].tag = 1;
    map.sectors[1].tag = 1;
    const rig = specialsRig(map, grid.centre(0, 0));
    rig.specials.update(TIC, grid.centre(1, 0).x, grid.centre(1, 0).y, 0, NO_INPUT, new Set());
    for (let i = 0; i < 60; i++) rig.tick();
    assert.equal(map.sectors[1].floorHeight, 32, 'rose to the next higher floor');
    assert.equal(map.sectors[1].floorTex, 'NUKAGE1', 'copied the model neighbor floor flat on arrival');
    assert.equal(map.sectors[1].special, 7, 'copied the model neighbor special (FChgTyp)');
  });

  test('trigger-model change copies from the activating line front sector and zeroes the type', () => {
    const grid = gridMap(['..'], { heights: { '.': { floor: 0, ceil: 128 } } });
    const { map } = grid;
    map.sectors[0].floorTex = 'RROCK01';
    map.sectors[1].special = 5;
    const line = grid.westEdge(1, 0);
    // W1 slow floor up 24, trigger model, FChgZero
    map.linedefs[line].special = 0x6000 | (1 << 10) | (6 << 7) | 0x40;
    map.linedefs[line].tag = 2;
    map.sectors[1].tag = 2;
    const rig = specialsRig(map, grid.centre(0, 0));
    rig.specials.update(TIC, grid.centre(1, 0).x, grid.centre(1, 0).y, 0, NO_INPUT, new Set());
    for (let i = 0; i < 40; i++) rig.tick();
    assert.equal(map.sectors[1].floorHeight, 24);
    assert.equal(map.sectors[1].floorTex, 'RROCK01');
    assert.equal(map.sectors[1].special, 0, 'FChgZero clears the special on arrival');
  });

  test('a crushing generalized ceiling grinds down to the floor', () => {
    const grid = gridMap(['..']);
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = 0x4000 | (4 << 7) | 0x1000; // W1 slow crush ceiling to own floor
    map.linedefs[line].tag = 3;
    map.sectors[1].tag = 3;
    const rig = specialsRig(map, grid.centre(0, 0));
    rig.specials.update(TIC, grid.centre(1, 0).x, grid.centre(1, 0).y, 0, NO_INPUT, new Set());
    for (let i = 0; i < 200; i++) rig.tick();
    assert.equal(map.sectors[1].ceilHeight, 0);
  });

  test('retriggerable generalized stairs alternate direction without mutating the map', () => {
    const grid = gridMap(['...']);
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    const special = 0x3000 | 1 | (1 << 6) | 0x100; // WR slow 8-unit stairs, up
    map.linedefs[line].special = special;
    map.linedefs[line].tag = 4;
    map.sectors[0].tag = 4;
    const rig = specialsRig(map, grid.centre(0, 0));
    const cross = () => {
      rig.specials.update(TIC, grid.centre(0, 0).x, grid.centre(0, 0).y, 0, NO_INPUT, new Set());
      rig.specials.update(TIC, grid.centre(1, 0).x, grid.centre(1, 0).y, 0, NO_INPUT, new Set());
      for (let i = 0; i < 200; i++) rig.tick();
    };

    cross();
    assert.deepEqual(
      [map.sectors[0].floorHeight, map.sectors[1].floorHeight, map.sectors[2].floorHeight],
      [8, 16, 24],
      'built up along the chain',
    );
    // The authored number is the map's truth throughout; the flip is the
    // controller's own state, and rides the save.
    assert.equal(map.linedefs[line].special, special, 'the linedef itself is never mutated');
    assert.deepEqual(rig.specials.snapshot().stairFlips, [line], 'the flip rides the save');

    // The second activation builds *downward* — a fresh descending staircase
    // from the start sector's current height, not an undo of the first
    // (`EV_DoGenStairs` re-walks the chain accumulating `-stepHeight`).
    cross();
    assert.deepEqual(
      [map.sectors[0].floorHeight, map.sectors[1].floorHeight, map.sectors[2].floorHeight],
      [0, -8, -16],
      'the next activation builds the other way',
    );
    assert.deepEqual(rig.specials.snapshot().stairFlips, [], 'and flips back');
  });
});
