import { SILENT } from '../../src/audio/sfx.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { World } from '../../src/game/world.ts';
import { ProjectileLayer } from '../../src/game/projectiles.ts';
import type { Player } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { MonsterRef } from '../../src/game/things/defs.ts';
import type { CombatContext } from '../../src/game/combat.ts';
import type { HitscanShot, ProjectileShot } from '../../src/game/weapons.ts';
import { traceHitsBox } from '../../src/util/geom.ts';
import type { Pos3 } from '../../src/types.ts';
import { MATERIALS, ROT0_BANK, fxLayer } from './spritestubs.ts';
import type { DoomMap } from '../../src/wad/map.ts';
import { gridMap } from './gridmap.ts';
import { stepFor } from './tics.ts';

/**
 * One player's shots — a hitscan pellet or a missile — fired at hand-placed bodies, with no thing
 * layer behind them. docs/testing.md § Shared helpers.
 */

/** One body a shot damaged: who, how much, and where the damage came from. */
export interface RigHit {
  id: number;
  amount: number;
  from: Pos3;
}

/** What a {@link shotRig} records, and the triggers it pulls. */
export interface ShotRig {
  world: World;
  /** Every body id a shot damaged, in order — direct hits and splash alike. */
  damaged: number[];
  /** The same hits, with their amounts and origins. */
  hits: RigHit[];
  blood: Pos3[];
  /** Every tracer's impact end. */
  tracers: Pos3[];
  /** Where every one-shot effect spawned — a missile's explosion. */
  impacts: Pos3[];
  /**
   * One pellet along `angleRad` (radians, map space), locked onto `target` or free.
   */
  fire(angleRad: number, target: MonsterRef | null): void;
  /** One missile, locked onto `target` or free. */
  launch(shot: ProjectileShot, target: MonsterRef | null): void;
  /**
   * Runs the layer a tic at a time until nothing is left in flight or `maxTics` have passed.
   *
   * @param onTic  called before each tic's update, with the tic's index
   */
  fly(onTic?: (tic: number) => void, maxTics?: number): void;
  /** How many missiles are still in the air. */
  inFlight(): number;
}

/**
 * Nine open cells east, five rows, 128 units each: a shooter at `centre(1, 3)` has room either
 * side of the line for a stray pellet.
 */
export const SHOT_ROOM = gridMap(
  ['###########', '#.........#', '#.........#', '#.........#', '#.........#', '#.........#', '###########'],
  { cell: 128 },
);

/** An imp's {@link MonsterRef} at `at`, feet on the floor at 0. */
export function impBody(id: number, at: { x: number; y: number }): MonsterRef {
  const imp = MONSTER_STATS[ThingType.imp];
  return { id, type: ThingType.imp, x: at.x, y: at.y, z: 0, height: imp.height, angle: 0, radius: imp.radius };
}

/** A rocket fired east: `mobjinfo` speed 20, damage 20. */
export function rocket(splash: ProjectileShot['splash'] = null): ProjectileShot {
  return { kind: 'projectile', angleRad: 0, speed: 20 * 35, sprite: 'MISL', damage: 20, splash, spray: null };
}

/**
 * A shooter standing at `at` on `level` — a `gridMap`, or a loaded map's `World` — and `bodies`
 * for its shots to hit. The bodies stand in for `ThingLayer.raycastMonster` through the same
 * {@link traceHitsBox} diagonal, nearest first — with no vertical test, so a scene that needs one
 * belongs to the real thing layer. A missile is offered every body and runs its own contact test.
 */
export function shotRig(level: { map: DoomMap }, at: { x: number; y: number }, bodies: MonsterRef[]): ShotRig {
  const world = new World(level.map);
  const damaged: number[] = [];
  const hits: RigHit[] = [];
  const blood: Pos3[] = [];
  const tracers: Pos3[] = [];
  const impacts: Pos3[] = [];
  const things = {
    raycastMonster(o: Pos3, angleRad: number, maxDist: number) {
      const dirX = Math.cos(angleRad);
      const dirY = Math.sin(angleRad);
      let best: (MonsterRef & { dist: number }) | null = null;
      for (const b of bodies) {
        const dist = traceHitsBox(o.x, o.y, dirX, dirY, b.x, b.y, b.radius);
        if (dist === null || dist > maxDist || (best && dist >= best.dist)) continue;
        best = { ...b, x: o.x + dirX * dist, y: o.y + dirY * dist, dist };
      }
      return best;
    },
    monstersAlongStep: () => bodies,
    monstersNear: () => bodies,
    bleeds: () => true,
    damage: (id: number, amount: number, opts: { from: Pos3 }) => {
      damaged.push(id);
      hits.push({ id, amount, from: { ...opts.from } });
    },
  };
  const ctx = {
    world,
    things,
    slots: [{ player: { ...at, z: 0, angle: 0 } as Player, dead: false }],
    pvp: false,
    damageSlot: () => true,
    triggerShot: () => {},
    triggerShotPath: () => {},
  } as unknown as CombatContext;
  const effects = fxLayer({ fogVisible: () => true });
  effects.beginLevel(world);
  effects.addTracer = (_from: Pos3, to: Pos3) => {
    tracers.push(to);
  };
  effects.spawnBlood = (hitAt: Pos3) => {
    blood.push(hitAt);
  };
  effects.spawnImpact = (_sprite: string, _frames: string[], _seconds: number, where: Pos3) => {
    impacts.push({ ...where });
  };
  const layer = new ProjectileLayer(ctx, { effects, spriteBank: ROT0_BANK, spriteMaterials: MATERIALS, audio: SILENT });
  layer.beginLevel();
  const inFlight = () => layer.snapshot().length;
  return {
    world,
    damaged,
    hits,
    blood,
    tracers,
    impacts,
    fire(angleRad, target) {
      const shot: HitscanShot = { kind: 'hitscan', angleRad, slopeOffset: 0, damage: 10 };
      layer.spawnPlayerShot(shot, target, null, 0);
    },
    launch(shot, target) {
      layer.spawnPlayerShot(shot, target, null, 0);
    },
    fly(onTic, maxTics = 400) {
      const tic = (i: number) => {
        onTic?.(i);
        layer.update(DOOM_TIC);
      };
      stepFor(maxTics * DOOM_TIC, tic, () => inFlight() === 0);
    },
    inFlight,
  };
}
