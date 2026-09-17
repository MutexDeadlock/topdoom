import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyDehacked, resetDehacked } from '../../src/game/dehacked/apply.ts';
import { parseDehacked } from '../../src/game/dehacked.ts';
import { MONSTER_STATS, monsterStatsFor } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { World } from '../../src/game/world.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { soundLog } from '../fixtures/specialsrig.ts';
import { chaseStep, monsterBody } from '../fixtures/monsterbody.ts';

/**
 * A missile chain used to be read for its *first* damaging action alone, so every later shot of a
 * volley repeated it. NoSp2.wad's cybruiser fires `A_CyberAttack` and then `A_BruisAttack` off one
 * chain — a rocket and then the baron's green ball — and came out throwing two rockets.
 * `AttackStats.shotAttacks` is the per-shot answer; docs/monster-attacks.md § A volley of unlike
 * shots.
 *
 * The patch here is the cybruiser's shape written against vanilla's own indices: the cyberdemon's
 * `S_CYBER_ATK6` (state 689, the last of its three `A_CyberAttack` states) repointed to
 * `A_BruisAttack`.
 */
const MIXED = [
  'Patch File for DeHackEd v3.0', '', 
  'Doom version = 21', 'Patch format = 6', '', 
  '[CODEPTR]', 
  'FRAME 689 = BruisAttack', ''
].join('\n');

/** Big enough that nothing walks out of its cell, far enough that the cyberdemon shoots rather than claws. */
const CELL = 1024;

/** The projectile sprite each shot of one volley throws, in firing order. */
function volleySprites(type: number): string[] {
  const grid = gridMap(['#....#'], { cell: CELL });
  const world = new World(grid.map);
  const stats = monsterStatsFor(false)[type];
  const at = grid.centre(1, 0);
  // `MF_JUSTHIT`: the next missile check fires regardless of the range roll, which is what makes
  // this deterministic — `P_CheckMissileRange` is otherwise a `P_Random` draw.
  const body = monsterBody({ ...at, z: 0 }, { movecount: 8, justHit: true });
  const target = { x: grid.centre(4, 0).x, y: at.y, z: 0 };
  const log = soundLog();
  const sprites: string[] = [];
  for (let i = 0; i < 120; i++) {
    const attack = chaseStep(body, stats, world, target, { sfx: log.sfx });
    for (const shot of attack?.projectiles ?? []) sprites.push(shot.sprite);
    // One volley only: stop the moment its last shot has left, before a second attack is chosen.
    if (sprites.length > 0 && body.burstLeft === 0) break;
  }
  return sprites;
}

describe('DEHACKED · a volley of unlike shots', () => {
  beforeEach(() => resetDehacked());

  test('vanilla repeats one attack across a volley, and gains no per-shot table', () => {
    const cyber = MONSTER_STATS[ThingType.cyberdemon].ranged!;
    assert.equal(cyber.shots, 3, "S_CYBER_ATK2/ATK4/ATK6's three A_CyberAttack calls");
    assert.equal(cyber.shotAttacks, undefined, 'all three are the same attack');
    // The one vanilla chain whose firing actions have *different names*: A_FatAttack1/2/3 are one
    // attack fanned by `pairOffsetsRad`, and all three name the mancubus.
    assert.equal(MONSTER_STATS[ThingType.mancubus].ranged!.shotAttacks, undefined);
    assert.deepEqual(volleySprites(ThingType.cyberdemon), ['MISL', 'MISL', 'MISL']);
  });

  test('a chain whose last shot is repointed throws that shot, not another of the first', () => {
    applyDehacked(parseDehacked(MIXED));
    const ranged = MONSTER_STATS[ThingType.cyberdemon].ranged!;
    assert.equal(ranged.shots, 3, 'still three shots off the same chain');
    assert.equal(ranged.projectile!.sprite, 'MISL', "and the chain's own attack is still the rocket");
    // `A_BruisAttack` belongs to the baron, so shot three is the baron's own: BAL7, 8×8 rather
    // than the rocket's 8×20, and no splash.
    assert.deepEqual(ranged.shotAttacks?.map((shot) => shot.projectile?.sprite), ['MISL', 'MISL', 'BAL7']);
    assert.equal(ranged.shotAttacks![2].diceMult, 8);
    assert.equal(ranged.shotAttacks![2].projectile?.splash, undefined);
    assert.deepEqual(volleySprites(ThingType.cyberdemon), ['MISL', 'MISL', 'BAL7']);
  });

  test('fast mode speeds up a per-shot missile the same way it speeds up a chain', () => {
    applyDehacked(parseDehacked(MIXED));
    const fast = monsterStatsFor(true)[ThingType.cyberdemon].ranged!;
    // `G_InitNew` raises BAL7 from 15 to 20 units per tic and leaves MT_ROCKET alone.
    assert.deepEqual(fast.shotAttacks?.map((shot) => shot.projectile?.speed), [700, 700, 20 * 35]);
  });

  test('reset takes the per-shot table back off', () => {
    applyDehacked(parseDehacked(MIXED));
    resetDehacked();
    assert.equal(MONSTER_STATS[ThingType.cyberdemon].ranged!.shotAttacks, undefined);
    assert.deepEqual(volleySprites(ThingType.cyberdemon), ['MISL', 'MISL', 'MISL']);
  });
});
