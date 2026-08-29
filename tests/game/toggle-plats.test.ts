import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, NO_INPUT, TIC } from '../fixtures/specialsrig.ts';
import type { SpecialsSnapshot } from '../../src/game/snapshot.ts';

/**
 * Boom's instant toggle plats, 211 (SR) and 212 (WR) — `EV_DoPlat(toggleUpDn)`.
 * See docs/specials.md § Toggle plats.
 */
describe('specials · toggle plats', () => {
  /**
   * One tagged cell whose floor starts at 0 and ceiling at 128, with the
   * toggle on its west edge. The special is triggered directly: what is under
   * test is the plat, not the crossing.
   */
  function rig(special: number) {
    const grid = gridMap(['a.'], { heights: { a: { floor: 64, ceil: 128 } } });
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = special;
    map.linedefs[line].tag = 1;
    map.sectors[1].tag = 1;
    const r = specialsRig(map, grid.centre(1, 0));
    const s = r.specials as unknown as {
      trigger(lineIndex: number, keys: Set<never>): unknown;
      floorMovers: Map<number, { state: string; instant?: boolean; crush?: boolean }>;
      snapshot(): SpecialsSnapshot;
      restore(snapshot: SpecialsSnapshot): void;
    };
    /** Trigger, then one tic — the stroke completes inside that tic. */
    const press = () => {
      s.trigger(line, new Set());
      r.specials.update(TIC, { x: 0, y: 0, angle: 0 }, NO_INPUT, new Set());
    };
    return { map, rig: r, s, line, press, ceil: map.sectors[1].ceilHeight, floor: map.sectors[1].floorHeight };
  }

  test('the first press seals the sector within one tic', () => {
    const { map, press, ceil, floor } = rig(212);
    assert.equal(map.sectors[1].floorHeight, floor);
    press();
    assert.equal(map.sectors[1].floorHeight, ceil, 'floor snapped up to the ceiling');
  });

  test('the second press puts it straight back', () => {
    const { map, press, ceil, floor } = rig(212);
    press();
    assert.equal(map.sectors[1].floorHeight, ceil);
    press();
    assert.equal(map.sectors[1].floorHeight, floor, 'back to where it started');
    press();
    assert.equal(map.sectors[1].floorHeight, ceil, 'and up again — it toggles forever');
  });

  test('it parks in stasis between presses, and stays put until the next one', () => {
    const { map, rig: r, s, press, ceil } = rig(212);
    press();
    assert.equal(s.floorMovers.get(1)?.state, 'stasis');
    for (let i = 0; i < 100; i++) r.specials.update(TIC, { x: 0, y: 0, angle: 0 }, NO_INPUT, new Set());
    assert.equal(map.sectors[1].floorHeight, ceil, 'still sealed after three seconds of ticks');
  });

  /**
   * `EV_DoPlat` sets `rtn = 1` unconditionally for `toggleUpDn`, before the
   * per-sector loop — unlike `perpetualRaise`, whose stasis wake reports
   * nothing. So an SR switch flips on every press, including the wakes.
   */
  test('waking a parked toggle counts as a hit, unlike waking a perpetual lift', () => {
    const toggle = rig(211);
    const lift = (r: ReturnType<typeof rig>, target: string) =>
      (r.rig.specials as unknown as { triggerLift(i: number, e: unknown): boolean }).triggerLift(1, {
        kind: 'lift',
        speed: 1,
        waitSeconds: 1,
        target,
      });
    toggle.press(); // now parked in stasis
    assert.equal(lift(toggle, 'toggle'), true, 'the toggle wake reports a hit');

    // The perpetual family's own wake, for contrast: it reports nothing,
    // because vanilla's stasis never cleared the sector's specialdata.
    const perpetual = rig(87);
    perpetual.press();
    (perpetual.s.floorMovers.get(1) as { state: string }).state = 'stasis';
    assert.equal(lift(perpetual, 'perpetual'), false, 'the perpetual wake reports nothing');
  });

  test('the mover carries its instant and crush flags', () => {
    const { s, press } = rig(212);
    press();
    const mover = s.floorMovers.get(1)!;
    assert.equal(mover.instant, true);
    assert.equal(mover.crush, true, 'toggleUpDn is the one plat type that sets plat->crush');
  });

  test('a toggle parked in stasis survives a save and reverses correctly after', () => {
    const { map, s, press, ceil, floor } = rig(212);
    press();
    assert.equal(map.sectors[1].floorHeight, ceil);
    const saved = s.snapshot();
    s.restore(saved);
    assert.equal(s.floorMovers.get(1)?.state, 'stasis', 'restored still parked');
    press();
    assert.equal(map.sectors[1].floorHeight, floor, 'and reverses from the direction it remembered');
  });
});
