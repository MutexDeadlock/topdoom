import { readFileSync } from 'node:fs';
import { Wad, WadFile } from '../../src/wad/wad.ts';
import { loadMap } from '../../src/wad/map.ts';
import { World } from '../../src/game/world.ts';
import { ThingType } from '../../src/game/thingtypes.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * `long_corridor_with_chaingunner.wad`: a 3648-unit straight corridor with a
 * chaingunner (doomednum 65) 3584 units from the player start, and nothing
 * else. Self-contained — it carries its own MAP01 and needs no IWAD.
 *
 * The map both chaingunner regressions were reported on, and the reason it is
 * a real WAD rather than a `gridMap`: it exercises the parser on the way in,
 * and it is the geometry the player actually stood in.
 */
export interface Corridor {
  world: World;
  player: Pos3;
  monster: Pos3;
}

export function loadCorridor(): Corridor {
  const bytes = readFileSync(
    new URL('./wads/long_corridor_with_chaingunner.wad', import.meta.url),
  );
  // `readFileSync` hands back a view into a pooled ArrayBuffer, so the slice is
  // load-bearing: passing `.buffer` raw would give `WadFile` the whole pool.
  const file = new WadFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    'long_corridor_with_chaingunner.wad',
  );
  const map = loadMap(new Wad([file]), 'MAP01');
  const world = new World(map);
  const start = world.playerStart();
  const chaingunner = map.things.find((t) => t.type === ThingType.heavyWeaponDude)!;
  return {
    world,
    player: { x: start.x, y: start.y, z: 0 },
    monster: { x: chaingunner.x, y: chaingunner.y, z: 0 },
  };
}
