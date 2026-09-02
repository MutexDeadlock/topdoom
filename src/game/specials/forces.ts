/**
 * Boom's parameter lines: the specials consumed once at level spawn to give a surface or a sector
 * a permanent physical property, rather than dispatched from a trigger — scrolling walls and flats,
 * conveyors, sector friction and the pushers. See docs/specials.md § Scrollers and conveyors.
 */
import type { DoomMap, Thing } from '../../wad/map.ts';
import { NO_SIDE } from '../../wad/map.ts';
import { sectorsByTag, linesByTag, type SectorTouchCache, type World } from '../world.ts';
import { decodeSectorType } from './sectortypes.ts';
import { transfersOf, type Transfers } from './transfers.ts';
import { EYE_HEIGHT } from '../player.ts';
import { NO_FRICTION, ORIG_FRICTION, type FrictionEffect } from './defs.ts';
import { ThingType } from '../things/doomednums.ts';
import { DOOM_TIC } from '../../constants.ts';
import type { Pos3 } from '../../types.ts';
import type { ScrollerSnapshot } from '../snapshot.ts';
import { vecLength } from '../../util/geom.ts';

/**
 * `P_SpawnScrollers`' `SCROLL_SHIFT` of 5: a scroller's rate is its control
 * line's own vector divided by 32, in map units per tic. Written as the divisor
 * rather than a shift because everything here is float map units, not fixed
 * point.
 */
const SCROLL_DIVISOR = 1 << 5;

/**
 * `p_spec.c`'s `CARRYFACTOR`, 3/32 — what turns a scroll rate into the impulse
 * given to things standing on it, "so scrolling floors and objects on them can
 * move at same speed".
 */
const CARRY_FACTOR = 0.09375;

/**
 * Tics per second. Rates lifted from thinkers are per tic; this engine's velocities are per second.
 */
const TICS_PER_SECOND = 1 / DOOM_TIC;

/**
 * `T_Pusher`'s `PUSH_FACTOR` of 7: a pusher line's length is its magnitude in
 * map units, and the impulse it applies per tic is that shifted down by
 * `FRACBITS - PUSH_FACTOR` — i.e. divided by 2^7.
 */
const PUSH_DIVISOR = 1 << 7;

/**
 * `doomdef.h`: the thrust factor that goes with vanilla's own friction
 * (`ORIG_FRICTION_FACTOR`, `0x800`), and the momentum above which a muddy floor
 * starts giving better footing (`15000` in fixed point, so 0.229 units/tic).
 * `ORIG_FRICTION` itself lives in `defs.ts` beside `NO_FRICTION`, since
 * `player.ts` needs the same number.
 */
const ORIG_FRICTION_FACTOR = 2048;
const MORE_FRICTION_MOMENTUM = 15000 / 0x10000;

/**
 * `p_local.h`'s `MAXMOVE` (30 units/tic), the clamp `P_XYMovement` puts on
 * momentum however slippery the floor underneath is, expressed as a multiple of
 * vanilla's own terminal speed running on a normal floor — thrust
 * `forwardmove[1] × ORIG_FRICTION_FACTOR` over `1 − ORIG_FRICTION`, 16.67
 * units/tic, so 1.8×. It is the ceiling on how far a friction sector can raise
 * the terminal speed, and the reason `frictionUnder` bounds the friction it
 * derives its two scales from: a 223 line long enough for MBF's own clamp to
 * pin `friction` at exactly 1 would otherwise read as an infinite terminal.
 * docs/movement.md § Friction.
 */
const MAX_TARGET_SCALE = 30 / ((50 * ORIG_FRICTION_FACTOR) / 0x10000 / (1 - ORIG_FRICTION));

/**
 * What one scroller moves. `side` rewrites a linedef's front sidedef offsets
 * (Boom's `sc_side`, whose affectee is always `*l->sidenum`, so the line index
 * plus "front" names it exactly); `floorTex`/`ceilTex` are a sector's flat
 * offsets; `carry` is the conveyor channel that moves things standing on it.
 */
export type ScrollTarget = 'side' | 'floorTex' | 'ceilTex' | 'carry';

/**
 * One `T_Scroll` thinker as plain data: `dx`/`dy` are its authored rate in map
 * units per **tic**, `vdx`/`vdy` the accelerative integrator, `lastHeight` the
 * displacement control sector's previous `floor + ceiling`. `affectee` is a
 * linedef index for `side` and a sector index for the rest.
 */
interface Scroller {
  target: ScrollTarget;
  dx: number;
  dy: number;
  affectee: number;
  /** Sector whose height change drives this scroller, or -1 for a plain one. */
  control: number;
  accel: boolean;
  vdx: number;
  vdy: number;
  lastHeight: number;
  /**
   * The rate `tick` last resolved for this scroller, units per tic — what `advanceOffsets`
   * integrates between tics.
   */
  rate: Vec2;
}

/**
 * This file's own 2D pair: a scrolling surface's accumulated texture offset, a
 * scroll rate, a conveyor or pusher impulse. Deliberately **not** `Pos2`, which
 * `types.ts` reserves for positions in map space — nothing here is a point.
 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * One `T_Pusher` thinker as plain data. `wind` and `current` are constant
 * forces over a whole sector, differing only in how being off the floor changes
 * them; `point` radiates from (or pulls toward) an `MT_PUSH`/`MT_PULL` thing,
 * falling off linearly with distance and needing line of sight.
 *
 * `xMag`/`yMag` are the impulse in map units per tic, and are what wind and
 * current are made of. `x`/`y`, `magnitude` and `away` are `point`'s alone —
 * the union member the `kind` tag selects.
 */
type Pusher = { sector: number } & (
  | { kind: 'wind' | 'current'; xMag: number; yMag: number }
  | {
      kind: 'point';
      /** The `MT_PUSH`/`MT_PULL` thing this radiates from. */
      x: number;
      y: number;
      /** Strength at the source, and — doubled — the distance the force reaches zero at. */
      magnitude: number;
      /** Away from the source (`MT_PUSH`) rather than toward it (`MT_PULL`). */
      away: boolean;
    }
);

/**
 * What `frictionUnder` measures for, beside the point it stands at: the body's box, how fast it is
 * going, and its own touched-sector cache. Named because `radius` and `speed` are adjacent numbers
 * a call site could swap in silence — docs/conventions.md § Named arguments. The per-thing queries
 * beside it stay scalar; see `carryForBody`.
 */
export interface FrictionQuery {
  radius: number;
  speed: number;
  cache: SectorTouchCache;
}

/**
 * What one 250-254 control line says about every scroller it spawns: the authored rate in map
 * units per tic, the sector whose height drives it (-1 for a plain scroller), and whether it
 * accelerates. Taken as a record because `control` and `affectee` are both plain sector-ish
 * indexes and were adjacent arguments — docs/conventions.md § Named arguments.
 */
interface ScrollSource {
  dx: number;
  dy: number;
  control: number;
  accel: boolean;
}

/** Zero, handed back for every surface that has no scroller — never mutated. */
const NO_OFFSET: Readonly<Vec2> = { x: 0, y: 0 };

/**
 * The always-on parameter lines of one level: scanned once from the map, then
 * ticked with the simulation.
 *
 * **Two clocks, deliberately.** `tick` advances everything the simulation can observe exactly once
 * per tic; `advanceOffsets` integrates the *visual* offsets per rendered frame off the rate `tick`
 * last computed, so a scrolling waterfall doesn't step at 35 Hz.
 * docs/specials.md § Scrollers and conveyors.
 */
export class Forces {
  private map: DoomMap;
  private world: World;
  private scrollers: Scroller[] = [];
  private pushers: Pusher[] = [];
  /**
   * Accumulated offsets by affectee, one map per target kind — read by the renderer every frame.
   */
  private sideOffsets = new Map<number, Vec2>();
  private floorOffsets = new Map<number, Vec2>();
  private ceilOffsets = new Map<number, Vec2>();
  /** This tic's conveyor impulse per sector, in map units/sec — rebuilt by `tick`. */
  private carry = new Map<number, Vec2>();
  /**
   * Bounding box over every sector a conveyor targets, in map units, or an
   * inverted box where the level has none. `carryForBody` runs for *every* thing
   * on the level every tic, so this rejects the overwhelming majority before the
   * BSP descent `sectorsTouching` would cost.
   */
  private carryBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  /**
   * Returned by `carryForBody` and `pushForBody`, which run per body per tic — see their docs. One
   * each, so a caller can hold both at once.
   */
  private carryScratch: Vec2 = { x: 0, y: 0 };
  private pushScratch: Vec2 = { x: 0, y: 0 };
  private frictionScratch: FrictionEffect = { friction: ORIG_FRICTION, targetScale: 1, accelScale: 1 };
  /** `pushForBody`'s line-of-sight target, rewritten per point pusher rather than allocated. */
  private sightScratch: Pos3 = { x: 0, y: 0, z: 0 };
  /**
   * Per-sector friction and thrust factor, `sec->friction`/`sec->movefactor` —
   * filled once by `spawnFriction`, never ticked (see its doc).
   */
  private friction = new Float64Array(0);
  private moveFactor = new Float64Array(0);
  /**
   * Whether any 223 line exists at all, so the per-body query costs nothing on the maps that have
   * none.
   */
  private hasFriction = false;
  /**
   * The level's render transfers, for the one thing they change about
   * *movement*: a Boom 242 sector's water surface, which both the conveyor and
   * the pusher channels test against instead of the real floor
   * (docs/specials.md § Deep water).
   */
  private transfers: Transfers;

  constructor(map: DoomMap, world: World) {
    this.map = map;
    this.world = world;
    this.transfers = transfersOf(map);
    this.spawnScrollers();
    this.boundCarrySectors();
    this.spawnPushers();
    this.spawnFriction();
  }

  /**
   * `P_GetFriction` + `P_GetMoveFactor`: what the floor under a body of this
   * radius does to its movement, or `NO_FRICTION` where nothing does.
   *
   * Every sector the body **touches** is a candidate, and vanilla's own selection rule is
   * transcribed rather than simplified to a minimum — docs/specials.md § Friction.
   *
   * `speed` is the body's current horizontal speed in map units/sec, which only a muddy floor
   * reads: `P_GetMoveFactor` boosts the thrust in three steps as momentum builds, and the
   * thresholds are low enough that anything actually walking sits in the top step.
   *
   * The result is **shared** scratch overwritten by the next call. `cache` is
   * the caller's per-body touch cache, shared with the other two body queries —
   * see `carryForBody`.
   */
  frictionUnder(pos: Pos3, body: FrictionQuery): Readonly<FrictionEffect> {
    if (!this.hasFriction) return NO_FRICTION;
    const { radius, speed, cache } = body;
    let friction = ORIG_FRICTION;
    let moveFactor = ORIG_FRICTION_FACTOR;
    for (const sectorIndex of this.world.sectorsTouchingCached(pos.x, pos.y, radius, cache)) {
      const candidate = this.friction[sectorIndex];
      // The array read first: a sector still at the normal pair can never
      // displace anything below, so this skips `decodeSectorType`'s per-call
      // record for every ordinary floor a body touches.
      if (candidate === ORIG_FRICTION && this.moveFactor[sectorIndex] === ORIG_FRICTION_FACTOR) continue;
      const sector = this.map.sectors[sectorIndex];
      if (!sector || pos.z > sector.floorHeight) continue;
      if (!decodeSectorType(sector.special).friction) continue;
      if (candidate < friction || friction === ORIG_FRICTION) {
        friction = candidate;
        moveFactor = this.moveFactor[sectorIndex];
      }
    }
    if (friction === ORIG_FRICTION) return NO_FRICTION;
    if (friction < ORIG_FRICTION) {
      // Sludge: `movefactor <<= 1/2/3` as the body gets going.
      const momentum = Math.abs(speed) * DOOM_TIC;
      if (momentum > MORE_FRICTION_MOMENTUM * 4) moveFactor *= 8;
      else if (momentum > MORE_FRICTION_MOMENTUM * 2) moveFactor *= 4;
      else if (momentum > MORE_FRICTION_MOMENTUM) moveFactor *= 2;
    }
    // The friction everything below is derived from, bounded so the terminal
    // speed it implies stays inside `P_XYMovement`'s own `MAXMOVE` — the one
    // thing that keeps a `friction` MBF's clamp pinned at exactly 1 finite
    // (mbfedit!.wad MAP01 sectors 121/154). docs/movement.md § Friction.
    const bounded = Math.min(
      friction,
      1 - ((moveFactor / ORIG_FRICTION_FACTOR) * (1 - ORIG_FRICTION)) / MAX_TARGET_SCALE,
    );
    this.frictionScratch.friction = bounded;
    // Vanilla's terminal speed is `thrust/(1 − friction)` with the thrust
    // proportional to `movefactor`; this engine's is the target velocity
    // outright, so the ratio of the two terminals *is* the scale to apply.
    this.frictionScratch.targetScale =
      (moveFactor / ORIG_FRICTION_FACTOR) * ((1 - ORIG_FRICTION) / (1 - bounded));
    // And the ramp: a per-tic decay of `f` is a continuous rate of `−ln(f)·35`,
    // so matching vanilla's time constant here is that rate over the normal
    // floor's. docs/movement.md § Friction.
    this.frictionScratch.accelScale = Math.log(bounded) / Math.log(ORIG_FRICTION);
    return this.frictionScratch;
  }

  /**
   * Whether anything in this level scrolls at all — lets the per-frame caller skip the walk
   * entirely.
   */
  get hasScrollers(): boolean {
    return this.scrollers.length > 0;
  }

  /** The linedefs whose front sidedef scrolls — the renderer's index, read once. */
  scrollingLines(): readonly number[] {
    const out: number[] = [];
    for (const s of this.scrollers) {
      if (s.target === 'side' && !out.includes(s.affectee)) out.push(s.affectee);
    }
    return out;
  }

  /** The sector surfaces whose flat scrolls — the renderer's index, read once. */
  scrollingFlats(): readonly { sector: number; isCeiling: boolean }[] {
    const out: { sector: number; isCeiling: boolean }[] = [];
    for (const s of this.scrollers) {
      if (s.target !== 'floorTex' && s.target !== 'ceilTex') continue;
      const isCeiling = s.target === 'ceilTex';
      if (!out.some((f) => f.sector === s.affectee && f.isCeiling === isCeiling)) {
        out.push({ sector: s.affectee, isCeiling });
      }
    }
    return out;
  }

  /**
   * How many sectors a 223 line gave a friction other than normal — the inspector's coverage line.
   */
  get frictionSectors(): number {
    let n = 0;
    for (let i = 0; i < this.friction.length; i++) if (this.friction[i] !== ORIG_FRICTION) n++;
    return n;
  }

  /** How many pushers this level spawned — same. */
  get pusherCount(): number {
    return this.pushers.length;
  }

  /** Scroller count by target, for the headless inspector's coverage line. */
  counts(): Record<ScrollTarget, number> {
    const out: Record<ScrollTarget, number> = { side: 0, floorTex: 0, ceilTex: 0, carry: 0 };
    for (const s of this.scrollers) out[s.target]++;
    return out;
  }

  /**
   * One simulation tic of `T_Scroll`: resolves each scroller's rate for this
   * tic (control-sector delta, then acceleration) and rebuilds the conveyor
   * impulses from it. The visual offsets are integrated separately — see the
   * class doc.
   */
  tick(): void {
    this.carry.clear();
    for (const s of this.scrollers) {
      let dx = s.dx;
      let dy = s.dy;
      if (s.control !== -1) {
        const height = this.controlHeight(s.control);
        const delta = height - s.lastHeight;
        s.lastHeight = height;
        dx *= delta;
        dy *= delta;
      }
      if (s.accel) {
        s.vdx += dx;
        s.vdy += dy;
        dx = s.vdx;
        dy = s.vdy;
      }
      // Vanilla's own early-out: a scroller whose rate resolved to nothing this
      // tic (a displacement scroller whose control sector didn't move) does not
      // touch its target at all.
      if (dx === 0 && dy === 0) {
        s.rate.x = 0;
        s.rate.y = 0;
        continue;
      }
      s.rate.x = dx;
      s.rate.y = dy;
      if (s.target === 'carry') {
        const into = this.carry.get(s.affectee);
        // Cumulative, as Boom's are: several conveyor lines may name one sector.
        if (into) {
          into.x += dx * TICS_PER_SECOND;
          into.y += dy * TICS_PER_SECOND;
        } else {
          this.carry.set(s.affectee, { x: dx * TICS_PER_SECOND, y: dy * TICS_PER_SECOND });
        }
      }
    }
  }

  /**
   * Integrates the visual offsets by `dt` seconds at the rate `tick` last
   * resolved. Called once per rendered frame, not per tic — see the class doc.
   */
  advanceOffsets(dt: number): void {
    const tics = dt * TICS_PER_SECOND;
    for (const s of this.scrollers) {
      if (s.target === 'carry') continue;
      if (s.rate.x === 0 && s.rate.y === 0) continue;
      const into = this.offsetsFor(s.target);
      let offset = into.get(s.affectee);
      if (!offset) {
        offset = { x: 0, y: 0 };
        into.set(s.affectee, offset);
      }
      offset.x += s.rate.x * tics;
      offset.y += s.rate.y * tics;
    }
  }

  /** Accumulated offset of a linedef's front sidedef, in map units. */
  sideOffset(lineIndex: number): Readonly<Vec2> {
    return this.sideOffsets.get(lineIndex) ?? NO_OFFSET;
  }

  /** Accumulated offset of a sector's floor or ceiling flat, in map units. */
  flatOffset(sectorIndex: number, isCeiling: boolean): Readonly<Vec2> {
    return (isCeiling ? this.ceilOffsets : this.floorOffsets).get(sectorIndex) ?? NO_OFFSET;
  }

  /** This tic's conveyor impulse for one sector, map units/sec, or null where nothing carries. */
  carryInSector(sectorIndex: number): Readonly<Vec2> | null {
    return this.carry.get(sectorIndex) ?? null;
  }

  /**
   * This tic's conveyor impulse for a body of this radius standing at `z`, or null where nothing
   * carries it — `T_Scroll`'s `sc_carry` walk seen from the thing rather than from the sector.
   * Every touched sector counts, a body only rides a floor it is standing on, and overlapping
   * belts sum. docs/specials.md § Scrollers and conveyors.
   *
   * `cache` must be the caller's **own body's** (docs/world.md § Sectors under a body). Scalars
   * rather than a record: this runs per thing per frame, through `ThingLayer.update`'s carry
   * callback. The return is shared scratch the next call overwrites, and `MF_NOGRAVITY` bodies are
   * the caller's to skip — this has no thing table.
   */
  carryForBody(pos: Pos3, radius: number, cache: SectorTouchCache): Readonly<Vec2> | null {
    if (this.carry.size === 0) return null;
    // Cheap reject before the BSP descent: most things on a conveyor map are
    // nowhere near a belt. See `carryBounds`.
    const b = this.carryBounds;
    if (pos.x + radius < b.minX || pos.x - radius > b.maxX) return null;
    if (pos.y + radius < b.minY || pos.y - radius > b.maxY) return null;
    let cx = 0;
    let cy = 0;
    for (const sectorIndex of this.world.sectorsTouchingCached(pos.x, pos.y, radius, cache)) {
      const carry = this.carry.get(sectorIndex);
      if (!carry) continue;
      const sector = this.map.sectors[sectorIndex];
      if (!sector) continue;
      // "Underwater, carry things even w/o gravity": a body below a 242 sector's
      // water surface rides the belt whether or not it is standing on the floor.
      const water = this.transfers.waterHeight(sectorIndex);
      if (pos.z > sector.floorHeight && !(water !== null && pos.z < water)) continue;
      cx += carry.x;
      cy += carry.y;
    }
    if (cx === 0 && cy === 0) return null;
    this.carryScratch.x = cx;
    this.carryScratch.y = cy;
    return this.carryScratch;
  }

  /**
   * This tic's pusher impulse on the **player** standing at `pos`, map
   * units/sec, or null where nothing pushes — `T_Pusher`.
   *
   * Wind and current are constant over their sector and differ only in what being off the floor
   * does; a point source radiates from its `MT_PUSH`/`MT_PULL` thing and needs line of sight.
   *
   * **Players only** — including voodoo dolls, which are player mobjs. A conveyor's carry has no
   * such gate (`carryForBody`); the asymmetry is deliberate. See docs/specials.md § Pushers.
   *
   * Like `carryForBody`, the caller supplies its per-body `cache` and gets
   * back **shared** scratch that this method's next call overwrites — read it
   * before calling again.
   */
  pushForBody(pos: Pos3, radius: number, onGround: boolean, cache: SectorTouchCache): Readonly<Vec2> | null {
    if (this.pushers.length === 0) return null;
    let px = 0;
    let py = 0;
    const touching = this.world.sectorsTouchingCached(pos.x, pos.y, radius, cache);
    for (const p of this.pushers) {
      // "Be sure the special sector type is still turned on" — a switch can
      // rewrite the sector's special out from under a live pusher.
      if (!decodeSectorType(this.map.sectors[p.sector]?.special ?? 0).push) continue;
      if (p.kind === 'point') {
        // Unlike wind/current this crosses sector boundaries: what matters is
        // the distance to the source, not which sector the body is standing in.
        const dist = aproxDistance(pos.x - p.x, pos.y - p.y);
        // `(magnitude - (dist >> 1)) << (FRACBITS - PUSH_FACTOR - 1)` — one
        // shift further down than the constant pushers, hence the extra halving.
        const speed = (p.magnitude - Math.floor(dist / 2)) / (PUSH_DIVISOR * 2);
        // `p->radius = magnitude << (FRACBITS + 1)` — twice the magnitude, where the force reaches
        // zero.
        if (speed <= 0 || dist > p.magnitude * 2) continue;
        this.sightScratch.x = p.x;
        this.sightScratch.y = p.y;
        this.sightScratch.z = pos.z;
        if (!this.world.hasLineOfSight(pos, this.sightScratch)) continue;
        // `R_PointToAngle2(thing, source)`, turned around by 180° for a pusher.
        const angle = Math.atan2(p.y - pos.y, p.x - pos.x) + (p.away ? Math.PI : 0);
        px += Math.cos(angle) * speed * TICS_PER_SECOND;
        py += Math.sin(angle) * speed * TICS_PER_SECOND;
        continue;
      }
      if (!touching.includes(p.sector)) continue;
      // Wind blows at full strength in the air and half on the ground; a
      // current is the other way round — nothing in the air, full on the floor.
      // In a 242 sector the water surface stands in for the floor, and wind
      // stops entirely once the eye is under it.
      const water = this.transfers.waterHeight(p.sector);
      const grounded = water === null ? onGround : pos.z <= water;
      if (p.kind === 'current' && !grounded) continue;
      if (p.kind === 'wind' && water !== null && pos.z + EYE_HEIGHT < water) continue;
      const scale = p.kind === 'wind' && grounded ? 0.5 : 1;
      px += (p.xMag / PUSH_DIVISOR) * scale * TICS_PER_SECOND;
      py += (p.yMag / PUSH_DIVISOR) * scale * TICS_PER_SECOND;
    }
    if (px === 0 && py === 0) return null;
    this.pushScratch.x = px;
    this.pushScratch.y = py;
    return this.pushScratch;
  }

  /**
   * The accelerative scrollers' integrators — the one piece of scroller state a
   * restore can't re-derive, since a belt that has built up speed keeps it
   * until its control sector moves again. Sparse and index-keyed against the
   * spawn order, and `undefined` when nothing has built up, so the overwhelming
   * majority of saves carry no block at all.
   * docs/savegames.md § What is saved and what is deliberately not.
   */
  snapshot(): ScrollerSnapshot[] | undefined {
    let saved: ScrollerSnapshot[] | undefined;
    for (const [i, s] of this.scrollers.entries()) {
      if (s.vdx === 0 && s.vdy === 0) continue;
      (saved ??= []).push([i, s.vdx, s.vdy]);
    }
    return saved;
  }

  /**
   * The restore twin. An absent block means every integrator is at zero, which is both a fresh
   * spawn and a save from before the field existed — the reason it needs no `SAVE_VERSION` bump.
   * Indices outside the list are ignored: the scroller list comes from the map, not the save.
   *
   * `lastHeight` needs no equivalent **only because of the apply order**: `Forces` is constructed
   * after `applySectors` has written the restored heights, so every displacement scroller spawns
   * watching the height it was saved at. Spawning it earlier would make the first restored tic see
   * the whole saved-to-authored difference as one tic's movement. docs/savegames.md § Apply order.
   */
  restore(saved: readonly ScrollerSnapshot[] | undefined): void {
    if (!saved) return;
    for (const [i, vdx, vdy] of saved) {
      const s = this.scrollers[i];
      if (!s) continue;
      s.vdx = vdx;
      s.vdy = vdy;
    }
  }

  /**
   * Fills `carryBounds` from the linedefs bounding every conveyor sector — a
   * sector's footprint is contained in its own lines' vertices, so this is a
   * conservative box. Runs once, after `spawnScrollers` has decided which
   * sectors carry.
   */
  private boundCarrySectors(): void {
    const carrying = new Set<number>();
    for (const s of this.scrollers) if (s.target === 'carry') carrying.add(s.affectee);
    if (carrying.size === 0) return;
    const b = this.carryBounds;
    for (const line of this.map.linedefs) {
      const front = line.right === NO_SIDE ? undefined : this.map.sidedefs[line.right]?.sector;
      const back = line.left === NO_SIDE ? undefined : this.map.sidedefs[line.left]?.sector;
      if (!(front !== undefined && carrying.has(front)) && !(back !== undefined && carrying.has(back))) continue;
      for (const v of [this.map.vertexes[line.v1], this.map.vertexes[line.v2]]) {
        if (!v) continue;
        if (v.x < b.minX) b.minX = v.x;
        if (v.x > b.maxX) b.maxX = v.x;
        if (v.y < b.minY) b.minY = v.y;
        if (v.y > b.maxY) b.maxY = v.y;
      }
    }
  }

  /**
   * `P_SpawnPushers`. 224 is wind, 225 a current, 226 a point source — and 226
   * only takes effect where the tagged sector actually holds an
   * `MT_PUSH`/`MT_PULL` thing to radiate from (`P_GetPushThing`), the pusher's
   * strength and reach coming from the line's length rather than the thing.
   */
  private spawnPushers(): void {
    for (const line of this.map.linedefs) {
      if (line.special < 224 || line.special > 226) continue;
      const v1 = this.map.vertexes[line.v1];
      const v2 = this.map.vertexes[line.v2];
      if (!v1 || !v2) continue;
      // `Add_Pusher`'s `x_mag>>FRACBITS`: the line's vector in whole map units.
      const xMag = v2.x - v1.x;
      const yMag = v2.y - v1.y;
      for (const sector of sectorsByTag(this.map, line.tag)) {
        if (line.special === 226) {
          const source = this.pushThingIn(sector);
          if (!source) continue; // "No MT_P* means no effect"
          this.pushers.push({
            kind: 'point',
            sector,
            x: source.x,
            y: source.y,
            magnitude: aproxDistance(xMag, yMag),
            away: source.type === ThingType.pointPusher,
          });
        } else {
          this.pushers.push({ kind: line.special === 224 ? 'wind' : 'current', sector, xMag, yMag });
        }
      }
    }
  }

  /**
   * `P_SpawnFriction`, in PrBoom's thinkerless form: two per-sector arrays filled once at load
   * rather than a thinker re-stamping every mobj. The control line's **length** is the dial, and
   * both curves are transcribed as written — including the C's own warning that a *higher*
   * `friction` value means *less* friction. MBF's clamps are a deliberate deviation, applied
   * unconditionally here. docs/specials.md § Friction.
   */
  private spawnFriction(): void {
    this.friction = new Float64Array(this.map.sectors.length).fill(ORIG_FRICTION);
    this.moveFactor = new Float64Array(this.map.sectors.length).fill(ORIG_FRICTION_FACTOR);
    for (const line of this.map.linedefs) {
      if (line.special !== 223) continue;
      const v1 = this.map.vertexes[line.v1];
      const v2 = this.map.vertexes[line.v2];
      if (!v1 || !v2) continue;
      const length = Math.floor(aproxDistance(v2.x - v1.x, v2.y - v1.y));
      let friction = (0x1eb8 * length) / 0x80 + 0xd000;
      let moveFactor =
        friction > 0xe800 ? ((0x10092 - friction) * 0x70) / 0x158 : ((friction - 0xdb34) * 0xa) / 0x80;
      friction = Math.max(0, Math.min(0x10000, friction));
      moveFactor = Math.max(32, moveFactor);
      for (const s of sectorsByTag(this.map, line.tag)) {
        if (s >= this.friction.length) continue;
        this.friction[s] = friction / 0x10000;
        this.moveFactor[s] = moveFactor;
        this.hasFriction = true;
      }
    }
  }

  /** `P_GetPushThing`: the `MT_PUSH`/`MT_PULL` thing standing in this sector, if any. */
  private pushThingIn(sectorIndex: number): Thing | null {
    for (const thing of this.map.things) {
      if (thing.type !== ThingType.pointPusher && thing.type !== ThingType.pointPuller) continue;
      if (this.world.sectorIndexAt(thing.x, thing.y) === sectorIndex) return thing;
    }
    return null;
  }

  /**
   * `P_SpawnScrollers`. The rate is the line's own vector shifted down by
   * `SCROLL_SHIFT`, so a longer control line scrolls faster; 48 and 85 instead
   * use a fixed ±1 unit/tic (`FRACUNIT`), which is where vanilla's 35 units/sec
   * comes from.
   *
   * 245-249 (displacement, driven by the control sector's height changes) and
   * 214-218 (the same but accelerative) are remapped onto 250-254 up front,
   * exactly as Boom does, so only one set of cases is written out.
   */
  private spawnScrollers(): void {
    for (const [i, line] of this.map.linedefs.entries()) {
      const v1 = this.map.vertexes[line.v1];
      const v2 = this.map.vertexes[line.v2];
      if (!v1 || !v2) continue;
      const dx = (v2.x - v1.x) / SCROLL_DIVISOR;
      const dy = (v2.y - v1.y) / SCROLL_DIVISOR;
      let control = -1;
      let accel = false;
      let special = line.special;

      if (special >= 245 && special <= 249) {
        special += 250 - 245;
        control = this.frontSector(i);
      } else if (special >= 214 && special <= 218) {
        accel = true;
        special += 250 - 214;
        control = this.frontSector(i);
      }

      switch (special) {
        case 250: // scroll ceiling texture
          for (const s of sectorsByTag(this.map, line.tag)) {
            this.addScroller('ceilTex', s, { dx: -dx, dy, control, accel });
          }
          break;
        case 251: // scroll floor texture
        case 253: // scroll floor texture *and* carry what stands on it
          for (const s of sectorsByTag(this.map, line.tag)) {
            this.addScroller('floorTex', s, { dx: -dx, dy, control, accel });
          }
          // 253 is 251 and 252 in one line (Boom reaches the carry half by
          // falling through). The carry rate is the **unnegated** vector — only
          // the flat's own texture axis needs the sign flip above.
          if (special === 253) this.addCarry(line.tag, { dx, dy, control, accel });
          break;
        case 252: // carry what stands on the floor
          this.addCarry(line.tag, { dx, dy, control, accel });
          break;
        case 254: // scroll the tagged lines' walls, in each line's own frame
          for (const s of linesByTag(this.map, line.tag)) {
            if (s !== i) this.addWallScroller(s, { dx, dy, control, accel });
          }
          break;
        case 255: {
          // Scroll by the trigger line's own authored sidedef offsets.
          const side = this.map.sidedefs[line.right];
          if (side) this.addScroller('side', i, { dx: -side.xOffset, dy: side.yOffset, control: -1, accel });
          break;
        }
        case 48: // vanilla's own scroll-left, `FRACUNIT` per tic
          this.addScroller('side', i, { dx: 1, dy: 0, control: -1, accel });
          break;
        case 85: // Boom's scroll-right twin
          this.addScroller('side', i, { dx: -1, dy: 0, control: -1, accel });
          break;
      }
    }
  }

  /**
   * The conveyor half of 252/253: the same rate scaled by `CARRY_FACTOR`, on every tagged sector.
   */
  private addCarry(tag: number, from: ScrollSource): void {
    const rate = { ...from, dx: from.dx * CARRY_FACTOR, dy: from.dy * CARRY_FACTOR };
    for (const s of sectorsByTag(this.map, tag)) this.addScroller('carry', s, rate);
  }

  /**
   * The sector behind a line's front sidedef — Boom's `sides[*l->sidenum].sector` control lookup.
   */
  private frontSector(lineIndex: number): number {
    const line = this.map.linedefs[lineIndex];
    if (!line || line.right === NO_SIDE) return -1;
    return this.map.sidedefs[line.right]?.sector ?? -1;
  }

  /**
   * `Add_WallScroller`: rotates the rate into the *target* line's own frame, so
   * a control line drawn across the wall scrolls it vertically and one drawn
   * along it scrolls horizontally. Vanilla does this in fixed point with a
   * `finesine` table to avoid overflow on long linedefs; the float form is the
   * same projection onto the line's unit normal and tangent.
   */
  private addWallScroller(lineIndex: number, from: ScrollSource): void {
    const line = this.map.linedefs[lineIndex];
    if (!line) return;
    const v1 = this.map.vertexes[line.v1];
    const v2 = this.map.vertexes[line.v2];
    if (!v1 || !v2) return;
    const lx = v2.x - v1.x;
    const ly = v2.y - v1.y;
    const len = vecLength(lx, ly);
    if (len < 1e-6) return;
    const x = -(from.dy * ly + from.dx * lx) / len;
    const y = -(from.dx * ly - from.dy * lx) / len;
    this.addScroller('side', lineIndex, { ...from, dx: x, dy: y });
  }

  private addScroller(target: ScrollTarget, affectee: number, from: ScrollSource): void {
    if (affectee < 0) return;
    const { dx, dy, control, accel } = from;
    this.scrollers.push({
      target,
      dx,
      dy,
      affectee,
      control,
      accel,
      vdx: 0,
      vdy: 0,
      lastHeight: control >= 0 ? this.controlHeight(control) : 0,
      // A plain scroller's rate never changes, so it is live from spawn and the
      // first frame scrolls even before the first tic. A displacement one waits
      // for its control sector to move, an accelerative one for `vdx` to build.
      rate: control < 0 && !accel ? { x: dx, y: dy } : { x: 0, y: 0 },
    });
  }

  /**
   * `sectors[control].floorheight + sectors[control].ceilingheight` — what a displacement scroller
   * watches.
   */
  private controlHeight(sectorIndex: number): number {
    const sector = this.map.sectors[sectorIndex];
    return sector ? sector.floorHeight + sector.ceilHeight : 0;
  }

  private offsetsFor(target: ScrollTarget): Map<number, Vec2> {
    if (target === 'ceilTex') return this.ceilOffsets;
    if (target === 'floorTex') return this.floorOffsets;
    return this.sideOffsets;
  }
}

/**
 * Vanilla's `P_AproxDistance` (`m_fixed.c`), the cheap octagonal
 * distance estimate every pusher figure is computed against — reproduced rather
 * than replaced with a real hypotenuse, because a point pusher's reach and
 * falloff are defined in terms of it and a truer distance would move both.
 */
function aproxDistance(dx: number, dy: number): number {
  dx = Math.abs(dx);
  dy = Math.abs(dy);
  return dx < dy ? dx + dy - Math.floor(dx / 2) : dx + dy - Math.floor(dy / 2);
}
