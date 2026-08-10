# Randomness

DOOM has no random number generator. It has a 256-byte lookup table and two cursors that walk it,
and every "random" thing the game does — a damage roll, a pellet's spread, whether a monster
flinches, how long a broken light stays lit — is one entry off that table. `src/util/random.ts` is
that table, transcribed from `linuxdoom-1.10/m_random.c`, and it is the **only** source of
randomness in `src/`; `tests/util/random.test.ts` fails the build if a `Math.random` reappears.

## The table and the two cursors

```c
unsigned char rndtable[256] = { 0, 8, 109, 220, 222, 241, 149, 107, 75, 248, ... };
int prndindex = 0, rndindex = 0;

int P_Random (void) { prndindex = (prndindex+1)&0xff; return rndtable[prndindex]; }
int M_Random (void) { rndindex  = (rndindex+1)&0xff;  return rndtable[rndindex];  }
void M_ClearRandom (void) { rndindex = prndindex = 0; }
```

`pRandom()` is `P_Random`, the **play simulation's** cursor: damage, spread, pain chance, every AI
decision, the light patterns, the radiation suit's leak, the Icon of Sin's spawn pick, and the
sight/death sound variants (vanilla picks those inside `A_Look`/`A_Scream`, so they are simulation
draws even though only the speaker notices).

`mRandom()` is `M_Random`, a **second cursor over the same table** for draws outside the simulation.
`audio/sfx.ts`'s pitch wobble is its only caller here, exactly as in vanilla. The split is the
point: a sound that does or doesn't play, or an extra cosmetic draw, must never shift what the next
damage roll sees. A port that collapses the two into one cursor passes almost every other test.

Two details that are easy to get wrong, and both are pinned by tests:

- **Vanilla pre-increments.** `rndtable[0]` is never the first value returned after a clear — the
  first draw is `rndtable[1] = 8`. A post-increment port would open every level on a 0 roll, i.e. a
  guaranteed minimum-damage first shot.
- **The table has no two adjacent entries equal**, wrap included. So `P_Random()-P_Random()` can
  never come out 0 and every pellet is thrown at least slightly off-aim, where a real uniform
  generator would occasionally fire dead centre.

## Why the cursors are global

They are module-level `let`s in `util/random.ts`, matching vanilla's own globals, and nothing takes
an injected generator. `docs/testing.md § Determinism` records the earlier decision not to thread a
`random` parameter through `rollDamage` — it would have changed `src/` on the fire path purely for
the tests — and a table-backed generator removes the motive entirely: a test calls `clearRandom()`
and then asserts *exact* values, because there is nothing left to sample.

`util/` rather than `game/` because `audio/sfx.ts` needs `mRandom` and must not import from `game/`.
It is the one stateful module in `util/`.

## The triangular draw

`triangularDraw` (`game/weapons.ts`) is vanilla's `(P_Random() - P_Random()) << shift`, and it is
the shape under *every* fuzzed value in the game: pellet and melee spread, the super shotgun's
slope jitter, monster bullet spread, `A_FaceTarget`'s `MF_SHADOW` penalty, blood and puff z-jitter,
the brain's explosion scatter.

Two rules hold it together:

- **Two separate `pRandom()` calls, never one draw reused.** Subtracting two *adjacent table
  entries* is the distribution — it is not two independent uniforms, and the serial correlation
  between neighbouring entries is part of how vanilla feels.
- **The `/255`.** Every caller's `width` constant is already the value at vanilla's `255 << shift`
  extreme (`docs/weapons.md § Spread` derives them that way), so dividing the raw ±255 difference by
  255 reproduces vanilla's own integer grid while leaving all those constants alone.

One consequence worth knowing before writing a test against it: draws taken in **lockstep pairs**
from a clear cursor sit on alternating table parities forever, because 256 is even — so a long run
of nothing-but-`triangularDraw` has a small nonzero mean. The distribution is symmetric taken over
*starting positions* (the cyclic sum telescopes to exactly zero), which is how
`tests/game/dice.test.ts` measures it. Real play interleaves other draws, so the parity never locks.

## What this does not buy

**Not run-to-run determinism.** `clearRandom()` runs at level load (`game.ts: loadMapByIndex`,
vanilla's `G_InitNew` position), so a level always starts from the same table position — but this
engine's loop is dt-scaled, not tic-locked, and the light patterns and monster chase calls draw on
wall-clock timers. Which draw lands on which table entry therefore still varies with framerate. The
clear matches vanilla's contract and keeps a level's opening rolls stable; it does not make a run
reproducible, and there are no demos here that would need it to be.

What the table *does* buy is the distribution vanilla actually has, and exact-value tests: every
number in `docs/weapons.md`, `docs/combat.md`, `docs/monster-ai.md` and `docs/monster-attacks.md`
that cites a `P_Random` formula is now literally that call rather than a float re-expression of it.

## A note on operand order

`P_Random()-P_Random()` has **unspecified operand evaluation order in C** — the standard does not
fix which call runs first, and it was a compiler's choice in 1993. This engine evaluates
left-to-right, which JavaScript does fix. Since the distribution is symmetric about zero the choice
cannot be observed statistically; it would only matter for demo playback, which this engine has
none of. It is a convention here, not a fidelity claim.
