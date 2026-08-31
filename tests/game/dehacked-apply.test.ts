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
  CORPSE_GIB,
  COUNTKILL_TYPES,
  FULLBRIGHT_FRAMES,
  FUZZ_TYPES,
  MONSTER_ATTACK_POSE,
  MONSTER_CORPSE_VANISHES,
  MONSTER_DEATH_FRAMES,
  MONSTER_DEATH_SPRITE_OVERRIDE,
  MONSTER_DROPS,
  MONSTER_HEALTH,
  MONSTER_PAIN_FRAMES,
  MONSTER_RAISE_FRAMES,
  MONSTER_TYPES,
  MONSTER_WALK_FRAMES_OVERRIDE,
  OBITUARIES,
  SOLID_DECORATION_RADIUS_OVERRIDE,
  SOLID_DECORATION_TYPES,
  THING_ANIM_FRAMES,
  THING_SPRITES,
  obituary,
} from '../../src/game/things/tables.ts';
import { BARREL_CHAIN } from '../../src/game/things/defs.ts';
import { IMPACT_EFFECTS, PROJECTILE_FRAMES, PROJECTILE_RADIUS, PROJECTILE_SOUNDS } from '../../src/game/spritefx/tables.ts';
import { STATES } from '../../src/game/dehacked/states.ts';
import { SpriteBank } from '../../src/wad/sprites.ts';
import { Wad } from '../../src/wad/wad.ts';
import { wadFile } from '../fixtures/wadfile.ts';
import { WEAPONS } from '../../src/game/weapons.ts';
import { SFX_ORDER, WEAPON_ORDER } from '../../src/game/dehacked/tables.ts';
import { applyPickup, ammoMax, createInventory } from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { soundLumpName } from '../../src/audio/sfx.ts';
import { finaleMusicFor, intermissionMusicFor, vanillaMusicFor } from '../../src/audio/music/tables.ts';
import { OBITUARY_SINKS, classifyDehackedField, classifyDehackedString } from '../../src/game/dehacked/tables.ts';
import { LOCKED_LINES, lockedLine } from '../../src/game/specials/tables.ts';
import { CHEAT_MESSAGES, Cheats } from '../../src/game/cheats.ts';
import { dehFixture } from '../fixtures/dehacked.ts';

const apply = (text: string) => applyDehacked(parseDehacked(text));
const stateNamed = (name: string) => STATES.findIndex((row) => row[5] === name);
const tics = (seconds: number) => Math.round(seconds * 35);

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

  test("Misc's cheat rows reach the two cheats that have one", () => {
    // `God Mode Health` and `IDKFA Armor`/`IDKFA Armor Class` are separate from the start health
    // and the armor classes a pickup follows — docs/cheats.md.
    apply('Misc 0\nInitial Health = 5\nGod Mode Health = 300\nIDKFA Armor = 50\nIDKFA Armor Class = 1\n');
    const cheats = new Cheats();
    const inv = createInventory();
    cheats.type('iddqdidkfa', inv);
    assert.equal(inv.health, 300);
    assert.equal(inv.armor, 50);
    assert.equal(inv.armorType, 1);
    // `IDFA` has no cheat here, so its rows still report honestly.
    assert.equal(classifyDehackedField('misc', 'IDFA Armor'), 'noTarget');
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

  test('[STRINGS] STSTR_* replaces a cheat response, verbatim', () => {
    // Same by-mnemonic replacement the PD_* lines get, and for the same reason — docs/cheats.md.
    apply('[STRINGS]\nSTSTR_DQDON = Nice try\n');
    assert.equal(CHEAT_MESSAGES.STSTR_DQDON, 'Nice try');
    assert.equal(CHEAT_MESSAGES.STSTR_DQDOFF, 'Degreelessness Mode Off', 'the other half of the toggle is untouched');
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

  test("a Thing's death pointer re-derives its death letters, borrowing the other sprite", () => {
    // EPIC.WAD's shape — a death aimed at the imp's gib chain — on a zombieman (Thing 2), where it
    // can actually be seen. docs/dehacked.md § Frames.
    apply('Thing 2\nDeath frame = 462\n');
    assert.deepEqual(MONSTER_DEATH_FRAMES[ThingType.zombieman], ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U']);
    assert.deepEqual(MONSTER_DEATH_SPRITE_OVERRIDE[ThingType.zombieman], { death: 'TROO' });
    // Nothing else on the type moved.
    assert.deepEqual(MONSTER_ATTACK_POSE[ThingType.zombieman].ranged, { frames: ['E', 'F', 'E'], tics: [10, 8, 8] });
    resetDehacked();
    assert.deepEqual(MONSTER_DEATH_FRAMES[ThingType.zombieman], ['H', 'I', 'J', 'K', 'L']);
    assert.equal(ThingType.zombieman in MONSTER_DEATH_SPRITE_OVERRIDE, false);
  });

  test('a death pointed at S_NULL leaves the type with no death art, so it hides on death', () => {
    apply('Thing 2\nDeath frame = 0\n');
    assert.equal(ThingType.zombieman in MONSTER_DEATH_FRAMES, false);
  });

  test("a Frame's Duration retimes the stagger its state belongs to", () => {
    apply(`Frame ${stateNamed('S_POSS_PAIN')}\nDuration = 20\n`);
    assert.equal(tics(MONSTER_STATS[ThingType.zombieman].painDuration), 23); // 20 + S_POSS_PAIN2's 3
    assert.equal(tics(FAST_MONSTER_STATS[ThingType.zombieman].painDuration), 23);
  });

  test('a Next frame that cuts a death chain short makes the corpse vanish', () => {
    apply(`Frame ${stateNamed('S_TROO_DIE2')}\nNext frame = 0\n`);
    assert.deepEqual(MONSTER_DEATH_FRAMES[ThingType.imp], ['I', 'J']);
    assert.equal(MONSTER_CORPSE_VANISHES.has(ThingType.imp), true);
    resetDehacked();
    assert.equal(MONSTER_CORPSE_VANISHES.has(ThingType.imp), false);
  });

  test("retiming the walk loop moves the chase clock, composing with a Speed line", () => {
    // Every S_POSS_RUN state halved (4 → 2 tics) doubles the chase rate; `Speed = 16` doubles the
    // per-call stride. Either order: 70 × 2 × 2.
    const run1 = stateNamed('S_POSS_RUN1');
    const frames = Array.from({ length: 8 }, (_, i) => `Frame ${run1 + i}\nDuration = 2`).join('\n');
    apply(`Thing 2\nSpeed = 16\n${frames}\n`);
    assert.equal(Math.round(MONSTER_STATS[ThingType.zombieman].speed), 280);
    assert.equal(tics(MONSTER_STATS[ThingType.zombieman].chaseInterval), 2);
  });

  test("a Frame's Duration on a gun state retunes that weapon's fire rate", () => {
    // S_SGUN2 is the shotgun's 7-tic firing state; the chain's other seven states hold 30 tics
    // between them, so a 27-tic state makes the pass 57.
    apply(`Frame ${stateNamed('S_SGUN2')}\nDuration = 27\n`);
    assert.equal(tics(WEAPONS.shotgun.cooldown), 57);
    resetDehacked();
    assert.equal(tics(WEAPONS.shotgun.cooldown), 37);
  });

  test("the A_ReFire state's own tics stay out of the rate, however long a patch makes them", () => {
    // S_PLASMA2 already holds 20 tics that a held trigger never spends. Vanilla's rule is the whole
    // reason the plasma rifle is the fastest weapon in the game rather than a middling one.
    apply(`Frame ${stateNamed('S_PLASMA2')}\nDuration = 200\n`);
    assert.equal(tics(WEAPONS.plasmaRifle.cooldown), 3);
  });

  test('a chain that fires twice a pass keeps its rate at the gap between shots', () => {
    // Both S_CHAIN1 and S_CHAIN2 call A_FireCGun, so doubling one state's tics moves the pass from
    // 8 tics to 12 and the rate from 4 to 6 — not to 12.
    apply(`Frame ${stateNamed('S_CHAIN1')}\nDuration = 8\n`);
    assert.equal(tics(WEAPONS.chaingun.cooldown), 6);
  });

  test("a Weapon's Shooting frame repoints the chain the rate is walked from", () => {
    // The pistol made to fire off the shotgun's chain: 37 tics, not its own 14. `Ammo type` is
    // absent, which must leave the class it draws from alone.
    apply(`Weapon 1\nShooting frame = ${stateNamed('S_SGUN1')}\n`);
    assert.equal(tics(WEAPONS.pistol.cooldown), 37);
    assert.equal(WEAPONS.pistol.ammoType, 'bullets');
    resetDehacked();
    assert.equal(tics(WEAPONS.pistol.cooldown), 14);
  });

  test('a patch that touches one weapon leaves the other eight exactly as they were', () => {
    const before = WEAPON_ORDER.map((id) => WEAPONS[id].cooldown);
    apply(`Frame ${stateNamed('S_SGUN2')}\nDuration = 27\n`);
    const after = WEAPON_ORDER.map((id) => WEAPONS[id].cooldown);
    for (const [i, id] of WEAPON_ORDER.entries()) {
      if (id === 'shotgun') continue;
      assert.equal(after[i], before[i], `${id} should not have moved`);
    }
  });

  test("a missile's flight sprite moves it to a new key in every sprite-keyed table", () => {
    // The imp's fireball redrawn as TFOG (sprite 26): the stat block, the flight and impact art,
    // and the two tables the walker does not derive all follow the new name.
    const tball = stateNamed('S_TBALL1');
    apply(`Frame ${tball}\nSprite number = 26\nFrame ${tball + 1}\nSprite number = 26\n`);
    assert.equal(MONSTER_STATS[ThingType.imp].ranged!.projectile!.sprite, 'TFOG');
    assert.deepEqual(PROJECTILE_FRAMES.TFOG, ['A', 'B']);
    assert.deepEqual(IMPACT_EFFECTS.TFOG, { sprite: 'BAL1', frames: ['C', 'D', 'E'] });
    assert.equal(PROJECTILE_RADIUS.TFOG, 6);
    assert.deepEqual(PROJECTILE_SOUNDS.TFOG, PROJECTILE_SOUNDS.BAL1);
    resetDehacked();
    assert.equal(MONSTER_STATS[ThingType.imp].ranged!.projectile!.sprite, 'BAL1');
    assert.equal('TFOG' in PROJECTILE_FRAMES, false);
    assert.equal('TFOG' in PROJECTILE_RADIUS, false);
  });

  test('a Sprite subnumber edit adds or clears a fullbright frame', () => {
    // freedoom2's own edit: the zombieman's firing frame, not bright in vanilla.
    assert.equal(FULLBRIGHT_FRAMES.has('POSSF'), false);
    apply(`Frame 185\nSprite subnumber = 32773\nFrame ${stateNamed('S_CANDLESTIK')}\nSprite subnumber = 0\n`);
    assert.equal(FULLBRIGHT_FRAMES.has('POSSF'), true);
    assert.equal(FULLBRIGHT_FRAMES.has('CANDA'), false);
    resetDehacked();
    assert.equal(FULLBRIGHT_FRAMES.has('POSSF'), false);
    assert.equal(FULLBRIGHT_FRAMES.has('CANDA'), true);
  });

  /**
   * `S_GIBS` is reached by name, not by walking a `mobjinfo` chain — no thing's states point at it
   * — so it is the one derived pose that could silently miss a patch. docs/specials.md § Crushed
   * corpses.
   */
  test('a repointed S_GIBS moves what a crushed corpse is drawn as', () => {
    assert.deepEqual({ ...CORPSE_GIB }, { sprite: 'POL5', frames: ['A'] });
    // `SPR_SARG` with frame letter C — the demon's own art, standing in for the pool.
    apply(`Frame ${stateNamed('S_GIBS')}\nSprite number = 39\nSprite subnumber = 2\n`);
    assert.deepEqual({ ...CORPSE_GIB }, { sprite: 'SARG', frames: ['C'] });
    resetDehacked();
    assert.deepEqual({ ...CORPSE_GIB }, { sprite: 'POL5', frames: ['A'] });
  });

  test("the barrel's blast delay follows A_Explode's place in its patched chain", () => {
    assert.equal(tics(BARREL_CHAIN.explodeDelaySeconds), 15);
    apply(`Frame ${stateNamed('S_BEXP')}\nDuration = 1\n`);
    assert.equal(tics(BARREL_CHAIN.explodeDelaySeconds), 11);
    resetDehacked();
    assert.equal(tics(BARREL_CHAIN.explodeDelaySeconds), 15);
  });

  test("a repointed attack chain fires the action's own attack, not a retimed old one", () => {
    // S_POSS_ATK2 is where the zombieman's `A_PosAttack` sits: hand it the cyberdemon's rocket.
    assert.equal(MONSTER_STATS[ThingType.zombieman].ranged!.projectile, undefined);
    apply(`[CODEPTR]\nFrame ${stateNamed('S_POSS_ATK2')} = A_CyberAttack\n`);
    const ranged = MONSTER_STATS[ThingType.zombieman].ranged!;
    // The cyberdemon's roll and missile, whole — splash included, since that is the attack.
    assert.equal(ranged.projectile!.sprite, 'MISL');
    assert.deepEqual(ranged.projectile!.splash, MONSTER_STATS[ThingType.cyberdemon].ranged!.projectile!.splash);
    assert.equal(ranged.diceMult, MONSTER_STATS[ThingType.cyberdemon].ranged!.diceMult);
    // Timed by the chain it now sits in, which is still the zombieman's own.
    assert.equal(tics(ranged.duration), 26);
    resetDehacked();
    assert.equal(MONSTER_STATS[ThingType.zombieman].ranged!.projectile, undefined);
  });

  test('an attack chain whose firing action is cleared fires nothing at all', () => {
    apply(`[CODEPTR]\nFrame ${stateNamed('S_POSS_ATK2')} = A_NULL\n`);
    assert.equal(MONSTER_STATS[ThingType.zombieman].ranged, null);
    resetDehacked();
    assert.notEqual(MONSTER_STATS[ThingType.zombieman].ranged, null);
  });

  test('a repoint to an action that is not an attack leaves the attack alone', () => {
    // `A_FaceTarget` is a wind-up, not a shot: the chain keeps firing what it fired, one state later.
    const before = structuredClone(MONSTER_STATS[ThingType.zombieman].ranged);
    apply(`[CODEPTR]\nFrame ${stateNamed('S_POSS_ATK3')} = A_FaceTarget\n`);
    assert.deepEqual(MONSTER_STATS[ThingType.zombieman].ranged, before);
  });

  test('a repointed attack takes the owning type as the patch left it, not as vanilla wrote it', () => {
    // `Thing 34` is MT_ROCKET, the missile `A_CyberAttack` launches. Retuning it and then
    // borrowing the action gets the retuned figure: in vanilla the two share one `mobjinfo`, so
    // the patched reading is the faithful one.
    apply(`Thing 34\nMissile damage = 40\n\n[CODEPTR]\nFrame ${stateNamed('S_POSS_ATK2')} = A_CyberAttack\n`);
    assert.equal(MONSTER_STATS[ThingType.zombieman].ranged!.diceMult, 40);
  });

  test("MBF's A_Scratch is an attack of its own: misc1 flat damage, misc2 the swing's sound", () => {
    // S_SARG_ATK2 is where the demon bites. MBF reads the damage off the state, not off a roll,
    // so a one-sided die is how a flat figure is written into `AttackStats`.
    apply(
      `Frame ${stateNamed('S_SARG_ATK2')}\nUnknown 1 = 50\nUnknown 2 = 30\n` +
        `\n[CODEPTR]\nFrame ${stateNamed('S_SARG_ATK2')} = A_Scratch\n`,
    );
    const melee = MONSTER_STATS[ThingType.demon].melee!;
    assert.equal(melee.diceSides, 1);
    assert.equal(melee.diceMult, 50);
    assert.equal(MONSTER_STATS[ThingType.demon].sounds.melee, SFX_ORDER[30]);
    resetDehacked();
    assert.equal(MONSTER_STATS[ThingType.demon].melee!.diceSides, 10);
  });

  test("MBF's A_PlaySound becomes the sound of whichever chain it sits in", () => {
    apply(
      `Frame ${stateNamed('S_SARG_DIE2')}\nUnknown 1 = 22\n` +
        `\n[CODEPTR]\nFrame ${stateNamed('S_SARG_DIE2')} = A_PlaySound\n`,
    );
    assert.equal(MONSTER_STATS[ThingType.demon].sounds.death, SFX_ORDER[22]);
    resetDehacked();
    assert.equal(MONSTER_STATS[ThingType.demon].sounds.death, 'sgtdth');
  });

  test("MBF's A_Spawn on a death chain is what this engine models as a drop", () => {
    // `misc1` is a 1-based `mobjinfo` index: 65 is MT_MISC17, the box of bullets.
    apply(
      `Frame ${stateNamed('S_SARG_DIE3')}\nUnknown 1 = 65\n` +
        `\n[CODEPTR]\nFrame ${stateNamed('S_SARG_DIE3')} = A_Spawn\n`,
    );
    assert.equal(MONSTER_DROPS[ThingType.demon], ThingType.boxOfBullets);
    resetDehacked();
    assert.equal(ThingType.demon in MONSTER_DROPS, false);
  });

  test('a decoration repointed onto another spawn chain takes its sprite and loop', () => {
    // Thing 100 is the plain candle (34); its spawn aimed at the evil eye's loop.
    apply(`Thing 100\nInitial frame = ${stateNamed('S_EVILEYE')}\n`);
    assert.equal(THING_SPRITES[34], 'CEYE');
    assert.deepEqual(THING_ANIM_FRAMES[34], { frames: ['A', 'B', 'C', 'B'], frameSeconds: THING_ANIM_FRAMES[ThingType.evilEye].frameSeconds });
    resetDehacked();
    assert.equal(THING_SPRITES[34], 'CAND');
    assert.equal(34 in THING_ANIM_FRAMES, false);
  });

  test('[SPRITES] renames which lumps a sprite name resolves to, at bank-build time', () => {
    const lumps = ['S_START', 'ZOMBA1', 'ZOMBB2B8', 'POSSA1', 'S_END'];
    apply('[SPRITES]\nPOSS = ZOMB\n');
    const bank = new SpriteBank(new Wad([wadFile('PWAD', 'x.wad', lumps)]));
    // Things asking for POSS get the ZOMB lumps; ZOMB's own name still works too.
    assert.equal(bank.lookup('POSS', 'A', 1)?.lump, 'ZOMBA1');
    assert.deepEqual(bank.lookup('POSS', 'B', 8), { lump: 'ZOMBB2B8', flip: true });
    assert.equal(bank.lookup('ZOMB', 'A', 1)?.lump, 'ZOMBA1');
    resetDehacked();
    assert.equal(new SpriteBank(new Wad([wadFile('PWAD', 'x.wad', lumps)])).lookup('POSS', 'A', 1)?.lump, 'POSSA1');
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
      cheatMessages: { ...CHEAT_MESSAGES },
      sprites: { ...THING_SPRITES },
      anims: structuredClone(THING_ANIM_FRAMES),
      walk: structuredClone(MONSTER_WALK_FRAMES_OVERRIDE),
      death: structuredClone(MONSTER_DEATH_FRAMES),
      deathSprite: structuredClone(MONSTER_DEATH_SPRITE_OVERRIDE),
      pain: structuredClone(MONSTER_PAIN_FRAMES),
      attack: structuredClone(MONSTER_ATTACK_POSE),
      raise: structuredClone(MONSTER_RAISE_FRAMES),
      vanishes: [...MONSTER_CORPSE_VANISHES].sort(),
      flight: structuredClone(PROJECTILE_FRAMES),
      impacts: structuredClone(IMPACT_EFFECTS),
      sounds: structuredClone(PROJECTILE_SOUNDS),
      barrel: structuredClone(BARREL_CHAIN),
      fullbright: [...FULLBRIGHT_FRAMES].sort(),
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
        '[STRINGS]\nOB_CRUSH = %o was squished.\nPD_BLUEK = Locked, obviously\nSTSTR_NCON = Through walls now',
        '[SOUNDS]\npistol = DSNEWGUN',
        '[MUSIC]\nrunnin = D_OTHER',
        // The frame walker's sinks: a repointed death, a retimed pain, a shortened death chain that
        // vanishes, a renamed missile, a brightened frame, the barrel, a candle on another loop.
        'Thing 2\nDeath frame = 462\nFirst moving frame = 951',
        `Frame ${stateNamed('S_POSS_PAIN')}\nDuration = 20\nSprite subnumber = 32773`,
        `Frame ${stateNamed('S_TROO_DIE2')}\nNext frame = 0`,
        `Frame ${stateNamed('S_TBALL1')}\nSprite number = 26`,
        `Frame ${stateNamed('S_BEXP')}\nDuration = 1`,
        `Thing 100\nInitial frame = ${stateNamed('S_EVILEYE')}`,
        '[SPRITES]\nPOSS = ZOMB',
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
    assert.deepEqual(CHEAT_MESSAGES, before.cheatMessages);
    assert.deepEqual(THING_SPRITES, before.sprites);
    assert.deepEqual(THING_ANIM_FRAMES, before.anims);
    assert.deepEqual(MONSTER_WALK_FRAMES_OVERRIDE, before.walk);
    assert.deepEqual(MONSTER_DEATH_FRAMES, before.death);
    assert.deepEqual(MONSTER_DEATH_SPRITE_OVERRIDE, before.deathSprite);
    assert.deepEqual(MONSTER_PAIN_FRAMES, before.pain);
    assert.deepEqual(MONSTER_ATTACK_POSE, before.attack);
    assert.deepEqual(MONSTER_RAISE_FRAMES, before.raise);
    assert.deepEqual([...MONSTER_CORPSE_VANISHES].sort(), before.vanishes);
    assert.deepEqual(PROJECTILE_FRAMES, before.flight);
    assert.deepEqual(IMPACT_EFFECTS, before.impacts);
    assert.deepEqual(PROJECTILE_SOUNDS, before.sounds);
    assert.deepEqual(BARREL_CHAIN, before.barrel);
    assert.deepEqual([...FULLBRIGHT_FRAMES].sort(), before.fullbright);
    // The rename sink has no table of its own — a rebuilt bank drawing POSS from its own lumps is
    // what "no [SPRITES] rename survived" looks like from outside.
    const bank = new SpriteBank(new Wad([wadFile('PWAD', 'x.wad', ['S_START', 'ZOMBA1', 'POSSA1', 'S_END'])]));
    assert.equal(bank.lookup('POSS', 'A', 1)?.lump, 'POSSA1');
  });

  test('the pristine snapshot is deep, so a reset hands back no patched sub-object', () => {
    resetDehacked();
    const originalSpeed = MONSTER_STATS[ThingType.imp].ranged!.projectile!.speed;
    // Two rounds: a shallow snapshot would survive the first reset and fail the second, because
    // the "pristine" nested object would itself have been mutated by the first patch.
    const originalDeath = [...MONSTER_DEATH_FRAMES[ThingType.zombieman]];
    for (let round = 0; round < 2; round++) {
      apply('Thing 32\nSpeed = 1310720\nThing 2\nDeath frame = 462\n');
      assert.equal(MONSTER_STATS[ThingType.imp].ranged!.projectile!.speed, 700);
      assert.equal(MONSTER_DEATH_FRAMES[ThingType.zombieman][0], 'N');
      resetDehacked();
      assert.equal(MONSTER_STATS[ThingType.imp].ranged!.projectile!.speed, originalSpeed);
      assert.deepEqual(MONSTER_DEATH_FRAMES[ThingType.zombieman], originalDeath);
    }
  });
});
