import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHEAT_MESSAGES, Cheats, warpTargets } from '../../src/game/cheats.ts';
import { AMMO_TYPES, KEY_SLOTS, ammoMax, applyDamage, createInventory } from '../../src/game/inventory.ts';
import { WEAPON_ORDER, classifyDehackedString } from '../../src/game/dehacked/tables.ts';
import { TELEFRAG_DAMAGE } from '../../src/game/things.ts';
import { World } from '../../src/game/world.ts';
import { PLAYER_RADIUS, Player } from '../../src/game/player.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { NO_INPUT, TIC, specialsRig } from '../fixtures/specialsrig.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { TeleportDest } from '../../src/game/specials.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { heldInput } from '../fixtures/input.ts';

/**
 * IDDQD, IDKFA, IDCLIP and IDCLEV, against `st_stuff.c`'s `ST_Responder`. See docs/cheats.md.
 */
describe('Cheats · recognising a code', () => {
  test('a code fires however much junk came before it', () => {
    const cheats = new Cheats();
    assert.equal(cheats.type('walking', createInventory(), 'commercial'), null);
    assert.equal(cheats.type('iddqd', createInventory(), 'commercial'), CHEAT_MESSAGES.STSTR_DQDON);
  });

  test('the buffer spans tics, so a code typed slowly still lands', () => {
    const cheats = new Cheats();
    // One character per tic is what typing actually looks like at 35 Hz.
    for (const char of 'iddq') assert.equal(cheats.type(char, createInventory(), 'commercial'), null);
    assert.equal(cheats.type('d', createInventory(), 'commercial'), CHEAT_MESSAGES.STSTR_DQDON);
  });

  test('a code in progress is announced, so a save is not taken over half a buffer', () => {
    const cheats = new Cheats();
    const inv = createInventory();
    assert.equal(cheats.type('xx', inv, 'commercial'), null);
    assert.equal(cheats.typing, false, 'junk is not a code being typed');
    for (const char of 'idcli') {
      cheats.type(char, inv, 'commercial');
      assert.equal(cheats.typing, true, `after ${char}`);
    }
    assert.equal(cheats.type('p', inv, 'commercial'), CHEAT_MESSAGES.STSTR_NCON);
    assert.equal(cheats.typing, false, 'the match cleared the buffer');
  });

  test('junk before a code does not hide that the code has started', () => {
    const cheats = new Cheats();
    cheats.type('walkingid', createInventory(), 'commercial');
    assert.equal(cheats.typing, true, 'the buffer keeps the junk; its *tail* is what counts');
  });

  test('every code in one burst fires in order, the last response winning', () => {
    const cheats = new Cheats();
    assert.equal(cheats.type('iddqdiddqd', createInventory(), 'commercial'), CHEAT_MESSAGES.STSTR_DQDOFF);
    assert.equal(cheats.god, false, 'toggled twice, not once');
  });
});

describe('Cheats · IDDQD', () => {
  test('it toggles god mode and heals to 100 on the way on', () => {
    const cheats = new Cheats();
    const inv = createInventory();
    inv.health = 7;
    assert.equal(cheats.type('iddqd', inv, 'commercial'), CHEAT_MESSAGES.STSTR_DQDON);
    assert.equal(cheats.god, true);
    assert.equal(inv.health, 100, "st_stuff.c's own literal, not the start health");
    // Off again heals nothing.
    inv.health = 7;
    assert.equal(cheats.type('iddqd', inv, 'commercial'), CHEAT_MESSAGES.STSTR_DQDOFF);
    assert.equal(cheats.god, false);
    assert.equal(inv.health, 7);
  });

  test('an ordinary hit is ignored, a telefrag is not', () => {
    const inv = createInventory();
    assert.equal(applyDamage(inv, 60, true), null, "P_DamageMobj returns before touching health");
    assert.equal(inv.health, 100);
    // The same `damage < 1000` limit the invulnerability sphere is under.
    assert.equal(applyDamage(inv, TELEFRAG_DAMAGE, true), 100 - TELEFRAG_DAMAGE);
    assert.equal(inv.health, 0);
  });
});

describe('Cheats · IDKFA', () => {
  test('armor, every weapon, full ammo and all six keys', () => {
    const cheats = new Cheats();
    const inv = createInventory();
    assert.equal(cheats.type('idkfa', inv, 'commercial'), CHEAT_MESSAGES.STSTR_KFAADDED);
    assert.equal(inv.armor, 200);
    assert.equal(inv.armorType, 2);
    assert.deepEqual([...inv.weapons].sort(), [...WEAPON_ORDER].sort(), 'NUMWEAPONS, on a DOOM 2 map');
    for (const type of AMMO_TYPES) assert.equal(inv.ammo[type], ammoMax(inv, type));
    assert.equal(inv.keys.size, KEY_SLOTS.length);
    assert.equal(inv.currentWeapon, 'pistol', 'vanilla arms nothing; only a pickup switches weapons');
  });

  test('a DOOM 1 set is handed everything but the super shotgun', () => {
    const inv = createInventory();
    new Cheats().type('idkfa', inv, 'registered');
    assert.equal(inv.weapons.has('supershotgun'), false, 'vanilla can never select it in DOOM 1');
    assert.deepEqual(
      [...inv.weapons].sort(),
      WEAPON_ORDER.filter((w) => w !== 'supershotgun').sort(),
      'the rest of NUMWEAPONS is untouched',
    );
  });

  test('shareware loses the plasma rifle and the BFG with it', () => {
    const inv = createInventory();
    new Cheats().type('idkfa', inv, 'shareware');
    assert.deepEqual(
      [...inv.weapons].sort(),
      WEAPON_ORDER.filter((w) => !['supershotgun', 'plasmaRifle', 'bfg'].includes(w)).sort(),
      "`WeaponSelectable`'s shareware pair, on top of DOOM 1's super shotgun",
    );
    // The ammo is filled all the same: `maxammo` is not gated on the mode, and a shareware set
    // has cells to pick up for a plasma rifle a PWAD places.
    assert.equal(inv.ammo.cells, ammoMax(inv, 'cells'));
  });

  test('a backpack already collected raises what "full" means', () => {
    const inv = createInventory();
    inv.backpack = true;
    new Cheats().type('idkfa', inv, 'commercial');
    assert.equal(inv.ammo.bullets, 400);
  });

  test('it leaves nothing switched on to record', () => {
    const cheats = new Cheats();
    cheats.type('idkfa', createInventory(), 'commercial');
    assert.equal(cheats.active, false);
  });
});

describe('Cheats · IDCLIP', () => {
  test('either spelling toggles the same flag', () => {
    const cheats = new Cheats();
    const inv = createInventory();
    assert.equal(cheats.type('idclip', inv, 'commercial'), CHEAT_MESSAGES.STSTR_NCON);
    assert.equal(cheats.noclip, true);
    // Vanilla tests both sequences in one condition, whatever the IWAD is.
    assert.equal(cheats.type('idspispopd', inv, 'commercial'), CHEAT_MESSAGES.STSTR_NCOFF);
    assert.equal(cheats.noclip, false);
  });

  /**
   * A raised cell the player can never step into: 64 is far over `MAX_STEP_UP`, so the move is
   * refused outright until nothing is clipping it.
   */
  const CELL = 256;
  function arena() {
    const grid = gridMap(['###', '#H#', '#.#', '###'], {
      cell: CELL,
      heights: { H: { floor: 64, ceil: 192 } },
    });
    const floor = grid.centre(1, 2);
    const world = new World(grid.map);
    const player = new Player(world);
    player.moveTo(floor);
    return { player, edgeY: floor.y + CELL / 2 };
  }

  /** North at `forwardDeg` 90, so autorun's run speed applies. */
  const RUN_NORTH = heldInput('KeyW');

  function runNorth(noclip: boolean) {
    const { player, edgeY } = arena();
    player.noclip = noclip;
    for (let tic = 0; tic < 20; tic++) player.update(DOOM_TIC, RUN_NORTH, null, 90);
    return { player, edgeY };
  }

  test('a wall stops the player without it', () => {
    const { player, edgeY } = runNorth(false);
    assert.ok(player.y <= edgeY - PLAYER_RADIUS, `stopped at ${player.y}, short of ${edgeY}`);
    assert.equal(player.z, 0);
  });

  test('a line walked over fires nothing while it is on, and fires once it is off', () => {
    // `P_TryMove` runs its `spechit` list only for a thing without `MF_NOCLIP`. A W1 teleport is
    // the crossing that says loudest whether it fired — one fresh rig per case, since W1 is
    // once-only and the walk back over the line is a crossing of its own.
    function walkEast(noclip: boolean): number {
      const grid = gridMap(['#######', '#.....#', '#######']);
      const { map } = grid;
      map.sectors[grid.index(4, 1)].tag = 1;
      map.things.push(thingAt(grid, 4, 1, ThingType.teleportDest));
      const line = grid.westEdge(2, 1);
      map.linedefs[line].special = 39; // W1 teleport
      map.linedefs[line].tag = 1;

      const arrivals: TeleportDest[] = [];
      const rig = specialsRig(map, grid.centre(1, 1), { onTeleport: (dest) => arrivals.push(dest) });
      const boundary = grid.centre(2, 1).x - grid.cell / 2;
      const y = grid.centre(1, 1).y;
      // The first update seeds prevX/prevY, the second is the crossing.
      rig.specials.update(TIC, { x: boundary - 20, y, angle: 0 }, NO_INPUT, new Set(), noclip);
      rig.specials.update(TIC, { x: boundary + 20, y, angle: 0 }, NO_INPUT, new Set(), noclip);
      return arrivals.length;
    }

    assert.equal(walkEast(true), 0, 'noclipped straight over the teleport line');
    assert.equal(walkEast(false), 1, 'the same crossing fires when nothing is clipping');
  });

  test('with it the player walks through and stands on the far sector floor', () => {
    const { player, edgeY } = runNorth(true);
    assert.ok(player.y > edgeY + PLAYER_RADIUS, `walked through to ${player.y}`);
    // P_CheckPosition's MF_NOCLIP early-out: the floor under the centre, with no step limit.
    assert.equal(player.z, 64);
  });
});

describe('Cheats · IDCLEV', () => {
  test('the two characters after the code come back once, and nothing else does', () => {
    const cheats = new Cheats();
    const inv = createInventory();
    assert.equal(cheats.type('idclev', inv, 'commercial'), null, 'the code alone prints nothing');
    assert.equal(cheats.takeWarp(), null, 'and asks for nothing until both characters are in');
    assert.equal(cheats.typing, true, 'a code waiting for its parameters is still being typed');
    cheats.type('0', inv, 'commercial');
    assert.equal(cheats.takeWarp(), null);
    cheats.type('5', inv, 'commercial');
    assert.equal(cheats.typing, false);
    assert.equal(cheats.takeWarp(), '05');
    assert.equal(cheats.takeWarp(), null, 'the read clears it, so one code changes level once');
  });

  test('the parameters are swallowed, whatever they spell', () => {
    const cheats = new Cheats();
    const inv = createInventory();
    // `cht_GetParam` takes the next two keys as parameters; the code inside them is not a code.
    assert.equal(cheats.type('idclevidclip', inv, 'commercial'), null);
    assert.equal(cheats.noclip, false, 'the `id` went into the parameters, leaving a bare `clip`');
    assert.equal(cheats.takeWarp(), 'id');
  });

  test('typing it is not yet cheating: the level it names may not exist', () => {
    const cheats = new Cheats();
    cheats.type('idclev99', createInventory(), 'commercial');
    assert.equal(cheats.used, false, 'ST_Responder returns before it changes anything');
  });

  test('a warp that happens counts as used and takes the toggles with it', () => {
    const cheats = new Cheats();
    cheats.type('iddqdidclipidclev01', createInventory(), 'commercial');
    assert.deepEqual([cheats.god, cheats.noclip], [true, true]);
    // `G_DeferedInitNew` rebirths every player, and `G_PlayerReborn` memsets `player_t.cheats`.
    cheats.warped();
    assert.equal(cheats.active, false);
    assert.equal(cheats.used, true, 'the run has still cheated');
  });

  test('the map spelling follows the level being played, with the other still reachable', () => {
    assert.deepEqual(warpTargets('12', 'MAP07'), ['MAP12', 'E1M2']);
    assert.deepEqual(warpTargets('12', 'E1M1'), ['E1M2', 'MAP12']);
    // Vanilla's own two forms: `idclev31` is MAP31 in DOOM 2 and E3M1 in DOOM 1.
    assert.equal(warpTargets('31', 'MAP01')[0], 'MAP31');
    assert.equal(warpTargets('31', 'E2M4')[0], 'E3M1');
  });
});

describe('Cheats · what a save and a patch see', () => {
  test('the toggles round-trip, and a save from before them means neither', () => {
    const cheats = new Cheats();
    cheats.type('iddqdidclip', createInventory(), 'commercial');
    assert.equal(cheats.active, true);
    const restored = new Cheats();
    restored.restore(cheats.snapshot());
    assert.deepEqual([restored.god, restored.noclip], [true, true]);
    restored.restore(undefined);
    assert.deepEqual([restored.god, restored.noclip], [false, false]);
  });

  test('a session that typed one is marked, IDKFA included, and the mark travels in the block', () => {
    const cheats = new Cheats();
    assert.equal(cheats.used, false);
    cheats.type('idkfa', createInventory(), 'commercial');
    assert.equal(cheats.used, true, 'a code that leaves no toggle still cheated');
    // The block is written for a session that used one, so its presence alone is what says so —
    // which is why an IDKFA session records `{god: false, noclip: false}` rather than nothing.
    const restored = new Cheats();
    restored.restore(cheats.snapshot());
    assert.equal(restored.used, true);
    restored.restore(undefined);
    assert.equal(restored.used, false, 'no block means the session never cheated');
  });

  test("the classifier's STSTR_* list is exactly the set of responses that exist", () => {
    // `dehacked/tables.ts` spells the mnemonics out rather than importing them, because it is on
    // the read side and must not pull the game layer into the menu's graph. This is what keeps the
    // two copies from drifting — see the same test for `PD_*` in dehacked-apply.test.ts.
    for (const mnemonic of Object.keys(CHEAT_MESSAGES)) {
      assert.equal(classifyDehackedString(mnemonic), 'applied', `${mnemonic} has a response but is not applied`);
    }
    // And nothing beyond them: a cheat this engine doesn't have still reports honestly.
    assert.equal(classifyDehackedString('STSTR_FAADDED'), 'noTarget');
  });
});
