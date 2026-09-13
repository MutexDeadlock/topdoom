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
    assert.equal(deathLine('guest', 'host'), 'host killed guest');
    assert.equal(deathLine('guest', null), 'guest died');
  });
});
