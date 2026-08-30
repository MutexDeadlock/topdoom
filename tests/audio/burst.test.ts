import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { burstVictim } from '../../src/audio/audio.ts';
import { sampleGroup, type SfxId } from '../../src/audio/sfx.ts';

/**
 * The same-tic start budget — docs/audio.md § Same-tic bursts. `AudioEngine` itself needs an
 * `AudioContext` and stays in docs/testing.md's carve-out, so what is pinned here is the pure half:
 * the key a burst is counted under, and the property `admitBurst` leans on — that `burstVictim`
 * rates a copy alone in the stereo field above one of a stack, and falls back to loudness where
 * they crowd each other equally. Nothing states one of the dials; every claim is a comparison.
 */

/** A crowd all in one direction: pans a hair apart, loudness falling with distance. */
function ahead(gains: readonly number[]): { pan: number; gain: number }[] {
  return gains.map((gain, i) => ({ pan: -0.02 + i * 0.01, gain }));
}

describe('Sound bursts · the budget key', () => {
  test('a variant family spends one budget', () => {
    // Ten zombiemen waking together draw a different `randomVariant` each, so keying on the lump
    // would hand one wake three budgets.
    assert.equal(sampleGroup('posit1'), sampleGroup('posit2'));
    assert.equal(sampleGroup('posit1'), sampleGroup('posit3'));
    assert.equal(sampleGroup('bgdth1'), sampleGroup('bgdth2'));
  });

  test('separate families, and everything else, keep their own', () => {
    assert.notEqual(sampleGroup('posit1'), sampleGroup('podth1'));
    assert.notEqual(sampleGroup('posit1'), sampleGroup('bgsit1'));
    for (const id of ['plasma', 'barexp', 'telept'] as SfxId[]) assert.equal(sampleGroup(id), id);
  });
});

describe('Sound bursts · rating a burst member', () => {
  test('a crowd in one direction gives up its quietest', () => {
    // Crowded alike, so loudness — that is, nearness — decides.
    const members = ahead([0.9, 0.2, 0.7, 0.5]);
    assert.equal(burstVictim(members), 1);
  });

  test('identical copies turn the newcomer away rather than churning', () => {
    // Nothing to choose between them, so the tie rule decides — and `admitBurst` passes the
    // newcomer last.
    const members = [0, 1, 2, 3].map(() => ({ pan: 0, gain: 0.5 }));
    assert.equal(burstVictim([...members, { pan: 0, gain: 0.5 }]), members.length);
  });

  test('an isolated copy outranks a stack, at equal loudness', () => {
    const left = [
      { pan: -0.9, gain: 0.5 },
      { pan: -0.88, gain: 0.5 },
      { pan: -0.92, gain: 0.5 },
      { pan: -0.86, gain: 0.5 },
    ];
    // The newcomer is on the far side and goes last: the stack gives up a member, not the newcomer.
    const victim = burstVictim([...left, { pan: 0.9, gain: 0.5 }]);
    assert.notEqual(victim, left.length);
    assert.ok(left[victim].pan < 0);
  });

  test('copies at one pan are still separated by loudness', () => {
    const members = [
      { pan: 0.5, gain: 0.8 },
      { pan: 0.5, gain: 0.3 },
    ];
    assert.equal(burstVictim(members), 1);
  });

  test('a lone member is rated on loudness alone, with nobody to be isolated from', () => {
    assert.equal(burstVictim([{ pan: 0, gain: 1 }]), 0);
  });
});

/**
 * `admitBurst`'s own loop, over the same `burstVictim`: what a whole tic's worth of calls settles
 * on. The budget is a local here rather than the engine's dial — the claim under test is
 * `burstVictim`'s behaviour across a burst, not the value the mixer happens to set.
 */
function settle(
  calls: readonly { pan: number; gain: number }[],
  budget: number,
): { pan: number; gain: number }[] {
  const burst: { pan: number; gain: number }[] = [];
  for (const call of calls) {
    if (burst.length < budget) {
      burst.push(call);
      continue;
    }
    const victim = burstVictim([...burst, call]);
    if (victim < burst.length) burst[victim] = call;
  }
  return burst;
}

describe('Sound bursts · what a tic settles on', () => {
  test('a crowd straight ahead admits its nearest', () => {
    // Crowding is near enough uniform along one direction that loudness decides. Not *exactly* the
    // loudest four: a copy out at the edge of the crowd is worth a few percent of gain, and that
    // trade is the rule working. The claim is that the far half of the crowd is never heard.
    const calls = ahead([0.2, 0.9, 0.35, 0.8, 0.15, 0.95, 0.4, 0.85, 0.25, 0.75]);
    const nearer = calls.map((m) => m.gain).sort((a, b) => b - a).slice(0, calls.length / 2);
    for (const kept of settle(calls, 4)) assert.ok(nearer.includes(kept.gain));
  });

  test('five each side settle on both sides, not one', () => {
    // Every caller equally loud, so only crowding can decide — the case a plain first-four cap
    // gets wrong.
    const calls = [
      ...[0, 1, 2, 3, 4].map((i) => ({ pan: -0.9 + i * 0.01, gain: 0.6 })),
      ...[0, 1, 2, 3, 4].map((i) => ({ pan: 0.9 - i * 0.01, gain: 0.6 })),
    ];
    const kept = settle(calls, 4);
    assert.equal(kept.length, 4);
    assert.equal(kept.filter((m) => m.pan < 0).length, 2);
    assert.equal(kept.filter((m) => m.pan > 0).length, 2);
  });

  test('a lone caller off to one side is not drowned by the crowd it arrives after', () => {
    const calls = [...ahead([0.6, 0.6, 0.6, 0.6, 0.6, 0.6]), { pan: 0.95, gain: 0.6 }];
    const kept = settle(calls, 4);
    assert.ok(kept.some((m) => m.pan === 0.95));
  });
});
