import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wad, WadFile } from '../../src/wad/wad.ts';
import { loadMap } from '../../src/wad/map.ts';
import { World } from '../../src/game/world.ts';
import { MONSTER_HIT_HEIGHT, MONSTER_STATS, type MonsterBody } from '../../src/game/monsters/defs.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/thingtypes.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * A cacodemon parked in a pit could never leave it. Fliers were exempt from the
 * dropoff rule but nothing else — they walked the floor, so the 48-unit step out
 * of the pit refused every chase step and the monster paced the far wall
 * forever. Vanilla answers a blocked step for an `MF_FLOAT` monster by *changing
 * height* (`P_Move`'s `floatok` branch) and hovers it toward the target
 * (`P_ZMovement`), which is how a cacodemon crosses geometry a demon can't.
 * See docs/monster-ai.md § Floating monsters.
 *
 * `caco_pit_test.wad`: one room split at `y = 32`, player start at `(0, -64)` on
 * the `0` floor and a cacodemon at `(0, 96)` in a pit at `-48`. Self-contained,
 * needing no IWAD, the same as the pinky fixtures.
 */

const PIT_FLOOR = -48;
const ROOM_FLOOR = 0;
/** The divider the pit's near edge sits on. */
const LEDGE_Y = 32;

function loadCacoPit(): { world: World; body: MonsterBody; player: Pos3 } {
  const bytes = readFileSync(new URL('../fixtures/wads/caco_pit_test.wad', import.meta.url));
  // `readFileSync` hands back a view into a pooled ArrayBuffer, so the slice is
  // load-bearing — same reason the other WAD fixtures do it.
  const file = new WadFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    'caco_pit_test.wad',
  );
  const map = loadMap(new Wad([file]), 'E1M1');
  const world = new World(map);
  const stats = MONSTER_STATS[ThingType.cacodemon];
  const thing = map.things.find((t) => t.type === ThingType.cacodemon)!;
  const start = map.things.find((t) => t.type === 1)!;

  return {
    world,
    player: { x: start.x, y: start.y, z: world.groundFloor(start.x, start.y, PLAYER_RADIUS) },
    body: {
      id: 0,
      x: thing.x,
      y: thing.y,
      z: world.groundFloor(thing.x, thing.y, stats.radius),
      velZ: 0,
      angle: -Math.PI / 2, // facing the player, as `A_FaceTarget` would leave it
      // Awake, idle, nothing in progress — the same "ready for a chase call"
      // shape as the pinky fixture's body.
      attackPause: 0,
      burstLeft: 0,
      burstTimer: 0,
      chargeTimer: 0,
      chargeAngle: 0,
      painTimer: 0,
      inFloat: false,
      movedir: 6, // south, toward the player
      movecount: 8,
      chaseTimer: 0,
      moveBlocked: false,
      threshold: 0,
      justHit: false,
      justAttacked: false,
      reactionTicks: 0,
      refiring: false,
      homingBias: false,
      walkSoundTimer: 0,
      walkSoundStep: 0,
    },
  };
}

/** Steps the monster at a fixed 35 fps for `seconds`. */
function run(f: ReturnType<typeof loadCacoPit>, seconds: number): void {
  const dt = 1 / 35;
  for (let t = 0; t < seconds; t += dt) {
    stepMonsterAI(f.body, MONSTER_STATS[ThingType.cacodemon], dt, f.world, f.player, PLAYER_RADIUS, PLAYER_HEIGHT);
  }
}

describe('Regressions · floating monsters over a ledge', () => {
  test('the fixture holds the geometry the tests assume', () => {
    const f = loadCacoPit();
    assert.deepEqual({ x: f.body.x, y: f.body.y }, { x: 0, y: 96 }, 'cacodemon position');
    assert.equal(f.body.z, PIT_FLOOR, 'it starts on the pit floor');
    assert.equal(f.player.z, ROOM_FLOOR, 'the player stands on the room floor');
    // The step out of the pit is well past MAX_STEP_UP, so a grounded monster
    // genuinely could not take it — otherwise this passes for the wrong reason.
    assert.ok(ROOM_FLOOR - PIT_FLOOR > 24);
    assert.equal(MONSTER_STATS[ThingType.cacodemon].flies, true);
  });

  test('a cacodemon floats out of the pit and reaches the player', () => {
    const f = loadCacoPit();
    run(f, 5);
    assert.ok(f.body.y < LEDGE_Y, `crossed the ledge (y = ${f.body.y})`);
    assert.ok(
      Math.hypot(f.body.x - f.player.x, f.body.y - f.player.y) < 128,
      `closed on the player (${Math.hypot(f.body.x - f.player.x, f.body.y - f.player.y)} away)`,
    );
  });

  test('it hovers off the floor, closing on the target mid-height without passing it', () => {
    const f = loadCacoPit();
    run(f, 5);
    const midHeight = f.player.z + MONSTER_HIT_HEIGHT / 2;
    assert.ok(f.body.z > ROOM_FLOOR, `airborne over the room floor (z = ${f.body.z})`);
    // `P_ZMovement`'s drift target is `target->z + (mo->height>>1)`, but its
    // `dist < |delta|*3` gate switches off before the gap closes — a cacodemon
    // in your face settles a third of its distance below eye level, not at it.
    // Landing *on* the mid-height here would mean the gate had been dropped.
    assert.ok(f.body.z < midHeight, `still below the ${midHeight} mid-height (z = ${f.body.z})`);
  });

  test('a grounded monster of the same size still refuses the step', () => {
    const f = loadCacoPit();
    // The demon: same class of body, no MF_FLOAT. It must stay in the pit.
    const demon = MONSTER_STATS[ThingType.demon];
    assert.equal(demon.flies, undefined);
    const dt = 1 / 35;
    for (let t = 0; t < 5; t += dt) {
      stepMonsterAI(f.body, demon, dt, f.world, f.player, PLAYER_RADIUS, PLAYER_HEIGHT);
    }
    assert.ok(f.body.y > LEDGE_Y, `still in the pit (y = ${f.body.y})`);
    assert.equal(f.body.z, PIT_FLOOR, 'and still on its floor');
  });
});
