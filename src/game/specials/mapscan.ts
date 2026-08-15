/**
 * Load-time analysis of a map's specials: which sectors a mover can drive,
 * which animate their light, which sectors a special's linedef targets, where
 * a stair chain runs, which sidedef slots carry switch art, and what a boss
 * death does on this particular map.
 *
 * Everything here is a pure function of the `DoomMap` — no runtime state, no
 * `SpecialsController`, no THREE. `computeMovableSectors` in particular runs
 * before the controller exists at all (`mapmesh.ts` needs it to decide what
 * stays out of the static batch), which is what makes this module the natural
 * home for the rest of the same scans.
 *
 * See docs/specials.md.
 */
import { NO_SIDE, type DoomMap, type LineDef } from '../../wad/map.ts';
import { BOSS_DEATH_TYPES } from '../things/tables.ts';
import { ThingType } from '../things/doomednums.ts';
import { LINE_SPECIALS, SECTOR_LIGHT_SPECIALS, SECTOR_DOOR_SPECIALS } from './tables.ts';
import { switchPairTexture, type SpecialDef } from './defs.ts';

/** Which sectors a special's linedef affects: the line's own back sector for manual doors, tag matches otherwise. */
export function resolveTargets(map: DoomMap, line: LineDef, def: SpecialDef): number[] {
  if (def.manual) {
    const backSector = line.left !== NO_SIDE ? map.sidedefs[line.left]?.sector : undefined;
    return backSector !== undefined ? [backSector] : [];
  }
  if (line.tag === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < map.sectors.length; i++) {
    if (map.sectors[i].tag === line.tag) out.push(i);
  }
  return out;
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
 * against `map.sectors`. **Load-bearing for `computeMovableSectors`:** these sectors are driven by
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
 * Every two-sided line's *other-side* sector index, in the order that line
 * appears in `map.linedefs` — which, since every stock WAD's `sector->lines[]`
 * is built by walking linedefs in that same ascending order (vanilla's own
 * `P_GroupLines`), is exactly the order vanilla itself would enumerate a given
 * sector's own bordering lines in. Used wherever a special's own vanilla
 * source walks `sec->lines[i]` and reacts to whichever neighbor comes first —
 * `lowerAndChange`'s model-sector search and the donut's ring/outer search.
 */
export function neighborSectorIndices(map: DoomMap, sectorIndex: number): number[] {
  const out: number[] = [];
  for (const line of map.linedefs) {
    if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
    const front = map.sidedefs[line.right]?.sector;
    const back = map.sidedefs[line.left]?.sector;
    if (front === sectorIndex && back !== undefined) out.push(back);
    else if (back === sectorIndex && front !== undefined) out.push(front);
  }
  return out;
}

/**
 * Vanilla `P_PointOnLineSide`: true when (x, y) sits on the line's front
 * (right-sidedef) side. `P_UseSpecialLine` (confirmed against
 * `linuxdoom-1.10/p_switch.c`) rejects *every* use-triggered special except
 * an unused one (124, a "sliding door" case that never appears as a `use`
 * special in `LINE_SPECIALS`) when activated from the back side — so a
 * manual door or switch mounted on a wall is only usable from the side a
 * mapper actually intended, not through the wall from behind it.
 *
 * Also the `side` a walk trigger hands `trigger` (`P_TryMove`'s `oldside`),
 * which only teleports act on — docs/specials.md § Teleporters.
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
 * Vanilla `EV_BuildStairs`/`T_BuildStairs`: starting at `startSectorIndex`,
 * follow a chain of two-sided lines where the current sector is the line's
 * *front* side and the back sector's floor texture matches the start
 * sector's, each one `stepHeight` higher than the last. This is directional
 * and single-path, exactly like vanilla's own search — it takes the first
 * matching line it finds each round and never branches — so a mapper's stair
 * group only works if its connector lines all face the same way, same
 * requirement vanilla itself has. Purely a function of static map data
 * (adjacency + floor textures), so it's safe to run once at load time
 * (`computeMovableSectors`) and again at trigger time without the two ever
 * disagreeing.
 */
export function findStairChain(map: DoomMap, startSectorIndex: number, stepHeight: number): StairStep[] {
  const texture = map.sectors[startSectorIndex]?.floorTex;
  if (texture === undefined) return [];
  const steps: StairStep[] = [];
  const visited = new Set<number>([startSectorIndex]);
  let sectorIndex = startSectorIndex;
  let height = map.sectors[startSectorIndex].floorHeight;
  for (;;) {
    height += stepHeight;
    steps.push({ sectorIndex, targetHeight: height });
    let next = -1;
    for (const line of map.linedefs) {
      if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
      if (map.sidedefs[line.right]?.sector !== sectorIndex) continue;
      const backSector = map.sidedefs[line.left]?.sector;
      if (backSector === undefined || visited.has(backSector)) continue;
      if (map.sectors[backSector]?.floorTex !== texture) continue;
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
 * texture found at scan time is treated as "off"; its SW1/SW2 pair is "on".
 */
export function findSwitchEntries(map: DoomMap, line: LineDef): SwitchEntry[] {
  const out: SwitchEntry[] = [];
  for (const sideIndex of [line.right, line.left]) {
    if (sideIndex === NO_SIDE) continue;
    const side = map.sidedefs[sideIndex];
    if (!side) continue;
    for (const slot of ['upper', 'lower', 'middle'] as const) {
      const offTexture = side[slot];
      const onTexture = switchPairTexture(offTexture);
      if (onTexture) out.push({ sideIndex, slot, sectorIndex: side.sector, onTexture, offTexture });
    }
  }
  return out;
}

/** Sectors whose height a mover will drive, or whose wall carries a switch texture — must stay out of the static batch (see mapmesh.ts). */
export function computeMovableSectors(map: DoomMap): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < map.sectors.length; i++) {
    // Sector-type door timers (10/14) never wait for a linedef trigger, so
    // there's no `def`/tag-resolution step to hook into here — the sector
    // itself is the mover from the moment the map loads.
    if (SECTOR_DOOR_SPECIALS[map.sectors[i].special] !== undefined) out.add(i);
  }
  for (const line of map.linedefs) {
    const def = LINE_SPECIALS[line.special];
    if (!def) continue;
    if (def.effect.kind === 'stairs') {
      // The tag match only names the chain's start; the rest is discovered by
      // walking the same texture-matched adjacency the trigger will use.
      for (const startSector of resolveTargets(map, line, def)) {
        for (const step of findStairChain(map, startSector, def.effect.stepHeight)) out.add(step.sectorIndex);
      }
    } else if (def.effect.kind === 'donut') {
      // Same reasoning as stairs above: the tag only names the "hole", and
      // its ring neighbor is discovered dynamically (see triggerDonut) so it
      // has to be walked here too, not just resolved from the tag.
      for (const startSector of resolveTargets(map, line, def)) {
        out.add(startSector);
        const ringIndex = neighborSectorIndices(map, startSector)[0];
        if (ringIndex !== undefined) out.add(ringIndex);
      }
    } else if (
      def.effect.kind !== 'exit' &&
      def.effect.kind !== 'teleport' &&
      def.effect.kind !== 'lightChange'
    ) {
      // Exit doesn't move geometry; teleport's tag match is a destination
      // lookup, not a mover — the target sector's own height never changes.
      // A pure light change never moves geometry either, so it stays out of
      // the movable set: `recolorSector` reaches static and mover geometry
      // alike, and a sector whose height never changes has no reason to pay
      // for a mesh of its own.
      for (const sectorIndex of resolveTargets(map, line, def)) out.add(sectorIndex);
    }
    for (const e of findSwitchEntries(map, line)) out.add(e.sectorIndex);
  }
  // A boss-death tag has no triggering linedef for the loop above to find — see bossDeathSectors.
  for (const sectorIndex of bossDeathSectors(map)) out.add(sectorIndex);
  return out;
}

/** Sectors animating their light level — no geometry impact, just a recolor. */
export function computeLightSectors(map: DoomMap): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < map.sectors.length; i++) {
    if (SECTOR_LIGHT_SPECIALS[map.sectors[i].special] !== undefined) out.add(i);
  }
  return out;
}
