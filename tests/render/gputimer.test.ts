import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuTimer, type QueryContext } from '../../src/render/gputimer.ts';
import { PROFILE_SMOOTHING } from '../../src/util/profiler.ts';

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT_AVAILABLE = 0x9194;
const QUERY_RESULT = 0x9193;

/**
 * A WebGL2 context with just the query calls, so the bookkeeping this class exists for — one
 * outstanding query at a time, results claimed frames later, a disjoint dropping the batch — can be
 * driven exactly. `results` maps a query to the nanoseconds it will report once `ready` holds it.
 */
class FakeGl implements QueryContext {
  readonly QUERY_RESULT_AVAILABLE = QUERY_RESULT_AVAILABLE;
  readonly QUERY_RESULT = QUERY_RESULT;

  hasExt: boolean;
  lost = false;
  disjoint = false;
  created = 0;
  begun: WebGLQuery[] = [];
  ended = 0;
  /** Queries whose result the driver has finished, and the nanoseconds each reports. */
  ready = new Map<WebGLQuery, number>();

  constructor(hasExt = true) {
    this.hasExt = hasExt;
  }

  getExtension(name: string): unknown {
    if (name !== 'EXT_disjoint_timer_query_webgl2' || !this.hasExt) return null;
    return { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT };
  }

  isContextLost(): boolean {
    return this.lost;
  }

  createQuery(): WebGLQuery {
    this.created++;
    return { id: this.created } as unknown as WebGLQuery;
  }

  beginQuery(target: number, query: WebGLQuery): void {
    assert.equal(target, TIME_ELAPSED_EXT, 'the timer must use the extension\'s own target');
    // Reusing a query object resets it: whatever it last reported is gone, which is what makes
    // pooling safe and what a fake that forgets it would quietly double-count.
    this.ready.delete(query);
    this.begun.push(query);
  }

  endQuery(): void {
    this.ended++;
  }

  getQueryParameter(query: WebGLQuery, pname: number): unknown {
    if (pname === QUERY_RESULT_AVAILABLE) return this.ready.has(query);
    return this.ready.get(query) ?? 0;
  }

  getParameter(pname: number): unknown {
    if (pname !== GPU_DISJOINT_EXT) return null;
    // Reading the flag clears it, which is what the spec says and what `harvest` relies on.
    const was = this.disjoint;
    this.disjoint = false;
    return was;
  }

  /** The driver finishing the query begun `framesAgo` frames back, at `ms` milliseconds. */
  finish(index: number, ms: number): void {
    this.ready.set(this.begun[index], ms * 1e6);
  }
}

/** One measured frame. */
function frame(timer: GpuTimer): void {
  timer.begin();
  timer.end();
}

describe('GpuTimer · the frame\'s GPU milliseconds', () => {
  test('without the extension it reports nothing and touches no query', () => {
    // Browsers have disabled `EXT_disjoint_timer_query_webgl2` on and off, and some drivers lack
    // it — so this is the ordinary case, not an error, and the overlay says `n/a` rather than 0.
    const gl = new FakeGl(false);
    const timer = new GpuTimer(gl);
    frame(timer);
    assert.equal(timer.ms, null);
    assert.equal(gl.created, 0, 'a query was created with no extension to read it back');
    assert.equal(gl.begun.length, 0);
  });

  test('a result arriving a frame later is what the first reading reports', () => {
    const gl = new FakeGl();
    const timer = new GpuTimer(gl);

    frame(timer);
    assert.equal(timer.ms, null, 'a query cannot be read back in its own frame');

    gl.finish(0, 8);
    frame(timer);
    assert.equal(timer.ms, 8, 'the first result is taken whole, not smoothed towards from zero');
  });

  test('later results are smoothed on the profiler\'s own weight', () => {
    // Two rates in one overlay would read as one number lagging the other — see PROFILE_SMOOTHING.
    const gl = new FakeGl();
    const timer = new GpuTimer(gl);
    frame(timer);
    gl.finish(0, 10);
    frame(timer);
    gl.finish(1, 20);
    frame(timer);
    assert.equal(timer.ms, 10 + (20 - 10) * PROFILE_SMOOTHING);
  });

  test('a disjoint drops every result in flight, not just one', () => {
    // The GPU having been reset invalidates the whole batch, and reading the flag clears it.
    const gl = new FakeGl();
    const timer = new GpuTimer(gl);
    frame(timer);
    gl.finish(0, 9);
    frame(timer);
    assert.equal(timer.ms, 9);

    frame(timer);
    gl.finish(2, 500);
    gl.disjoint = true;
    frame(timer);
    assert.equal(timer.ms, 9, 'a disjoint frame\'s nonsense reading reached the overlay');
  });

  test('queries are pooled: the count stops growing once the driver is answering', () => {
    // How many the pool settles at is the driver's answer latency in frames plus one, which is not
    // this class's business — that it *settles*, rather than creating one per frame forever, is.
    const gl = new FakeGl();
    const timer = new GpuTimer(gl);
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        frame(timer);
        gl.finish(gl.begun.length - 1, 5);
      }
    };
    run(10);
    const settled = gl.created;
    run(200);
    assert.equal(gl.created, settled, `pool grew from ${settled} to ${gl.created} queries`);
    assert.ok(settled <= 3, `pool settled at ${settled} queries`);
    assert.equal(timer.ms, 5);
  });

  test('a driver that never answers stops the timer rather than queueing forever', () => {
    // The cap is what bounds this: without it a stuck driver queues one query per frame for the
    // rest of the session.
    const gl = new FakeGl();
    const timer = new GpuTimer(gl);
    for (let i = 0; i < 500; i++) frame(timer);
    assert.ok(gl.created <= 4, `created ${gl.created} queries with nothing ever read back`);
    assert.equal(timer.ms, null);
  });

  test('a lost context drops the queries instead of reading them back', () => {
    const gl = new FakeGl();
    const timer = new GpuTimer(gl);
    frame(timer);
    gl.lost = true;
    frame(timer);
    gl.lost = false;
    // Nothing was read while it was lost, and the timer still works afterwards.
    frame(timer);
    gl.finish(gl.begun.length - 1, 7);
    frame(timer);
    assert.equal(timer.ms, 7);
  });

  test('begin without end never opens a second query', () => {
    // Only one TIME_ELAPSED query may be active at a time; a second `beginQuery` is a GL error.
    const gl = new FakeGl();
    const timer = new GpuTimer(gl);
    timer.begin();
    timer.begin();
    assert.equal(gl.begun.length, 1);
    timer.end();
    assert.equal(gl.ended, 1);
  });
});
