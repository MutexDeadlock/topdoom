import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { targetOfSlot } from '../../src/game/things/defs.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Pos3 } from '../../src/types.ts';
import { monsterArena } from '../fixtures/arena.ts';

/**
 * A monster dropped its attack the tic its target died: the look that notices a dead target ran on
 * every tic, where vanilla runs it in `A_Chase` alone and no attack state calls that. An arch-vile
 * never blasted a player killed during its windup, and an idle monster kept its unfired shots for
 * its next wake. The rule this pins: **what is under way plays out against the body, and nothing
 * new starts** — a refire loop breaks on `health <= 0`. docs/monster-ai.md § Losing the target.
 */

/** The arena with one monster of `type` and the player across the room from it. */
function arena(type: number) {
  clearRandom();
  const { grid, world, layer } = monsterArena([type]);
  const start = grid.centre(1, 2);
  const player: Pos3 = { x: start.x, y: start.y, z: world.floorAt(start.x, start.y) };
  return { layer, player };
}

/** How many tics `type`'s attack chain lasts. */
function chainTics(type: number): number {
  return Math.round(MONSTER_STATS[type].ranged!.duration / DOOM_TIC);
}

describe('Regressions · an attack outlives the target it was fired at', () => {
  test('an arch-vile blasts the corpse of a player killed during its windup, then idles', () => {
    const { layer, player } = arena(ThingType.archVile);
    let cast = false;
    for (let tic = 0; tic < 1000 && !cast; tic++) {
      cast = layer.update(DOOM_TIC, [player]).attacks.some((a) => a.kind === 'vileWindup');
    }
    assert.ok(cast, 'the vile started a cast');

    // The player dies a tic into the windup; the corpse lies where they stood.
    let blastAt: number | null = null;
    for (let tic = 0; tic < chainTics(ThingType.archVile) + 2; tic++) {
      const { attacks } = layer.update(DOOM_TIC, [null], { bodies: [player] });
      const blast = attacks.find((a) => a.blast);
      if (blast) {
        assert.equal(blast.targetId, targetOfSlot(0), 'the blast is the corpse’s');
        blastAt ??= tic;
      }
    }
    assert.notEqual(blastAt, null, 'A_VileAttack fired at the corpse');
    assert.equal(layer.awakeMonsterCount(), 0, 'with nobody left to want, it idles once the cast is over');
  });

  test('a chaingunner breaks its refire on a corpse and idles, instead of hosing it', () => {
    const { layer, player } = arena(ThingType.heavyWeaponDude);
    let firing = false;
    for (let tic = 0; tic < 1000 && !firing; tic++) firing = layer.update(DOOM_TIC, [player]).attacks.length > 0;
    assert.ok(firing, 'the chaingunner opened fire');

    const chain = chainTics(ThingType.heavyWeaponDude);
    let lastShot = -1;
    for (let tic = 0; tic < chain * 4; tic++) {
      if (layer.update(DOOM_TIC, [null], { bodies: [player] }).attacks.length > 0) lastShot = tic;
    }
    assert.ok(lastShot < chain, `no shot past the chain under way (the last on tic ${lastShot} of ${chain})`);
    assert.equal(layer.awakeMonsterCount(), 0, 'it idles once the chain is over');
  });
});
