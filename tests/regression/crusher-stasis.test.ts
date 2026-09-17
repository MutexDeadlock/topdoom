import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CRUSH_SLOWDOWN, CRUSHER_SPEED } from '../../src/game/specials/defs.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { SpecialsController } from '../../src/game/specials.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, type SpecialsRigOptions } from '../fixtures/specialsrig.ts';

/**
 * Two rules the crusher keeps, both confirmed against `linuxdoom-1.10` rather than the wiki:
 *
 * - `T_MoveCeiling` grinds at `CEILSPEED / 8` for as long as it is crushing something, so a body
 *   under it takes a whole cycle's damage rather than an eighth of one. A Hell Knight survived
 *   MAP06's crusher for four cycles instead of one.
 * - `EV_CeilingCrushStop` saves `olddirection` and `P_ActivateInStasisCeiling` restores it, so a
 *   crusher frozen on its way up resumes *upward*.
 *
 * The switch half of the pair this file was split out of is `switch-gating.test.ts`.
 * See docs/specials-crushers.md § Crushers.
 */

/**
 * The controller as these tests drive it: `update` picked off the class so its signature is never
 * re-declared here, plus the members that have no outside face — which slot the mover landed in,
 * and whether a stasis wake reported a hit. `SpecialsController &` will not do: TS treats private
 * members nominally, so intersecting over them yields `never`.
 */
type CrusherProbe = Pick<SpecialsController, 'update'> & {
  triggerCrusherStop(sector: number): boolean;
  triggerCrusher(sector: number, effect: unknown): boolean;
  ceilingMovers: Map<number, { state: string; stoppedFrom?: string; slowed?: boolean }>;
};

/** Special 49: S1 ceiling crush and raise, the one both tests below trigger. */
const CRUSH_AND_RAISE = 49;

/**
 * A room with a crusher in the cell beside it, its special on the boundary between the two, and
 * the player standing in the room.
 */
function crusherRoom(ceil: number, options: SpecialsRigOptions = {}) {
  const grid = gridMap(['####', '#..#', '####'], { heights: { '.': { floor: 0, ceil } } });
  const { map } = grid;
  const crush = grid.index(2, 1);
  map.sectors[crush].tag = 1;
  const line = grid.edgeBetween(grid.index(1, 1), crush);
  map.linedefs[line].special = CRUSH_AND_RAISE;
  map.linedefs[line].tag = 1;

  const rig = specialsRig(map, grid.centre(1, 1), options);
  const probe = rig.specials as unknown as CrusherProbe;
  return {
    map,
    crush,
    rig,
    probe,
    start: () => rig.trigger(line),
    tick: () => rig.tick(),
    mover: () => probe.ceilingMovers.get(crush)!,
    ceilHeight: () => map.sectors[crush].ceilHeight,
  };
}

describe('Regressions · crusher speed and stasis', () => {
  test('a crusher grinds at an eighth speed while it is crushing something', () => {
    // `caught` stands in for a body under the ceiling; the controller only ever
    // learns about one through this callback.
    let damageTics = 0;
    const room = crusherRoom(256, {
      onCrush: (_s, dealDamage) => {
        if (dealDamage) damageTics++;
        return true;
      },
    });
    room.start();

    // One tic at full speed, then the first crush report slows it.
    room.tick();
    const afterFirst = room.ceilHeight();
    room.tick();
    const slowStep = afterFirst - room.ceilHeight();
    assert.equal(room.mover().slowed, true, 'a crush report slows the descent');
    const slowed = (CRUSHER_SPEED / CRUSH_SLOWDOWN) * DOOM_TIC;
    assert.ok(Math.abs(slowStep - slowed) < 1e-6, `the slowed step is an eighth of CEILSPEED, got ${slowStep}`);

    // Run to the bottom; the slowdown is cleared there, so the way up is full speed.
    for (let i = 0; i < 20000 && room.mover().state === 'lowering'; i++) room.tick();
    assert.equal(room.mover().slowed, false, 'reaching the bottom restores full speed');
    const beforeUp = room.ceilHeight();
    room.tick();
    assert.ok(
      Math.abs(room.ceilHeight() - beforeUp - CRUSHER_SPEED * DOOM_TIC) < 1e-6,
      'the up-stroke runs at the full 1 unit per tic',
    );
    assert.ok(damageTics > 0, 'and damage was dealt on the way down');
  });

  test('a crusher frozen on its way up resumes upward, not downward', () => {
    const room = crusherRoom(128);
    room.start();
    // Read through accessors, not a captured `mover`: `assert/strict`'s `equal`
    // carries an `asserts actual is T` signature, so asserting on a captured
    // field pins its type to that literal for the rest of the test.
    const state = () => room.mover().state;
    const stoppedFrom = () => room.mover().stoppedFrom;
    assert.equal(state(), 'lowering');

    // Run to the bottom and into the up-stroke.
    for (let i = 0; i < 2000 && state() !== 'raising'; i++) room.tick();
    assert.equal(state(), 'raising', 'the crusher reversed at the bottom');
    const frozenAt = room.ceilHeight();

    assert.equal(room.probe.triggerCrusherStop(room.crush), true, 'stopping a running crusher is a hit');
    assert.equal(state(), 'stopped');
    assert.equal(stoppedFrom(), 'raising', 'the direction is remembered — vanilla olddirection');

    for (let i = 0; i < 35; i++) room.tick();
    assert.equal(room.ceilHeight(), frozenAt, 'in stasis it does not move at all');

    // A second stop is not a hit: vanilla's own `direction != 0` guard.
    assert.equal(room.probe.triggerCrusherStop(room.crush), false);

    // Restarting resumes the up-stroke, and reports rtn 0 — stasis never cleared
    // specialdata, so EV_DoCeiling's loop skips the sector.
    const restarted = room.probe.triggerCrusher(room.crush, { kind: 'crusher', speed: CRUSHER_SPEED, silent: false });
    assert.equal(restarted, false, 'reactivating an in-stasis crusher is not a fresh thinker');
    assert.equal(state(), 'raising', 'it resumes upward, not back down');

    room.tick();
    assert.ok(room.ceilHeight() > frozenAt, 'and actually moves up');
  });
});
