import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyDehacked, resetDehacked, thingStatsPatched } from '../../src/game/dehacked/apply.ts';
import { parseDehacked } from '../../src/game/dehacked.ts';
import {
  FAST_MONSTER_STATS,
  MONSTER_STATS,
  TALLEST_BODY_HEIGHT,
  monsterStatsFor,
} from '../../src/game/monsters/tables.ts';
import {
  CEILING_HUNG_HEIGHT,
  COUNTKILL_TYPES,
  FUZZ_TYPES,
  MONSTER_HEALTH,
  MONSTER_TYPES,
  OBITUARIES,
  SOLID_DECORATION_RADIUS_OVERRIDE,
  SOLID_DECORATION_TYPES,
  obituary,
} from '../../src/game/things/tables.ts';
import { PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';
import { WEAPONS } from '../../src/game/weapons.ts';
import { applyPickup, ammoMax, createInventory } from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { soundLumpName } from '../../src/audio/sfx.ts';
import { finaleMusicFor, intermissionMusicFor, vanillaMusicFor } from '../../src/audio/music/tables.ts';
import { OBITUARY_SINKS, classifyDehackedString } from '../../src/game/dehacked/tables.ts';
import { LOCKED_LINES, lockedLine } from '../../src/game/specials/tables.ts';
import { dehFixture } from '../fixtures/dehacked.ts';

const apply = (text: string) => applyDehacked(parseDehacked(text));

/**
 * Writing a patch into the tables, and getting them back afterwards. Every test resets first, so
 * the order they run in cannot matter — which is the same guarantee `Game`'s constructor relies on.
 * See docs/dehacked.md § Applying: reset, then patch.
 */
describe('DEHACKED · applying', () => {
  beforeEach(() => resetDehacked());

  test('a Thing edit reaches the stat table and everything derived from it', () => {
    // The module-init staleness guard: both of these were frozen at import before the applier
    // existed, so a patched imp would have stayed fast-mode-vanilla.
    const imp = ThingType.imp;
    apply('Thing 12\nHit points = 500\nMass = 400\nPain chance = 128\n');
    assert.equal(MONSTER_HEALTH[imp], 500);
    assert.equal(MONSTER_STATS[imp].mass, 400);
    assert.equal(MONSTER_STATS[imp].painChance, 0.5);
    assert.equal(FAST_MONSTER_STATS[imp].mass, 400);
    assert.equal(monsterStatsFor(true)[imp].mass, 400);
  });

  test('a patched height moves the tallest-body early-out with it', () => {
    // Thing 22 is MT_CYBORG, the current tallest at 110.
    apply('Thing 22\nHeight = 400\n');
    assert.equal(MONSTER_STATS[ThingType.cyberdemon].height, 400);
    assert.equal(TALLEST_BODY_HEIGHT, 400);
  });

  test("a walker's speed is scaled, preserving the walk loop's own tic factor", () => {
    // MT_TROOP's vanilla `speed` is 8; doubling it doubles this engine's derived units/sec.
    const before = MONSTER_STATS[ThingType.imp].speed;
    apply('Thing 12\nSpeed = 16\n');
    assert.equal(MONSTER_STATS[ThingType.imp].speed, before * 2);
  });

  test('a missile edit moves every stat block naming that sprite, and no others', () => {
    // In vanilla the imp's fireball is one shared `mobjinfo`, so this is faithful rather than
    // approximate — but the cacodemon's is a different one (BAL2) and must not move.
    const caco = MONSTER_STATS[ThingType.cacodemon].ranged!.projectile!.speed;
    apply('Thing 32\nSpeed = 1310720\nMissile damage = 9\n'); // MT_TROOPSHOT, 20*FRACUNIT
    assert.equal(MONSTER_STATS[ThingType.imp].ranged!.projectile!.speed, 700);
    assert.equal(MONSTER_STATS[ThingType.imp].ranged!.diceMult, 9);
    assert.equal(MONSTER_STATS[ThingType.cacodemon].ranged!.projectile!.speed, caco);
  });

  test('one missile shared by a weapon and a monster moves both', () => {
    // MT_ROCKET (Thing 34) is the rocket launcher's missile and the cyberdemon's alike.
    apply('Thing 34\nSpeed = 655360\nWidth = 1310720\n'); // 10*FRACUNIT, 20*FRACUNIT
    assert.equal(WEAPONS.rocketLauncher.projectileSpeed, 350);
    assert.equal(MONSTER_STATS[ThingType.cyberdemon].ranged!.projectile!.speed, 350);
    assert.equal(PROJECTILE_RADIUS.MISL, 20);
  });

  test('Bits adds and removes membership across the sets that stand in for flags', () => {
    const imp = ThingType.imp;
    assert.equal(COUNTKILL_TYPES.has(imp), true);
    // A mask omitting COUNTKILL removes it — Bits is a replacement, not a delta.
    apply('Thing 12\nBits = SOLID+SHOOTABLE+SHADOW\n');
    assert.equal(COUNTKILL_TYPES.has(imp), false);
    assert.equal(FUZZ_TYPES.has(imp), true);
    assert.equal(MONSTER_TYPES.has(imp), true);
  });

  test('a monster keeping MF_SOLID does not become a solid decoration', () => {
    // Every `info.c` monster carries MF_SOLID, and `SOLID_DECORATION_TYPES` means solid *and not
    // shootable* — a shot passes through its members, so an imp landing in it would be unkillable
    // and 16 units wide. Any `Bits` line on a monster used to put it there.
    apply('Thing 12\nBits = SOLID+SHOOTABLE+COUNTKILL\n');
    assert.equal(SOLID_DECORATION_TYPES.has(ThingType.imp), false);
    assert.equal(MONSTER_TYPES.has(ThingType.imp), true);
  });

  test('Width and Bits in one record reach the solid-decoration radius together', () => {
    // Thing 83 is MT_MISC32, the tall green pillar (doomednum 30), solid already.
    apply('Thing 83\nWidth = 2621440\n');
    assert.equal(SOLID_DECORATION_RADIUS_OVERRIDE[30], 40);
    resetDehacked();
    // Thing 100 is MT_MISC49, the plain candle (34), which is `flags: 0` and so *not* solid until
    // this record says so — the radius still has to land, though `Bits` is applied after it.
    apply('Thing 100\nWidth = 2621440\nBits = SOLID\n');
    assert.equal(SOLID_DECORATION_TYPES.has(34), true);
    assert.equal(SOLID_DECORATION_RADIUS_OVERRIDE[34], 40);
  });

  test('losing SHOOTABLE drops the health entry, so nothing can be killed', () => {
    apply('Thing 12\nBits = SOLID\n');
    assert.equal(MONSTER_TYPES.has(ThingType.imp), false);
    assert.equal(ThingType.imp in MONSTER_HEALTH, false);
  });

  test("EPIC.WAD's two Thing records land where they should", () => {
    applyDehacked(parseDehacked(dehFixture('epic')));
    // Thing 97 is MT_MISC46, the small red torch (doomednum 57): `Bits = SOLID` makes it solid.
    assert.equal(SOLID_DECORATION_TYPES.has(57), true);
    // Thing 130 is MT_MISC79, a hanging body (74): 40 HP, and `Bits = 768` keeps it ceiling-hung
    // while dropping SOLID and SHOOTABLE — so the health entry goes with them.
    assert.equal(SOLID_DECORATION_TYPES.has(74), false);
    assert.equal(74 in CEILING_HUNG_HEIGHT, true);
  });

  test('Ammo edits reach the caps and, through the clip count, the pickups', () => {
    apply('Ammo 0\nMax ammo = 400\nPer ammo = 25\n'); // am_clip
    const inv = createInventory();
    assert.equal(ammoMax(inv, 'bullets'), 400);
    inv.ammo.bullets = 0;
    applyPickup(inv, ThingType.clip);
    assert.equal(inv.ammo.bullets, 25, 'a clip is worth clipammo');
    inv.ammo.bullets = 0;
    applyPickup(inv, ThingType.boxOfBullets);
    assert.equal(inv.ammo.bullets, 125, 'a box is five clips');
    inv.ammo.bullets = 0;
    applyPickup(inv, ThingType.chaingun);
    assert.equal(inv.ammo.bullets, 50, 'a weapon hands over two clips');
  });

  test('a Weapon record moves the ammo class it draws from', () => {
    apply('Weapon 1\nAmmo type = 1\n'); // wp_pistol -> am_shell
    assert.equal(WEAPONS.pistol.ammoType, 'shells');
    // `am_noammo` is 5, past the four real classes.
    apply('Weapon 1\nAmmo type = 5\n');
    assert.equal(WEAPONS.pistol.ammoType, null);
  });

  test('Misc moves the starting kit and the armour classes', () => {
    apply('Misc 0\nInitial Health = 42\nInitial Bullets = 7\nGreen Armor Class = 2\n');
    const inv = createInventory();
    assert.equal(inv.health, 42);
    assert.equal(inv.ammo.bullets, 7);
    applyPickup(inv, ThingType.greenArmor);
    assert.equal(inv.armor, 200, 'class 2 is worth 200');
    assert.equal(inv.armorType, 2);
  });

  test('the megasphere follows Blue Armor Class, not the armor-bonus cap', () => {
    const vanilla = createInventory();
    applyPickup(vanilla, ThingType.megasphere);
    assert.equal(vanilla.armor, 200);
    assert.equal(vanilla.armorType, 2);
    // `P_GiveArmor(blue_armor_class)` — `Max Armor` caps the armor bonus and nothing else, so it
    // is the class that decides both the amount and the absorption, exactly as a shirt's does.
    apply('Misc 0\nBlue Armor Class = 1\nMax Armor = 500\n');
    const inv = createInventory();
    applyPickup(inv, ThingType.megasphere);
    assert.equal(inv.armor, 100);
    assert.equal(inv.armorType, 1);
  });

  test('BFG Cells/Shot reaches the weapon, which is the one Misc row that is not a limit', () => {
    // It classifies `applied`, so it has to land somewhere: vanilla's `deh_bfgcells` writes
    // `weaponinfo[wp_bfg].ammopershot`. It used to be assigned onto `LIMITS` under its raw DEH
    // spelling, where nothing read it.
    assert.equal(WEAPONS.bfg.ammoPerShot, 40);
    apply('Misc 0\nBFG Cells/Shot = 20\n');
    assert.equal(WEAPONS.bfg.ammoPerShot, 20);
    resetDehacked();
    assert.equal(WEAPONS.bfg.ammoPerShot, 40);
  });

  test('[MUSIC] reaches the intermission and finale tracks, not just the level ones', () => {
    assert.equal(intermissionMusicFor('MAP01'), 'D_DM2INT');
    assert.equal(intermissionMusicFor('E1M1'), 'D_INTER');
    assert.equal(finaleMusicFor('MAP30'), 'D_READ_M');
    assert.equal(finaleMusicFor('E1M8'), 'D_VICTOR');
    apply('[MUSIC]\ndm2int = NEWINT\nvictor = D_NEWVIC\n');
    assert.equal(intermissionMusicFor('MAP01'), 'D_NEWINT');
    assert.equal(finaleMusicFor('E1M8'), 'D_NEWVIC');
    // The ones the patch didn't name stay put.
    assert.equal(intermissionMusicFor('E1M1'), 'D_INTER');
    resetDehacked();
    assert.equal(intermissionMusicFor('MAP01'), 'D_DM2INT');
    assert.equal(finaleMusicFor('E1M8'), 'D_VICTOR');
  });

  test("a Thing's sound fields resolve through sfxenum_t onto MonsterSounds", () => {
    // Index 1 is `sfx_pistol`; index 0 is `sfx_None`, which means silence rather than a sound.
    apply('Thing 12\nAlert sound = 1\nDeath sound = 0\n');
    assert.equal(MONSTER_STATS[ThingType.imp].sounds.see, 'pistol');
    assert.equal('death' in MONSTER_STATS[ThingType.imp].sounds, false);
  });

  test('[SOUNDS] and [MUSIC] redirect which lump a name resolves to', () => {
    assert.equal(soundLumpName('pistol'), 'DSPISTOL');
    assert.equal(vanillaMusicFor('MAP01'), 'D_RUNNIN');
    // A `[SOUNDS]` value is a sfx name, which `I_GetSfxLumpNum` prefixes — the six-character cap
    // `deh_procBexSounds` puts on it is there because the lump is `DS` plus these bytes.
    apply('[SOUNDS]\npistol = newgun\n[MUSIC]\nrunnin = D_OTHER\n');
    assert.equal(soundLumpName('pistol'), 'DSNEWGUN');
    assert.equal(vanillaMusicFor('MAP01'), 'D_OTHER');
    resetDehacked();
    assert.equal(soundLumpName('pistol'), 'DSPISTOL');
    assert.equal(vanillaMusicFor('MAP01'), 'D_RUNNIN');
  });

  test('[STRINGS] obituaries replace the death overlay line, in the second person', () => {
    // ZDoom's `LANGUAGE` writes a third-person sentence about a named victim; `%o` is that victim,
    // who here is the one player being shown the line, so it resolves and `was` follows it over.
    apply('[STRINGS]\nOB_VILE = %o was incinerated by an archvile.\nOB_WOLFSS = %o met a Nazi.');
    assert.equal(obituary(ThingType.archVile), 'You were incinerated by an archvile.');
    assert.equal(obituary(ThingType.wolfensteinSS), 'You met a Nazi.');
    // Untouched lines keep this engine's own wording.
    assert.equal(obituary(ThingType.imp), 'You were killed by an Imp');
  });

  test('a patch that writes no %o gets no subject invented for it', () => {
    // Eternity's BEX table lists the bare predicate, and its port prepends the player's name. This
    // one has no name to prepend and does not guess: the line is shown as written, capitalised.
    apply('[STRINGS]\nOB_CRUSH = was squished');
    assert.equal(obituary('crush'), 'Was squished');
  });

  test('OB_DEFAULT gives the unattributed death a line it otherwise has none of', () => {
    assert.equal(obituary(undefined), '');
    apply('[STRINGS]\nOB_DEFAULT = %o died.');
    assert.equal(obituary(undefined), 'You died.');
    // A doomednum with no obituary of its own falls back the same way — here a player start.
    assert.equal(obituary(1), 'You died.');
  });

  test('the pronoun tokens follow the subject into the second person', () => {
    apply('[STRINGS]\nOB_BABY = %o let an arachnotron get %h.\nOB_SPIDER = %o killed %hself.');
    assert.equal(obituary(ThingType.arachnotron), 'You let an arachnotron get you.');
    assert.equal(obituary(ThingType.spiderMastermind), 'You killed yourself.');
  });

  test('every obituary sink names a line that already exists, so a patch replaces and never adds', () => {
    // The failure this catches is silent: `OBITUARIES[sink] = …` on a mistyped doomednum would
    // write a key nothing ever reads, and the mnemonic would look applied in the report.
    for (const sink of Object.values(OBITUARY_SINKS)) {
      assert.ok(sink in OBITUARIES, `OBITUARY_SINKS names ${sink}, which OBITUARIES has no line for`);
    }
  });

  test('[STRINGS] PD_* replaces the locked-door line, verbatim', () => {
    // No transform, unlike an OB_*: these are already whole sentences spoken to the player.
    apply('[STRINGS]\nPD_BLUEK = You need the blue keycard\nPD_ALL6 = Bring all six');
    assert.equal(lockedLine({ kind: 'color', color: 'blue' }, 'door'), 'You need the blue keycard');
    assert.equal(lockedLine({ kind: 'all', colorsSuffice: false }, 'door'), 'Bring all six');
    // The object variant of the same color is a separate mnemonic and is untouched.
    assert.equal(lockedLine({ kind: 'color', color: 'blue' }, 'switch'), 'You need a blue key to activate this object');
  });

  test("the classifier's PD_* list is exactly the set of lines that exist", () => {
    // `dehacked/tables.ts` spells the mnemonics out rather than importing `LOCKED_LINES`, because
    // it is on the read side and must not pull the game layer into the menu's graph. This is what
    // keeps the two copies from drifting — a line added to one and not the other shows up here.
    for (const mnemonic of Object.keys(LOCKED_LINES)) {
      assert.equal(classifyDehackedString(mnemonic), 'applied', `${mnemonic} has a line but is not applied`);
    }
    // And nothing beyond them: a PD_ the engine has no line for still reports honestly.
    assert.equal(classifyDehackedString('PD_GREENK'), 'noTarget');
  });

  test('thingStatsPatched follows the patch, and clears on reset', () => {
    assert.equal(thingStatsPatched(), false);
    apply('Thing 12\nHit points = 5\n');
    assert.equal(thingStatsPatched(), true);
    resetDehacked();
    assert.equal(thingStatsPatched(), false);
  });
});

/**
 * The completeness guard for the applier: whatever it can write, a reset must be able to put back.
 * A table added to `applyThing` and forgotten in `PATCHED_TABLES` fails here rather than as a mysterious
 * difficulty change two levels into a session.
 */
describe('DEHACKED · reset restores every table it can write', () => {
  test('a maximal patch leaves nothing behind after resetDehacked', () => {
    resetDehacked();
    const before = {
      stats: structuredClone(MONSTER_STATS),
      health: { ...MONSTER_HEALTH },
      ceiling: { ...CEILING_HUNG_HEIGHT },
      projectiles: { ...PROJECTILE_RADIUS },
      weapons: structuredClone(WEAPONS),
      countkill: [...COUNTKILL_TYPES].sort(),
      monsters: [...MONSTER_TYPES].sort(),
      fuzz: [...FUZZ_TYPES].sort(),
      solid: [...SOLID_DECORATION_TYPES].sort(),
      tallest: TALLEST_BODY_HEIGHT,
      inventory: createInventory(),
      obituaries: { ...OBITUARIES },
      lockedLines: { ...LOCKED_LINES },
    };

    // Every section the applier writes, at once, on types chosen to hit each sink.
    apply(
      [
        'Thing 12\nHit points = 1\nMass = 2\nPain chance = 3\nWidth = 4\nHeight = 5\nSpeed = 6\nBits = SHADOW\nAlert sound = 1',
        'Thing 22\nHeight = 900',
        'Thing 32\nSpeed = 1310720\nMissile damage = 9\nWidth = 1310720',
        'Thing 34\nSpeed = 655360',
        'Thing 97\nBits = SOLID',
        'Ammo 0\nMax ammo = 1\nPer ammo = 2',
        'Weapon 1\nAmmo type = 2',
        'Misc 0\nInitial Health = 3\nInitial Bullets = 4\nGreen Armor Class = 2\nMax Armor = 7',
        '[STRINGS]\nOB_CRUSH = %o was squished.\nPD_BLUEK = Locked, obviously',
        '[SOUNDS]\npistol = DSNEWGUN',
        '[MUSIC]\nrunnin = D_OTHER',
      ].join('\n'),
    );
    assert.notDeepEqual(MONSTER_STATS[ThingType.imp], before.stats[ThingType.imp], 'the patch did something');

    resetDehacked();
    assert.deepEqual(MONSTER_STATS, before.stats);
    assert.deepEqual(MONSTER_HEALTH, before.health);
    assert.deepEqual(CEILING_HUNG_HEIGHT, before.ceiling);
    assert.deepEqual(PROJECTILE_RADIUS, before.projectiles);
    assert.deepEqual(WEAPONS, before.weapons);
    assert.deepEqual([...COUNTKILL_TYPES].sort(), before.countkill);
    assert.deepEqual([...MONSTER_TYPES].sort(), before.monsters);
    assert.deepEqual([...FUZZ_TYPES].sort(), before.fuzz);
    assert.deepEqual([...SOLID_DECORATION_TYPES].sort(), before.solid);
    assert.equal(TALLEST_BODY_HEIGHT, before.tallest);
    assert.deepEqual(createInventory(), before.inventory);
    assert.equal(ammoMax(createInventory(), 'bullets'), 200);
    assert.equal(soundLumpName('pistol'), 'DSPISTOL');
    assert.equal(vanillaMusicFor('MAP01'), 'D_RUNNIN');
    assert.deepEqual(OBITUARIES, before.obituaries);
    assert.deepEqual(LOCKED_LINES, before.lockedLines);
  });

  test('the pristine snapshot is deep, so a reset hands back no patched sub-object', () => {
    resetDehacked();
    const originalSpeed = MONSTER_STATS[ThingType.imp].ranged!.projectile!.speed;
    // Two rounds: a shallow snapshot would survive the first reset and fail the second, because
    // the "pristine" nested object would itself have been mutated by the first patch.
    for (let round = 0; round < 2; round++) {
      apply('Thing 32\nSpeed = 1310720\n');
      assert.equal(MONSTER_STATS[ThingType.imp].ranged!.projectile!.speed, 700);
      resetDehacked();
      assert.equal(MONSTER_STATS[ThingType.imp].ranged!.projectile!.speed, originalSpeed);
    }
  });
});
