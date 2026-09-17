import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpriteFxLayer } from '../../src/game/spritefx.ts';
import { World } from '../../src/game/world.ts';
import { TELEPORT_FOG } from '../../src/game/spritefx/tables.ts';
import { drawnLumps, fxLayer, teleportFogLump } from '../fixtures/spritestubs.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A monster teleporting out of a closet used to give the closet away: vanilla
 * spawns a fog puff at *both* ends of a teleport, and the one left behind in the
 * unexplored room was drawn as a lit sprite hanging in the black. Effects are
 * gated on fog of war exactly like thing sprites now — see
 * docs/fogofwar.md § How reveal reaches the geometry.
 */


/** Two one-cell rooms with no way between them, so each is its own subsector. */
const GRID = gridMap(['#####', '#.#.#', '#####'], { cell: 128 });
const ROOM = { col: 1, row: 1 };
const CLOSET = { col: 3, row: 1 };

function layerOn(revealed: Set<number>): SpriteFxLayer {
  const layer = fxLayer({ fogVisible: (subsector) => revealed.has(subsector) });
  layer.beginLevel(new World(GRID.map));
  return layer;
}

function fogAt(layer: SpriteFxLayer, cell: { col: number; row: number }): void {
  const at = GRID.centre(cell.col, cell.row);
  layer.spawnTeleportFog({ x: at.x, y: at.y, z: 0 });
}

describe('Sprites · effects in rooms the player has not seen', () => {
  test('a teleport fog in an unexplored room is not drawn, the one in sight is', () => {
    const layer = layerOn(new Set([GRID.index(ROOM.col, ROOM.row)]));
    fogAt(layer, CLOSET);
    fogAt(layer, ROOM);
    assert.deepEqual(drawnLumps(layer), [teleportFogLump(0)], 'one puff drawn, not two');
  });

  test('it is skipped rather than dropped: revealing the room mid-animation shows it on the right frame', () => {
    const revealed = new Set<number>();
    const layer = layerOn(revealed);
    fogAt(layer, CLOSET);
    // Mid-frame (3.5 in) rather than on a boundary, where float rounding makes
    // the frame a coin toss — the same reason `spritefx-snapshot.test.ts` picks 4.5.
    layer.updateTeleportFogs(TELEPORT_FOG.frameSeconds * 3.5);
    assert.deepEqual(drawnLumps(layer), [], 'still hidden');

    revealed.add(GRID.index(CLOSET.col, CLOSET.row));
    assert.notEqual(teleportFogLump(3), teleportFogLump(0), 'the frame it resumes on is not the one a restart shows');
    assert.deepEqual(drawnLumps(layer), [teleportFogLump(3)], 'resumes three frames in, not restarted');
  });

  test('an effect still expires on schedule while hidden', () => {
    const revealed = new Set<number>();
    const layer = layerOn(revealed);
    fogAt(layer, CLOSET);
    layer.updateTeleportFogs(TELEPORT_FOG.frameSeconds * TELEPORT_FOG.frames.length);
    revealed.add(GRID.index(CLOSET.col, CLOSET.row));
    assert.deepEqual(drawnLumps(layer), [], 'ran out unseen, nothing pops in late');
  });
});
