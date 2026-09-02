import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFrameTables,
  patchStates,
  pristineFrameTables,
  walkChain,
} from '../../src/game/dehacked/frames.ts';
import {
  FF_FULLBRIGHT, frameLetter, freshState, MBF_STATES_START, MOBJ_STATES, SPRITE_NAMES, STATES,
} from '../../src/game/dehacked/states.ts';
import { MOBJ_INFO, WEAPON_ACTION_SOURCES, WEAPON_ORDER } from '../../src/game/dehacked/tables.ts';
import { WEAPONS } from '../../src/game/weapons.ts';
import {
  CORPSE_GIB,
  FULLBRIGHT_FRAMES,
  MONSTER_ATTACK_POSE,
  MONSTER_CORPSE_VANISHES,
  MONSTER_DEATH_FRAMES,
  MONSTER_IDLE_FRAMES,
  MONSTER_PAIN_FRAMES,
  MONSTER_RAISE_FRAMES,
  MONSTER_WALK_FRAMES,
  MONSTER_WALK_FRAMES_OVERRIDE,
  MONSTER_XDEATH_FRAMES,
  THING_ANIM_FRAMES,
  THING_SPRITES,
} from '../../src/game/things/tables.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { BARREL_CHAIN } from '../../src/game/things/defs.ts';
import { IMPACT_EFFECTS, PROJECTILE_FRAMES } from '../../src/game/spritefx/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import {
  GOLDEN_ANIMS,
  GOLDEN_BARREL,
  GOLDEN_GIBS,
  GOLDEN_MISSILES,
  GOLDEN_MONSTERS,
  GOLDEN_SPRITES,
  GOLDEN_WEAPONS,
} from '../fixtures/frametables.ts';

const round3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);
const inTics = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? null : Math.round(seconds * 35));
const rowSpeed = (dn: number) => MOBJ_INFO.find((r) => r.doomednum === dn)!.speed;
const stateNamed = (name: string) => STATES.findIndex((row) => row[5] === name);
const rowOf = (type: string) => MOBJ_INFO.findIndex((row) => row.type === type);

/**
 * The entries the walker reads differently from the hand-curated tables, each with its reason.
 * The diff-against-pristine write rule (docs/dehacked.md § Frames) is what keeps these at their
 * shipped values; this list is the whole of what that rule is protecting, and a new row here is a
 * decision, never a shrug.
 */
const EXCEPTIONS = new Map<string, string>([
  // The shipped 35 tics include the two `A_FaceTarget` states ahead of the `A_CPosRefire` loop;
  // the chaingunner's and the spiders' entries count only the loop, which is the walker's rule.
  // The pose and windup follow the same span, so all three disagree together.
  ['MT_WOLFSS ranged.duration', 'includes the windup ahead of the refire loop'],
  ['MT_WOLFSS ranged pose', 'spans the whole chain, not just the refire loop'],
  ['MT_WOLFSS windup', 'measured from the whole chain, not the refire loop'],
  // Two attacks that never reach the burst timer `startDelaySeconds` is read through — the lost
  // soul's charge and the pain elemental's spawn both return straight out of `beginRangedAttack`,
  // so their `MONSTER_STATS` entries deliberately carry no windup for the walker to match.
  ['MT_SKULL windup', 'a charge attack; the burst timer never runs'],
  ['MT_PAIN windup', 'a spawn attack; the burst timer never runs'],
  // `MT_HEAD`'s `meleestate` is `S_NULL`: `A_HeadAttack` bites from inside the missile chain, and
  // this engine models that bite as a melee block of the same length. The walker has no chain to
  // read it from.
  ['MT_HEAD melee.duration', 'meleestate is S_NULL; the bite lives in the missile chain'],
  ['MT_HEAD melee windup', 'meleestate is S_NULL; the bite lives in the missile chain'],
]);

/**
 * The anchor: the walker's reading of vanilla's own frame table must be the shipped tables. One
 * test validates the transcription and every chain-walking rule at once, and its exceptions list is
 * the complete inventory of where the hand-curated tables and `info.c` part ways.
 * See docs/dehacked.md § Frames.
 */
describe('DEHACKED · the frame walker reproduces the shipped tables', () => {
  test('deriving from pristine states[] equals the tables, bar the listed exceptions', () => {
    const t = pristineFrameTables();
    const mismatches = new Map<string, { shipped: unknown; derived: unknown }>();
    const cmp = (label: string, shipped: unknown, derived: unknown) => {
      if (JSON.stringify(shipped) !== JSON.stringify(derived)) mismatches.set(label, { shipped, derived });
    };

    let monsters = 0;
    for (const [key, m] of Object.entries(t.monsters)) {
      monsters++;
      const dn = Number(key);
      const n = MOBJ_INFO.find((r) => r.doomednum === dn)!.type;
      const g = GOLDEN_MONSTERS[n];
      assert.ok(g, `${n} (doomednum ${dn}) was derived but has no golden row`);
      cmp(`${n} sprite`, g.sprite, m.sprite);
      cmp(`${n} walk`, g.walk, m.walk);
      cmp(`${n} idle`, g.idle, m.idle);
      cmp(`${n} death`, g.death, m.death);
      cmp(`${n} xdeath`, g.xdeath, m.xdeath);
      // No stock monster dies in another type's sprite.
      cmp(`${n} deathSprite`, null, m.deathSprite);
      cmp(`${n} vanishes`, g.vanishes, m.vanishes);
      cmp(`${n} pain`, g.pain, m.pain);
      cmp(`${n} melee pose`, g.meleePose, m.meleePose);
      cmp(`${n} ranged pose`, g.rangedPose, m.rangedPose);
      cmp(`${n} raise`, g.raise, m.raise);
      if (g.painTics === null) continue; // an INERT_SHOOTABLE type: art only, no stat block
      cmp(`${n} painDuration`, g.painTics, inTics(m.painDuration));
      cmp(`${n} melee.duration`, g.meleeTics, inTics(m.meleeDuration));
      cmp(`${n} ranged.duration`, g.rangedTics, inTics(m.rangedDuration));
      cmp(`${n} melee windup`, g.meleeWindupTics, inTics(m.meleeDelay));
      cmp(`${n} windup`, g.windupTics, inTics(m.rangedDelay));
      // A volley's shape. The cyberdemon's interval was 12 tics here — one state's length rather
      // than the gap between two `A_CyberAttack` calls — until this comparison was added.
      cmp(`${n} shots`, g.shots, m.rangedShots > 1 ? m.rangedShots : null);
      cmp(`${n} shotInterval`, g.shotIntervalTics, inTics(m.rangedInterval));
      cmp(`${n} chaseInterval`, g.chaseSeconds, m.chase ? round3(m.chase.interval) : null);
      cmp(`${n} speed`, g.speed, m.chase ? Math.round(rowSpeed(dn) * m.chase.factor * 10) / 10 : null);
    }
    assert.equal(monsters, Object.keys(GOLDEN_MONSTERS).length, 'every golden monster row was derived');

    const derivedSprites: Record<number, string> = {};
    for (const [key, sprite] of Object.entries(t.sprites)) derivedSprites[Number(key)] = sprite;
    for (const [key, m] of Object.entries(t.monsters)) derivedSprites[Number(key)] = m.sprite!;
    cmp('THING_SPRITES', GOLDEN_SPRITES, derivedSprites);

    const derivedAnims: Record<number, { frames: string[]; tics: number }> = {};
    for (const [key, anim] of Object.entries(t.anims)) {
      if (anim) derivedAnims[Number(key)] = { frames: anim.frames, tics: inTics(anim.frameSeconds)! };
    }
    cmp('THING_ANIM_FRAMES', GOLDEN_ANIMS, derivedAnims);

    for (const [sprite, m] of Object.entries(t.missiles)) {
      cmp(`${sprite} flightSprite`, sprite, m.flightSprite);
      cmp(`${sprite} flight`, GOLDEN_MISSILES[sprite]?.flight ?? null, m.flight);
      cmp(`${sprite} impact`, GOLDEN_MISSILES[sprite]?.impact ?? null, m.impact);
    }
    assert.equal(Object.keys(t.missiles).length, 9);

    for (const [i, g] of GOLDEN_WEAPONS.entries()) {
      cmp(`weapon ${i} cooldown`, g.tics, inTics(t.weapons[i].cooldown));
      cmp(`weapon ${i} shots`, g.shots, t.weapons[i].shots);
    }
    assert.equal(Object.keys(t.weapons).length, GOLDEN_WEAPONS.length, 'every weapon chain was walked');

    assert.ok(t.barrel, 'the barrel was derived');
    cmp('barrel', GOLDEN_BARREL, {
      idleFrames: t.barrel.idleFrames,
      idleTics: inTics(t.barrel.idleFrameSeconds),
      deathSprite: t.barrel.deathSprite,
      deathFrames: t.barrel.deathFrames,
      explodeTics: inTics(t.barrel.explodeDelaySeconds),
    });

    assert.ok(t.gibs, 'S_GIBS was reached, though no mobjinfo chain points at it');
    cmp('gibs', GOLDEN_GIBS, t.gibs);

    const unexpected = [...mismatches].filter(([label]) => !EXCEPTIONS.has(label));
    assert.deepEqual(unexpected, [], 'the walker and the shipped tables disagree somewhere not in EXCEPTIONS');
    const stale = [...EXCEPTIONS.keys()].filter((label) => !mismatches.has(label));
    assert.deepEqual(stale, [], 'an EXCEPTIONS row no longer differs — remove it');
  });

  test('the fullbright set is vanilla’s: torches, keys, the lost soul, projectiles — not the zombieman’s gun', () => {
    for (const key of ['CANDA', 'TREDA', 'TREDD', 'SKULA', 'SKULB', 'BAL1A', 'MISLB', 'BKEYB', 'PLAYF', 'BOSFA', 'PUFFA']) {
      assert.ok(FULLBRIGHT_FRAMES.has(key), `${key} should be fullbright`);
    }
    for (const key of ['POSSE', 'POSSF', 'TROOA', 'PUFFC', 'PLAYA', 'BAR1A']) {
      assert.equal(FULLBRIGHT_FRAMES.has(key), false, `${key} should take its sector light`);
    }
  });

  test('where vanilla splits a letter across bright and dim states, the states vote and a tie is bright', () => {
    // The whole stock list of splits — the per-(sprite, letter) set is an approximation of the
    // per-state bit exactly here, and nowhere else.
    // Vanilla's rows only, the same span `rebuildFullbrightFrames` votes over: MBF's appended
    // states are dummies nothing reaches until a `Frame` record writes one.
    const byKey = new Map<string, { on: number; off: number }>();
    for (const [sprite, frame] of STATES.slice(0, MBF_STATES_START)) {
      const key = SPRITE_NAMES[sprite] + frameLetter(frame);
      const tally = byKey.get(key) ?? byKey.set(key, { on: 0, off: 0 }).get(key)!;
      if (frame & FF_FULLBRIGHT) tally.on++;
      else tally.off++;
    }
    const split = [...byKey].filter(([, t]) => t.on && t.off).map(([key]) => key).sort();
    assert.deepEqual(split, ['BSPIA', 'CPOSE', 'CPOSF', 'PAINH', 'PAINI', 'PAINJ', 'PAINK', 'PAINL', 'PAINM', 'SPIDA']);
    // The spiders' `A_FaceTarget` frame is their walk letter: one bright state against the
    // stand and run states — dim, or they would glow the whole way across a room.
    assert.equal(FULLBRIGHT_FRAMES.has('SPIDA'), false);
    assert.equal(FULLBRIGHT_FRAMES.has('BSPIA'), false);
    // The chaingunner's two firing frames alternate bright and dim through its refire loop, and
    // the pain elemental's death frames are its (never-played) raise frames dimmed: ties, bright.
    assert.equal(FULLBRIGHT_FRAMES.has('CPOSE'), true);
    assert.equal(FULLBRIGHT_FRAMES.has('CPOSF'), true);
    assert.equal(FULLBRIGHT_FRAMES.has('PAINH'), true);
  });

  test('each of vanilla\u2019s nine fire chains names its own weapon through the bridge', () => {
    // The 1:1 the applier rests on: what a chain fires is enough to say whose shot it is. A tenth
    // action, or two weapons sharing one, would make a repoint borrow the wrong `WeaponDef`.
    const t = pristineFrameTables();
    for (const [i, id] of WEAPON_ORDER.entries()) {
      const action = t.weapons[i].action;
      assert.ok(action, `${id} fires nothing`);
      assert.equal(WEAPON_ACTION_SOURCES[action], id);
    }
    assert.equal(Object.keys(WEAPON_ACTION_SOURCES).length, WEAPON_ORDER.length);
  });
});

/** The chain walker and the deriver against hand-built edits. docs/dehacked.md § Frames. */
describe('DEHACKED · walking patched chains', () => {
  test('a chain ends where info.c ends it: a loop, S_NULL, a held frame, or the walk cycle', () => {
    const troop = MOBJ_STATES[rowOf('MT_TROOP')];
    const see = walkChain(STATES, troop.see);
    assert.equal(see.cycleAt, 0, 'the imp’s run loops back to its first state');
    assert.equal(see.indices.length, 8);
    const death = walkChain(STATES, troop.death);
    assert.equal(death.holds, true);
    assert.equal(death.exitsToNull, false);
    const skull = MOBJ_STATES[rowOf('MT_SKULL')];
    assert.equal(walkChain(STATES, skull.death).exitsToNull, true);
    const pain = walkChain(STATES, troop.pain, new Set(see.indices));
    assert.equal(pain.indices.length, 2, 'S_TROO_PAIN, S_TROO_PAIN2, then back into the run');
    assert.deepEqual(walkChain(STATES, 0).indices, []);
  });

  test('patchStates grows the table, and every row it grew into starts out fresh', () => {
    // The patch defines 2000 and 2001 and names nothing else past the shipped table; the doubling
    // brings 2152 rows, and the ones between are what a `Next frame` landing there would find.
    const patched = patchStates(
      [{ index: 2000, spriteNum: 29, duration: 4, nextFrame: 2001 }, { index: 2001, duration: 6 }],
      [],
      [],
      [],
      2152,
    );
    assert.equal(patched.states.length, 2152);
    assert.deepEqual(patched.states[2000], [29, 0, 4, '', 2001, '']);
    assert.deepEqual(patched.states[2001], [freshState(2001)[0], 0, 6, '', 2001, '']);
    assert.deepEqual(patched.states[2151], freshState(2151));
    // A chain into an untouched row stops there: it holds forever and steps to itself.
    const chain = walkChain(patched.states, 2000);
    assert.deepEqual(chain.indices, [2000, 2001]);
    // Vanilla's own rows are untouched by the growth.
    assert.deepEqual(patched.states.slice(0, STATES.length), STATES.map((row) => [...row]));
  });

  test('a monster spawned onto extended states derives its art from them', () => {
    // The shape the probe patch uses: the zombieman's spawn and walk moved onto rows the patch
    // grew the table into, drawing another sprite entirely.
    const zombie = rowOf('MT_POSSESSED') + 1;
    const patched = patchStates(
      [
        { index: 2000, spriteNum: SPRITE_NAMES.indexOf('BON1'), subNumber: 0, duration: 6, nextFrame: 2001 },
        { index: 2001, spriteNum: SPRITE_NAMES.indexOf('BON1'), subNumber: 1, duration: 6, nextFrame: 2000 },
      ],
      [{ index: zombie, states: { spawn: 2000, see: 2000 } }],
      [],
      [],
      2152,
    );
    const m = deriveFrameTables(patched).monsters[ThingType.zombieman];
    assert.equal(m.sprite, 'BON1');
    assert.deepEqual(m.walk, ['A', 'B']);
  });

  test('repointing a death frame borrows the other sprite and its letters', () => {
    // EPIC.WAD's shape: a hanging body's death aimed at the imp's gib chain — on a shootable
    // monster here, so the derivation is visible.
    const zombie = rowOf('MT_POSSESSED') + 1;
    const patched = patchStates([], [{ index: zombie, states: { death: stateNamed('S_TROO_XDIE1') } }]);
    const t = deriveFrameTables(patched);
    const m = t.monsters[ThingType.zombieman];
    assert.deepEqual(m.death, ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U']);
    assert.deepEqual(m.deathSprite, { death: 'TROO' });
    assert.equal(m.vanishes, false);
    // And a death pointed at S_NULL is no death chain at all.
    const gone = deriveFrameTables(patchStates([], [{ index: zombie, states: { death: 0 } }]));
    assert.equal(gone.monsters[ThingType.zombieman].death, null);
  });

  test('a Duration edit moves the chain’s summed tics, a Next frame edit its shape', () => {
    const pain = stateNamed('S_POSS_PAIN');
    let t = deriveFrameTables(patchStates([{ index: pain, duration: 20 }], []));
    assert.equal(round3(t.monsters[ThingType.zombieman].painDuration), round3(23 / 35));
    // Cutting the imp's death after its second state: two letters, and the chain no longer holds
    // but expires into S_NULL, so the corpse vanishes.
    const die2 = stateNamed('S_TROO_DIE2');
    t = deriveFrameTables(patchStates([{ index: die2, nextFrame: 0 }], []));
    assert.deepEqual(t.monsters[ThingType.imp].death, ['I', 'J']);
    assert.equal(t.monsters[ThingType.imp].vanishes, true);
  });

  test('the walk loop’s tics set the chase clock and the speed factor', () => {
    // Halving every S_POSS_RUN state from 4 to 2 tics doubles the chase rate — what fast monsters
    // do to the demon, applied by hand to the zombieman.
    const run1 = stateNamed('S_POSS_RUN1');
    const edits = Array.from({ length: 8 }, (_, i) => ({ index: run1 + i, duration: 2 }));
    const before = pristineFrameTables().monsters[ThingType.zombieman].chase!;
    const after = deriveFrameTables(patchStates(edits, [])).monsters[ThingType.zombieman].chase!;
    assert.equal(round3(after.interval), round3(before.interval / 2));
    assert.equal(round3(after.factor), round3(before.factor * 2));
  });

  test('a Sprite number edit on a missile’s flight state renames the missile', () => {
    const tball = stateNamed('S_TBALL1');
    const sprite = 41; // SPR_BAL7
    const t = deriveFrameTables(patchStates([{ index: tball, spriteNum: sprite }, { index: tball + 1, spriteNum: sprite }], []));
    assert.equal(t.missiles.BAL1.flightSprite, 'BAL7');
    assert.deepEqual(t.missiles.BAL1.flight, ['A', 'B']);
    assert.deepEqual(t.missiles.BAL1.impact, { sprite: 'BAL1', frames: ['C', 'D', 'E'] });
  });

  test('a decoration’s loop is read as written, at the loop’s flat rate', () => {
    // The evil eye, with its third state held twice as long: A,B,C,B at the mean.
    const ceye = stateNamed('S_EVILEYE');
    const t = deriveFrameTables(patchStates([{ index: ceye + 2, duration: 12 }], []));
    const anim = t.anims[ThingType.evilEye]!;
    assert.deepEqual(anim.frames, ['A', 'B', 'C', 'B']);
    assert.equal(Math.round(anim.frameSeconds * 35), 7); // (6+6+12+6)/4 = 7.5, ties down
  });

  test('the barrel’s blast delay follows A_Explode’s state', () => {
    const bexp = stateNamed('S_BEXP');
    const t = deriveFrameTables(patchStates([{ index: bexp, duration: 1 }], []));
    assert.equal(Math.round(t.barrel!.explodeDelaySeconds! * 35), 11);
  });
});

/**
 * The other half of the anchor. The test above proves the *walker* reads vanilla's states the way
 * the hand transcription did, bar `EXCEPTIONS`; this one proves the tables the engine actually
 * animates from are the shipped reading — **exceptions included**, because each one is restored by
 * a documented override next to its table. Without this, a divergence the walker is *expected* to
 * have would reach the game silently: deriving `MONSTER_ATTACK_POSE` dropped the Wolfenstein SS's
 * wind-up frame exactly that way, and the anchor test passed throughout.
 */
describe('DEHACKED · the derived tables the engine uses are the shipped reading', () => {
  test('every frame-derived table matches the golden transcription exactly', () => {
    const wrong = new Map<string, { shipped: unknown; live: unknown }>();
    const cmp = (label: string, shipped: unknown, live: unknown) => {
      if (JSON.stringify(shipped) !== JSON.stringify(live)) wrong.set(label, { shipped, live });
    };

    for (const [name, g] of Object.entries(GOLDEN_MONSTERS)) {
      const dn = MOBJ_INFO.find((r) => r.type === name)!.doomednum;
      cmp(`${name} sprite`, g.sprite, THING_SPRITES[dn]);
      cmp(`${name} walk`, g.walk, MONSTER_WALK_FRAMES_OVERRIDE[dn] ?? (MONSTER_IDLE_FRAMES[dn] ? [] : MONSTER_WALK_FRAMES));
      cmp(`${name} idle`, g.idle, MONSTER_IDLE_FRAMES[dn] ?? null);
      cmp(`${name} death`, g.death, MONSTER_DEATH_FRAMES[dn] ?? null);
      cmp(`${name} xdeath`, g.xdeath, MONSTER_XDEATH_FRAMES[dn] ?? null);
      cmp(`${name} vanishes`, g.vanishes, MONSTER_CORPSE_VANISHES.has(dn));
      cmp(`${name} pain`, g.pain, MONSTER_PAIN_FRAMES[dn] ?? null);
      cmp(`${name} raise`, g.raise, MONSTER_RAISE_FRAMES[dn] ?? null);
      cmp(`${name} meleePose`, g.meleePose, MONSTER_ATTACK_POSE[dn]?.melee ?? null);
      cmp(`${name} rangedPose`, g.rangedPose, MONSTER_ATTACK_POSE[dn]?.ranged ?? null);

      const stats = MONSTER_STATS[dn];
      if (g.painTics === null) {
        assert.ok(!stats, `${name} is INERT_SHOOTABLE and should carry no stat block`);
        continue;
      }
      cmp(`${name} painDuration`, g.painTics, inTics(stats.painDuration));
      cmp(`${name} melee.duration`, g.meleeTics, inTics(stats.melee?.duration));
      cmp(`${name} ranged.duration`, g.rangedTics, inTics(stats.ranged?.duration));
      cmp(`${name} melee windup`, g.meleeWindupTics, inTics(stats.melee?.startDelaySeconds));
      cmp(`${name} windup`, g.windupTics, inTics(stats.ranged?.startDelaySeconds));
      cmp(`${name} shots`, g.shots, stats.ranged?.shots ?? null);
      cmp(`${name} shotInterval`, g.shotIntervalTics, inTics(stats.ranged?.shotInterval));
      cmp(`${name} chaseInterval`, g.chaseSeconds, round3(stats.chaseInterval));
      cmp(`${name} speed`, g.speed, stats.speed);
    }

    cmp('THING_SPRITES', GOLDEN_SPRITES, THING_SPRITES);
    const liveAnims: Record<number, { frames: string[]; tics: number }> = {};
    for (const [key, a] of Object.entries(THING_ANIM_FRAMES)) liveAnims[Number(key)] = { frames: a.frames, tics: inTics(a.frameSeconds)! };
    cmp('THING_ANIM_FRAMES', GOLDEN_ANIMS, liveAnims);
    for (const [sprite, g] of Object.entries(GOLDEN_MISSILES)) {
      cmp(`${sprite} flight`, g.flight, PROJECTILE_FRAMES[sprite] ?? null);
      cmp(`${sprite} impact`, g.impact, IMPACT_EFFECTS[sprite] ?? null);
    }
    for (const [i, id] of WEAPON_ORDER.entries()) {
      cmp(`${id} cooldown`, GOLDEN_WEAPONS[i].tics, inTics(WEAPONS[id].cooldown));
    }

    cmp('gibs', GOLDEN_GIBS, { sprite: CORPSE_GIB.sprite, frames: CORPSE_GIB.frames });
    cmp('barrel', GOLDEN_BARREL, {
      idleFrames: BARREL_CHAIN.idleFrames,
      idleTics: inTics(BARREL_CHAIN.idleFrameSeconds),
      deathSprite: BARREL_CHAIN.deathSprite,
      deathFrames: BARREL_CHAIN.deathFrames,
      explodeTics: inTics(BARREL_CHAIN.explodeDelaySeconds),
    });

    assert.deepEqual([...wrong], [], 'a derived table reached the engine differing from the shipped reading');
  });
});
