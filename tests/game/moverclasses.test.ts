import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, NO_INPUT, TIC } from '../fixtures/specialsrig.ts';
import type { Mover } from '../../src/game/specials.ts';
import type { SpecialsSnapshot } from '../../src/game/snapshot.ts';

/**
 * Boom's split of vanilla's one `sec->specialdata` into independent floor,
 * ceiling and lighting slots (`P_SectorActive`), and the three numbers that
 * only do their whole job because of it.
 * See docs/specials.md § One mover per sector.
 */
describe('Specials · mover classes', () => {
  /** Reaches the controller's two private slots, the way the crusher tests already do. */
  function slots(specials: unknown) {
    return specials as unknown as {
      floorMovers: Map<number, Mover>;
      ceilingMovers: Map<number, Mover>;
      lightStates: Map<number, unknown>;
      trigger(lineIndex: number, keys: Set<never>): unknown;
      snapshot(): SpecialsSnapshot;
      restore(s: SpecialsSnapshot): void;
    };
  }

  /**
   * Two cells: `a` is a raised neighbor, `.` (sector 1) is the tagged target.
   * The two lines carry `specialA`/`specialB`, both tag 1, and are triggered
   * directly — what is under test is the slot bookkeeping, not the crossing.
   */
  function rig(specialA: number, specialB: number) {
    const grid = gridMap(['a.'], { heights: { a: { floor: 64, ceil: 128 } } });
    const { map } = grid;
    const lineA = grid.westEdge(0, 0);
    const lineB = grid.westEdge(1, 0);
    map.linedefs[lineA].special = specialA;
    map.linedefs[lineA].tag = 1;
    map.linedefs[lineB].special = specialB;
    map.linedefs[lineB].tag = 1;
    map.sectors[1].tag = 1;
    const r = specialsRig(map, grid.centre(1, 0));
    return { map, rig: r, lineA, lineB, s: slots(r.specials) };
  }

  // 23 is S1 "lower floor to lowest" (floor slot), 41 is S1 "lower ceiling to
  // floor" (ceiling slot) — one probe per class, both tag-targeted.
  test('a floor and a ceiling run on one sector at the same time', () => {
    const { map, rig: r, lineA, lineB, s } = rig(23, 41);
    s.trigger(lineA, new Set());
    assert.equal(s.floorMovers.get(1)?.kind, 'floor', 'the floor slot took the 23');
    s.trigger(lineB, new Set());
    assert.equal(s.ceilingMovers.get(1)?.kind, 'ceiling', 'the ceiling slot took the 41 too');

    // Both actually move: a single slot would have refused the second outright.
    const start = { floor: map.sectors[1].floorHeight, ceil: map.sectors[1].ceilHeight };
    for (let i = 0; i < 20; i++) r.tick();
    assert.notEqual(map.sectors[1].floorHeight, start.floor, 'the floor-slot mover ticked');
    assert.notEqual(map.sectors[1].ceilHeight, start.ceil, 'the ceiling-slot mover ticked');
  });

  test('a running elevator claims both slots, so a ceiling trigger is still refused', () => {
    // 229 is S1 "raise elevator next floor" — the one mover that sets both
    // `floordata` and `ceilingdata` in vanilla.
    const { lineA, lineB, s } = rig(229, 41);
    s.trigger(lineA, new Set());
    assert.equal(s.floorMovers.get(1)?.kind, 'elevator', 'the elevator lives in the floor slot');
    s.trigger(lineB, new Set());
    assert.equal(s.ceilingMovers.get(1), undefined, 'the ceiling trigger found the sector busy');
  });

  test('a light strobe is gated on the lighting slot, not on whether a mover runs', () => {
    // 29 is an S1 door (ceiling slot); 17 starts a strobe. Vanilla's unified
    // `specialdata` refuses the strobe here, Boom's `lighting_special` allows it.
    const { lineA, lineB, s } = rig(29, 17);
    s.trigger(lineA, new Set());
    assert.ok(s.ceilingMovers.has(1), 'the door is running');
    assert.equal(s.lightStates.has(1), false, 'no light thinker on the sector yet');
    s.trigger(lineB, new Set());
    assert.ok(s.lightStates.has(1), 'the strobe started despite the door');
  });

  test('151 runs both of its halves', () => {
    const { lineA, s } = rig(151, 0);
    s.trigger(lineA, new Set());
    assert.equal(s.ceilingMovers.get(1)?.kind, 'ceiling', 'the ceiling half started');
    assert.equal(s.floorMovers.get(1)?.kind, 'floor', 'the floor half started too');
  });

  /**
   * 166/186 are `if (EV_DoCeiling(…) || EV_DoFloor(…))`, so C's short-circuit
   * skips the floor half entirely whenever the ceiling half took.
   */
  test('166 skips its floor half when the ceiling half succeeded', () => {
    const { lineA, s } = rig(166, 0);
    s.trigger(lineA, new Set());
    assert.equal(s.ceilingMovers.get(1)?.kind, 'ceiling', 'the ceiling half started');
    assert.equal(s.floorMovers.get(1), undefined, 'the floor half never ran');
  });

  /**
   * The savegame contract: a pre-split save put every kind in `movers`, so the
   * reader sorts on `mover.kind` rather than trusting which field it arrived in.
   */
  test('a save written before the split restores each mover into its own slot', () => {
    const { map, rig: r, lineA, lineB, s } = rig(23, 41);
    s.trigger(lineA, new Set());
    s.trigger(lineB, new Set());
    const saved = s.snapshot();
    assert.equal(saved.movers.length, 1, '`movers` carries the floor slot');
    assert.equal(saved.ceilingMovers?.length, 1, '`ceilingMovers` carries the ceiling slot');

    // Re-shape it the way a pre-split build wrote it: one flat list, no second field.
    const legacy: SpecialsSnapshot = { ...saved, movers: [...saved.movers, ...saved.ceilingMovers!] };
    delete legacy.ceilingMovers;
    s.restore(legacy);
    assert.equal(s.floorMovers.get(1)?.kind, 'floor', 'the floor mover landed in the floor slot');
    assert.equal(s.ceilingMovers.get(1)?.kind, 'ceiling', 'the ceiling mover in the ceiling slot');

    // And both still tick from there — `tickMovers` walks each map.
    const start = { floor: map.sectors[1].floorHeight, ceil: map.sectors[1].ceilHeight };
    for (let i = 0; i < 20; i++) r.specials.update(TIC, { x: 0, y: 0, angle: 0 }, NO_INPUT, new Set());
    assert.notEqual(map.sectors[1].floorHeight, start.floor, 'restored floor mover ticks');
    assert.notEqual(map.sectors[1].ceilHeight, start.ceil, 'restored ceiling mover ticks');
  });
});
