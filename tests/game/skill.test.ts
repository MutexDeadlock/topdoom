import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ammoAtSkill,
  fastMonsters,
  isAmbush,
  isMultiplayerOnly,
  playerDamageAtSkill,
  spawnAngleDeg,
  spawnsAtSkill,
  type Skill,
} from '../../src/game/skill.ts';
import { FAST_MONSTER_STATS, MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';

/**
 * What the chosen skill decides: which THINGs spawn at all, the flags the spawn reads, and the
 * ammo and damage adjustments the two extreme skills make.
 * See docs/items.md § Skill and docs/sprites.md § Which things spawn.
 */

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

/**
 * The two rules that make skills 1 and 5 more than a thing filter, plus the fast-monster table.
 * Sources: `P_GiveAmmo` and `P_DamageMobj` (`p_inter.c`), `G_InitNew` (`g_game.c`).
 * See docs/items.md § Skill and docs/monster-ai.md § Fast monsters.
 */
describe('Game rules · what a skill changes beyond spawns', () => {
  test('ammo doubles on skill 1 and skill 5, and nowhere between', () => {
    assert.deepEqual(
      SKILLS.map((s) => ammoAtSkill(10, s)),
      [20, 10, 10, 10, 20],
      'baby and nightmare only',
    );
  });

  test('the player takes half damage on skill 1 only', () => {
    assert.deepEqual(
      SKILLS.map((s) => playerDamageAtSkill(40, s)),
      [20, 40, 40, 40, 40],
    );
  });

  test('fast monsters are nightmare and nothing else', () => {
    assert.deepEqual(
      SKILLS.map(fastMonsters),
      [false, false, false, false, true],
    );
  });
});

describe('Vanilla tables · fast monsters', () => {
  test('the demon and the spectre halve their tics, and nothing else does', () => {
    const changed = Object.keys(MONSTER_STATS).filter(
      (type) => FAST_MONSTER_STATS[Number(type)].speed !== MONSTER_STATS[Number(type)].speed,
    );
    // `S_SARG_RUN1`..`S_SARG_PAIN2` is the whole of `G_InitNew`'s state loop, and `MT_SPECTRE`
    // shares that chain — no other monster in the game moves faster on nightmare.
    assert.deepEqual(changed.map(Number).sort(), [ThingType.demon, ThingType.spectre].sort());
  });

  test('a fast demon covers twice the ground per second at half the chase interval', () => {
    const normal = MONSTER_STATS[ThingType.demon];
    const fast = FAST_MONSTER_STATS[ThingType.demon];
    assert.equal(fast.speed, normal.speed * 2);
    assert.equal(fast.chaseInterval, normal.chaseInterval / 2);
    assert.equal(fast.painDuration, normal.painDuration / 2);
    assert.equal(fast.melee!.duration, normal.melee!.duration / 2);
    // Halving a walk state's tics doubles the speed and halves the interval, so the distance one
    // chase call covers — what `BLOCKER_MARGIN`'s probe term is built on — is unchanged.
    assert.equal(fast.speed * fast.chaseInterval, normal.speed * normal.chaseInterval);
  });

  test('only the imp, cacodemon, baron and hell knight missiles speed up, all to 20 units/tic', () => {
    const missileSpeeds = (table: typeof MONSTER_STATS) =>
      Object.fromEntries(
        Object.entries(table)
          .filter(([, s]) => s.ranged?.projectile)
          .map(([type, s]) => [Number(type), s.ranged!.projectile!.speed]),
      );
    const normal = missileSpeeds(MONSTER_STATS);
    const fast = missileSpeeds(FAST_MONSTER_STATS);
    const sped = Object.keys(fast).filter((type) => fast[Number(type)] !== normal[Number(type)]);
    assert.deepEqual(
      sped.map(Number).sort(),
      [ThingType.imp, ThingType.cacodemon, ThingType.baronOfHell, ThingType.hellKnight].sort(),
    );
    for (const type of sped) assert.equal(fast[Number(type)], 20 * 35, 'MT_*SHOT speed 20 × 35 tics');
  });
});
