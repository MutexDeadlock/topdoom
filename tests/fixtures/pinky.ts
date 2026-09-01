import { Wad } from '../../src/wad/wad.ts';
import { loadMap } from '../../src/wad/map.ts';
import { World } from '../../src/game/world.ts';
import { type MonsterBody, type MonsterStats } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';
import { fixtureWad } from './wadfile.ts';
import { monsterBody } from './monsterbody.ts';

/** Doomednum of the demon/pinky (`MT_SERGEANT`). */
const DEMON_TYPE = ThingType.demon;

/**
 * `pinky_{above,below}_test.wad`: two four-line rooms split at `y = 128`, with a
 * demon parked at `(0, 160)` on the far side and the player start at `(0, 64)`.
 * Both self-contained — each carries its own MAP01 and needs no IWAD, the same
 * as `long_corridor_with_chaingunner.wad`.
 *
 * The only difference between them is the far sector's floor: **-72** (a pit the
 * demon stands in) in `below`, **+88** (a ledge it stands on) in `above`. Both
 * put the demon within 2D melee reach of a player at the lip while leaving the
 * two bodies with no vertical overlap at all, which is the case
 * `meleeReachesVertically` exists for. Reported against GZDoom; see
 * docs/monster-ai.md § Melee reach.
 */
export type PinkyMap = 'pinky_above_test' | 'pinky_below_test';

export interface PinkyFixture {
  world: World;
  stats: MonsterStats;
  /** The demon's resting position — its own `groundFloor`, so `z` is the real floor it stands on. */
  demon: Pos3;
  /** The far sector's floor height, the one thing that differs between the two maps. */
  ledgeFloor: number;
  /** The player standing on the near floor at `y`, walking toward the divider at `y = 128`. */
  playerAt(y: number): Pos3;
  /** A freshly woken demon body at `demon`, ready for a chase call — see `loadPinky`'s doc. */
  demonBody(): MonsterBody;
}

export function loadPinky(which: PinkyMap): PinkyFixture {
  const map = loadMap(new Wad([fixtureWad(`${which}.wad`)]), 'MAP01');
  const world = new World(map);
  const stats = MONSTER_STATS[DEMON_TYPE];
  const thing = map.things.find((t) => t.type === DEMON_TYPE)!;
  const demon: Pos3 = {
    x: thing.x,
    y: thing.y,
    z: world.groundFloor(thing.x, thing.y, stats.radius),
  };

  return {
    world,
    stats,
    demon,
    ledgeFloor: demon.z,
    playerAt: (y) => ({ x: 0, y, z: world.groundFloor(0, y, PLAYER_RADIUS) }),
    // Facing the player, due south, and already headed that way (`movedir` 6): a chase call that
    // has to turn first is a worse test.
    demonBody: () => monsterBody(demon, { angle: -Math.PI / 2, movedir: 6, movecount: 8 }),
  };
}
