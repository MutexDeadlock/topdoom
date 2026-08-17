/**
 * Voodoo dolls: the extra player-1 starts a map places as script actors, carried around by
 * conveyors to fire walk lines and to take damage on the real player's behalf.
 * See docs/specials.md § Voodoo dolls.
 */
import {
  makePinnedMemo,
  makeTouchCache,
  slideMove,
  type PinnedMemo,
  type SectorTouchCache,
  type World,
} from './world.ts';
import { MOMENTUM_STOP_SPEED, PLAYER_RADIUS } from './player.ts';
import { ThingType } from './things/doomednums.ts';
import { spawnAngleDeg } from './skill.ts';
import type { Forces } from './specials/forces.ts';
import type { TeleportDest } from './specials.ts';
import type { VoodooSnapshot } from './snapshot.ts';
import type { Pos2, Pos3 } from '../types.ts';

/**
 * One doll. It has a player's radius and height because it *is* a player mobj —
 * everything that makes it different from the real player is that nothing
 * drives it but the world.
 */
export interface VoodooDoll extends Pos3 {
  /** Radians, and only ever read by a silent teleport that rotates it. */
  angle: number;
  /** The external momentum channel, exactly `Player`'s — docs/movement.md § External momentum. */
  momX: number;
  momY: number;
  /**
   * Derived per-tic state, never saved — `snapshot` copies the simulation's
   * fields explicitly, exactly as `PosedThing` keeps its own `touch`/`pinned`.
   * `touch` backs the force queries (`World.sectorsTouchingCached`); `rest` is
   * the pinned-body memo (docs/movement.md § Pinned-body memo): the doll
   * proved a whole tic a no-op from this exact position under this exact
   * summed impulse, and skips the re-derivation until the impulse or a stamped
   * nearby height changes.
   */
  touch: SectorTouchCache;
  rest: PinnedMemo;
}

/**
 * Every voodoo doll on the level, ticked as one.
 *
 * **Which things are dolls**: every doomednum-1 thing *except the last*, which
 * is the real player start (`World.playerStart`, docs/wad.md § Player start).
 * Vanilla spawns a body for all of them and puts the console player in the last
 * one; the rest keep standing there being player mobjs nobody controls, which is
 * the whole trick.
 *
 * **They are not drawn.** Vanilla renders them as marines, which in a top-down
 * view would read as a second player standing across the map — a deliberate
 * deviation, and the only one here.
 */
export class VoodooDolls {
  private world: World;
  readonly dolls: VoodooDoll[] = [];

  constructor(world: World) {
    const starts = world.thingsOfType(ThingType.playerStart);
    for (const t of starts.slice(0, -1)) {
      this.dolls.push({
        x: t.x,
        y: t.y,
        z: world.groundFloor(t.x, t.y, PLAYER_RADIUS),
        angle: (spawnAngleDeg(t.angle) * Math.PI) / 180,
        momX: 0,
        momY: 0,
        touch: makeTouchCache(),
        rest: makePinnedMemo(),
      });
    }
    this.world = world;
  }

  get empty(): boolean {
    return this.dolls.length === 0;
  }

  /**
   * One tic: the world's forces push each doll, it slides, and whatever walk
   * lines it crossed fire through `cross` — which returns a landing spot when
   * the crossing was a teleporter, exactly as a monster's does.
   *
   * A doll has no gravity of its own: it rides whatever floor it is standing on
   * (`groundFloor`), which is all a script actor ever needs and keeps a doll
   * parked on a lift moving with it.
   *
   * A doll pinned against a wall by a conveyor — the resting state of a whole
   * closet's worth of dolls on a Boom script map — would otherwise re-attempt
   * the same blocked `slideMove` every tic forever; the `rest` memo skips the
   * whole tic once it has been proven a no-op (see `VoodooDoll.rest`). The
   * impulse is still recomputed live each tic, so a belt turning on or off, or
   * water rising over a parked doll, breaks the memo through the impulse
   * compare.
   */
  update(dt: number, forces: Forces, cross: (prev: Pos2, doll: VoodooDoll) => TeleportDest | null): void {
    for (const doll of this.dolls) {
      const carry = forces.carryForBody(doll, PLAYER_RADIUS, doll.touch);
      // A doll is a player mobj, so the pushers reach it too — and it counts as
      // on the ground whenever it is resting on its floor.
      const push = forces.pushForBody(doll, PLAYER_RADIUS, true, doll.touch);
      const impX = (carry ? carry.x : 0) + (push ? push.x : 0);
      const impY = (carry ? carry.y : 0) + (push ? push.y : 0);
      if (
        doll.momX === 0 &&
        doll.momY === 0 &&
        this.world.pinMatches(doll.rest, doll.x, doll.y, doll.z, impX, impY)
      ) {
        continue;
      }
      doll.rest.active = false;

      const startZ = doll.z;
      const prev = { x: doll.x, y: doll.y };
      doll.momX += impX;
      doll.momY += impY;

      if (doll.momX !== 0 || doll.momY !== 0) {
        // Only asked for once the doll is actually moving: a parked doll — the
        // normal state of most of them — never pays for the sector walk.
        const speed = Math.hypot(doll.momX, doll.momY);
        const ground = forces.frictionUnder(doll, PLAYER_RADIUS, speed, doll.touch);
        // `P_SlideMove`, as for the player it is a copy of.
        const moved = slideMove(this.world, doll, doll.momX * dt, doll.momY * dt, PLAYER_RADIUS);
        if (dt > 0) {
          doll.momX = (moved.x - doll.x) / dt;
          doll.momY = (moved.y - doll.y) / dt;
        }
        doll.x = moved.x;
        doll.y = moved.y;
        const decay = Math.pow(ground.friction, dt * 35);
        doll.momX *= decay;
        doll.momY *= decay;
        // Unlike the player's channel this snaps unconditionally: a doll only
        // ever moves because something is pushing it *this* tic, so there is no
        // sustained-force case to protect (see `Player.applyForce`).
        if (!carry && !push) {
          if (Math.abs(doll.momX) < MOMENTUM_STOP_SPEED) doll.momX = 0;
          if (Math.abs(doll.momY) < MOMENTUM_STOP_SPEED) doll.momY = 0;
        }
      }

      doll.z = this.world.groundFloor(doll.x, doll.y, PLAYER_RADIUS);
      const dest = cross(prev, doll);
      if (dest) {
        doll.x = dest.x;
        doll.y = dest.y;
        doll.angle = dest.angle;
        doll.z = this.world.groundFloor(dest.x, dest.y, PLAYER_RADIUS);
        if (dest.rotateBy === undefined) {
          doll.momX = 0;
          doll.momY = 0;
        } else {
          const cos = Math.cos(dest.rotateBy);
          const sin = Math.sin(dest.rotateBy);
          const mx = doll.momX;
          const my = doll.momY;
          doll.momX = mx * cos - my * sin;
          doll.momY = mx * sin + my * cos;
        }
      }

      // The tic just proved itself a no-op: nothing moved, nothing lingers in
      // the momentum channel. Capture the memo so the next tic can skip it
      // outright (`World.capturePin` stamps everything the blocked slideMove
      // and groundFloor could have read). `dest` must be null: a teleporter
      // loop that lands the doll back exactly where it started still fired
      // triggers this tic — a periodic-script idiom the memo must never
      // silence. Without a teleport, position-unchanged also means no line was
      // crossed and nothing fired.
      if (
        dest === null &&
        doll.x === prev.x &&
        doll.y === prev.y &&
        doll.z === startZ &&
        doll.momX === 0 &&
        doll.momY === 0
      ) {
        this.world.capturePin(doll.rest, doll.x, doll.y, doll.z, impX, impY, PLAYER_RADIUS, dt);
      }
    }
  }

  /** Every field the simulation mutates — docs/savegames.md § What is saved and what is deliberately not. */
  snapshot(): VoodooSnapshot[] {
    return this.dolls.map((d) => ({ x: d.x, y: d.y, z: d.z, angle: d.angle, momX: d.momX, momY: d.momY }));
  }

  /**
   * The restore twin. A save written before dolls existed has no block at all,
   * which leaves them where the map put them — the same state a fresh level
   * load produces, and the reason this needs no `SAVE_VERSION` bump.
   * Extra or missing entries are ignored rather than trusted: the doll list
   * comes from the map, not from the save.
   */
  restore(saved: readonly VoodooSnapshot[] | undefined): void {
    if (!saved) return;
    for (let i = 0; i < this.dolls.length && i < saved.length; i++) {
      const d = this.dolls[i];
      const s = saved[i];
      d.x = s.x;
      d.y = s.y;
      d.z = s.z;
      d.angle = s.angle;
      d.momX = s.momX;
      d.momY = s.momY;
      // Derived state only — but stale against the restored position, so drop it.
      d.rest.active = false;
    }
  }
}
