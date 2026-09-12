import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { playerDeath } from '../../src/game/playerslot.ts';
import { applyDamage, createInventory } from '../../src/game/inventory.ts';
import { playerDamageAtSkill } from '../../src/game/skill.ts';
import { splashDamage } from '../../src/game/combat.ts';

/**
 * What a hit does to a player, in vanilla's whole points: the armor split and skill 1's halving
 * (`P_DamageMobj`, `p_inter.c`), a blast's falloff (`PIT_RadiusAttack`, `p_map.c`), and how a
 * killing hit dies — `P_KillMobj`'s gib test and `A_PlayerScream`'s cry. See docs/death.md
 * § Player death and docs/combat.md § Splash and the BFG.
 */

describe('Player damage · whole points', () => {
  test("armor absorbs in C's integer division, so armor and health stay whole", () => {
    const green = createInventory();
    green.armor = 100;
    green.armorType = 1;
    applyDamage(green, 10, false);
    assert.deepEqual([green.health, green.armor], [93, 97], 'damage/3 is 3, not 3.33');

    const blue = createInventory();
    blue.armor = 200;
    blue.armorType = 2;
    applyDamage(blue, 25, false);
    assert.deepEqual([blue.health, blue.armor], [87, 188], 'damage/2 is 12, not 12.5');
  });

  test('armor that runs out mid-hit gives what it has and falls back to bare', () => {
    const inv = createInventory();
    inv.armor = 2;
    inv.armorType = 1;
    applyDamage(inv, 10, false);
    assert.deepEqual([inv.health, inv.armor, inv.armorType], [92, 0, 0]);
  });

  test("skill 1 halves by a shift: an odd hit rounds down", () => {
    assert.equal(playerDamageAtSkill(25, 1), 12);
    assert.equal(playerDamageAtSkill(25, 3), 25);
  });

  test("a blast deals bombdamage - dist, and whole points where the pair is tuned apart", () => {
    assert.equal(splashDamage(128, 128, 52), 76);
    assert.equal(splashDamage(70, 70, 13), 57);
    assert.equal(splashDamage(100, 128, 50), 60, '60.94 truncated');
  });
});

describe('Player death · gib and cry', () => {
  test('below -spawnhealth the body gibs, with slop, in any game', () => {
    assert.deepEqual(playerDeath(-101, 'shareware'), { gibbed: true, sound: 'slop' });
    assert.deepEqual(playerDeath(-9900, 'commercial'), { gibbed: true, sound: 'slop' });
  });

  test('at -spawnhealth itself the death is plain: the test is strict', () => {
    assert.equal(playerDeath(-100, 'commercial').gibbed, false);
  });

  test('pdiehi below -50, and only in a commercial game', () => {
    assert.equal(playerDeath(-51, 'commercial').sound, 'pdiehi');
    assert.equal(playerDeath(-50, 'commercial').sound, 'pldeth');
    assert.equal(playerDeath(-100, 'registered').sound, 'pldeth');
    assert.equal(playerDeath(0, 'commercial').sound, 'pldeth');
  });
});
