import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { specialsRig, crossingBody, TIC } from '../fixtures/specialsrig.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { lookupSpecial } from '../../src/game/specials/tables.ts';
import type { TeleportDest } from '../../src/game/specials.ts';

/**
 * Boom's silent (207-210, 268/269) and line-to-line (243/244, 262-267)
 * teleporters. What separates them from vanilla 39/97 is the *arrival*: no
 * fog, a rotation rather than an absolute facing, and a preserved height.
 * See docs/specials.md § Silent and line-to-line teleporters.
 */
describe('specials · silent teleporters', () => {
  /**
   * A corridor with a landing marker at cell 4, and the special on the west
   * edge of cell 2 — so walking east across it is a front-side crossing.
   * `markerAngle` is the marker's own facing, which a silent arrival rotates
   * *relative to* rather than adopting.
   */
  function thingRig(special: number, markerAngle = 0, options: { marker?: boolean } = {}) {
    const grid = gridMap(['#######', '#.....#', '#######']);
    const { map } = grid;
    const pad = grid.index(4, 1);
    map.sectors[pad].tag = 1;
    if (options.marker !== false) {
      map.things.push(thingAt(grid, 4, 1, ThingType.teleportDest, markerAngle));
    }
    const line = grid.westEdge(2, 1);
    map.linedefs[line].special = special;
    map.linedefs[line].tag = 1;

    const start = { x: grid.centre(1, 1).x, y: grid.centre(1, 1).y };
    const arrivals: TeleportDest[] = [];
    const rig = specialsRig(map, start, { onTeleport: (dest) => arrivals.push(dest) });
    return { grid, map, rig, arrivals, line, start, pad };
  }

  /**
   * Walks the player east across the special line at the given facing. The
   * first update seeds `prevX`/`prevY`, the second is the crossing.
   */
  function walkEast(rig: ReturnType<typeof thingRig>, facing = 0) {
    const { grid } = rig;
    const boundary = grid.centre(2, 1).x - grid.cell / 2;
    const y = grid.centre(1, 1).y;
    rig.rig.tick(TIC, boundary - 20, y, facing);
    rig.rig.tick(TIC, boundary + 20, y, facing);
  }

  test('a silent teleport reports itself silent; a vanilla one does not', () => {
    const silent = thingRig(207);
    walkEast(silent);
    assert.equal(silent.arrivals.length, 1, 'the silent line fired');
    assert.equal(silent.arrivals[0].silent, true);

    const loud = thingRig(39);
    walkEast(loud);
    assert.equal(loud.arrivals.length, 1, 'the vanilla line fired');
    assert.notEqual(loud.arrivals[0].silent, true, 'vanilla 39 still puffs and sounds');
    assert.equal(loud.arrivals[0].rotateBy, undefined, 'and sets an absolute facing, not a rotation');
  });

  /**
   * `EV_SilentTeleport`'s rotation is `srcLineAngle - markerAngle + 90°`, and
   * the right angle is why walking *perpendicularly* across the line comes out
   * along the marker's own direction.
   */
  test('a silent arrival rotates the body instead of aiming it at the marker', () => {
    // The crossed line is the vertical west edge; the grid winds it so its
    // heading is one of ±90°. Whatever it is, crossing it with the marker
    // pointing the same way must leave the body's facing shifted by exactly
    // the marker-relative right angle, not snapped to the marker.
    const rig = thingRig(207, 0);
    const facing = 0.5;
    walkEast(rig, facing);
    const dest = rig.arrivals[0];
    assert.ok(dest.rotateBy !== undefined, 'a rotation was reported');
    assert.ok(
      Math.abs(dest.angle - (facing + dest.rotateBy!)) < 1e-9,
      'the reported facing is the body facing turned by that rotation',
    );
    // Walking in at a different heading comes out at a correspondingly
    // different heading — the mark of a rotation rather than a snap.
    const other = thingRig(207, 0);
    walkEast(other, facing + 1);
    assert.ok(Math.abs(other.arrivals[0].angle - (dest.angle + 1)) < 1e-9);
  });

  test('the marker angle shifts the rotation, and the landing spot is the marker', () => {
    const a = thingRig(207, 0);
    walkEast(a);
    const b = thingRig(207, 90);
    walkEast(b);
    assert.ok(Math.abs((a.arrivals[0].rotateBy! - b.arrivals[0].rotateBy!) - Math.PI / 2) < 1e-9);
    assert.deepEqual(
      { x: a.arrivals[0].x, y: a.arrivals[0].y },
      a.grid.centre(4, 1),
      'still lands on the marker itself',
    );
  });

  test('268 is monster-only: a player crossing it does nothing at all', () => {
    const rig = thingRig(268);
    walkEast(rig);
    assert.equal(rig.arrivals.length, 0, 'the player is refused');
    // The same line under a monster does teleport it.
    const dest = rig.rig.specials.crossMonster(
      { x: rig.grid.centre(1, 1).x, y: rig.grid.centre(1, 1).y },
      crossingBody(rig.grid.centre(2, 1)),
      new Set(),
    );
    assert.ok(dest, 'a monster crosses it');
    assert.equal(dest!.silent, true);
  });

  /**
   * Boom clears `line->special` inside `if (EV_Silent…)`, unlike vanilla 39's
   * unconditional clear — so a W1 silent line that found no destination is
   * still live and fires once the destination exists.
   */
  test('a one-shot silent line that found no destination is not spent', () => {
    // Built with no landing marker at all, so the first crossing finds
    // nothing. (The marker is varied rather than the tag: the tag indexes are
    // memoized per map — docs/world.md § The tag indexes.)
    const rig = thingRig(207, 0, { marker: false });
    walkEast(rig);
    assert.equal(rig.arrivals.length, 0, 'nothing to teleport to');
    rig.map.things.push(thingAt(rig.grid, 4, 1, ThingType.teleportDest));
    walkEast(rig);
    assert.equal(rig.arrivals.length, 1, 'the line survived the failed crossing');
    // And now it really is spent — a W1 fires exactly once.
    walkEast(rig);
    assert.equal(rig.arrivals.length, 1, 'a successful crossing does spend it');
  });

  test('the deferred set no longer claims the teleport family', () => {
    for (const n of [207, 208, 209, 210, 243, 244, 262, 263, 264, 265, 266, 267, 268, 269]) {
      assert.equal(lookupSpecial(n)?.effect.kind, 'teleport', `${n} resolves`);
    }
    // The monster-only half of the family, per `p_spec.c`'s `!thing->player` gates.
    for (const n of [264, 265, 266, 267, 268, 269]) {
      const effect = lookupSpecial(n)!.effect;
      assert.equal(effect.kind === 'teleport' && effect.monsterOnly, true, `${n} is monster-only`);
    }
    for (const n of [207, 208, 209, 210, 243, 244, 262, 263]) {
      const effect = lookupSpecial(n)!.effect;
      assert.equal(effect.kind === 'teleport' && effect.monsterOnly, false, `${n} admits the player`);
    }
  });
});

describe('specials · line-to-line teleporters', () => {
  /**
   * Two parallel north-south walls far apart: the player crosses the entry
   * line in cell 1 and comes out along the tag-matched exit line in cell 4.
   * Both are ordinary two-sided cell boundaries, which is all
   * `EV_SilentLineTeleport` requires of an exit.
   */
  function lineRig(special: number) {
    const grid = gridMap(['#######', '#.....#', '#######']);
    const { map } = grid;
    const entry = grid.westEdge(2, 1);
    const exit = grid.westEdge(5, 1);
    map.linedefs[entry].special = special;
    map.linedefs[entry].tag = 7;
    map.linedefs[exit].tag = 7;

    const arrivals: TeleportDest[] = [];
    const start = { x: grid.centre(1, 1).x, y: grid.centre(1, 1).y };
    const rig = specialsRig(map, start, { onTeleport: (dest) => arrivals.push(dest) });
    const cross = (facing = 0) => {
      const boundary = grid.centre(2, 1).x - grid.cell / 2;
      const y = grid.centre(1, 1).y;
      rig.tick(TIC, boundary - 20, y, facing);
      rig.tick(TIC, boundary + 20, y, facing);
    };
    return { grid, map, rig, arrivals, cross, entry, exit };
  }

  test('244 lands the body on its tag-matched exit line, silently', () => {
    const rig = lineRig(244);
    rig.cross();
    assert.equal(rig.arrivals.length, 1);
    const dest = rig.arrivals[0];
    assert.equal(dest.silent, true);
    // The exit line is the west edge of cell 5, a vertical line at that x.
    const exitX = rig.grid.centre(5, 1).x - rig.grid.cell / 2;
    assert.ok(Math.abs(dest.x - exitX) < 1, `landed on the exit line (x ${dest.x} vs ${exitX})`);
  });

  /**
   * The two lines here are parallel and identically wound, so a forward
   * teleport turns the body by 180° and a reversed one leaves it alone —
   * `angle = (reverse ? 0 : ANG180) + exitAngle - entryAngle`.
   */
  test('reversed flips the turn a forward teleport applies', () => {
    const forward = lineRig(244);
    forward.cross();
    const reversed = lineRig(263);
    reversed.cross();
    const turn = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
    assert.ok(Math.abs(turn(forward.arrivals[0].rotateBy!) - Math.PI) < 1e-9, 'forward turns 180°');
    assert.ok(Math.abs(turn(reversed.arrivals[0].rotateBy!)) < 1e-9, 'reversed does not turn');
  });

  test('the exit position tracks where along the entry line the body crossed', () => {
    const north = lineRig(244);
    const south = lineRig(244);
    const boundary = north.grid.centre(2, 1).x - north.grid.cell / 2;
    const cellY = north.grid.centre(1, 1).y;
    for (const [rig, y] of [
      [north, cellY + 40],
      [south, cellY - 40],
    ] as const) {
      rig.rig.tick(TIC, boundary - 20, y);
      rig.rig.tick(TIC, boundary + 20, y);
    }
    assert.equal(north.arrivals.length, 1);
    assert.equal(south.arrivals.length, 1);
    assert.notEqual(north.arrivals[0].y, south.arrivals[0].y, 'two crossing points, two exits');
    // 80 units apart going in, 80 apart coming out — the exit line is the same
    // length and parallel, so the proportional position is preserved exactly.
    assert.ok(Math.abs(Math.abs(north.arrivals[0].y - south.arrivals[0].y) - 80) < 1e-6);
  });

  test('a tag matching no two-sided linedef teleports nobody', () => {
    const rig = lineRig(244);
    rig.map.linedefs[rig.exit].tag = 0;
    rig.cross();
    assert.equal(rig.arrivals.length, 0);
  });

  test('the trigger line is never its own exit', () => {
    const rig = lineRig(244);
    // Only the entry line carries the tag now, so the search finds nothing but
    // itself — which `EV_SilentLineTeleport` explicitly skips (`l != line`).
    rig.map.linedefs[rig.exit].tag = 0;
    rig.map.linedefs[rig.entry].tag = 7;
    rig.cross();
    assert.equal(rig.arrivals.length, 0);
  });
});
