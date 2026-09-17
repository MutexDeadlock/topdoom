import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, soundLog, TIC } from '../fixtures/specialsrig.ts';
import { NO_INPUT, USE_INPUT } from '../fixtures/input.ts';

/**
 * A shot G1 line kept shadowing the switch behind it from the use trace: vanilla zeroes a
 * one-shot's `line->special` when it fires, so the press meets a plain opening there and carries
 * on, but this engine keeps the number and records `usedOnce`, which the trace never read. The
 * switch could never be pressed. See docs/specials.md § The use trace.
 *
 * **Repro: D5DA3.wad MAP05**, standing on lift sector 32: G1 door line 129 lies between the player
 * and the SR switch on line 119, both inside `USE_RANGE`.
 */

const STANDING = { x: 28, y: 16, angle: 0 };

/**
 * Four cells in a row, cell size 32, the player near cell 0's east edge facing east. The edge at
 * x=32 carries 24 (G1 raise floor, tag 9 on the far cell), the edge at x=64 carries 138 (light ->
 * 255, tag 7) — both inside USE_RANGE.
 */
function rig() {
  const grid = gridMap(['....'], { cell: 32 });
  const { map } = grid;
  const shot = grid.westEdge(1, 0);
  map.linedefs[shot].special = 24;
  map.linedefs[shot].tag = 9;
  map.sectors[3].tag = 9;
  map.linedefs[grid.westEdge(2, 0)].special = 138;
  map.linedefs[grid.westEdge(2, 0)].tag = 7;
  map.sectors[2].tag = 7;
  const log = soundLog();
  const { specials } = specialsRig(map, STANDING, { sfx: log.sfx });
  return { map, specials, shot, played: log.played };
}

describe('Regressions · a spent one-shot line in front of a switch', () => {
  test('unspent, the shoot line shadows the switch behind it', () => {
    const { map, specials } = rig();
    specials.update(TIC, STANDING, USE_INPUT, new Set());
    assert.equal(map.sectors[2].light, 160);
  });

  test('once shot, the same press reaches the switch', () => {
    const { map, specials, shot, played } = rig();
    specials.triggerShot(shot, new Set());
    specials.update(TIC, STANDING, NO_INPUT, new Set());
    specials.update(TIC, STANDING, USE_INPUT, new Set());
    assert.equal(map.sectors[2].light, 255);
    assert.ok(!played.includes('noway'));
  });
});
