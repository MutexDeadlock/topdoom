import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSS_DEATH_TYPES,
  COUNTKILL_TYPES,
  MONSTER_DEATH_FRAMES,
  MONSTER_HEALTH,
  MONSTER_TYPES,
  SPAWN_CUBE_MONSTERS,
  THING_SPRITES,
} from '../../src/game/thingdefs.ts';
import { INERT_SHOOTABLE, MONSTER_STATS } from '../../src/game/monsters.ts';
import { WEAPONS, WEAPON_CYCLE, WEAPON_SLOTS } from '../../src/game/weapons.ts';
import { IMPACT_EFFECTS, PROJECTILE_SOUNDS } from '../../src/game/effectdefs.ts';
import { SFX_NAMES } from '../../src/audio/sfx.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { SfxId } from '../../src/audio/sfx.ts';

/**
 * Cross-checks between the tables transcribed out of vanilla. These cannot
 * verify *fidelity* — only `info.c` can, and CLAUDE.md's rule about citing it
 * still governs. What they catch is an **incomplete** transcription: a monster
 * added to one table and forgotten in the four others that have to know about
 * it, which is the documented way several shipped bugs got in.
 */

const numericKeys = (o: object): number[] => Object.keys(o).map(Number);
const missing = (needles: Iterable<number>, haystack: Set<number>): number[] =>
  [...needles].filter((n) => !haystack.has(n));

describe('Vanilla tables · monsters', () => {
  test('every monster type has a sprite', () => {
    assert.deepEqual(missing(MONSTER_TYPES, new Set(numericKeys(THING_SPRITES))), []);
  });

  test('every monster type has stats, or is inert-shootable — exactly one of the two', () => {
    // The split is documented on INERT_SHOOTABLE: Commander Keen and the Icon of
    // Sin are shootable but have no AI. A type in neither table is a monster
    // that spawns and then does nothing.
    const withStats = new Set(numericKeys(MONSTER_STATS));
    const inert = new Set(numericKeys(INERT_SHOOTABLE));

    assert.deepEqual(
      [...MONSTER_TYPES].filter((t) => !withStats.has(t) && !inert.has(t)),
      [],
      'types with neither',
    );
    assert.deepEqual(
      [...MONSTER_TYPES].filter((t) => withStats.has(t) && inert.has(t)),
      [],
      'types with both',
    );
    // And nothing in either table that is not a monster at all.
    assert.deepEqual(missing(withStats, MONSTER_TYPES), []);
    assert.deepEqual(missing(inert, MONSTER_TYPES), []);
  });

  test('every monster type has health and a death animation', () => {
    assert.deepEqual(missing(MONSTER_TYPES, new Set(numericKeys(MONSTER_HEALTH))), []);
    assert.deepEqual(missing(MONSTER_TYPES, new Set(numericKeys(MONSTER_DEATH_FRAMES))), []);
    for (const [type, hp] of Object.entries(MONSTER_HEALTH)) {
      assert.ok(hp > 0 && Number.isInteger(hp), `${type} has health ${hp}`);
    }
    for (const [type, frames] of Object.entries(MONSTER_DEATH_FRAMES)) {
      assert.ok(frames.length > 0, `${type} has an empty death animation`);
    }
  });

  test('the kill counter and the boss-death list only name real monsters', () => {
    assert.deepEqual(missing(COUNTKILL_TYPES, MONSTER_TYPES), []);
    for (const [map, types] of Object.entries(BOSS_DEATH_TYPES)) {
      for (const type of [types].flat()) {
        assert.ok(MONSTER_TYPES.has(type as number), `${map} names non-monster ${type}`);
      }
    }
  });

  test("the Icon of Sin's spawn table is an ordered, total partition of 0..255", () => {
    // `below` is an upper bound on a P_Random() roll, so the entries have to
    // ascend and the last has to cover the top of the range — a gap or an
    // out-of-order entry silently makes one monster unspawnable.
    let previous = -1;
    for (const entry of SPAWN_CUBE_MONSTERS) {
      assert.ok(entry.below > previous, `below ${entry.below} does not exceed ${previous}`);
      assert.ok(MONSTER_TYPES.has(entry.type), `spawns non-monster ${entry.type}`);
      previous = entry.below;
    }
    assert.equal(
      SPAWN_CUBE_MONSTERS[SPAWN_CUBE_MONSTERS.length - 1].below,
      256,
      'the last bucket must cover the top of the roll',
    );
  });

  test('every sound a monster can play exists in the sound table', () => {
    const known = new Set<string>(SFX_NAMES);
    for (const [type, stats] of Object.entries(MONSTER_STATS)) {
      const { walk, ...single } = stats.sounds;
      for (const [slot, id] of Object.entries(single)) {
        // NOTE: `sounds.walk` is `{sounds: SfxId[], interval}`, not an SfxId —
        // it is destructured out above rather than iterated, which would yield
        // "[object Object]".
        if (id) assert.ok(known.has(id), `monster ${type} ${slot}: unknown sound ${id}`);
      }
      for (const id of walk?.sounds ?? []) {
        assert.ok(known.has(id), `monster ${type} walk: unknown sound ${id}`);
      }
    }
    for (const [type, inert] of Object.entries(INERT_SHOOTABLE)) {
      assert.ok(known.has(inert.painSound), `inert ${type}: unknown ${inert.painSound}`);
      assert.ok(known.has(inert.deathSound), `inert ${type}: unknown ${inert.deathSound}`);
    }
  });
});

describe('Vanilla tables · weapons', () => {
  test('the weapon cycle and the keyboard slots each cover every weapon exactly once', () => {
    const all = Object.keys(WEAPONS).sort();

    assert.deepEqual([...WEAPON_CYCLE].sort(), all, 'WEAPON_CYCLE is a permutation');
    assert.equal(new Set(WEAPON_CYCLE).size, WEAPON_CYCLE.length, 'and has no duplicates');

    const slotted = WEAPON_SLOTS.flat();
    assert.deepEqual([...slotted].sort(), all, 'WEAPON_SLOTS covers every weapon');
    assert.equal(new Set(slotted).size, slotted.length, 'no weapon sits in two slots');
    // A weapon missing from either list is simply unreachable in play.
  });

  test('every weapon definition is internally consistent', () => {
    for (const [id, w] of Object.entries(WEAPONS)) {
      assert.ok(w.cooldown > 0, `${id} has cooldown ${w.cooldown}`);
      // Fire rates are summed state tics, so each must land on a whole tic.
      const tics = w.cooldown / DOOM_TIC;
      assert.ok(
        Math.abs(tics - Math.round(tics)) < 1e-9,
        `${id}'s cooldown is ${tics} tics, not a whole number of state tics`,
      );
      assert.ok(w.ammoPerShot >= 0 && Number.isInteger(w.ammoPerShot), `${id} ammoPerShot`);
      assert.ok(w.ammoType !== null || w.ammoPerShot === 0, `${id} spends ammo it has no type for`);
      assert.ok(w.iconLump.length > 0, `${id} has no icon lump`);
      assert.ok(w.spreadDeg >= 0 && w.slopeSpread >= 0, `${id} has negative spread`);

      if (w.kind === 'hitscan') {
        assert.ok(w.pellets >= 1, `${id} is hitscan but fires ${w.pellets} pellets`);
      }
      if (w.kind === 'projectile') {
        assert.ok(w.projectileSpeed > 0, `${id} is a projectile with speed ${w.projectileSpeed}`);
        assert.ok(w.projectileSprite.length > 0, `${id} has no projectile sprite`);
      }
      if (w.kind === 'melee') {
        assert.ok(w.meleeRange > 0, `${id} is melee with range ${w.meleeRange}`);
      }
    }
  });
});

describe('Vanilla tables · projectiles', () => {
  test('every projectile sprite in flight has an impact effect and a sound entry', () => {
    // NOTE: assert against IMPACT_EFFECTS/PROJECTILE_SOUNDS, never
    // PROJECTILE_FRAMES — `MISL` is deliberately absent from the latter, since
    // its frame A is the only flight art and B-D are the explosion.
    const sprites = new Set<string>();
    for (const w of Object.values(WEAPONS)) {
      if (w.kind === 'projectile') sprites.add(w.projectileSprite);
    }
    for (const stats of Object.values(MONSTER_STATS)) {
      for (const attack of [stats.melee, stats.ranged]) {
        if (attack?.projectile) sprites.add(attack.projectile.sprite);
      }
    }
    assert.ok(sprites.size > 0, 'the scan found no projectiles at all');

    const known = new Set<string>(SFX_NAMES);
    for (const sprite of sprites) {
      assert.ok(IMPACT_EFFECTS[sprite], `${sprite} has no impact effect`);
      const sounds = PROJECTILE_SOUNDS[sprite];
      assert.ok(sounds, `${sprite} has no sound entry`);
      for (const id of [sounds.launch, sounds.explode]) {
        if (id !== null) assert.ok(known.has(id as SfxId), `${sprite}: unknown sound ${id}`);
      }
    }
  });
});
