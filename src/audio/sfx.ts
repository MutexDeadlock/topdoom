import type { Pos2 } from '../types.ts';
import { mRandom, pRandom } from '../util/random.ts';

/**
 * Vanilla's complete `S_sfx[]` table (`linuxdoom-1.10/sounds.c`), name → the
 * entry's own **priority**, which is the only field of it this engine reads:
 * it decides which playing sound a new one may cut off once every channel is
 * busy (`audio/audio.ts: allocate`, vanilla's `S_getChannel`).
 *
 * The table's other fields are deliberately absent rather than transcribed:
 * `singularity` is dead in `linuxdoom-1.10` (declared in `sounds.h`, read
 * nowhere), and `link`/`pitch`/`volume` are `0`/`-1`/`-1` for every DOOM entry,
 * so nothing ever takes `S_StartSoundAtVolume`'s link branch.
 *
 * Listed in full — including sounds nothing here plays yet (the boss brain's,
 * `chgun`) — because it *is* vanilla's table, and a partial copy would
 * silently drift the moment another hook is added. Each name is a `DS`-prefixed
 * lump in the WAD (`wad/sound.ts`).
 */
export const SFX = {
  pistol: 64, shotgn: 64, sgcock: 64, dshtgn: 64, dbopn: 64, dbcls: 64, dbload: 64, plasma: 64,
  bfg: 64, sawup: 64, sawidl: 118, sawful: 64, sawhit: 64, rlaunc: 64, rxplod: 70, firsht: 70,
  firxpl: 70, pstart: 100, pstop: 100, doropn: 100, dorcls: 100, stnmov: 119, swtchn: 78,
  swtchx: 78, plpain: 96, dmpain: 96, popain: 96, vipain: 96, mnpain: 96, pepain: 96, slop: 78,
  itemup: 78, wpnup: 78, oof: 96, telept: 32, posit1: 98, posit2: 98, posit3: 98, bgsit1: 98,
  bgsit2: 98, sgtsit: 98, cacsit: 98, brssit: 94, cybsit: 92, spisit: 90, bspsit: 90, kntsit: 90,
  vilsit: 90, mansit: 90, pesit: 90, sklatk: 70, sgtatk: 70, skepch: 70, vilatk: 70, claw: 70,
  skeswg: 70, pldeth: 32, pdiehi: 32, podth1: 70, podth2: 70, podth3: 70, bgdth1: 70, bgdth2: 70,
  sgtdth: 70, cacdth: 70, skldth: 70, brsdth: 32, cybdth: 32, spidth: 32, bspdth: 32, vildth: 32,
  kntdth: 32, pedth: 32, skedth: 32, posact: 120, bgact: 120, dmact: 120, bspact: 100, bspwlk: 100,
  vilact: 100, noway: 78, barexp: 60, punch: 64, hoof: 70, metal: 70, chgun: 64, tink: 60,
  bdopn: 100, bdcls: 100, itmbk: 100, flame: 32, flamst: 32, getpow: 60, bospit: 70, boscub: 70,
  bossit: 70, bospn: 70, bosdth: 70, manatk: 70, mandth: 70, sssit: 70, ssdth: 70, keenpn: 70,
  keendt: 70, skeact: 70, skesit: 70, skeatk: 70, radio: 60,
} as const;

export type SfxId = keyof typeof SFX;

/** Every sfx name, for the `SoundBank` pre-decode pass (`encodedNames`). */
export const SFX_NAMES = Object.keys(SFX) as SfxId[];

/**
 * Vanilla's `NORM_PITCH`, and the two per-sound random pitch wobbles
 * `S_StartSoundAtVolume` applies on top of it: `±8` for the chainsaw's four
 * sounds (`sfx_sawup`..`sfx_sawhit`, a contiguous run in vanilla's enum),
 * nothing at all for `itemup` and `tink`, and `±16` for everything else.
 * Playback rate is `pitch / NORM_PITCH`, so a shot's length varies with it
 * exactly as it does in vanilla's own mixer.
 *
 * Vanilla: 128 | Topdoom: 192 (more subtle)
 */
const NORM_PITCH = 192;
const SAW_SOUNDS: ReadonlySet<SfxId> = new Set<SfxId>(['sawup', 'sawidl', 'sawful', 'sawhit']);
const UNPITCHED: ReadonlySet<SfxId> = new Set<SfxId>(['itemup', 'tink']);

/** Playback rate for one instance of `id` — see `NORM_PITCH`. */
export function randomPlaybackRate(id: SfxId): number {
  if (UNPITCHED.has(id)) return 1;
  // `16 - (M_Random()&31)` / `8 - (M_Random()&15)`, clamped to 0..255 there;
  // neither range can reach the clamp from NORM_PITCH, so it's omitted.
  // The engine's only `mRandom` caller, which is vanilla's situation too — the
  // pitch cursor is separate precisely so a muted or extra sound cannot shift
  // the simulation's own draws. docs/random.md § The table and the two cursors.
  const swing = SAW_SOUNDS.has(id) ? 8 - (mRandom() & 15) : 16 - (mRandom() & 31);
  return (NORM_PITCH + swing) / NORM_PITCH;
}

/**
 * Vanilla's two randomized sound families, from the `switch` statements in
 * `A_Look` (sight) and `A_Scream` (death): the three zombieman-family sight
 * and death sounds and the two imp-family ones are each picked at random from
 * their group at play time, whichever member `mobjinfo` names. Anything else
 * plays exactly what it was given.
 */
const VARIANT_GROUPS: readonly SfxId[][] = [
  ['posit1', 'posit2', 'posit3'],
  ['bgsit1', 'bgsit2'],
  ['podth1', 'podth2', 'podth3'],
  ['bgdth1', 'bgdth2'],
];

export function randomVariant(id: SfxId): SfxId {
  for (const group of VARIANT_GROUPS) {
    // `pRandom`, not `mRandom`: vanilla picks these inside the play simulation
    // (`A_Look`/`A_Scream`'s `P_Random()%3` / `%2`), unlike the pitch wobble above.
    if (group.includes(id)) return group[pRandom() % group.length];
  }
  return id;
}

/**
 * How a game system asks for a sound without knowing anything about Web Audio
 * — `audio/audio.ts: AudioEngine` is the only implementation, and `SILENT`
 * below stands in wherever there is no audio at all (a headless script, a
 * browser that refused an `AudioContext`).
 *
 * Sound is the one effect this engine's systems raise directly instead of
 * reporting back for `game.ts` to realize (the split `WeaponSystem.fire`'s
 * `Shot[]` and `ThingLayer.update`'s attacks follow): it changes no game
 * state, and the moments vanilla plays sounds at are *inside* those systems —
 * `A_Chase`'s 3-in-256 idle grunt has no observable event to hang off.
 * See docs/audio.md § Who plays what.
 */
export interface SoundEmitter {
  /**
   * Starts `id` at DOOM-space point `at`, or unattenuated and centred at the
   * listener when `at` is null/omitted — vanilla's own `S_StartSound(NULL, …)`,
   * used for pickups, a locked door's grunt and the two bosses' sight/death
   * roars.
   *
   * `origin` is vanilla's `origin` mobj pointer as a stable numeric key (see
   * `monsterOrigin`/`sectorOrigin`/`PLAYER_ORIGIN`): starting a sound cuts off
   * whatever that same origin was already playing, which is `S_StartSound`'s
   * own "kill old sound" step — and the reason a held chaingun trigger sounds
   * the way it does rather than layering a dozen overlapping shots.
   */
  play(id: SfxId, at?: Pos2 | null, origin?: number): void;
}

/** A `SoundEmitter` that plays nothing, so no caller needs an audio-or-not branch. */
export const SILENT: SoundEmitter = { play: () => {} };

/**
 * Origin keys (`SoundEmitter.play`'s third argument). Vanilla keys the
 * one-sound-per-origin rule on the emitting `mobj_t*`; the equivalents here are
 * the player, a `PosedThing` id and a sector index, which overlap as plain
 * numbers and so get disjoint ranges. The offsets sit far past any WAD's own
 * 16-bit thing/sector index counts.
 */
export const PLAYER_ORIGIN = 1;

export function monsterOrigin(id: number): number {
  return 0x100000 + id;
}

export function sectorOrigin(sectorIndex: number): number {
  return 0x200000 + sectorIndex;
}
