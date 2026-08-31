/**
 * The GLDEFS lump family: GZDoom's dynamic-light definitions, and the `object`/`frame` blocks that
 * bind one to a sprite frame. Parsed into a frame-keyed table `render/lights.ts` looks lights up in
 * every frame it draws. See docs/lights.md.
 */
import type { Wad } from './wad.ts';
import { SHIPPED_GLDEFS, shippedLump } from './shipped.ts';
import { decodeTextLump, stripComments } from './textlump.ts';

/**
 * The lump names carrying light definitions. GZDoom reads **every** one of these, in load order,
 * layering them (`gldefs.cpp: LoadGLDefs`) — unlike the MAPINFO family, where a file's several
 * lumps are alternatives and only the first is read. `GLDEFS` is the modern name; `DOOMDEFS` is
 * the game-specific one GZDoom still accepts for Doom.
 */
export const GLDEFS_LUMPS = ['GLDEFS', 'DOOMDEFS'];

/**
 * How a light's radius moves over time. GZDoom's own four animated types
 * (`gldefs.cpp`'s block keywords, `a_dynlight.cpp: ADynamicLight::Tick`); its `sectorlight`,
 * which scales with the sector's own light level rather than binding to a frame, is not read.
 */
export type LightKind = 'point' | 'pulse' | 'flicker' | 'flicker2';

/**
 * One named light definition — a `pointlight`/`pulselight`/`flickerlight`/`flickerlight2` block.
 */
export interface LightDef {
  kind: LightKind;
  /**
   * Colour, 0..1 per channel, used as a linear-light multiplier (docs/lights.md § Two lighting
   * paths).
   */
  r: number;
  g: number;
  b: number;
  /** Primary radius in map units. GZDoom clamps `size` to 1..1024 (`gldefs.cpp`). */
  size: number;
  /** The other radius an animated light moves between; equal to `size` for a `point`. */
  secondarySize: number;
  /** Seconds per cycle, for `pulse` and `flicker2`. GZDoom stores `interval * TICRATE` tics. */
  interval: number;
  /** Probability 0..1 of taking `size` rather than `secondarySize` on a tic, for `flicker`. */
  chance: number;
  /**
   * Where the light sits relative to the thing, in DOOM map space. GLDEFS writes
   * `offset x up y`, so its **middle** argument is the vertical one (`gldefs.cpp: ParseTriple`
   * feeds a ZDoom-space triple) — that is `offZ` here, measured up from the thing's feet.
   */
  offX: number;
  offY: number;
  offZ: number;
  /**
   * Whether the emitter's own sprite is excluded from this light (docs/lights.md § Two lighting
   * paths).
   */
  dontLightSelf: boolean;
  /** Parsed but never rendered — see docs/lights.md § Falloff and what is not reproduced. */
  subtractive: boolean;
}

/**
 * A parsed GLDEFS set: the named lights, plus the two ways an `object` block binds one to a frame.
 * Class names are dropped — this engine keys lights by the sprite frame actually drawn, which is
 * what `SpriteAnimator.frameKey` already is (docs/lights.md § The frame key).
 */
export interface Gldefs {
  /** By uppercased light name. */
  lights: Map<string, LightDef>;
  /**
   * Frame reference → light name, both kinds in one map: `PUFFA` (5 characters, one specific
   * frame) and `TROO` (4, every frame of that sprite). The key's own length tells them apart, so
   * one can never shadow the other and `lightForFrame` reads the exact binding first.
   */
  frames: Map<string, string>;
  /**
   * `lightForFrame`'s memo, frame key → the light it resolves to or null. Filled on first ask and
   * cleared whenever `parseGldefs` writes into this set. It exists because the two-step lookup
   * below allocates: the exact 5-character binding misses for nearly every drawn frame, and the
   * sprite-wide fallback's `slice` would then run once per drawn sprite per frame.
   */
  resolved: Map<string, LightDef | null>;
}

/** An empty set, for a session with no GLDEFS at all. */
export function emptyGldefs(): Gldefs {
  return { lights: new Map(), frames: new Map(), resolved: new Map() };
}

/**
 * Braces are tokens of their own; everything else splits on whitespace. A frame name may be any
 * run of non-space characters — vanilla frames past `Z` are spelled `[`, `\` and `]`, which the
 * arch-vile's resurrection frames use and which `String.fromCharCode(65 + frame)` produces here
 * too (`dehacked/states.ts`).
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '{' || ch === '}') {
      tokens.push(ch);
      i++;
    } else {
      let end = i;
      while (end < text.length && !/[\s{}]/.test(text[end])) end++;
      tokens.push(text.slice(i, end));
      i = end;
    }
  }
  return tokens;
}

/** A light's declared radius, held to the 1..1024 map units GZDoom allows (`gldefs.cpp`). */
function clampSize(value: number): number {
  return Math.min(1024, Math.max(1, Math.round(value)));
}

const BLOCK_KIND: Record<string, LightKind> = {
  pointlight: 'point',
  pulselight: 'pulse',
  flickerlight: 'flicker',
  flickerlight2: 'flicker2',
};

/** A fresh definition with every field at its "not stated" value, before the block's keys land. */
function blankLight(kind: LightKind): LightDef {
  return {
    kind,
    r: 1,
    g: 1,
    b: 1,
    size: 1,
    secondarySize: 1,
    interval: 0,
    chance: 0,
    offX: 0,
    offY: 0,
    offZ: 0,
    dontLightSelf: false,
    subtractive: false,
  };
}

/**
 * A tolerant walk over one GLDEFS text. Anything it does not recognise — GZDoom's other top-level
 * blocks (`glow`, `brightmap`, `skybox`, `hardwareshader`, `sectorlight`), an unknown key inside a
 * light, a malformed number — is skipped rather than thrown on: a PWAD's GLDEFS is written for a
 * renderer with far more features than this one, and must never keep a level from loading.
 */
export function parseGldefs(text: string, into: Gldefs = emptyGldefs()): Gldefs {
  const tokens = tokenize(stripComments(text));
  let i = 0;

  /** Skips the brace-delimited block starting at or after `i`, however deeply it nests. */
  const skipBlock = (): void => {
    while (i < tokens.length && tokens[i] !== '{') {
      // A block type we don't read may still be followed by a name and flags before its brace.
      if (tokens[i] === '}') return;
      i++;
    }
    let depth = 0;
    while (i < tokens.length) {
      if (tokens[i] === '{') depth++;
      else if (tokens[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          return;
        }
      }
      i++;
    }
  };

  /** The next token as a number, consuming it only if it is one. */
  const num = (): number | null => {
    const value = Number(tokens[i]);
    if (tokens[i] === undefined || tokens[i] === '{' || tokens[i] === '}' || !Number.isFinite(value)) {
      return null;
    }
    i++;
    return value;
  };

  while (i < tokens.length) {
    const keyword = tokens[i].toLowerCase();
    const kind = BLOCK_KIND[keyword];

    if (kind) {
      i++;
      const name = tokens[i]?.toUpperCase();
      if (!name || name === '{' || name === '}') {
        skipBlock();
        continue;
      }
      i++;
      if (tokens[i] !== '{') continue;
      i++;

      const def = blankLight(kind);
      let sawSecondary = false;
      while (i < tokens.length && tokens[i] !== '}') {
        const key = tokens[i].toLowerCase();
        i++;
        switch (key) {
          case 'color': {
            const r = num();
            const g = num();
            const b = num();
            if (r !== null && g !== null && b !== null) {
              def.r = r;
              def.g = g;
              def.b = b;
            }
            break;
          }
          case 'size': {
            const v = num();
            if (v !== null) def.size = clampSize(v);
            break;
          }
          case 'secondarysize': {
            const v = num();
            if (v !== null) {
              def.secondarySize = clampSize(v);
              sawSecondary = true;
            }
            break;
          }
          case 'interval': {
            const v = num();
            if (v !== null) def.interval = v;
            break;
          }
          case 'chance': {
            const v = num();
            if (v !== null) def.chance = v;
            break;
          }
          case 'offset': {
            const x = num();
            const up = num();
            const y = num();
            if (x !== null && up !== null && y !== null) {
              def.offX = x;
              def.offY = y;
              def.offZ = up;
            }
            break;
          }
          case 'dontlightself': {
            const v = num();
            def.dontLightSelf = v === null ? true : v !== 0;
            break;
          }
          case 'subtractive': {
            const v = num();
            def.subtractive = v === null ? true : v !== 0;
            break;
          }
          default:
            // An unrecognised key (`attenuate`, `additive`, `spot`, `halo`, …): drop whatever
            // numbers follow it and carry on with the next key.
            while (num() !== null);
            break;
        }
      }
      i++; // past '}'
      if (!sawSecondary) def.secondarySize = def.size;
      into.lights.set(name, def);
      continue;
    }

    if (keyword === 'object') {
      i++;
      // The class name is read only to be skipped: this engine binds by sprite frame.
      if (tokens[i] !== '{') i++;
      if (tokens[i] !== '{') {
        skipBlock();
        continue;
      }
      i++;
      while (i < tokens.length && tokens[i] !== '}') {
        if (tokens[i].toLowerCase() !== 'frame') {
          i++;
          continue;
        }
        i++;
        const frame = tokens[i]?.toUpperCase();
        i++;
        if (!frame || tokens[i] !== '{') continue;
        i++;
        let light: string | null = null;
        while (i < tokens.length && tokens[i] !== '}') {
          if (tokens[i].toLowerCase() === 'light') {
            light = tokens[i + 1]?.toUpperCase() ?? null;
            i += 2;
          } else {
            i++;
          }
        }
        i++; // past the frame block's '}'
        if (!light) continue;
        // GZDoom stores the frame name as written and matches it exactly against the actor's
        // current frame; a 4-character name therefore covers every frame of that sprite, and a
        // 5-character one exactly the frame it names (`gldefs.cpp`'s frame-name handling).
        if (frame.length >= 4) into.frames.set(frame.slice(0, 5), light);
      }
      i++; // past the object block's '}'
      continue;
    }

    // Any other top-level block type this engine has no use for.
    i++;
    skipBlock();
  }

  into.resolved.clear();
  return into;
}

/**
 * The light bound to a drawn sprite frame, or null. An exact 5-character binding wins over the
 * sprite-wide one — the stock file relies on it for the blur sphere, whose `PINS` rule covers the
 * sprite while `PINSA`..`PINSD` override single frames.
 */
export function lightForFrame(defs: Gldefs, frameKey: string): LightDef | null {
  const memo = defs.resolved.get(frameKey);
  if (memo !== undefined) return memo;
  if (frameKey.length < 4) return null;
  const name = defs.frames.get(frameKey) ?? defs.frames.get(frameKey.slice(0, 4));
  const def = name ? (defs.lights.get(name) ?? null) : null;
  defs.resolved.set(frameKey, def);
  return def;
}

/**
 * Parses every GLDEFS-family lump the loaded set carries, in load order, over `base` — a later
 * file's definition of the same light name or frame binding replaces the earlier one, which is
 * GZDoom's own layering (`gldefs.cpp: LoadGLDefs` reads all such lumps rather than the first).
 * `base` is not mutated.
 */
export function gldefsFromWad(wad: Wad, base: Gldefs): Gldefs {
  const merged: Gldefs = {
    lights: new Map(base.lights),
    frames: new Map(base.frames),
    resolved: new Map(),
  };
  const lumps = GLDEFS_LUMPS.flatMap((name) => wad.findAll(name)).sort((a, b) => a.index - b.index);
  for (const lump of lumps) {
    try {
      parseGldefs(decodeTextLump(wad.data(lump)), merged);
    } catch (err) {
      console.warn(`GLDEFS lump ${lump.name} could not be read:`, err);
    }
  }
  return merged;
}

/** Memoized: the lump is a fixed asset, and every level load would otherwise re-decode it. */
let stockText: Promise<string> | null = null;

/**
 * The stock GZDoom light definitions as text for `parseGldefs`: the `GLDEFS` lump of the WAD the
 * engine ships, built from `assets/gldefs.txt`. A file that fails to load resolves to an empty
 * string rather than rejecting — no lights is a worse looking game, not a broken one, and it must
 * never keep a level from starting. See docs/wad.md § The WAD the engine ships.
 */
export function stockGldefs(): Promise<string> {
  stockText ??= shippedLump(SHIPPED_GLDEFS).then((lump) => (lump ? decodeTextLump(lump) : ''));
  return stockText;
}
