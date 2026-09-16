import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage, installStorage } from '../fixtures/storage.ts';

/**
 * The feed's setting and its lines — the halves of `ui/hud/messages.ts` that need no DOM. The
 * module reads its setting at import, so the storage is installed first and the module loaded
 * after. docs/hud.md § HUD messages, docs/menu.md § Persisted settings.
 */
describe('HUD · message feed', () => {
  test('the mode is read from storage, and anything but the three names is the default', async () => {
    const storage = fakeStorage();
    storage.map.set('topdoom.settings', JSON.stringify({ hudMessages: 'multiplayer' }));
    installStorage(storage);
    const messages = await import('../../src/ui/hud/messages.ts');
    assert.equal(messages.getHudMessageMode(), 'multiplayer');
    messages.setHudMessageMode('off');
    assert.equal(messages.getHudMessageMode(), 'off');
    assert.equal(JSON.parse(storage.map.get('topdoom.settings')!).hudMessages, 'off');
    messages.setHudMessageMode('all');
  });

  test('a repeated line carries its count from the second time on', async () => {
    const { countSuffix } = await import('../../src/ui/hud/messages.ts');
    assert.equal(countSuffix(1), '');
    assert.equal(countSuffix(3), ' (x3)');
  });

  test('a death line names the killer where another player did it, and only the victim otherwise', async () => {
    const { deathLine } = await import('../../src/ui/hud/messages.ts');
    const host = { text: 'host', color: [215, 66, 66] as const };
    const guest = { text: 'guest', color: [99, 99, 255] as const };
    assert.deepEqual(deathLine(guest, host), [host, ' killed ', guest], 'both names in their colours');
    assert.deepEqual(deathLine(guest, null), [guest, ' died']);
  });

  test('a join or leave line is the name in its colour, then what the player did', async () => {
    const { presenceLine } = await import('../../src/ui/hud/messages.ts');
    const late = { text: 'late', color: [255, 160, 0] as const };
    assert.deepEqual(presenceLine(late, 'joined'), [late, ' joined the game']);
    assert.deepEqual(presenceLine(late, 'left'), [late, ' left the game']);
  });

  test("a name's colour is its ramp's sixth shade, lifted where it is too dark to read", async () => {
    const { nameColors } = await import('../../src/ui/hud/scoreboard.ts');
    const { PLAYER_COLOR_RAMPS } = await import('../../src/wad/playercolor.ts');
    const palette = new Uint8Array(768);
    palette.set([127, 27, 27], (PLAYER_COLOR_RAMPS.red + 5) * 3);
    palette.set([200, 200, 200], (PLAYER_COLOR_RAMPS.white + 5) * 3);
    const colors = nameColors(palette);
    assert.deepEqual(colors.red, [215, 66, 66], "red's #7f1b1b, its hue at the least lightness");
    assert.deepEqual(colors.white, [200, 200, 200], 'a light enough shade stays as it is');
  });
});
