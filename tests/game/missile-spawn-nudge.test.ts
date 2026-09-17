import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT } from '../../src/audio/sfx.ts';
import { World } from '../../src/game/world.ts';
import { ProjectileLayer } from '../../src/game/projectiles.ts';
import { MISSILE_HEIGHT_OFFSET, AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { MATERIALS, ROT0_BANK, fxLayer } from '../fixtures/spritestubs.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { CombatContext } from '../../src/game/combat.ts';
import type { Player } from '../../src/game/player.ts';
import type { ProjectileShot } from '../../src/game/weapons.ts';

/**
 * A missile is born half a tic of its own momentum in front of the shooter and 32 units up, not at
 * the dead centre of its body — vanilla's `P_CheckMissileSpawn` and `P_SpawnPlayerMissile`. This
 * view draws the player's own billboard, where the difference is the plasma bolt visibly leaving
 * the marine's head. See docs/combat.md § Where a missile starts.
 */

/** One open cell with a wall to the north, so a shot can be given room or denied it. */
const GRID = gridMap(['#', '.', '.', '.'], { cell: 128 });
const NORTH = Math.PI / 2;
/** `MT_PLASMA`'s own `mobjinfo` speed, the units/sec this engine holds it in. */
const PLASMA_SPEED = 25 * 35;

const PLASMA: ProjectileShot = {
  kind: 'projectile',
  angleRad: NORTH,
  speed: PLASMA_SPEED,
  sprite: 'PLSS',
  damage: 0,
  splash: null,
  spray: null,
};

function rig(row: number) {
  const world = new World(GRID.map);
  const at = GRID.centre(0, row);
  const player = { x: at.x, y: at.y, z: 0 } as Player;
  const effects = fxLayer({ fogVisible: () => true });
  effects.beginLevel(world);
  const ctx = {
    world,
    things: null,
    slots: [{ player, dead: false }],
    damageSlot: () => false,
    triggerShot: () => {},
    triggerShotPath: () => {},
  } as unknown as CombatContext;
  const projectiles = new ProjectileLayer(ctx, {
    effects,
    spriteBank: ROT0_BANK,
    spriteMaterials: MATERIALS,
    audio: SILENT,
  });
  projectiles.beginLevel();
  return { projectiles, effects, player, at };
}

describe('Projectiles · where a missile is born', () => {
  test('half a tic of its own momentum ahead of the shooter, at the missile fire height', () => {
    const { projectiles, player, at } = rig(3);
    projectiles.spawnPlayerShot(PLASMA, null, null, 0);

    const [shot] = projectiles.snapshot();
    assert.ok(shot, 'the plasma bolt is in flight');
    // `P_CheckMissileSpawn`: `th->x += th->momx>>1`, i.e. 12.5 units for a bolt flying 25 a tic.
    const nudge = (PLASMA_SPEED * DOOM_TIC) / 2;
    assert.equal(nudge, 12.5);
    assert.equal(shot.traveled, nudge);
    assert.ok(Math.abs(shot.drawY - (at.y + nudge)) < 1e-6, `drawn at y ${shot.drawY}, not ${at.y + nudge}`);
    assert.ok(Math.abs(shot.drawX - at.x) < 1e-6);
    // Its own drawn start, not the interpolation origin: the first frame must not streak in.
    assert.equal(shot.drawPrevY, shot.drawY);
    // Four units below the height a bullet traces from, and the flight starts there too.
    assert.equal(shot.startZ, player.z + MISSILE_HEIGHT_OFFSET);
    assert.equal(shot.drawZ, player.z + MISSILE_HEIGHT_OFFSET);
    assert.equal(AIM_HEIGHT_OFFSET - MISSILE_HEIGHT_OFFSET, 4);
  });

  test('a wall closer than the nudge takes it, rather than the bolt stepping through', () => {
    const { projectiles, player } = rig(1);
    // Six units off the wall, well inside the 12.5 the bolt would otherwise be moved: this is what
    // stands in for vanilla's `P_TryMove` failing at the nudged point.
    player.y = GRID.centre(0, 0).y - 64 - 6;
    projectiles.spawnPlayerShot(PLASMA, null, null, 0);

    const [shot] = projectiles.snapshot();
    const nudge = (PLASMA_SPEED * DOOM_TIC) / 2;
    assert.ok(shot.maxDist < nudge, `the wall is ${shot.maxDist} away, which has to be under ${nudge}`);
    assert.equal(shot.traveled, shot.maxDist, 'never nudged past where the flight ends');
    // The next step ends it: `traveled >= maxDist` is the arrival test.
    projectiles.update(DOOM_TIC);
    assert.equal(projectiles.snapshot().length, 0);
  });
});
