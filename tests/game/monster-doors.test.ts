import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, soundLog, TIC } from '../fixtures/specialsrig.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { DI_NODIR, type MonsterBody } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { LF } from '../../src/wad/map.ts';
import type { CrossingBody } from '../../src/game/things/defs.ts';
import type { SfxId } from '../../src/audio/sfx.ts';

/**
 * `P_Move`'s `spechit` pass: the door a chasing monster walks into, opened.
 * See docs/monster-ai.md § Opening doors.
 */

const stats = MONSTER_STATS[ThingType.demon];

interface DoorRig {
  /** Runs `seconds` of tics: the monster's chase step, then the specials tic that moves the door. */
  run(seconds: number): void;
  /** The door sector's ceiling — 0 while shut. */
  ceil(): number;
  body: MonsterBody;
  played: SfxId[];
  /** The door mover's state, for the reversal rules `ceilHeight` alone can't show. */
  state(): string | undefined;
  /** One press of the door line by hand, as either activator — the two the reuse branch splits on. */
  press(who: 'monster' | 'player'): void;
}

/**
 * Four cells in a row: the monster starts in the first, the third is a shut door carrying
 * `special` on its own west edge (`EV_VerticalDoor` takes the line's *back* sector), and the
 * target stands in the last. Everything the monster does is `stepMonsterAI`'s own — nothing here
 * walks it into the line by hand.
 */
function doorRig(special: number, flags = 0): DoorRig {
  const grid = gridMap(['..+.']);
  const { map } = grid;
  const door = grid.index(2, 0);
  const line = grid.westEdge(2, 0);
  map.linedefs[line].special = special;
  map.linedefs[line].flags |= flags;
  assert.equal(map.sidedefs[map.linedefs[line].left].sector, door, 'the manual line’s back sector is the door');

  const start = grid.centre(0, 0);
  const { sfx, played } = soundLog();
  const rig = specialsRig(map, start, { sfx });
  const body: MonsterBody = {
    id: 1,
    x: start.x,
    y: start.y,
    z: 0,
    velZ: 0,
    angle: 0,
    attackPause: 0,
    burstLeft: 0,
    burstTimer: 0,
    swinging: false,
    chargeTimer: 0,
    chargeAngle: 0,
    painTimer: 0,
    inFloat: false,
    movedir: DI_NODIR,
    movecount: 0,
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
  };
  const asCrossing = (): CrossingBody => ({ x: body.x, y: body.y, id: 1, type: ThingType.demon, blockRadius: stats.radius, angle: body.angle });
  const target = { ...grid.centre(3, 0), z: 0 };
  const s = rig.specials as unknown as {
    ceilingMovers: Map<number, { state: string }>;
    trigger(lineIndex: number, keys: Set<never>, activator: string): unknown;
  };
  return {
    body,
    played,
    ceil: () => map.sectors[door].ceilHeight,
    state: () => s.ceilingMovers.get(door)?.state,
    press: (who) => s.trigger(line, new Set(), who),
    run: (seconds) => {
      for (let i = 0; i < Math.round(seconds / TIC); i++) {
        stepMonsterAI(body, stats, rig.world, {
          dt: TIC,
          target,
          targetRadius: PLAYER_RADIUS,
          targetHeight: PLAYER_HEIGHT,
          useLines: (_body, x, y) => rig.specials.useMonster(asCrossing(), x, y, new Set()),
        });
        rig.tick();
      }
    },
  };
}

describe('monsters · opening doors', () => {
  test('a chasing monster walks a manual door (1) open and through it', () => {
    const d = doorRig(1);
    d.run(1.5);
    assert.ok(d.ceil() > 0, `the door is opening (${d.ceil()})`);
    d.run(2.5);
    // The door line sits at x = 256, two cells along; nothing else here could have let it past.
    assert.ok(d.body.x > 256, `the monster walked through (x = ${d.body.x.toFixed(1)})`);
  });

  test('a keyed door (32) stays shut, and refuses the monster in silence', () => {
    const d = doorRig(32);
    d.run(3);
    assert.equal(d.ceil(), 0, 'no key, no door');
    assert.ok(!d.played.includes('oof'), '`EV_VerticalDoor` returns before the key test that speaks');
  });

  test('a switch outside the non-player allow-list (103) stays shut', () => {
    // S1 open door — a number only the player may push, though it sits on the same line.
    const d = doorRig(103);
    d.run(3);
    assert.equal(d.ceil(), 0);
  });

  test('a BLOCK_MONSTERS door line is never even reached', () => {
    // `PIT_CheckLine` refuses the line before it can reach `spechit`.
    const d = doorRig(1, LF.BLOCK_MONSTERS);
    d.run(3);
    assert.equal(d.ceil(), 0);
  });

  test('a secret door stays shut', () => {
    const d = doorRig(1, LF.SECRET);
    d.run(3);
    assert.equal(d.ceil(), 0);
  });

  /**
   * "JDC: bad guys never close doors" — `EV_VerticalDoor`'s reuse branch, the half of it that
   * reads `thing->player`. The same press from the player is what shows the branch is live.
   */
  test('a monster leaning on an opening door never sends it back down', () => {
    const d = doorRig(1);
    d.press('monster');
    assert.equal(d.state(), 'raising');
    for (let i = 0; i < 10; i++) d.press('monster');
    assert.equal(d.state(), 'raising', 'still on its way up');

    d.press('player');
    assert.equal(d.state(), 'lowering', 'the player’s own press does reverse it');
    d.press('monster');
    assert.equal(d.state(), 'raising', 'and a monster still sends a closing door back up');
  });
});
