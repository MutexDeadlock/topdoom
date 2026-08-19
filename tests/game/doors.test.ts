import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap, addControlLine } from '../fixtures/gridmap.ts';
import { specialsRig, soundLog, TIC } from '../fixtures/specialsrig.ts';

/**
 * `EV_DoDoor` and `EV_VerticalDoor` (`p_doors.c`) — which trigger builds a new
 * door, which takes over the one already running, and which is refused.
 * See docs/specials.md § Retriggering a door.
 */
describe('specials · doors', () => {
  /**
   * Two cells at floor 0 / ceiling 128: the east one is the door, tagged 1 and
   * carrying the manual raise (1) on its own west edge, since `EV_VerticalDoor`
   * takes the line's *back* sector as its door. Every `special` passed becomes
   * a control line targeting the same tag, so a test names its triggers in the
   * order it wants to fire them. They are triggered directly — what is under
   * test is the door, not the crossing.
   */
  function rig(...specials: number[]) {
    const grid = gridMap(['..']);
    const { map } = grid;
    const door = grid.index(1, 0);
    map.sectors[door].tag = 1;
    const useLine = grid.westEdge(1, 0);
    map.linedefs[useLine].special = 1;
    assert.equal(map.sidedefs[map.linedefs[useLine].left].sector, door, 'the manual line’s back sector is the door');
    const lines = specials.map((special) => {
      addControlLine(map, 64, 0, special, 1);
      return map.linedefs.length - 1;
    });
    const { sfx, played } = soundLog();
    const r = specialsRig(map, grid.centre(0, 0), { sfx });
    const s = r.specials as unknown as {
      trigger(lineIndex: number, keys: Set<never>): unknown;
      ceilingMovers: Map<number, { state: string }>;
    };
    /** Run `seconds` of tics at the rate `game.ts` drives specials at. */
    const run = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / TIC); i++) r.tick();
    };
    return {
      useLine,
      /** Swap the manual line's number, for a test about which manual doors reverse a moving one. */
      setUseSpecial: (special: number) => {
        map.linedefs[useLine].special = special;
      },
      lines,
      played,
      run,
      trigger: (lineIndex: number) => s.trigger(lineIndex, new Set()),
      ceil: () => map.sectors[door].ceilHeight,
      state: () => s.ceilingMovers.get(door)?.state,
    };
  }

  /**
   * `EV_DoDoor`'s `close`/`blazeClose` set `direction = -1` at trigger time —
   * a closing door heads straight for the floor, and never stops at the open
   * height on the way.
   */
  test('a close line closes straight away, with no stop at the open height', () => {
    const d = rig(50); // S1 close
    d.trigger(d.lines[0]);
    d.run(0.5);
    assert.ok(d.ceil() < 128, `the ceiling is already coming down, not waiting (${d.ceil()})`);
    assert.equal(d.state(), 'lowering');
    d.run(3);
    assert.equal(d.ceil(), 0, 'shut');
    assert.equal(d.state(), 'closed');
  });

  /**
   * The EPIC.WAD MAP01 soft-lock: 1148 (W1 blazing close) shuts sector 168,
   * then 1166 (S1 open-stay) reopens it. Reusing the spent close's record left
   * the reopened door carrying `closeOnly`, so it went to the top, waited out
   * `DOOR_WAIT` and shut again over whoever had walked through.
   */
  test('an open-stay line reopens a shut door for good, not on the old trigger’s terms', () => {
    const d = rig(110, 103); // W1 blazing close, then S1 open stay
    d.trigger(d.lines[0]);
    d.run(4);
    assert.equal(d.ceil(), 0, 'shut by the close line');
    d.trigger(d.lines[1]);
    d.run(4);
    assert.equal(d.ceil(), 124, 'open, at lowestNeighborCeiling - 4');
    d.run(10);
    assert.equal(d.ceil(), 124, 'and still open well past DOOR_WAIT');
  });

  /** The same, the other way round: the door adopts each trigger's own speed. */
  test('a rebuilt door runs at the new line’s speed, not the spent one’s', () => {
    const d = rig(103, 113); // S1 open stay (normal), then S1 blazing close
    d.trigger(d.lines[0]);
    d.run(4);
    assert.equal(d.ceil(), 124);
    d.trigger(d.lines[1]);
    d.run(0.5);
    // 124 units in half a second is the blaze speed (4x VDOORSPEED); at the
    // open line's own speed the door would still be at 89.
    assert.equal(d.ceil(), 0, 'shut at the close line’s speed');
  });

  /**
   * `EV_DoDoor` skips a sector whose ceiling mover is still running
   * (`if (sec->specialdata) continue;`) and reports nothing, so the S1 switch
   * is neither flipped nor spent and works once the door has settled.
   */
  test('a tagged line does nothing to a door still moving, and stays unspent', () => {
    const d = rig(50, 103); // S1 close, S1 open stay
    d.trigger(d.lines[0]);
    d.run(0.5);
    const mid = d.ceil();
    d.trigger(d.lines[1]);
    d.run(0.2);
    assert.ok(d.ceil() < mid, 'the open line did not interrupt the close');
    d.run(4);
    assert.equal(d.ceil(), 0, 'the door finished closing');
    d.trigger(d.lines[1]);
    d.run(4);
    assert.equal(d.ceil(), 124, 'and the switch still had its one use left');
  });

  /**
   * `EV_VerticalDoor`'s reuse branch: a door on its way down goes back up
   * (`if (door->direction == -1) outval = 1;`), and it is silent — vanilla
   * returns before the sound switch.
   */
  test('a manual door reverses mid-close, without a sound', () => {
    const d = rig(42); // SR close, to get it moving down first
    d.trigger(d.lines[0]);
    d.run(0.5);
    assert.equal(d.state(), 'lowering');
    d.played.length = 0;
    d.trigger(d.useLine);
    assert.equal(d.state(), 'raising', 'the manual door went back up');
    assert.deepEqual(d.played, [], 'the reversal is silent');
  });

  /**
   * The other half of the same branch (`else if (player) outval = -1;`): a
   * press on a door waiting at the top shuts it there and then, rather than
   * restarting its wait — shutting the door behind you.
   */
  test('a manual door waiting at the top closes on the next press', () => {
    const d = rig();
    d.trigger(d.useLine);
    d.run(3);
    assert.equal(d.state(), 'hold', 'open, waiting out DOOR_WAIT');
    d.played.length = 0;
    d.trigger(d.useLine);
    assert.equal(d.state(), 'lowering', 'closing on the press');
    assert.deepEqual(d.played, [], 'and silently, like the reversal');
    d.run(3);
    assert.equal(d.ceil(), 0, 'shut');
  });

  /** A door still *rising* reverses on the same press, being direction 1 rather than -1. */
  test('a manual door closes on a press while it is still rising', () => {
    const d = rig(42);
    d.trigger(d.lines[0]); // shut it first, so the rise is a real one
    d.run(3);
    assert.equal(d.state(), 'closed');
    d.trigger(d.useLine);
    d.run(0.5);
    assert.equal(d.state(), 'raising');
    d.trigger(d.useLine);
    assert.equal(d.state(), 'lowering');
  });

  /**
   * Boom narrowed that branch to the five literal numbers, so a **generalized**
   * Push door does not take over a door in motion even though it is `manual`
   * and open-wait-close like the ones that do. 0x3C0F is PushMany + normal
   * speed + OdC kind — `manual`, `'openClose'`, and no `reverseWhenMoving`.
   */
  test('a generalized manual door leaves a door still moving alone', () => {
    const d = rig(42);
    d.setUseSpecial(0x3c0f);
    d.trigger(d.lines[0]);
    d.run(0.5);
    assert.equal(d.state(), 'lowering');
    const mid = d.ceil();
    d.trigger(d.useLine);
    d.run(0.2);
    assert.equal(d.state(), 'lowering', 'the press did not reverse it');
    assert.ok(d.ceil() < mid, 'it just kept closing');
  });
});
