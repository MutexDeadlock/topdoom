import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FF_FULLBRIGHT,
  frameLetter,
  isFlashState,
  isPspriteState,
  MOBJ_STATES,
  SPRITE_NAMES,
  STATES,
} from '../../src/game/dehacked/states.ts';
import { MOBJ_INFO } from '../../src/game/dehacked/tables.ts';

/**
 * The transcription of `info.c`'s `states[]`, `sprnames[]` and the `mobjinfo` state pointers.
 * Completeness and internal consistency, plus a handful of rows pinned by name — the rows every
 * other frame test and the shipped patches lean on. See docs/dehacked.md § Frames.
 */
describe('Vanilla tables · the frame table', () => {
  test('states[] is all 967 of it, sprnames[] all 138, in info.h order', () => {
    // `NUMSTATES`, `NUMSPRITES` in `info.h`.
    assert.equal(STATES.length, 967);
    assert.equal(SPRITE_NAMES.length, 138);
    assert.equal(STATES[0][5], 'S_NULL');
    assert.equal(STATES[1][5], 'S_LIGHTDONE');
    assert.equal(STATES[966][5], 'S_TECH2LAMP4');
    assert.equal(SPRITE_NAMES[0], 'TROO');
    assert.equal(SPRITE_NAMES[137], 'TLP2');
    assert.equal(new Set(STATES.map((row) => row[5])).size, 967);
    assert.equal(new Set(SPRITE_NAMES).size, 138);
  });

  test('every state names a real sprite and a real next state', () => {
    for (const [sprite, , tics, , next, name] of STATES) {
      assert.ok(sprite >= 0 && sprite < SPRITE_NAMES.length, `${name} sprite ${sprite}`);
      assert.ok(next >= 0 && next < STATES.length, `${name} next ${next}`);
      assert.ok(tics >= -1, `${name} tics ${tics}`);
    }
  });

  test('the mobj state pointers are index-aligned with MOBJ_INFO and in range', () => {
    assert.equal(MOBJ_STATES.length, MOBJ_INFO.length);
    for (const row of MOBJ_STATES) {
      for (const index of Object.values(row)) assert.ok(index >= 0 && index < STATES.length);
    }
    // MT_TROOP: S_TROO_STND, S_TROO_RUN1, S_TROO_PAIN, S_TROO_ATK1 for both attacks, S_TROO_DIE1,
    // S_TROO_XDIE1, S_TROO_RAISE1 — and the imp's melee and missile chains are the same one.
    const imp = MOBJ_STATES[11];
    assert.equal(STATES[imp.spawn][5], 'S_TROO_STND');
    assert.equal(STATES[imp.see][5], 'S_TROO_RUN1');
    assert.equal(STATES[imp.pain][5], 'S_TROO_PAIN');
    assert.equal(imp.melee, imp.missile);
    assert.equal(STATES[imp.death][5], 'S_TROO_DIE1');
    assert.equal(STATES[imp.xdeath][5], 'S_TROO_XDIE1');
    assert.equal(STATES[imp.raise][5], 'S_TROO_RAISE1');
    // A type with no such state points at S_NULL, and `info.c` writes some of those as a literal 0.
    assert.equal(MOBJ_STATES[1].melee, 0); // MT_POSSESSED
    assert.equal(MOBJ_STATES[24].see, 0); // MT_KEEN
  });

  test('the rows the shipped patches and the runtime lean on read as info.c writes them', () => {
    // freedoom2 brightens 185 (`S_POSS_ATK2`, frame 5 = F, *not* fullbright in vanilla) and shortens
    // 47/48 (the super shotgun's flash); EPIC aims a hanging body at 462 (the imp's gib chain) and 951.
    assert.deepEqual(STATES[185], [29, 5, 8, 'A_PosAttack', 186, 'S_POSS_ATK2']);
    assert.equal(STATES[47][5], 'S_DSGUNFLASH1');
    assert.equal(STATES[462][5], 'S_TROO_XDIE1');
    assert.equal(SPRITE_NAMES[STATES[462][0]], 'TROO');
    assert.equal(frameLetter(STATES[462][1]), 'N');
    assert.equal(STATES[951][5], 'S_HANGBNOBRAIN');
    // S_BEXP4 carries A_Explode, 15 tics into the barrel's death — the walker reads the delay off it.
    const bexp = STATES.findIndex((row) => row[5] === 'S_BEXP');
    assert.equal(STATES[bexp + 3][3], 'A_Explode');
    assert.equal(STATES[bexp][2] + STATES[bexp + 1][2] + STATES[bexp + 2][2], 15);
    // A held candle: fullbright frame A, tics -1.
    const candle = STATES.find((row) => row[5] === 'S_CANDLESTIK')!;
    assert.equal(candle[1], FF_FULLBRIGHT);
    assert.equal(candle[2], -1);
  });

  test('the psprite range is exactly S_LIGHTDONE..S_BFGFLASH2, and the flashes are named in it', () => {
    const psprite = STATES.map((_, i) => i).filter(isPspriteState);
    assert.equal(psprite[0], 1);
    assert.equal(psprite[psprite.length - 1], 89);
    assert.equal(psprite.length, 89);
    assert.equal(isPspriteState(90), false); // S_BLOOD1
    // The super shotgun's flash draws the gun's own SHT2 lump, which is why this is by name.
    assert.equal(isFlashState(47), true);
    assert.equal(isFlashState(1), true); // S_LIGHTDONE
    assert.equal(isFlashState(2), false); // S_PUNCH
    assert.equal(isFlashState(185), false);
  });

  test('frameLetter strips the fullbright bit', () => {
    assert.equal(frameLetter(0), 'A');
    assert.equal(frameLetter(FF_FULLBRIGHT | 5), 'F');
    assert.equal(frameLetter(22), 'W');
  });
});
