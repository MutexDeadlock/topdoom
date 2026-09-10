import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { lookForPlayers, tryWake, type PlayerLook } from '../../src/game/monsters/ai.ts';
import type { WakeCheckBody } from '../../src/game/monsters/defs.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * `P_LookForPlayers`' rotation over the player slots, and `A_Look` waking after whoever made the
 * noise. docs/monster-ai.md § Waking up, docs/multiplayer-coop.md § Target choice.
 */

/**
 * An open room with a sealed closet below it. The monster stands mid-room facing east; `AHEAD` is
 * in its cone and sight, `BEHIND` in sight but out of the cone, `HIDDEN` in neither.
 */
const grid = gridMap(
  ['#########', '#.......#', '#.......#', '#.......#', '#########', '#.#######', '#########'],
  { cell: 128 },
);
const world = new World(grid.map);

function at(col: number, row: number): Pos3 {
  const p = grid.centre(col, row);
  return { x: p.x, y: p.y, z: world.floorAt(p.x, p.y) };
}

const AHEAD = at(7, 2);
const BEHIND = at(1, 2);
const HIDDEN = at(1, 5);

function monster(lastlook: number, ambush = false): WakeCheckBody {
  const p = at(4, 2);
  return { ...p, facingDeg: 0, ambush, alerted: false, reactionTicks: 0, subsector: world.subsectorAt(p.x, p.y), lastlook };
}

/** Every slot's body as a look reads them, `null` where dead. */
function look(...players: (Pos3 | null)[]): PlayerLook {
  return { players, subsectors: players.map((p) => (p ? world.subsectorAt(p.x, p.y) : -1)) };
}

describe('Monster AI · P_LookForPlayers', () => {
  test('the slot the rotation stands on is looked at first, and the rotation stays on who it found', () => {
    const body = monster(1);
    assert.equal(lookForPlayers(body, false, world, look(AHEAD, AHEAD)), 1);
    assert.equal(body.lastlook, 1);
  });

  test('a dead player is passed over, and counts toward the two a call examines', () => {
    assert.equal(lookForPlayers(monster(0), false, world, look(null, AHEAD)), 1, 'the living one after the corpse');
    const body = monster(0);
    assert.equal(lookForPlayers(body, false, world, look(null, null, null, null)), -1);
    assert.equal(body.lastlook, 2, 'two examined, and the rotation left on the third');
  });

  test('a player behind its back is found only looking all around; one out of sight never', () => {
    assert.equal(lookForPlayers(monster(0), false, world, look(BEHIND)), -1);
    assert.equal(lookForPlayers(monster(0), true, world, look(BEHIND)), 0);
    assert.equal(lookForPlayers(monster(0), true, world, look(HIDDEN)), -1);
  });

  test('in single player a monster whose rotation starts on slot 1 misses its first look', () => {
    const body = monster(1);
    assert.equal(lookForPlayers(body, false, world, look(AHEAD)), -1, 'the lap stops on slot 0 before looking');
    assert.equal(body.lastlook, 0);
    assert.equal(lookForPlayers(body, false, world, look(AHEAD)), 0, 'and the next look finds the player');
  });

  test('a slot nobody plays is stepped over without being counted', () => {
    assert.equal(lookForPlayers(monster(2), false, world, look(AHEAD)), 0);
  });
});

describe('Monster AI · A_Look', () => {
  test('a noise wakes a monster after the player who made it, wherever they stand', () => {
    const heard = new World(grid.map);
    heard.noiseAlert(BEHIND.x, BEHIND.y, 1);
    const body = monster(0);
    const room = heard.sectorAt(body.x, body.y);
    assert.equal(tryWake(body, heard, room, look(HIDDEN, BEHIND)), 1);
    assert.equal(body.alerted, true);
  });

  test("a dead player's noise wakes nobody after them", () => {
    const heard = new World(grid.map);
    heard.noiseAlert(BEHIND.x, BEHIND.y, 1);
    const body = monster(0);
    assert.equal(tryWake(body, heard, heard.sectorAt(body.x, body.y), look(HIDDEN, null)), -1);
    assert.equal(body.alerted, false);
  });

  test('an ambush monster wakes on a noise only if it can see who made it', () => {
    const heard = new World(grid.map);
    heard.noiseAlert(BEHIND.x, BEHIND.y, 1);
    const deaf = monster(0, true);
    const room = heard.sectorAt(deaf.x, deaf.y);
    assert.equal(tryWake(deaf, heard, room, look(null, HIDDEN)), -1, 'the noise-maker has gone out of sight');
    assert.equal(tryWake(deaf, heard, room, look(null, BEHIND)), 1, 'no cone on the noise path');
    assert.equal(tryWake(monster(0), heard, room, look(null, HIDDEN)), 1, 'an ordinary monster needs no sight');
  });
});
