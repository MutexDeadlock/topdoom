import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { impBody, rocket, shotRig } from '../fixtures/shotrig.ts';

/**
 * A missile that struck a body used to burst where its tic's step ended — up to a whole step past
 * the contact, inside the body — so the struck monster took splash from inside its own box.
 * `P_TryMove` refuses the move that touches the body and leaves the missile where it stood, trying
 * a move faster than `MAXMOVE/2` in two halves. See docs/combat.md § How a projectile finds its
 * target.
 */

const GRID = gridMap(['####################', '#..................#', '####################'], { cell: 128 });
const IMP = MONSTER_STATS[ThingType.imp];
/** Centre-to-centre distance at which a rocket touches an imp: the two radii, `PIT_CheckThing`. */
const CONTACT = IMP.radius + PROJECTILE_RADIUS.MISL;
/** A rocket's 20-unit tic, tried in two halves. */
const HALF_MOVE = 10;
const ROCKET = rocket({ radius: 128, damage: 128, hitsPlayer: false });

describe('Regressions · a missile bursts short of the body it strikes', () => {
  test('the explosion sits outside the imp, so its splash is measured from outside the imp’s box', () => {
    // Every whole-unit launch position across one rocket step, so no step phase goes untried.
    for (let offset = 0; offset < 20; offset++) {
      const start = GRID.centre(1, 1);
      const imp = impBody(1, { x: start.x + 512, y: start.y });
      const rig = shotRig(GRID, { x: start.x + offset, y: start.y }, [imp]);
      rig.launch(ROCKET, null);
      rig.fly();

      assert.equal(rig.impacts.length, 1);
      const gap = imp.x - rig.impacts[0].x;
      assert.ok(gap >= CONTACT && gap <= CONTACT + HALF_MOVE, `launched ${offset} in, burst ${gap} from the imp`);
      const [direct, splash] = rig.hits;
      assert.equal(direct.amount, 20);
      // `128 - dist`, with dist the burst's distance to the imp's edge: 11 to 21 units.
      const edge = CONTACT - IMP.radius;
      assert.ok(splash.amount <= 128 - edge && splash.amount >= 128 - edge - HALF_MOVE, `splash ${splash.amount}`);
    }
  });
});
