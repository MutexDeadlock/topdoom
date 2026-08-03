import { Wad } from './wad/wad.ts';
import { loadWadFiles, type WadSource } from './wad/library.ts';
import { Menu, type Selection } from './ui/menu.ts';
import { Game, Viewport } from './game.ts';
import type { Pos2 } from './types.ts';

/** A short label naming the WAD set, for the HUD. */
function titleOf(iwad: WadSource, pwads: WadSource[]): string {
  return pwads.length === 0 ? iwad.label : `${iwad.label} + ${pwads.map((p) => p.label).join(' + ')}`;
}

/** `?pos=x,y` — drop the player there instead of at the map's own start. */
function parsePos(raw: string | null): Pos2 | null {
  if (!raw) return null;
  const [x, y] = raw.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function boot(): Promise<void> {
  const view = new Viewport(document.getElementById('app')!);
  const startPos = parsePos(new URLSearchParams(location.search).get('pos'));
  let game: Game | null = null;

  const startLevel = async (selection: Selection): Promise<void> => {
    menu.setStatus('Loading …');
    try {
      const files = await loadWadFiles(selection.iwad, selection.pwads);
      const wad = new Wad(files);

      game?.dispose();
      game = new Game(view, wad, selection.map, titleOf(selection.iwad, selection.pwads), selection.skill, startPos);

      menu.close();
      game.resume();
    } catch (err) {
      menu.setStatus((err as Error).message, true);
      console.error(err);
    }
  };

  const menu: Menu = new Menu((selection) => void startLevel(selection));

  // Esc toggles between playing and the menu; the level survives the trip.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    if (!menu.isOpen) {
      game?.pause();
      menu.open();
    } else if (game) {
      menu.close();
      game.resume();
    }
  });

  const params = new URLSearchParams(location.search);
  await menu.init({
    iwad: params.get('wad'),
    pwads: (params.get('pwad') ?? '').split(',').filter(Boolean),
    map: params.get('map'),
  });

  // A deep link with ?map= skips the menu; otherwise the menu is the entry point.
  const deepLink = params.get('map');
  if (deepLink && menu.isReady) menu.submit();
  else menu.open();
}

void boot();
