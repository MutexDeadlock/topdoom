/**
 * The six persisted settings the simulation reads, as one record a replay freezes: captured when
 * a recording starts, re-asserted before every tic of a playback through each owner's
 * `override*` hook — and the player half of them as the local slot reads it.
 * docs/replays.md § Settings are frozen per tic.
 */
import { getCameraMode, overrideCameraMode } from '../autocamera.ts';
import { getRightMouseAction, overrideRightMouseAction } from '../input.ts';
import {
  getAutoSwitchWeapon,
  getPistolStart,
  overrideAutoSwitchWeapon,
  overridePistolStart,
} from '../inventory.ts';
import { getAutorun, overrideAutorun } from '../player.ts';
import { getInfiniteTallActors, overrideInfiniteTallActors } from '../world.ts';
import type { PlayerSettings, SessionSettings, SimSettings } from './defs.ts';

/**
 * The player half as the owners hold it this moment — stored, or pinned by a playback — read
 * through getters, so the local slot follows the menu with no copy per tic.
 * docs/multiplayer.md § Player settings.
 */
export const GLOBAL_PLAYER_SETTINGS: PlayerSettings = {
  get autorun() {
    return getAutorun();
  },
  get autoSwitchWeapon() {
    return getAutoSwitchWeapon();
  },
  get rightMouse() {
    return getRightMouseAction();
  },
  get cameraMode() {
    return getCameraMode();
  },
};

export function captureSimSettings(): SimSettings {
  // The spread runs the getters: a copy of this moment's values, in the stored field order.
  return { ...GLOBAL_PLAYER_SETTINGS, ...captureSessionSettings() };
}

/** The session half as the owners hold it this moment. */
export function captureSessionSettings(): SessionSettings {
  return { infiniteTallActors: getInfiniteTallActors(), pistolStart: getPistolStart() };
}

/** Pins every owner to `settings` without writing storage. */
export function applySimSettings(settings: SimSettings): void {
  overrideAutorun(settings.autorun);
  overrideAutoSwitchWeapon(settings.autoSwitchWeapon);
  overrideRightMouseAction(settings.rightMouse);
  overrideCameraMode(settings.cameraMode);
  overrideInfiniteTallActors(settings.infiniteTallActors);
  overridePistolStart(settings.pistolStart);
}

/** Every owner back on its stored value. */
export function releaseSimSettings(): void {
  overrideAutorun(null);
  overrideAutoSwitchWeapon(null);
  overrideRightMouseAction(null);
  overrideCameraMode(null);
  overrideInfiniteTallActors(null);
  overridePistolStart(null);
}

export function samePlayerSettings(a: PlayerSettings, b: PlayerSettings): boolean {
  return (
    a.autorun === b.autorun &&
    a.autoSwitchWeapon === b.autoSwitchWeapon &&
    a.rightMouse === b.rightMouse &&
    a.cameraMode === b.cameraMode
  );
}

export function sameSessionSettings(a: SessionSettings, b: SessionSettings): boolean {
  return a.infiniteTallActors === b.infiniteTallActors && a.pistolStart === b.pistolStart;
}
