/**
 * The six persisted settings the simulation reads, as one record a replay freezes: captured when
 * a recording starts, re-asserted before every tic of a playback through each owner's
 * `override*` hook. docs/replays.md § Settings are frozen per tic.
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
import type { SimSettings } from './defs.ts';


export function captureSimSettings(): SimSettings {
  return {
    autorun: getAutorun(),
    autoSwitchWeapon: getAutoSwitchWeapon(),
    rightMouse: getRightMouseAction(),
    cameraMode: getCameraMode(),
    infiniteTallActors: getInfiniteTallActors(),
    pistolStart: getPistolStart(),
  };
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

export function sameSettings(a: SimSettings, b: SimSettings): boolean {
  return (
    a.autorun === b.autorun &&
    a.autoSwitchWeapon === b.autoSwitchWeapon &&
    a.rightMouse === b.rightMouse &&
    a.cameraMode === b.cameraMode &&
    a.infiniteTallActors === b.infiniteTallActors &&
    a.pistolStart === b.pistolStart
  );
}
