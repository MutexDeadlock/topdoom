/**
 * {@link GpuTimer}: how long the GPU actually spent on a frame — the half `FrameProfiler` cannot
 * see. See docs/devmode.md § Profiling overlay.
 */
import { PROFILE_SMOOTHING } from '../util/profiler.ts';

/**
 * The slice of a WebGL2 context this needs, taken structurally — the same seam `LightWorld` uses
 * (render/lights/vis.ts), so the query bookkeeping can be exercised without a GPU.
 */
export interface QueryContext {
  getExtension(name: string): unknown;
  isContextLost(): boolean;
  createQuery(): WebGLQuery | null;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, pname: number): unknown;
  getParameter(pname: number): unknown;
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
}

/** The two enums `EXT_disjoint_timer_query_webgl2` adds; everything else here is core WebGL2. */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * How many queries may be awaiting a result at once. A frame's answer lands one or two frames
 * later, so a couple of slots keeps a fresh measurement arriving every frame; the cap is what
 * bounds the pool against a driver that stops answering, which would otherwise queue one query per
 * frame forever. **Tuned by feel.**
 */
const MAX_IN_FLIGHT = 4;

/**
 * How many saturated frames in a row are taken as the driver having stopped answering, after which
 * the queries in flight are given up on and the pool starts over. Without it a single batch that
 * never completes is the last measurement of the session. **Tuned by feel** — a stall this long is
 * already far past the frame or two a result normally takes.
 */
const STALL_FRAMES = 120;

/**
 * One `TIME_ELAPSED_EXT` query around the render call, read back when the driver has it.
 *
 * The extension is **often absent**, so every method no-ops and {@link GpuTimer.ms} stays null
 * rather than this being an error. docs/devmode.md § Profiling overlay.
 */
export class GpuTimer {
  /**
   * The context and the extension together, or null where the extension is absent. One field
   * rather than two: the constructor takes both or neither, and every method below needs both, so
   * a pair of nullable fields would be one condition tested twice at every site.
   */
  private q: { gl: QueryContext; ext: TimerQueryExt } | null = null;
  /** Query objects to reuse, so a measured frame allocates nothing. */
  private free: WebGLQuery[] = [];
  private inFlight: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private smoothed = 0;
  private read = false;
  /** Consecutive frames the pool has been full with nothing collected — see {@link STALL_FRAMES}. */
  private stalled = 0;

  constructor(gl: QueryContext) {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    if (ext) this.q = { gl, ext };
  }

  /**
   * Smoothed GPU milliseconds per frame, or null while no result has arrived yet — which covers
   * both "the extension is missing" and "the first few frames". Smoothed on `FrameProfiler`'s own
   * weight so the number settles at the same rate as the rows beside it.
   */
  get ms(): number | null {
    return this.read ? this.smoothed : null;
  }

  /** Opens the frame's query. A no-op when unavailable, mid-query, or already saturated. */
  begin(): void {
    const q = this.q;
    if (!q || this.active || this.inFlight.length >= MAX_IN_FLIGHT || q.gl.isContextLost()) return;
    const query = this.free.pop() ?? q.gl.createQuery();
    if (!query) return;
    q.gl.beginQuery(q.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  /**
   * Closes the frame's query, if this frame opened one, and collects whatever earlier ones the
   * driver has finished — **unconditionally**, or a full pool would have nothing left to empty it.
   * docs/devmode.md § Profiling overlay.
   */
  end(): void {
    const q = this.q;
    if (!q) return;
    if (this.active) {
      q.gl.endQuery(q.ext.TIME_ELAPSED_EXT);
      this.inFlight.push(this.active);
      this.active = null;
    }
    this.harvest();
  }

  /**
   * Takes the results that are ready and returns their queries to the pool. A **disjoint**
   * invalidates every query in flight, and reading the flag clears it, so it is read once here and
   * the whole batch is dropped when it is set.
   */
  private harvest(): void {
    const q = this.q;
    if (!q) return;
    const { gl, ext } = q;
    if (gl.isContextLost()) {
      this.inFlight.length = 0;
      this.free.length = 0;
      this.active = null;
      this.stalled = 0;
      return;
    }
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
    let kept = 0;
    for (const query of this.inFlight) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) {
        this.inFlight[kept++] = query;
        continue;
      }
      if (!disjoint) {
        const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
        this.smoothed = this.read ? this.smoothed + (ms - this.smoothed) * PROFILE_SMOOTHING : ms;
        this.read = true;
      }
      this.free.push(query);
    }
    const collected = kept < this.inFlight.length;
    this.inFlight.length = kept;
    const saturated = !collected && kept >= MAX_IN_FLIGHT;
    this.stalled = saturated ? this.stalled + 1 : 0;
    // Given up on rather than deleted: `beginQuery` resets whatever a query object last held, so
    // the pool is reusable even where the driver never answered for it.
    if (this.stalled > STALL_FRAMES) {
      for (const query of this.inFlight) this.free.push(query);
      this.inFlight.length = 0;
      this.stalled = 0;
    }
  }
}
