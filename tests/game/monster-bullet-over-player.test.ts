import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { MonsterAttacks } from '../../src/game/monsters/attacks.ts';
import { monsterShootZ, type MonsterAttackEvent } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { PLAYER_RADIUS, type Player } from '../../src/game/player.ts';
import { targetOfSlot } from '../../src/game/things/defs.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { CombatContext } from '../../src/game/combat.ts';
import type { SpriteFxLayer } from '../../src/game/spritefx.ts';
import type { ProjectileLayer } from '../../src/game/projectiles.ts';
import type { AudioEngine } from '../../src/audio/audio.ts';
import { clearRandom } from '../../src/util/random.ts';
import { traceHitsBox, vecLength } from '../../src/util/geom.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A monster's bullet used to test the players on its line by their box alone, so a volley a
 * shotgun guy on a ledge fired at a player across the room hit a second player standing at the foot
 * of the ledge, a hundred units under the bolts. `PTR_ShootTraverse` (`p_map.c`) skips a shootable
 * thing the bolt passes over or under, a player as much as a monster. See docs/combat.md § The
 * vertical test.
 */

const LEDGE = 128;
/** A ledge `LEDGE` up in the west, open floor to the east, one cell wide. */
const GRID = gridMap(['############', '#HH........#', '############'], {
  cell: 64,
  heights: { '.': { floor: 0, ceil: 256 }, H: { floor: LEDGE, ceil: 256 } },
});
const SHOOTER = GRID.centre(1, 1);
const GUY = MONSTER_STATS[ThingType.shotgunGuy];
const VOLLEYS = 20;

/**
 * `VOLLEYS` shotgun-guy volleys from the ledge at slot 0, on the floor far to the east, with slot
 * 1 standing at `bystander`: every slot a bolt damaged, and every tracer's end.
 */
function volleys(bystander: Pos3): { damaged: number[]; tracers: Pos3[] } {
  clearRandom();
  const target = GRID.centre(9, 1);
  const damaged: number[] = [];
  const tracers: Pos3[] = [];
  const ctx = {
    world: new World(GRID.map),
    things: null,
    slots: [
      { player: { ...target, z: 0 } as Player, dead: false },
      { player: { ...bystander } as Player, dead: false },
    ],
    pvp: false,
    damageSlot: (slot: number) => {
      damaged.push(slot);
      return true;
    },
    triggerShot: () => {},
    triggerShotPath: () => {},
  } as unknown as CombatContext;
  const effects = {
    addTracer: (_from: Pos3, to: Pos3) => {
      tracers.push({ ...to });
    },
    spawnBlood: () => {},
    spawnPuff: () => {},
    spawnWallPuff: () => {},
  } as unknown as SpriteFxLayer;
  const attacks = new MonsterAttacks(ctx, effects, {} as ProjectileLayer, {} as AudioEngine, () => false);
  for (let i = 0; i < VOLLEYS; i++) {
    const atk: MonsterAttackEvent = {
      kind: 'ranged',
      damage: 0,
      bullets: [3, 3, 3],
      angleRad: 0,
      x: SHOOTER.x,
      y: SHOOTER.y,
      z: LEDGE + monsterShootZ(GUY.height),
      sourceId: 0,
      sourceType: ThingType.shotgunGuy,
      sourceRadius: GUY.radius,
      targetId: targetOfSlot(0),
    };
    attacks.resolve([atk]);
  }
  return { damaged, tracers };
}

describe('Combat · a monster bullet passes over a player below it', () => {
  test('a player at the foot of the ledge, under every bolt, is never hit', () => {
    const below = { ...GRID.centre(3, 1), z: 0 };
    const { damaged, tracers } = volleys(below);

    // The bolts that crossed the bystander's box on the map and flew on past it.
    const crossed = tracers.filter((to) => {
      const angle = Math.atan2(to.y - SHOOTER.y, to.x - SHOOTER.x);
      const along = traceHitsBox(SHOOTER.x, SHOOTER.y, Math.cos(angle), Math.sin(angle), below.x, below.y, PLAYER_RADIUS);
      return along !== null && along < vecLength(to.x - SHOOTER.x, to.y - SHOOTER.y);
    });
    assert.ok(crossed.length > 0, 'some bolts cross the bystander on the map');
    assert.equal(damaged.filter((slot) => slot === 1).length, 0, 'none of them hit the bystander');
    assert.ok(damaged.includes(0), 'the player they were fired at still takes some');
  });

  test('the same player up on the ledge, in the bolts’ way, is hit', () => {
    const { damaged } = volleys({ ...GRID.centre(2, 1), z: LEDGE });
    assert.ok(damaged.includes(1));
  });
});
