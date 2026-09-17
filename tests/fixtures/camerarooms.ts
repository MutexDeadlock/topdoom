/**
 * The rooms the auto-camera tests stand in, and the two readbacks they share. Each map is one
 * shape the camera has to handle — shut in, open, a dead end facing a hall, a plateau, a wall to
 * frame past — and all three suites draw from the same set, so a shape retuned for one is retuned
 * for all. docs/testing.md § Shared helpers.
 */
import { EYE_HEIGHT } from '../../src/game/player.ts';
import type { Pos2, Pos3 } from '../../src/types.ts';
import { gridMap } from './gridmap.ts';

/** DOOM bearings, degrees: +x is east, +y north. */
export const EAST = 0;
export const NORTH = 90;
export const WEST = 180;

/** A grid cell centre as the probe wants it, standing on a floor-0 cell. */
export const at = (p: Pos2): Pos3 => ({ ...p, z: 0 });

/** A long one-cell corridor running east–west: about as shut-in as geometry gets. */
export const corridor = () => gridMap(['#########', '.........', '#########']);

/** A 12×12 open room. */
export const room = () => gridMap(Array.from({ length: 12 }, () => '.'.repeat(12)));

/**
 * A dead end at the west, a hall running east — the shape the directional half exists for. The
 * player stands at the closed end.
 */
export const deadEndFacingHall = () =>
  gridMap(
    [
      '###################',
      '...................',
      '...................',
      '...................',
      '###################',
    ],
    { cell: 256 },
  );

/** A high plateau three cells south of the player, with room to the north. */
export const plateau = () =>
  gridMap(
    [
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      'PPPPPPP',
      'PPPPPPP',
      'PPPPPPP',
    ],
    { heights: { P: { floor: 512, ceil: 1024 } } },
  );

/**
 * A plateau starting half a cell away, on a grid fine enough that even the closest framing the
 * rescue will try still hangs over it.
 */
export const cliffEdge = () =>
  gridMap(['.......', '.......', 'PPPPPPP', 'PPPPPPP', 'PPPPPPP'], {
    cell: 64,
    heights: { P: { floor: 512, ceil: 1024 } },
  });

/**
 * A wall cell south of the player with open floor either side, under a ceiling high enough that
 * the camera cannot simply look over the wall's top — what it draws is an upper quad up to that
 * ceiling, and a test is about which side of it faces the camera.
 */
export const wallToTheSouth = () =>
  gridMap(['.....', '.....', '.....', '.....', '.....', '#####', '.....', '.....'], {
    heights: { '.': { floor: 0, ceil: 512 } },
  });

/** The same wall, drawn only to 256 — low enough that a wide framing hangs over its top. */
export const lowWallToTheSouth = () =>
  gridMap(['.....', '.....', '.....', '.....', '.....', '#####', '.....', '.....'], {
    heights: { '.': { floor: 0, ceil: 256 } },
  });

/** Where a camera `distance` back along `tiltDeg` at yaw 0 (due south) actually sits. */
export const eyeAt = (from: Pos3, tiltDeg: number, distance: number) => {
  const tilt = (tiltDeg * Math.PI) / 180;
  return {
    x: from.x,
    y: from.y - Math.sin(tilt) * distance,
    h: from.z + EYE_HEIGHT + Math.cos(tilt) * distance,
  };
};
