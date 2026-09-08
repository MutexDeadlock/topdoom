# Specials: lights

`src/game/specials.ts`, `src/game/specials/tables.ts`, `src/game/specials/movergeometry.ts`

The sector-type blink patterns, the runtime light changes, and how either reaches the geometry that
draws it. What a light level *means* on screen is docs/render-lighting.md § Sector lighting; what
dispatches a light-change line is docs/specials.md.

## Lights

The sector-type patterns (`SECTOR_LIGHT_SPECIALS`, `game/specials/tables.ts`) are assigned once at
map load and ticked by `updateLights` → `tickLight` (`game/specials.ts`). Each holds a `baseLight`
(the sector's own level) and a `darkLight` (`darkestNeighborLight`, vanilla's
`P_FindMinSurroundingLight`) and interpolates or toggles between them. Every random period draws
from `pRandom()` — docs/random.md § The table and the two cursors.

The strobes (`blink05`, `blink1` and their synced variants) are the easy ones: a fixed 5-tic lit
period against a 15- or 35-tic dark one, straight off vanilla's `STROBEBRIGHT`/`FASTDARK`/`SLOWDARK`
— `FASTDARK` (15) for sector types 2, 4 and 13, `SLOWDARK` (35) for 3 and 12, so the *synced* pair
runs slow-then-fast where the unsynced one runs fast-then-slow (`P_SpawnSpecials`).
`glow` ramps continuously.

**A strobe whose `darkLight` equals its `baseLight` blinks to black**, vanilla's
`if (minlight == maxlight) minlight = 0` — and `P_SpawnStrobeFlash` is the only spawn that carries
it, `P_SpawnLightFlash`/`P_SpawnGlowingLight`/`P_SpawnFireFlicker` all leaving the two equal and so
standing still. Without it a strobing sector as dark as everything it touches simply does not
strobe: `EPIC.WAD` MAP02 sector 0 is type 2 at light 240 with one neighbour, also at 240.

The two patterns that are **not** simple toggles are worth knowing:

- **`blinkRandom`** (sector type 1) is `T_LightFlash`, and vanilla's `mintime`/`maxtime` are used as
  **bit masks, not durations**. Dark is `(P_Random()&7)+1` — 1 to 8 tics. Lit is
  `(P_Random()&64)+1`, which is **1 tic or 65 tics and nothing in between**, because `&64` yields
  only 0 or 64. That lopsided split is the whole character of a vanilla broken light: mostly a slow
  pulse, punctuated by the occasional single-frame stutter. Modelling it as a fixed lit period and a
  random dark one — which this engine did until the light rework — gets the rhythm backwards.
  `P_SpawnLightFlash` seeds the counter with the same `(P_Random()&64)+1`, which is what puts a
  map's broken lights out of phase with each other rather than in lockstep.
- **`flicker`** (sector type 17) is `T_FireFlicker`, and it has no two-state toggle at all. Every
  4 tics it picks `amount = (P_Random()&3)*16` and sets the level to `maxlight - amount`, floored at
  `minlight` — four brightness steps, which is what makes it read as firelight rather than as a
  stutter. `minlight` is `P_FindMinSurroundingLight + 16`, so `darkLight + 16` here. `LightState`
  carries a `level` field for this pattern alone; a `bright` boolean cannot express four steps.

  Reproduce vanilla's asymmetry in that assignment exactly: the `< minlight` test reads the sector's
  **current** level while the assignment uses `maxlight`. Since the current level is itself
  `maxlight - something` from the last tick, the floor triggers more readily than the naive reading
  suggests, and the pattern sits at `minlight` more of the time. It looks like a bug in the C and is
  load-bearing for how the effect looks.

## Light changes

`LightChangeEffect` is the runtime-triggered counterpart to the sector-type blink patterns: those
assign an ongoing pattern once at map load, these mutate (or start animating) a *tag-matched*
sector's light on demand.

- `'setLevel'` (13/35/79/81/138/139) — a literal light value.
- `'brightestNeighbor'` (12/80) — vanilla's "bright = 0 means search" rule: the max level among
  immediate two-sided neighbors, or pitch black if there are none (`EV_LightTurnOn`).
- `'darkestNeighbor'` (104, `EV_TurnTagLightsOff`) — the min of the sector's own *current* level and
  its neighbors', which unlike `'brightestNeighbor'` never brightens, only darkens or leaves
  unchanged.
- `'startStrobe'` (17, `EV_StartLightStrobing`) — spawns the same slow, non-synced `blink1` pattern
  a sector-type-3 sector gets at load, skipped if the sector already has an active mover (vanilla's
  `specialdata` guard — light thinkers and movers share that slot in real vanilla; this engine's
  `lightStates`/`movers` maps are already independent, but the *trigger* still respects the guard).

Because any of these can target a sector that was never a light-pattern sector, `indexLightGeometry`
— previously scoped to just the load-time blink sectors — now indexes every sector's static-batch
occluders/flats unconditionally, a one-time load cost.

### Relighting mover geometry

`recolorSector` (`specials/movergeometry.ts`) rewrites the RGB of every surface lit by a sector, in
two places: the static batches (`sectorOccluders`/`sectorFlats`) and, via `recolorMoverGeometry`,
any mover mesh holding that sector's geometry. Both are needed because a mover mesh carries its own
sector's flats **plus** wall quads from *both* sides of every bordering line — so a sector that
moves, and a static sector next to one, each have geometry that `indexLightGeometry` cannot see.
`moverLightTargets` (filled in `createMoverMesh` from each quad's/fan's own `sector` field) is the
sector → owning-mover-meshes index that makes the second pass cheap; a rebuild never changes which
sectors a mesh covers, so it only grows once.

The invariant: **a sector's light must reach its geometry whether or not that geometry is currently
in a mover mesh.** Without the mover pass a strobing lift only relights while it happens to be
*moving* — a height change rebuilds the mesh from the live `sector.light` anyway, which is exactly
what masked the bug. Repro: DOOM1 E1M5 sectors 2 and 32, the tag-1 strobing lifts (also E1M5 sector
91, tag 2), covered by `tests/regression/strobing-lift-light.test.ts`.

This covers **every** light effect, since `updateLights` (all the sector-type patterns) and
`triggerLightChange` (the runtime line specials above) both funnel through `recolorSector` — and the
combination is not rare: 7 maps in DOOM1.WAD, 18 in DOOM2.WAD, 14 in Freedoom 2 and 8 in SCYTHE.WAD
have at least one light-driven mover, `glow` being the most common by a wide margin.

Both indexes are keyed by the sector a surface takes its **light** from, not the one it belongs to.
For a wall those are always the same sector; for a flat they differ wherever a 213/261 transfer or a
deep-water bottom is in play (docs/specials-transfers.md § Render transfers), and keying this way is
the whole of what makes a transferred light live — recoloring the control sector reaches its
dependents because they are filed under it.

Only RGB is written (`setXYZ`); vertex alpha belongs to `WallFader`/`FlatFader`
(render/occlusion.ts) and the two must not clobber each other.
