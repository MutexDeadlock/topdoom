/**
 * The wall half of the build: which of a linedef's three bands are drawn, the quads each becomes,
 * and the ceiling-trim index that decides an upper's fate.
 * See docs/render.md § Mesh building and § Ceiling trims.
 */
import { isTextured, LF, NO_SIDE, SKY_FLAT, type DoomMap, type LineDef, type SideDef, type Sector, type Vertex } from '../../wad/map.ts';
import type { Size } from '../textures.ts';
import type { Pos2 } from '../../types.ts';
import { vecLength } from '../../util/geom.ts';
import { skyLitSector } from '../skytint.ts';
import { lightSegment, wallContrast } from '../sectorlight.ts';
import { readStorage, writeStorage } from '../../util/storage.ts';
import { pushVertex, type Build, type SizeFn } from './build.ts';
import { WALL_CHUNK_LEN, type SectorTransfers } from './defs.ts';

const STORAGE_KEY = 'ceilingTrims';

/**
 * Whether thin ceiling steps are left out at all. On by default, and read once per level
 * (`trimIndex`): a trim is baked into the static batches, so a toggle mid-level would leave a
 * mover rebuild disagreeing with them. docs/render.md § Ceiling trims.
 */
let enabled = readStorage(STORAGE_KEY, true);

export function getCeilingTrims(): boolean {
  return enabled;
}

export function setCeilingTrims(on: boolean): void {
  enabled = on;
  writeStorage(STORAGE_KEY, on);
}

/** The two solid tiers one side of a two-sided line draws — see `twoSidedBands`. */
export interface DrawnBands {
  /** The lower step, drawn when `lowerTop > lowerBot`. */
  lowerBot: number;
  lowerTop: number;
  /** The upper step, drawn when `upperTop > upperBot`, not `skyPair` and not `upperTrimmed`. */
  upperBot: number;
  upperTop: number;
  /** Two sky ceilings, between which vanilla draws no upper at all. */
  skyPair: boolean;
  /**
   * A thin ceiling step over an opening the player walks under, which this engine draws as
   * nothing. Never true with `skyPair`; a deliberate deviation, docs/render.md § Ceiling trims.
   */
  upperTrimmed: boolean;
}

/** A zeroed record for a caller keeping one as scratch, so the field list exists in one place. */
export function newDrawnBands(): DrawnBands {
  return { lowerBot: 0, lowerTop: 0, upperBot: 0, upperTop: 0, skyPair: false, upperTrimmed: false };
}

/**
 * **Which bands one side of a two-sided line draws, and how tall** — the heights resolved through
 * Boom's 242 transfers rather than read off the two sectors. Exported because the auto camera asks
 * the same question (`autocamera.ts`'s `hidesFromCamera`), and the one owner of the rule so the
 * two cannot drift; written into a caller's record, so neither allocates.
 *
 * `wallHeightCap` is deliberately *not* applied here: no occlusion question wants a wall shortened
 * by a build option. `upperTrimmed` is the opposite case and belongs here — a trimmed upper is a
 * quad that does not exist, which no occlusion question may believe in either.
 * docs/render.md § Mesh building and § Ceiling trims.
 */
export function twoSidedBands(
  map: DoomMap,
  transfers: SectorTransfers,
  secIndex: number,
  otherIndex: number,
  upper: string,
  out: DrawnBands,
): void {
  const sec = map.sectors[secIndex];
  const other = map.sectors[otherIndex];
  out.lowerBot = transfers.drawnFloor(secIndex);
  out.lowerTop = transfers.drawnFloor(otherIndex);
  out.upperBot = ceilingFacing(transfers, other, otherIndex, secIndex);
  out.upperTop = sec.ceilHeight;
  out.skyPair = skyCeilings(sec, other);
  out.upperTrimmed = trimsCeiling(map, out, otherIndex, upper);
}

export function buildWalls(build: Build): void {
  const { map, movableSectors } = build;
  for (const [lineIndex, line] of map.linedefs.entries()) {
    // Whole line, both sides: a static neighbour's step is sized from the moving sector's heights,
    // so it cannot stay in a batch nobody rebuilds (`MapMeshOptions.movableSectors`).
    if (movableSectors && touchesAny(map, line, movableSectors)) continue;
    processLine(build, line, lineIndex);
  }
}

export function processLine(build: Build, line: LineDef, lineIndex: number): void {
  const { map, transfers, wallHeightCap, holdsStill, includeSide } = build;
  const v1 = map.vertexes[line.v1];
  const v2 = map.vertexes[line.v2];
  if (!v1 || !v2) return;

  const front = line.right !== NO_SIDE ? map.sidedefs[line.right] : undefined;
  const back = line.left !== NO_SIDE ? map.sidedefs[line.left] : undefined;
  const frontSec = front ? map.sectors[front.sector] : undefined;
  const backSec = back ? map.sectors[back.sector] : undefined;

  const cap = (sec: Sector, top: number) => (wallHeightCap > 0 ? Math.min(top, sec.floorHeight + wallHeightCap) : top);

  if (front && frontSec && !backSec) {
    if (includeSide && !includeSide(front.sector)) return;
    // Solid wall: the middle texture spans the sector height, down to the *drawn* floor so a 242
    // fake floor is not left ringed by a gap (docs/render.md § Deep water).
    const unpegged = (line.flags & LF.LOWER_UNPEGGED) !== 0;
    const floor = transfers.drawnFloor(front.sector);
    const dim = build.size('wall', front.middle);
    addWall(
      build,
      {
        ax: v1.x,
        ay: v1.y,
        bx: v2.x,
        by: v2.y,
        topH: cap(frontSec, frontSec.ceilHeight),
        botH: floor,
        texture: front.middle,
        xOffset: front.xOffset,
        yOffset: front.yOffset,
        pegRef: unpegged ? floor + (dim?.h ?? 128) : frontSec.ceilHeight,
        light: frontSec.light,
        sector: front.sector,
        line: lineIndex,
        frontSide: true,
      },
      holdsStill(front.sector),
    );
    return;
  }

  if (!front || !back || !frontSec || !backSec) return;

  // Two-sided line: each side gets its own step-up/step-down pieces, sized
  // against the *drawn* heights opposite it (`twoSidedBands`). Every tier is
  // sized from *both* sectors — the lower from the two floors, the upper from
  // the two ceilings — so one of them moving is enough to leave the whole side
  // undiced.
  const view: LineView = {
    index: lineIndex,
    flags: line.flags,
    cap,
    bandVertically: holdsStill(front.sector) && holdsStill(back.sector),
  };
  if (!includeSide || includeSide(front.sector)) {
    addTwoSidedSide(build, view, {
      a: v1,
      b: v2,
      side: front,
      secIndex: front.sector,
      sec: frontSec,
      otherIndex: back.sector,
      other: backSec,
      frontSide: true,
    });
  }
  if (!includeSide || includeSide(back.sector)) {
    addTwoSidedSide(build, view, {
      a: v2,
      b: v1,
      side: back,
      secIndex: back.sector,
      sec: backSec,
      otherIndex: front.sector,
      other: frontSec,
      frontSide: false,
    });
  }
}

/**
 * The two map-wide questions a trim asks, in one pass over the linedefs, built once: a mover
 * rebuilds through here every tic it runs and neither answer moves with a height. A sector no
 * linedef names has no extent at all, which keeps its upper.
 *
 * `signs` is what keeps an **exit sign**, and needs the art the map does not carry: a sign is a
 * texture drawn at exactly the texture's own height everywhere it appears, where material is
 * cropped or tiled to whatever band it fills. Measured off the sectors' own heights, not the drawn
 * ones — a 242 transfer changes what a wall draws, not what the mapper sized the texture for.
 */
export function trimIndex(map: DoomMap, size: SizeFn): TrimIndex {
  const cached = trimIndexes.get(map);
  if (cached) return cached;
  // The setting is read here and nowhere else, so it is latched for the level the memo belongs to.
  if (!enabled) {
    const off: TrimIndex = { trims: false, signs: new Set(), extent: new Float64Array(0) };
    trimIndexes.set(map, off);
    return off;
  }
  const n = map.sectors.length;
  const minX = new Float64Array(n).fill(Infinity);
  const minY = new Float64Array(n).fill(Infinity);
  const maxX = new Float64Array(n).fill(-Infinity);
  const maxY = new Float64Array(n).fill(-Infinity);
  const signs = new Set<string>();
  const cropped = new Set<string>();
  // Art heights by name, not by side: the largest map here draws 56 distinct textures over 13560
  // sides, and `MaterialBank.size` allocates a record per call.
  const artHeight = new Map<string, number | null>();
  const note = (name: string, height: number) => {
    if (!isTextured(name) || cropped.has(name)) return;
    let art = artHeight.get(name);
    if (art === undefined) {
      art = size('wall', name)?.h ?? null;
      artHeight.set(name, art);
    }
    if (art === null) return;
    if (art !== height) {
      cropped.add(name);
      signs.delete(name);
      return;
    }
    signs.add(name);
  };
  const stretch = (sec: number, v: Vertex) => {
    if (v.x < minX[sec]) minX[sec] = v.x;
    if (v.y < minY[sec]) minY[sec] = v.y;
    if (v.x > maxX[sec]) maxX[sec] = v.x;
    if (v.y > maxY[sec]) maxY[sec] = v.y;
  };
  const stretchSide = (side: SideDef | undefined, v1: Vertex | undefined, v2: Vertex | undefined) => {
    if (!side || side.sector >= n) return;
    if (v1) stretch(side.sector, v1);
    if (v2) stretch(side.sector, v2);
  };
  // Every band this side actually draws, at the height it draws it — the same three `addWall`
  // emits, so a texture is judged on what the player sees of it and nothing else.
  const noteSide = (side: SideDef | undefined, other: SideDef | undefined) => {
    const sec = side && map.sectors[side.sector];
    if (!side || !sec) return;
    const facing = other && map.sectors[other.sector];
    if (!facing) {
      note(side.middle, sec.ceilHeight - sec.floorHeight);
      return;
    }
    if (facing.floorHeight > sec.floorHeight) note(side.lower, facing.floorHeight - sec.floorHeight);
    if (sec.ceilHeight > facing.ceilHeight && !skyCeilings(sec, facing)) {
      note(side.upper, sec.ceilHeight - facing.ceilHeight);
    }
  };
  for (const line of map.linedefs) {
    const v1 = map.vertexes[line.v1];
    const v2 = map.vertexes[line.v2];
    const right = line.right === NO_SIDE ? undefined : map.sidedefs[line.right];
    const left = line.left === NO_SIDE ? undefined : map.sidedefs[line.left];
    stretchSide(right, v1, v2);
    stretchSide(left, v1, v2);
    noteSide(right, left);
    noteSide(left, right);
  }
  const extent = new Float64Array(n);
  for (let sec = 0; sec < n; sec++) {
    extent[sec] = Math.max(maxX[sec] - minX[sec], maxY[sec] - minY[sec]);
  }
  const index = { trims: true, signs, extent };
  trimIndexes.set(map, index);
  return index;
}

/**
 * The tallest ceiling step that reads as trim rather than as structure. **Tuned by feel**: 16 is
 * the band DOOM's mappers run around a room's edge, and 32 starts taking door lintels with it.
 * docs/render.md § Ceiling trims.
 */
const TRIM_MAX_HEIGHT = 16;

/**
 * How much room has to be left under a step before it is trim at all. Vanilla's own player height
 * (`info.c`'s `MT_PLAYER`, 56, the number `game/player.ts`'s `PLAYER_HEIGHT` carries) — under that
 * the step is a window sill or a closed door's face, which is structure whatever its height.
 */
const TRIM_MIN_OPENING = 56;

/**
 * How wide the sector whose ceiling drops may be and still be a **sign** hung from the ceiling
 * rather than a room the step runs around — the other half of the exemption `TrimIndex.signs` is
 * the first half of. **Tuned by feel**, on DOOM's 64-unit grid: every `EXITSIGN` in both id IWADs
 * hangs in a sector no wider than this. docs/render.md § Ceiling trims.
 */
const TRIM_MAX_SIGN = 64;

interface WallSpec {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  topH: number;
  botH: number;
  texture: string;
  xOffset: number;
  yOffset: number;
  /** World height at which texture row 0 sits (DOOM's "pegging"). */
  pegRef: number;
  light: number;
  /** Sector whose light level `light` was read from — carried onto the occluder record. */
  sector: number;
  /**
   * Linedef this quad belongs to, and whether it's the front (right) side — carried onto the
   * occluder record for `SurfaceScroller`.
   */
  line: number;
  frontSide: boolean;
  /** Permanent translucency — a Boom 260 midtexture, and nothing else. */
  baseAlpha?: number;
}

/**
 * True when the quad was drawn — what vanilla's `toptexture`/`bottomtexture` being non-zero decides
 * (see `addTwoSidedSide`'s midtexture clip). `bandVertically` off keeps the wall one quad tall
 * however high it is, which a wall whose height can move must be: `Build.holdsStill` decides it,
 * and `WALL_CHUNK_LEN` says why.
 */
function addWall(build: Build, spec: WallSpec, bandVertically: boolean): boolean {
  const dim = wallTextureSize(build, spec);
  if (!dim) return false;

  const dx = spec.bx - spec.ax;
  const dy = spec.by - spec.ay;
  const len = vecLength(dx, dy);

  // Fake contrast: east-west walls darken, north-south brighten, so corners stay legible under
  // flat sector lighting (`r_segs.c: R_StoreWallRange`).
  const contrast = wallContrast(spec.ax, spec.ay, spec.bx, spec.by);
  const seg = lightSegment(spec.light, contrast);

  const u0 = spec.xOffset / dim.w;
  const u1 = (spec.xOffset + len) / dim.w;
  const vTop = (spec.pegRef - spec.topH + spec.yOffset) / dim.h;
  const vBot = (spec.pegRef - spec.botH + spec.yOffset) / dim.h;

  const batch = build.batches.get('wall', spec.texture);
  const { ax, ay, bx, by, topH, botH } = spec;
  // A wall carries the tint of the room it faces into, which is the sector its light came from.
  const sky = skyLitSector(build.map.sectors[spec.sector]) ? 1 : 0;

  // Cut both ways so the fade can dissolve a ball around the sightline rather than a full-height
  // slab of wall — see `WALL_CHUNK_LEN`.
  const chunks = Math.max(1, Math.ceil(len / WALL_CHUNK_LEN));
  const bands = bandVertically ? Math.max(1, Math.ceil((spec.topH - spec.botH) / WALL_CHUNK_LEN)) : 1;
  const alpha = spec.baseAlpha ?? 1;
  for (let c = 0; c < chunks; c++) {
    const t0 = c / chunks;
    const t1 = (c + 1) / chunks;
    const cax = ax + dx * t0;
    const cay = ay + dy * t0;
    const cbx = ax + dx * t1;
    const cby = ay + dy * t1;
    // U runs linearly with wall length, so a chunk's edge U is the same lerp and shared edges land
    // on identical values. V does the same with height, for the bands.
    const cu0 = u0 + (u1 - u0) * t0;
    const cu1 = u0 + (u1 - u0) * t1;

    for (let r = 0; r < bands; r++) {
      // Bands run bottom-up, so `r`'s top is `r + 1`'s bottom. The wall's own two edges are taken
      // as given: interpolated, `top + (bottom - top)` lands an ulp off, and the fade tests a quad
      // against its line's opening exactly (docs/render-occlusion.md § Which sightlines a wall
      // fades for).
      const bandTop = r === 0 ? topH : topH + ((botH - topH) * r) / bands;
      const bandBot = r === bands - 1 ? botH : topH + ((botH - topH) * (r + 1)) / bands;
      const bandVTop = vTop + ((vBot - vTop) * r) / bands;
      const bandVBot = vTop + ((vBot - vTop) * (r + 1)) / bands;

      // A = top-left, B = top-right, C = bottom-right, D = bottom-left, facing right of a→b
      // (DOOM's front side), as the triangles A-D-C and A-C-B. Written out rather than iterated:
      // the dicing above makes up to `chunks * bands` of these, and a mover re-runs them per
      // refresh.
      const vertexStart = batch.positions.length / 3;
      pushVertex(batch, cax, bandTop, -cay, cu0, bandVTop, seg, alpha, -1, sky); // A
      pushVertex(batch, cax, bandBot, -cay, cu0, bandVBot, seg, alpha, -1, sky); // D
      pushVertex(batch, cbx, bandBot, -cby, cu1, bandVBot, seg, alpha, -1, sky); // C
      pushVertex(batch, cax, bandTop, -cay, cu0, bandVTop, seg, alpha, -1, sky); // A
      pushVertex(batch, cbx, bandBot, -cby, cu1, bandVBot, seg, alpha, -1, sky); // C
      pushVertex(batch, cbx, bandTop, -cby, cu1, bandVTop, seg, alpha, -1, sky); // B
      build.occluders.push({
        key: batch.key,
        vertexStart,
        vertexCount: 6,
        ax: cax,
        ay: cay,
        bx: cbx,
        by: cby,
        botH: bandBot,
        topH: bandTop,
        segAx: ax,
        segAy: ay,
        segBx: bx,
        segBy: by,
        sector: spec.sector,
        line: spec.line,
        texName: spec.texture,
        frontSide: spec.frontSide,
        subsector: -1,
        baseAlpha: spec.baseAlpha,
      });
    }
  }
  return true;
}

/**
 * The art `addWall` would draw this quad with, or null where it draws nothing at all — which is
 * also **vanilla's** answer for whether the tier exists, its `toptexture`/`bottomtexture` being
 * non-zero over a real span. `addTwoSidedSide` asks it without emitting for a ceiling trim, whose
 * midtexture clip has to follow vanilla rather than this engine (§ What cuts a midtexture).
 */
function wallTextureSize(build: Build, spec: WallSpec): Size | null {
  if (spec.topH <= spec.botH) return null;
  const dim = build.size('wall', spec.texture);
  if (!dim) return null;
  return vecLength(spec.bx - spec.ax, spec.by - spec.ay) < 1e-6 ? null : dim;
}

/** True if either side of `line` belongs to a sector in `sectors`. */
function touchesAny(map: DoomMap, line: LineDef, sectors: Set<number>): boolean {
  const front = line.right !== NO_SIDE ? map.sidedefs[line.right] : undefined;
  const back = line.left !== NO_SIDE ? map.sidedefs[line.left] : undefined;
  return (front !== undefined && sectors.has(front.sector)) || (back !== undefined && sectors.has(back.sector));
}

/** What both sides of a two-sided line share — resolved once per line by `processLine`. */
interface LineView {
  index: number;
  flags: number;
  /** `MapMeshOptions.wallHeightCap` applied: the height a wall in a sector is clipped to. */
  cap: (sec: Sector, top: number) => number;
  /** Whether these quads may be diced vertically — see `Build.holdsStill`. */
  bandVertically: boolean;
}

/**
 * One side of a two-sided line as `addTwoSidedSide` looks at it: the sidedef doing the drawing and
 * the sector across from it. The two calls a line makes differ only in this.
 */
interface SideView {
  /** The line's ends, ordered so the quads face right of a→b — this side's outward normal. */
  a: Pos2;
  b: Pos2;
  side: SideDef;
  secIndex: number;
  sec: Sector;
  otherIndex: number;
  other: Sector;
  frontSide: boolean;
}

/**
 * The ceiling a side of a two-sided line is sized against: the neighbour's *drawn* ceiling, which
 * a Boom 242 moves, except where the sector doing the looking has a 242 of its own. That exception
 * stands in for a branch vanilla picks per frame from where the eye is — a quad is only ever seen
 * from the sector it faces into. docs/render.md § Deep water.
 */
function ceilingFacing(transfers: SectorTransfers, other: Sector, otherIndex: number, viewerSector: number): number {
  return transfers.heightSec(viewerSector) >= 0 ? other.ceilHeight : transfers.drawnCeiling(otherIndex);
}

/** Both ceilings are sky, which draws no upper between them — see `twoSidedBands`. */
function skyCeilings(a: Sector, b: Sector): boolean {
  return a.ceilTex === SKY_FLAT && b.ceilTex === SKY_FLAT;
}

/**
 * Whether a side's upper is a **ceiling trim** — a thin step over an opening the player walks
 * under, which this engine draws as nothing. The clauses and the sign exemption are
 * docs/render.md § Ceiling trims; the heights come off the record the caller has just filled, so
 * they are the drawn ones. Ordered cheapest first: the map-wide index is only consulted for a step
 * the heights already admit, and its extent only for a step already wearing a sign.
 *
 * The index is read, never built, so a caller with no mesh behind it — the auto camera's rays
 * before a build, tests, tools — hangs no signs and trims every thin step. `beginBuild` seeds it,
 * which is what keeps the camera's verdict the one the mesh actually drew.
 */
function trimsCeiling(map: DoomMap, bands: DrawnBands, otherIndex: number, upper: string): boolean {
  if (bands.skyPair) return false;
  if (bands.upperTop <= bands.upperBot) return false;
  if (bands.upperTop - bands.upperBot > TRIM_MAX_HEIGHT) return false;
  if (bands.upperBot - Math.max(bands.lowerBot, bands.lowerTop) < TRIM_MIN_OPENING) return false;
  const index = trimIndexes.get(map);
  if (!index) return true;
  if (!index.trims) return false;
  return !(index.signs.has(upper) && index.extent[otherIndex] <= TRIM_MAX_SIGN);
}

/** What deciding a trim needs to know about the whole map — see `trimIndex`. */
interface TrimIndex {
  /** Whether the setting was on when this level built — off leaves every upper standing. */
  trims: boolean;
  /** Every texture the map draws **whole** everywhere: never cropped, never tiled. */
  signs: Set<string>;
  /** How wide each sector is at its widest, over the linedefs that bound it. */
  extent: Float64Array;
}

/** One index per map, weak on it like `bsp.ts`'s polygons — see `trimIndex`. */
const trimIndexes = new WeakMap<DoomMap, TrimIndex>();

/** `addTwoSidedSide`'s own scratch — it is not reentrant, so one record serves every side. */
const sideBands = newDrawnBands();

/**
 * How opaque a Boom 260 midtexture draws: `tran_filter_pct`'s default of 66 (`m_misc.c`'s config
 * table), the percentage Boom generates its `TRANMAP` at. Every 260 line gets this one value —
 * docs/specials-transfers.md § Translucent midtextures.
 */
const TRANSLUCENT_ALPHA = 0.66;
function addTwoSidedSide(build: Build, line: LineView, view: SideView): void {
  const { size, transfers } = build;
  const { a, b, side, secIndex, sec, otherIndex, other } = view;
  // The heights this side is *sized* against. Everything below reads these, never
  // `sec.floorHeight`/`other.ceilHeight` — except the midtexture's peg anchor, the one thing a 242
  // leaves alone (docs/render.md § Deep water).
  twoSidedBands(build.map, transfers, secIndex, otherIndex, side.upper, sideBands);
  const otherCeil = sideBands.upperBot;
  const selfFloor = sideBands.lowerBot;
  const otherFloor = sideBands.lowerTop;
  const skyPair = sideBands.skyPair;
  // A step whose own height can move is left alone whatever its span: a door would otherwise shed
  // its header mid-travel, the tic it drops under `TRIM_MAX_HEIGHT`.
  const trimmed = sideBands.upperTrimmed && build.holdsStill(secIndex) && build.holdsStill(otherIndex);
  const base = {
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
    xOffset: side.xOffset,
    yOffset: side.yOffset,
    light: sec.light,
    sector: secIndex,
    line: line.index,
    frontSide: view.frontSide,
  };
  const upperUnpegged = (line.flags & LF.UPPER_UNPEGGED) !== 0;
  const lowerUnpegged = (line.flags & LF.LOWER_UNPEGGED) !== 0;

  // Upper: this sector's ceiling is higher than the neighbour's.
  let upperDrawn = false;
  if (sec.ceilHeight > otherCeil && !skyPair) {
    const dim = size('wall', side.upper);
    const upper: WallSpec = {
      ...base,
      topH: line.cap(sec, sec.ceilHeight),
      botH: Math.min(line.cap(sec, sec.ceilHeight), otherCeil),
      texture: side.upper,
      pegRef: upperUnpegged ? sec.ceilHeight : otherCeil + (dim?.h ?? 128),
    };
    // A trim is left out of the mesh and still counts as drawn below: the midtexture clip is
    // vanilla's rule about what the mapper textured, not this engine's about what it draws.
    if (trimmed) {
      upperDrawn = wallTextureSize(build, upper) !== null;
      if (upperDrawn) build.trimmedUppers++;
    } else {
      upperDrawn = addWall(build, upper, line.bandVertically);
    }
  }

  // Lower: the neighbour's floor is higher, so a step faces this side. A pool's surface never
  // moves this — a step sized to it would ring the bottom with a hole — but a fake floor does, on
  // both sides at once. docs/render.md § Deep water.
  let lowerDrawn = false;
  if (otherFloor > selfFloor) {
    lowerDrawn = addWall(
      build,
      {
        ...base,
        topH: otherFloor,
        botH: selfFloor,
        texture: side.lower,
        pegRef: lowerUnpegged ? sec.ceilHeight : otherFloor,
      },
      line.bandVertically,
    );
  }

  // Middle: optional masked texture (grates, bars) hung across the line. Boom's 260 makes one
  // translucent and overloads the same name to point at the translucency map, in which case there
  // is no texture to draw at all. docs/specials-transfers.md § Translucent midtextures.
  if (isTextured(side.middle) && !transfers.midtexSuppressed(line.index)) {
    const dim = size('wall', side.middle);
    if (dim) {
      // What the midtexture is cut to: the tiers this side actually drew, so a step the mapper
      // left untextured cuts nothing and the texture runs on to this sector's own floor and
      // ceiling. Two sky ceilings are vanilla's one exception. docs/render.md § What cuts a
      // midtexture.
      const clipTop = skyPair ? otherCeil : upperDrawn ? Math.min(sec.ceilHeight, otherCeil) : sec.ceilHeight;
      const clipBot = lowerDrawn ? Math.max(selfFloor, otherFloor) : selfFloor;
      // The quad is the texture's own band — one copy hung off the pegged anchor, y-offset
      // included — *clipped* to that range, never sized to it. The anchor reads the **real**
      // sectors even where the opening is a 242's drawn one (docs/render.md § Deep water).
      const pegTop = Math.min(sec.ceilHeight, other.ceilHeight);
      const pegBot = Math.max(sec.floorHeight, other.floorHeight);
      const pegRef = lowerUnpegged ? pegBot + dim.h : pegTop;
      const texTop = pegRef + side.yOffset;
      const top = Math.min(clipTop, texTop);
      const bot = Math.max(clipBot, texTop - dim.h);
      addWall(
        build,
        {
          ...base,
          topH: top,
          botH: bot,
          texture: side.middle,
          pegRef,
          baseAlpha: transfers.translucentLine(line.index) ? TRANSLUCENT_ALPHA : undefined,
        },
        line.bandVertically,
      );
    }
  }
}
