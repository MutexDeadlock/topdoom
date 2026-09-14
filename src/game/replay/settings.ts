/**
 * The nine persisted settings the simulation reads, as one record a replay freezes: captured when
 * a recording starts, re-asserted before every tic of a playback through each owner's
 * `override*` hook — and the player half of them as the local slot reads it. The session half is
 * one table, {@link SESSION_FIELDS}. docs/replays.md § Settings are frozen per tic.
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
import {
  getFragLimit,
  getFriendlyFire,
  getTimeLimit,
  overrideFragLimit,
  overrideFriendlyFire,
  overrideTimeLimit,
} from '../rules.ts';
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
  return sessionRecord((key) => FIELDS[key].get());
}

/**
 * `partial` as a whole record, every absent field its {@link SessionField.fallback}: a recording or
 * a lobby from before the netgame rules carries only the first two, and reads as coop with no
 * limits. docs/multiplayer-deathmatch.md § Settings.
 *
 * @param partial  a record from any build — extra fields, a {@link SimSettings} among them, are
 *                 left out
 */
export function withSessionDefaults(partial: Partial<SessionSettings>): SessionSettings {
  return sessionRecord((key) => partial[key] ?? FIELDS[key].fallback);
}

/**
 * Whether every session field `record` carries has its {@link SessionField.fallback}'s type — a
 * limit a whole non-negative number. An absent one passes: it reads as its fallback.
 *
 * @param record  a lobby's or a start's rules, as the wire delivered them
 */
export function sessionFieldsValid(record: Record<string, unknown>): boolean {
  for (const key of SESSION_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    const isLimit = typeof FIELDS[key].fallback === 'number';
    if (isLimit ? !Number.isInteger(value) || (value as number) < 0 : typeof value !== 'boolean') return false;
  }
  return true;
}

/** Pins every owner to `settings` without writing storage. */
export function applySimSettings(settings: SimSettings): void {
  overrideAutorun(settings.autorun);
  overrideAutoSwitchWeapon(settings.autoSwitchWeapon);
  overrideRightMouseAction(settings.rightMouse);
  overrideCameraMode(settings.cameraMode);
  applySessionSettings(settings);
}

/**
 * Pins the session half alone — a network game runs under the host's
 * (docs/multiplayer-net.md § Settings).
 */
export function applySessionSettings(settings: SessionSettings): void {
  for (const key of SESSION_KEYS) FIELDS[key].override(settings[key]);
}

/** The session half back on its stored values. */
export function releaseSessionSettings(): void {
  for (const key of SESSION_KEYS) FIELDS[key].override(null);
}

/** Every owner back on its stored value. */
export function releaseSimSettings(): void {
  overrideAutorun(null);
  overrideAutoSwitchWeapon(null);
  overrideRightMouseAction(null);
  overrideCameraMode(null);
  releaseSessionSettings();
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
  for (const key of SESSION_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** One session setting, as {@link SESSION_FIELDS} holds it. */
interface SessionField<T> {
  /** The owner's module value, stored or pinned. */
  get(): T;
  /** The owner's pin, which writes no storage; `null` puts the stored value back. */
  override(value: T | null): void;
  /** What a record without the field reads it as — and, by its type, what the wire accepts. */
  fallback: T;
}

/**
 * Every session setting once, in the record's field order: capture, defaults, the wire's check,
 * pinning, release and comparison all run over it. Keyed by {@link SessionSettings}, so a field
 * without a row is a type error — a new session setting is its field there and one row here.
 */
const SESSION_FIELDS: { readonly [K in keyof SessionSettings]: SessionField<SessionSettings[K]> } = {
  infiniteTallActors: { get: getInfiniteTallActors, override: overrideInfiniteTallActors, fallback: false },
  pistolStart: { get: getPistolStart, override: overridePistolStart, fallback: false },
  friendlyFire: { get: getFriendlyFire, override: overrideFriendlyFire, fallback: false },
  fragLimit: { get: getFragLimit, override: overrideFragLimit, fallback: 0 },
  timeLimit: { get: getTimeLimit, override: overrideTimeLimit, fallback: 0 },
};

const SESSION_KEYS = Object.keys(SESSION_FIELDS) as (keyof SessionSettings)[];

/**
 * {@link SESSION_FIELDS} as the loops read it: a loop over the keys cannot tie each one to its own
 * field type, so every row is read as a flag or a limit.
 */
const FIELDS = SESSION_FIELDS as unknown as Record<keyof SessionSettings, SessionField<boolean | number>>;

/** A whole session record, built field by field in {@link SESSION_FIELDS}' order. */
function sessionRecord(valueOf: (key: keyof SessionSettings) => boolean | number): SessionSettings {
  const record: Partial<Record<keyof SessionSettings, boolean | number>> = {};
  for (const key of SESSION_KEYS) record[key] = valueOf(key);
  return record as SessionSettings;
}
