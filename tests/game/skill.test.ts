import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isAmbush, isMultiplayerOnly, spawnAngleDeg, spawnsAtSkill, type Skill } from '../../src/game/skill.ts';

/**
 * Which THINGs a map spawns at each difficulty. Pure flag arithmetic against
 * vanilla's `P_LoadThings`, so the whole matrix is cheap to pin.
 */

const EASY = 0x0001;
const MEDIUM = 0x0002;
const HARD = 0x0004;
const AMBUSH = 0x0008;
const NOTSINGLE = 0x0010;

const SKILLS: Skill[] = [1, 2, 3, 4, 5];

describe('Game rules · THING skill flags', () => {
  test('the easy/medium/hard bits each cover two, one and two skills', () => {
    // Vanilla groups 1-2, 3, and 4-5 onto one bit each — the reason a mapper
    // cannot distinguish baby from easy, or UV from nightmare.
    assert.deepEqual(
      SKILLS.map((s) => spawnsAtSkill(EASY, s)),
      [true, true, false, false, false],
    );
    assert.deepEqual(
      SKILLS.map((s) => spawnsAtSkill(MEDIUM, s)),
      [false, false, true, false, false],
    );
    assert.deepEqual(
      SKILLS.map((s) => spawnsAtSkill(HARD, s)),
      [false, false, false, true, true],
    );
  });

  test('skill bits combine, and no bits means the thing never spawns', () => {
    assert.deepEqual(
      SKILLS.map((s) => spawnsAtSkill(EASY | MEDIUM | HARD, s)),
      [true, true, true, true, true],
    );
    assert.deepEqual(
      SKILLS.map((s) => spawnsAtSkill(EASY | HARD, s)),
      [true, true, false, true, true],
    );
    for (const s of SKILLS) assert.equal(spawnsAtSkill(0, s), false);
  });

  test('the unrelated flags do not leak into the skill test', () => {
    // AMBUSH (0x08) and NOTSINGLE (0x10) sit just above the skill bits, so a
    // mask that was one bit too wide would show up here.
    for (const s of SKILLS) {
      assert.equal(spawnsAtSkill(AMBUSH | NOTSINGLE, s), false);
      assert.equal(spawnsAtSkill(MEDIUM | AMBUSH | NOTSINGLE, s), s === 3);
    }
  });

  test('isMultiplayerOnly and isAmbush read their own bit only', () => {
    assert.equal(isMultiplayerOnly(NOTSINGLE), true);
    assert.equal(isMultiplayerOnly(EASY | MEDIUM | HARD | AMBUSH), false);
    assert.equal(isMultiplayerOnly(0), false);

    assert.equal(isAmbush(AMBUSH), true);
    assert.equal(isAmbush(EASY | MEDIUM | HARD | NOTSINGLE), false);
    assert.equal(isAmbush(0), false);

    // A typical deathmatch-only ambush monster carries both.
    const both = HARD | AMBUSH | NOTSINGLE;
    assert.equal(isAmbush(both), true);
    assert.equal(isMultiplayerOnly(both), true);
    assert.equal(spawnsAtSkill(both, 5), true);
  });
});

describe('Game rules · THING spawn angle', () => {
  test('an on-grid angle survives untouched', () => {
    for (const a of [0, 45, 90, 135, 180, 225, 270, 315]) assert.equal(spawnAngleDeg(a), a);
  });

  test('an off-grid angle snaps down to the 45° step below it', () => {
    // `ANG45 * (mthing->angle/45)`: freedoom2.wad's off-grid placements are the
    // ones this actually moves. 250 -> 225 is the single DOOM2 case.
    assert.equal(spawnAngleDeg(250), 225);
    assert.equal(spawnAngleDeg(15), 0);
    assert.equal(spawnAngleDeg(44), 0);
    assert.equal(spawnAngleDeg(110), 90);
    assert.equal(spawnAngleDeg(359), 315);
  });

  test('a negative angle truncates toward zero, as C integer division does', () => {
    // The WAD field is a signed short, and Math.floor would send -100 to -135
    // where vanilla sends it to -90.
    assert.equal(spawnAngleDeg(-100), -90);
    assert.equal(spawnAngleDeg(-45), -45);
    assert.equal(spawnAngleDeg(-44), -0);
  });
});
