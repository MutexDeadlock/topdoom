/**
 * Load-time analysis of a map's specials: which sectors a mover can drive,
 * which animate their light, which sectors a special's linedef targets, where
 * a stair chain runs, which sidedef slots carry switch art, and what a boss
 * death does on this particular map.
 *
 * Everything here is a pure function of the `DoomMap` — no runtime state, no
 * `SpecialsController`, no THREE. `scanSectors` in particular runs
 * before the controller exists at all (`mapmesh.ts` needs it to decide what
 * stays out of the static batch), which is what makes this module the natural
 * home for the rest of the same scans.
 *
 * See docs/specials.md.
 */
import { NO_SIDE, type DoomMap, type LineDef } from '../../wad/map.ts';
import type { SwitchPairLookup } from '../../wad/switches.ts';
import { nextSectorIndices, sectorLines, sectorsByTag } from '../world.ts';
import { BOSS_DEATH_TYPES } from '../things/tables.ts';
import { ThingType } from '../things/doomednums.ts';
import { lookupSpecial } from './tables.ts';
import { decodeSectorType } from './sectortypes.ts';
import { transfersOf } from './transfers.ts';
import { switchPairTexture, type SpecialDef } from './defs.ts';

/** Which sectors a special's linedef affects: the line's own back sector for manual doors, tag matches otherwise. */
export function resolveTargets(map: DoomMap, line: LineDef, def: SpecialDef): readonly number[] {
  if (def.manual) {
    const backSector = line.left !== NO_SIDE ? map.sidedefs[line.left]?.sector : undefined;
    return backSector !== undefined ? [backSector] : [];
  }
  // Tag 0 resolves to nothing here and is not in the index either — see
  // `sectorsByTag`'s doc for why that is one rule rather than two.
  return sectorsByTag(map, line.tag);
}

export type BossDeathAction =
  | { kind: 'exit' }
  | { kind: 'lowerFloorToLowest' | 'raiseToTexture' | 'blazeOpen' | 'open'; tag: number };

export interface BossDeathTrigger {
  type: number;
  action: BossDeathAction;
  /**
   * Whether `A_BossDeath`'s "make sure there is a player alive for victory" loop guards this row.
   * Only rows that really come from that function carry it — Keen's does not. See `KEEN_DOOR_TAG`.
   */
  needsLivingPlayer: boolean;
}

/**
 * The door Commander Keen's death opens. `A_KeenDie` (`p_enemy.c`) is a separate action function
 * from `A_BossDeath` and shares **neither** of its two gates: not the `gameepisode`/`gamemap`
 * check — it builds a synthetic `line_t` with `tag = 666` and calls `EV_DoDoor(&junk, open)` on any
 * map at all, which is why this trigger is appended to every table below rather than living in the
 * per-map switch — and not the player-alive check, hence `needsLivingPlayer: false`. `open` is
 * `EV_DoDoor`'s ordinary `VDOORSPEED` open-and-stay, not the blaze speed E4M6 uses.
 */
export const KEEN_DOOR_TAG = 666;

/**
 * Vanilla's `A_BossDeath` (`p_enemy.c`), confirmed against source — see docs/death.md §
 * Boss death for the full table. Pure function of the map's own lump name: vanilla gates on
 * `gameepisode`/`gamemap`, not on which WAD supplied the map, so a PWAD's own MAP07 gets the
 * same Mancubus/Arachnotron triggers the IWAD's does.
 *
 * Commander Keen's own trigger is appended to every map's table, for the reason at `KEEN_DOOR_TAG`
 * above. The Icon of Sin has no entry here at all: `A_BrainDie` exits the level directly rather
 * than through a tag, and `game/monsters/iconofsin.ts` owns it.
 */
export function bossDeathTriggersFor(mapName: string): BossDeathTrigger[] {
  /** A row of `A_BossDeath`'s own switch, and so one its player-alive loop guards. */
  const boss = (type: number, action: BossDeathAction): BossDeathTrigger => ({
    type,
    action,
    needsLivingPlayer: true,
  });
  const keen: BossDeathTrigger = {
    type: ThingType.commanderKeen,
    action: { kind: 'open', tag: KEEN_DOOR_TAG },
    needsLivingPlayer: false,
  };
  const commercial = /^MAP(\d+)$/i.exec(mapName);
  if (commercial) {
    if (Number(commercial[1]) !== 7) return [keen];
    return [
      boss(BOSS_DEATH_TYPES.mancubus, { kind: 'lowerFloorToLowest', tag: 666 }),
      boss(BOSS_DEATH_TYPES.arachnotron, { kind: 'raiseToTexture', tag: 667 }),
      keen,
    ];
  }
  const episodic = /^E(\d+)M(\d+)$/i.exec(mapName);
  if (!episodic) return [keen];
  const episode = Number(episodic[1]);
  const map = Number(episodic[2]);
  switch (episode) {
    case 1:
      return map === 8 ? [boss(BOSS_DEATH_TYPES.baron, { kind: 'lowerFloorToLowest', tag: 666 }), keen] : [keen];
    case 2:
      return map === 8 ? [boss(BOSS_DEATH_TYPES.cyberdemon, { kind: 'exit' }), keen] : [keen];
    case 3:
      return map === 8 ? [boss(BOSS_DEATH_TYPES.spiderMastermind, { kind: 'exit' }), keen] : [keen];
    case 4:
      if (map === 6) return [boss(BOSS_DEATH_TYPES.cyberdemon, { kind: 'blazeOpen', tag: 666 }), keen];
      if (map === 8) return [boss(BOSS_DEATH_TYPES.spiderMastermind, { kind: 'lowerFloorToLowest', tag: 666 }), keen];
      return [keen];
    default:
      // Vanilla's own `default:` case has no per-type check, only `gamemap != 8` — any
      // recognized boss type dying on map 8 of an unlisted episode (e.g. SIGIL's E5M8) exits.
      return map === 8
        ? [...Object.values(BOSS_DEATH_TYPES).map((type) => boss(type, { kind: 'exit' })), keen]
        : [keen];
  }
}

/**
 * Every sector a map's boss-death table can move — the tags in `bossDeathTriggersFor`, resolved
 * against `map.sectors`. **Load-bearing for `scanSectors`:** these sectors are driven by
 * `triggerTag`, which has no triggering linedef, so nothing else in that scan can find them. MAP32's
 * Keen door (sector 16, tag 666) and MAP07's Arachnotron platform (sector 1, tag 667) both have no
 * linedef carrying their tag at all; without this they stay in the static batch and get drawn a
 * second time the moment their mover mesh appears. See docs/death.md § Boss death.
 */
function bossDeathSectors(map: DoomMap): number[] {
  const tags = new Set<number>();
  for (const t of bossDeathTriggersFor(map.name)) {
    if (t.action.kind !== 'exit') tags.add(t.action.tag);
  }
  const out: number[] = [];
  for (let i = 0; i < map.sectors.length; i++) {
    if (tags.has(map.sectors[i].tag)) out.push(i);
  }
  return out;
}

/**
 * True when (x, y) sits on the line's front (right-sidedef) side
 * (`P_PointOnLineSide`). Two callers need it:
 *
 * - **Use triggers**, which are refused outright from the back side, so a
 *   manual door or switch mounted on a wall is only usable from the side the
 *   mapper intended and not through the wall from behind it. Vanilla's one
 *   exception (special 124) never appears as a `use` special in
 *   `LINE_SPECIALS`, so this engine has no exception at all.
 * - **The `side` a walk trigger hands `trigger`**, which only teleports act on
 *   — docs/specials.md § Teleporters.
 */
export function isFrontSide(ax: number, ay: number, bx: number, by: number, x: number, y: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  return (y - ay) * dx < dy * (x - ax);
}

export interface StairStep {
  sectorIndex: number;
  targetHeight: number;
}

/**
 * The chain of sectors a stair builder raises, starting at `startSectorIndex`:
 * follow two-sided lines where the current sector is the line's *front* side
 * and the back sector's floor texture matches the start sector's, each step
 * `stepHeight` higher than the last.
 *
 * **Directional and single-path** — it takes the first matching line it finds
 * each round and never branches, so a mapper's stair group only works if its
 * connector lines all face the same way. That is vanilla's own
 * `EV_BuildStairs` walk, and mapsets depend on the restriction.
 *
 * Purely a function of static map data (adjacency + floor textures), so running
 * it once at load time (`scanSectors`) and again at trigger time can't
 * disagree. `direction` and `ignoreTexture` are Boom's generalized additions
 * (`EV_DoGenStairs`' Igno bit); both default to the vanilla walk.
 */
export function findStairChain(
  map: DoomMap,
  startSectorIndex: number,
  stepHeight: number,
  direction: 'up' | 'down' = 'up',
  ignoreTexture = false,
): StairStep[] {
  const texture = map.sectors[startSectorIndex]?.floorTex;
  if (texture === undefined) return [];
  const perStep = direction === 'down' ? -stepHeight : stepHeight;
  const steps: StairStep[] = [];
  const visited = new Set<number>([startSectorIndex]);
  let sectorIndex = startSectorIndex;
  let height = map.sectors[startSectorIndex].floorHeight;
  for (;;) {
    height += perStep;
    steps.push({ sectorIndex, targetHeight: height });
    let next = -1;
    for (const lineIndex of sectorLines(map, sectorIndex)) {
      const line = map.linedefs[lineIndex];
      if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
      if (map.sidedefs[line.right]?.sector !== sectorIndex) continue;
      const backSector = map.sidedefs[line.left]?.sector;
      if (backSector === undefined || visited.has(backSector)) continue;
      if (!ignoreTexture && map.sectors[backSector]?.floorTex !== texture) continue;
      next = backSector;
      break;
    }
    if (next === -1) break;
    visited.add(next);
    sectorIndex = next;
  }
  return steps;
}

/** One sidedef texture slot that's a switch graphic (SW1/SW2 name), with both states resolved. */
export interface SwitchEntry {
  sideIndex: number;
  slot: 'upper' | 'lower' | 'middle';
  sectorIndex: number;
  onTexture: string;
  offTexture: string;
}

/**
 * Switch-textured slots on either side of `line` — regardless of trigger
 * kind (walkover switches with real SW art exist too, if rarely). The
 * texture found at scan time is treated as "off"; its pair is "on".
 *
 * `pairs` resolves that pair: the `SW1`/`SW2` name convention by default, or
 * the WAD set's own `SWITCHES` table when it ships one (`wad/switches.ts`),
 * whose pairs need not share a suffix. Passed in rather than looked up here
 * because this stays a pure function of the map — docs/wad.md § ANIMATED and
 * SWITCHES.
 */
export function findSwitchEntries(
  map: DoomMap,
  line: LineDef,
  pairs: SwitchPairLookup = switchPairTexture,
): SwitchEntry[] {
  const out: SwitchEntry[] = [];
  for (const sideIndex of [line.right, line.left]) {
    if (sideIndex === NO_SIDE) continue;
    const side = map.sidedefs[sideIndex];
    if (!side) continue;
    for (const slot of ['upper', 'lower', 'middle'] as const) {
      const offTexture = side[slot];
      const onTexture = pairs(offTexture);
      if (onTexture) out.push({ sideIndex, slot, sectorIndex: side.sector, onTexture, offTexture });
    }
  }
  return out;
}

/**
 * The two sector sets a map's specials imply, from one walk of its linedefs.
 *
 * - `moving`: sectors whose floor or ceiling a special can actually drive.
 * - `movable`: those plus the ones pulled out of the static batch only so a
 *   switch texture can be swapped on them — a superset of `moving`.
 *
 * They are different questions and `mapmesh.ts` needs both — a mesh that never
 * moves is diced vertically like static geometry, and one that does cannot be
 * (`WALL_CHUNK_LEN`). docs/render.md § Mover meshes.
 */
export interface SectorScan {
  moving: Set<number>;
  movable: Set<number>;
}

/**
 * Both sets of `SectorScan` in one pass. `pairs` is `findSwitchEntries`'
 * switch-pair lookup, and must be the same one the controller is given or the
 * two disagree about which sectors carry switches.
 */
export function scanSectors(map: DoomMap, pairs?: SwitchPairLookup): SectorScan {
  const moving = new Set<number>();
  /** Switch hosts, held aside so they widen `movable` without ever reaching `moving`. */
  const switchHosts: number[] = [];
  for (let i = 0; i < map.sectors.length; i++) {
    // Sector-type door timers (10/14) never wait for a linedef trigger, so
    // there's no `def`/tag-resolution step to hook into here — the sector
    // itself is the mover from the moment the map loads.
    if (decodeSectorType(map.sectors[i].special).doorTimer !== null) moving.add(i);
  }
  for (const line of map.linedefs) {
    const def = lookupSpecial(line.special);
    if (!def) continue;
    for (const e of findSwitchEntries(map, line, pairs)) switchHosts.push(e.sectorIndex);
    if (def.effect.kind === 'stairs') {
      // The tag match only names the chain's start; the rest is discovered by
      // walking the same texture-matched adjacency the trigger will use.
      for (const startSector of resolveTargets(map, line, def)) {
        for (const step of findStairChain(map, startSector, def.effect.stepHeight, def.effect.direction, def.effect.ignoreTexture)) {
          moving.add(step.sectorIndex);
        }
      }
    } else if (def.effect.kind === 'donut') {
      // Same reasoning as stairs above: the tag only names the "hole", and
      // its ring neighbor is discovered dynamically (see triggerDonut) so it
      // has to be walked here too, not just resolved from the tag.
      for (const startSector of resolveTargets(map, line, def)) {
        moving.add(startSector);
        const ringIndex = nextSectorIndices(map, startSector)[0];
        if (ringIndex !== undefined) moving.add(ringIndex);
      }
    } else if (
      def.effect.kind !== 'exit' &&
      def.effect.kind !== 'teleport' &&
      def.effect.kind !== 'lightChange'
    ) {
      // Exit doesn't move geometry; teleport's tag match is a destination
      // lookup, not a mover — the target sector's own height never changes.
      // A pure light change never moves geometry either, so it stays out of
      // the moving set: `recolorSector` reaches static and mover geometry
      // alike, and a sector whose height never changes has no reason to pay
      // for a mesh of its own.
      for (const sectorIndex of resolveTargets(map, line, def)) moving.add(sectorIndex);
    }
  }
  // A boss-death tag has no triggering linedef for the loop above to find — see bossDeathSectors.
  for (const sectorIndex of bossDeathSectors(map)) moving.add(sectorIndex);
  addWaterDependents(map, moving);
  const movable = new Set(moving);
  for (const sectorIndex of switchHosts) movable.add(sectorIndex);
  // Run again over the widened set rather than trusting the pass above: a
  // switch sector could itself be a 242 control.
  addWaterDependents(map, movable);
  return { moving, movable };
}

/**
 * A Boom 242 sector draws its water surface at its control sector's floor
 * height, so a *movable* control sector makes the water movable too — it needs
 * a mesh of its own to rebuild, exactly like a sector that moves itself.
 *
 * Iterated to a fixpoint because a water sector can itself be another one's
 * control sector; the loop is bounded by the set only ever growing.
 * docs/specials.md § Deep water.
 */
function addWaterDependents(map: DoomMap, out: Set<number>): void {
  const transfers = transfersOf(map);
  if (!transfers.hasAny) return;
  const water = transfers.waterSectors();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { sector, control } of water) {
      if (out.has(control) && !out.has(sector)) {
        out.add(sector);
        changed = true;
      }
    }
  }
}

/** Sectors animating their light level — no geometry impact, just a recolor. */
export function computeLightSectors(map: DoomMap): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < map.sectors.length; i++) {
    if (decodeSectorType(map.sectors[i].special).lightPattern !== null) out.add(i);
  }
  return out;
}
