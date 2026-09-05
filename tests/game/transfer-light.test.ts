import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { lightSegment } from '../../src/render/sectorlight.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { gridMap, addControlSector, addTransferLine } from '../fixtures/gridmap.ts';
import { specialsRig, BANK, TIC } from '../fixtures/specialsrig.ts';

/**
 * Boom's 213/261: which sector a surface takes its light from, and what keeps
 * that live when the source is a strobe. See docs/specials.md § Transferred lighting.
 */

const OWN_LIGHT = 160; // gridMap's default
const LAVA_LIGHT = 255;

describe('Specials · transferred lighting', () => {
  test('213 lights a sector’s floor from the control sector, and leaves its walls alone', () => {
    const grid = gridMap(['#####', '#...#', '#####']);
    const map = grid.map;
    const lit = grid.index(2, 1);
    map.sectors[lit].tag = 2;
    addControlSector(map, { light: LAVA_LIGHT }, 213, 2);

    const built = buildMapMesh(map, BANK, { transfers: transfersOf(map) });
    const fan = built.flatSurfaces.find((f) => f.sector === lit)!;
    const attr = built.flatMeshes.get(fan.key)!.geometry.getAttribute('aLightSeg');
    assert.equal(attr.getX(fan.vertexStart), lightSegment(LAVA_LIGHT), 'floor takes the transferred light');

    // `rw_lightlevel` (r_segs.c) is the sector's own level, never the floor's.
    for (const quad of built.occluders.filter((o) => o.sector === lit)) {
      const wallAttr = built.wallMeshes.get(quad.key)!.geometry.getAttribute('aLightSeg');
      assert.notEqual(wallAttr.getX(quad.vertexStart), lightSegment(LAVA_LIGHT), 'walls keep their own light');
    }
  });

  test('a strobing control sector repaints every floor drawing from it', () => {
    const grid = gridMap(['#####', '#...#', '#####']);
    const map = grid.map;
    const lit = grid.index(3, 1);
    map.sectors[lit].tag = 2;
    // Sector type 2 is vanilla's fast strobe. The control sector is a real cell
    // (so the strobe has a darker neighbour to fall to) and is not the sector
    // being drawn — the two only ever meet through the transfer.
    const control = grid.index(1, 1);
    map.sectors[control].light = LAVA_LIGHT;
    map.sectors[control].special = 2;
    addTransferLine(map, control, 213, 2);

    const rig = specialsRig(map, grid.centre(1, 1));
    const fan = rig.built.flatSurfaces.find((f) => f.sector === lit)!;
    const attr = rig.built.flatMeshes.get(fan.key)!.geometry.getAttribute('aLightSeg') as THREE.BufferAttribute;
    assert.equal(fan.lightSector, control, 'filed under the sector it borrows from');
    assert.equal(attr.getX(fan.vertexStart), lightSegment(LAVA_LIGHT));

    // blink05 starts bright with an expired timer, so the first tic flips it
    // to the darkest neighbouring level.
    rig.tick(TIC);
    const dark = map.sectors[control].light;
    assert.notEqual(dark, LAVA_LIGHT, 'the control sector strobed');
    assert.equal(attr.getX(fan.vertexStart), lightSegment(dark), 'and the borrowing floor followed');
    assert.equal(map.sectors[lit].light, OWN_LIGHT, 'without touching the sector’s own level');
  });

  test('261 moves half a sprite’s light even though ceilings are never drawn', () => {
    const grid = gridMap(['..']);
    const map = grid.map;
    map.sectors[0].tag = 9;
    addControlSector(map, { light: 0 }, 261, 9);

    const t = transfersOf(map);
    assert.equal(t.ceilingLight(0), 0);
    assert.equal(t.floorLight(0), OWN_LIGHT, 'the floor is untouched');
    assert.equal(t.spriteLight(0), OWN_LIGHT / 2, 'R_AddSprites averages the two');
    assert.equal(t.spriteLight(1), OWN_LIGHT, 'a sector with no transfer is unchanged');
  });
});
