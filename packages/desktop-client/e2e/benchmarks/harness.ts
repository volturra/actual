/**
 * UI performance benchmark harness.
 *
 * Each scenario runs a measured action several times and records:
 * - wall time from the first input event (or the start of the action when
 *   it isn't input-driven, e.g. a navigation) until the frame painted after
 *   the last React commit, once the page has been quiet for a while;
 * - the number of React fibers rendered, and which components rendered
 *   the most, using a minimal fake React DevTools hook;
 * - total long-task time on the main thread;
 * - optionally (BENCHMARK_PROFILE=1) a CDP CPU profile of one extra,
 *   unmeasured repetition (and, with BENCHMARK_WORKER_PROFILE=1, one of the
 *   backend worker too).
 *
 * A measurement ends once the page is quiet: no React commit, paint, long
 * task or backend worker message for a while, and no backend request in
 * flight. Before every measured repetition the harness also waits for the
 * page to be quiet (unless BENCHMARK_NO_SETTLE=1), so work left over from
 * setup isn't measured. BENCHMARK_TRACE=1 records a per-repetition event
 * trace (inputs, commits, long tasks, backend requests) to `traces/`.
 *
 * Results are written as JSON to `test-results/benchmarks/` (which is kept
 * out of Playwright's own output directory so it isn't wiped between runs).
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CDPSession, Page } from '@playwright/test';

export const RESULTS_DIR =
  process.env.BENCHMARK_OUT ??
  path.join(__dirname, '..', '..', 'test-results', 'benchmarks');

const PROFILE = !!process.env.BENCHMARK_PROFILE;
const DEFAULT_REPS = Number(process.env.BENCHMARK_REPS) || 5;
const DEFAULT_WARMUP = Number(process.env.BENCHMARK_WARMUP ?? 1);
const TRACE = !!process.env.BENCHMARK_TRACE;
const NO_SETTLE = !!process.env.BENCHMARK_NO_SETTLE;
const WORKER_PROFILE = !!process.env.BENCHMARK_WORKER_PROFILE;
/** Backend requests pending longer than this are subscriptions or hung. */
const MAX_REQUEST_AGE_MS = 5000;
/** The page must have no React commit / long task for this long. */
const QUIET_MS = 250;
/** Give up waiting for the page to settle after this long. */
const SETTLE_TIMEOUT_MS = 15_000;

/**
 * Installed before any page script runs. React's renderer looks for
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` when it initializes and then calls
 * `onCommitFiberRoot` after every commit, in production builds too.
 *
 * A fiber counts as rendered in a commit if it is new (`!alternate`) or it
 * has the PerformedWork flag (`flags & 1`). Subtrees that React bailed out
 * of (`child === alternate.child`) are skipped.
 */
function installBenchmarkHooks(traceEnabled: boolean) {
  type Bench = {
    measuring: boolean;
    counts: Record<string, number>;
    fibers: number;
    commits: number;
    startAt: number;
    inputAt: number | null;
    lastCommitAt: number;
    lastPaintAt: number;
    lastLongTaskEnd: number;
    longTaskMs: number;
    pendingPaints: number;
    trace: Array<Record<string, unknown>>;
    /** In-flight backend requests: id -> time sent. */
    pendingRequests: Map<string, number>;
    lastWorkerAt: number;
  };
  const bench: Bench = {
    // Measure from page load until the first scenario resets it, so the
    // initial load can be measured too.
    measuring: true,
    counts: {},
    fibers: 0,
    commits: 0,
    startAt: 0,
    inputAt: null,
    lastCommitAt: 0,
    lastPaintAt: 0,
    lastLongTaskEnd: 0,
    longTaskMs: 0,
    pendingPaints: 0,
    trace: [],
    pendingRequests: new Map(),
    lastWorkerAt: 0,
  };
  (window as unknown as { __bench: Bench }).__bench = bench;
  const trace = (entry: Record<string, unknown>) => {
    if (traceEnabled && bench.measuring) {
      bench.trace.push(entry);
    }
  };

  type Fiber = {
    tag: number;
    flags: number;
    type: unknown;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
  };
  type NamedType = {
    displayName?: string;
    name?: string;
    render?: NamedType;
    type?: NamedType;
  };

  const nameOf = (fiber: Fiber): string | null => {
    const t = fiber.type as NamedType | string | null;
    if (!t || typeof t === 'string') {
      return null;
    }
    return (
      t.displayName ||
      t.name ||
      (t.render && (t.render.displayName || t.render.name)) ||
      (t.type && (t.type.displayName || t.type.name)) ||
      null
    );
  };

  // Fiber tags that aren't components: HostRoot, HostComponent, HostText
  const SKIP_TAGS = new Set([3, 5, 6]);

  const walk = (root: Fiber) => {
    const stack: Fiber[] = [root];
    while (stack.length) {
      const fiber = stack.pop() as Fiber;
      const alt = fiber.alternate;
      const rendered = !alt || (fiber.flags & 1) !== 0;
      if (rendered && !SKIP_TAGS.has(fiber.tag)) {
        const name = nameOf(fiber);
        if (name) {
          bench.counts[name] = (bench.counts[name] || 0) + 1;
          bench.fibers++;
        }
      }
      if (fiber.sibling) {
        stack.push(fiber.sibling);
      }
      if (fiber.child && (!alt || fiber.child !== alt.child)) {
        stack.push(fiber.child);
      }
    }
  };

  const noop = () => undefined;

  const onPainted = () => {
    bench.pendingPaints++;
    requestAnimationFrame(() =>
      setTimeout(() => {
        bench.pendingPaints--;
        bench.lastPaintAt = performance.now();
      }, 0),
    );
  };

  (
    window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    isDisabled: false,
    inject() {
      return 1;
    },
    checkDCE: noop,
    onCommitFiberRoot(_id: unknown, root: { current: Fiber }) {
      if (!bench.measuring) {
        return;
      }
      bench.commits++;
      bench.lastCommitAt = performance.now();
      const before = traceEnabled ? { ...bench.counts } : null;
      const fibersBefore = bench.fibers;
      if (root.current.child) {
        walk(root.current.child);
      }
      if (before) {
        trace({
          c: Math.round(bench.lastCommitAt),
          f: bench.fibers - fibersBefore,
          n: Object.entries(bench.counts)
            .map(([k, v]): [string, number] => [k, v - (before[k] || 0)])
            .filter(e => e[1] > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(e => e.join('x'))
            .join(' '),
        });
      }
      onPainted();
    },
    onCommitFiberUnmount: noop,
    onPostCommitFiberRoot: noop,
    onScheduleFiberRoot: noop,
  };

  // Track requests to the backend worker (loot-core's connection sends
  // `{ id, name, args }` and gets `{ type: 'reply' | 'error', id }` back, or
  // `{ type: 'push' }` events) so the page isn't considered settled while a
  // query is still in flight.
  const requestNames = new Map<string, string>();
  const trackOut = (msg: unknown) => {
    const m = msg as { id?: unknown; name?: unknown } | null;
    if (m && typeof m.id === 'string' && typeof m.name === 'string') {
      bench.pendingRequests.set(m.id, performance.now());
      requestNames.set(m.id, m.name);
      bench.lastWorkerAt = performance.now();
      trace({ c: Math.round(performance.now()), send: m.name });
    }
  };
  const trackIn = (e: MessageEvent) => {
    const d = e.data as { id?: string; type?: string; name?: string } | null;
    if (!d || typeof d !== 'object') {
      return;
    }
    if ((d.type === 'reply' || d.type === 'error') && d.id) {
      if (bench.pendingRequests.delete(d.id)) {
        bench.lastWorkerAt = performance.now();
        trace({
          c: Math.round(performance.now()),
          reply: requestNames.get(d.id),
        });
        requestNames.delete(d.id);
      }
    } else if (d.type === 'push') {
      bench.lastWorkerAt = performance.now();
      trace({ c: Math.round(performance.now()), push: d.name });
    }
  };
  type Listener = (this: unknown, e: MessageEvent) => unknown;
  for (const proto of [Worker.prototype, MessagePort.prototype] as Array<{
    postMessage: (...args: unknown[]) => void;
    addEventListener: (...args: unknown[]) => void;
  }>) {
    const post = proto.postMessage;
    proto.postMessage = function (this: unknown, ...args: unknown[]) {
      trackOut(args[0]);
      return post.apply(this, args);
    };
    const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    if (desc?.set && desc.get) {
      const { get, set } = desc;
      Object.defineProperty(proto, 'onmessage', {
        configurable: true,
        get() {
          return get.call(this);
        },
        set(fn: Listener | null) {
          set.call(
            this,
            fn
              ? function (this: unknown, e: MessageEvent) {
                  trackIn(e);
                  return fn.call(this, e);
                }
              : fn,
          );
        },
      });
    }
    const add = proto.addEventListener;
    proto.addEventListener = function (this: unknown, ...args: unknown[]) {
      if (args[0] === 'message' && typeof args[1] === 'function') {
        const fn = args[1] as Listener;
        args[1] = function (this: unknown, e: MessageEvent) {
          trackIn(e);
          return fn.call(this, e);
        };
      }
      return add.apply(this, args);
    };
  }

  // Only these start the clock; the others are just traced
  const INPUT_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'wheel'];
  const onInput = (e: Event) => {
    trace({ ev: e.type, t: Math.round(performance.now()) });
    if (
      bench.measuring &&
      bench.inputAt == null &&
      INPUT_EVENTS.includes(e.type)
    ) {
      bench.inputAt = performance.now();
    }
  };
  const tracedEvents = traceEnabled
    ? ['mouseup', 'click', 'keyup', 'scroll', 'mousemove', 'pointerover']
    : [];
  for (const type of [...INPUT_EVENTS, ...tracedEvents]) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }

  try {
    new PerformanceObserver(list => {
      if (!bench.measuring) {
        return;
      }
      for (const entry of list.getEntries()) {
        trace({
          lt: Math.round(entry.startTime),
          d: Math.round(entry.duration),
        });
        bench.longTaskMs += entry.duration;
        bench.lastLongTaskEnd = Math.max(
          bench.lastLongTaskEnd,
          entry.startTime + entry.duration,
        );
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch {
    // Long task timing isn't available everywhere
  }
}

type RepResult = {
  ms: number;
  commitMs: number;
  fibers: number;
  commits: number;
  longTaskMs: number;
  settled: boolean;
  counts: Record<string, number>;
  trace?: unknown;
  from?: number;
  end?: number;
};

export type ScenarioResult = {
  name: string;
  reps: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  medianCommitMs: number;
  medianFibers: number;
  medianCommits: number;
  medianLongTaskMs: number;
  unsettledReps: number;
  ms: number[];
  fibers: number[];
  /** Average renders per repetition, most rendered first. */
  top: Array<[string, number]>;
  profile?: string;
  error?: string;
};

/**
 * A measured interaction. Every callback gets a repetition counter that
 * never repeats within a run (warmups included), so edits can type a
 * different value each time: typing the value a cell already has is a
 * no-op for the app, which would measure nothing.
 *
 * Waits inside `run` must not use `expect(...)`: a failing `expect` poll
 * takes an aria snapshot of the whole page, which is hundreds of ms of
 * main-thread work inside the measured window. Use `locator.waitFor()`.
 */
export type Scenario = {
  name: string;
  reps?: number;
  /** Unmeasured repetitions before the measured ones (default 1). */
  warmup?: number;
  /** Runs before every repetition; not measured. */
  setup?: (rep: number) => Promise<void>;
  /** The measured interaction. */
  run: (rep: number) => Promise<void>;
  /** Runs after every repetition; not measured. */
  teardown?: (rep: number) => Promise<void>;
  /** Best effort to undo the scenario's state changes if it fails. */
  cleanup?: () => Promise<void>;
};

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export class BenchmarkHarness {
  readonly page: Page;
  readonly results: ScenarioResult[];
  readonly meta: Record<string, unknown> = {};
  private cdp: CDPSession | null = null;
  private workerCdp: WorkerSession | null = null;
  private repCounter = 0;

  /** `results` can be shared between harnesses (e.g. desktop and mobile). */
  constructor(page: Page, results: ScenarioResult[] = []) {
    this.page = page;
    this.results = results;
  }

  static async install(page: Page, results?: ScenarioResult[]) {
    await page.addInitScript(installBenchmarkHooks, TRACE);
    return new BenchmarkHarness(page, results);
  }

  /** Starts a measurement window; the measured action follows. */
  async start() {
    await this.page.evaluate(() => {
      const bench = (window as unknown as { __bench: BenchState }).__bench;
      bench.counts = {};
      bench.fibers = 0;
      bench.commits = 0;
      bench.inputAt = null;
      bench.longTaskMs = 0;
      bench.startAt = performance.now();
      bench.lastCommitAt = 0;
      bench.lastPaintAt = 0;
      bench.lastLongTaskEnd = 0;
      bench.trace = [{ start: Math.round(bench.startAt) }];
      bench.measuring = true;
    });
  }

  /** Waits for the page to go quiet and closes the measurement window. */
  async stop(): Promise<RepResult> {
    return this.page.evaluate(
      ({ quietMs, timeoutMs, maxRequestAgeMs }) => {
        const bench = (window as unknown as { __bench: BenchState }).__bench;
        const actionDoneAt = performance.now();
        bench.trace.push({ actionDone: Math.round(actionDoneAt) });
        return new Promise<RepResult>(resolve => {
          const check = () => {
            const now = performance.now();
            const inFlight = [...bench.pendingRequests.values()].some(
              sentAt => now - sentAt < maxRequestAgeMs,
            );
            const lastActivity = Math.max(
              bench.lastWorkerAt,
              bench.lastCommitAt,
              bench.lastPaintAt,
              bench.lastLongTaskEnd,
              actionDoneAt,
            );
            const settled =
              now - lastActivity >= quietMs &&
              bench.pendingPaints === 0 &&
              !inFlight;
            if (settled || now - actionDoneAt > timeoutMs) {
              bench.measuring = false;
              const from = bench.inputAt ?? bench.startAt;
              const end = bench.commits
                ? Math.max(bench.lastPaintAt, bench.lastCommitAt)
                : actionDoneAt;
              resolve({
                ms: Math.round(end - from),
                commitMs: bench.commits
                  ? Math.round(bench.lastCommitAt - from)
                  : 0,
                fibers: bench.fibers,
                commits: bench.commits,
                longTaskMs: Math.round(bench.longTaskMs),
                settled,
                counts: { ...bench.counts },
                trace: bench.trace,
                from: Math.round(from),
                end: Math.round(end),
              });
              return;
            }
            setTimeout(check, 50);
          };
          setTimeout(check, 50);
        });
      },
      {
        quietMs: QUIET_MS,
        timeoutMs: SETTLE_TIMEOUT_MS,
        maxRequestAgeMs: MAX_REQUEST_AGE_MS,
      },
    );
  }

  /** Settles, then measures `action`. */
  async measureOnce(action: () => Promise<void>) {
    await this.settle();
    await this.start();
    await action();
    return this.stop();
  }

  /**
   * Waits until the page is quiet (no commits, paints or long tasks), with
   * the same detection as a measurement, so work left over from setup (or
   * the previous scenario) doesn't leak into the next measured window.
   */
  async settle() {
    if (NO_SETTLE) {
      return;
    }
    await this.start();
    await this.stop();
  }

  private async runRep(scenario: Scenario) {
    const rep = this.repCounter++;
    await scenario.setup?.(rep);
    const result = await this.measureOnce(() => scenario.run(rep));
    await scenario.teardown?.(rep);
    return result;
  }

  async run(scenario: Scenario): Promise<ScenarioResult> {
    const reps = scenario.reps ?? DEFAULT_REPS;
    const repResults: RepResult[] = [];
    let error: string | undefined;
    let profile: string | undefined;

    try {
      for (let i = 0; i < (scenario.warmup ?? DEFAULT_WARMUP); i++) {
        await this.runRep(scenario);
      }
      for (let i = 0; i < reps; i++) {
        repResults.push(await this.runRep(scenario));
      }

      if (PROFILE) {
        const rep = this.repCounter++;
        await scenario.setup?.(rep);
        profile = await this.profileOnce(slug(scenario.name), () =>
          scenario.run(rep),
        );
        await scenario.teardown?.(rep);
      }
    } catch (e) {
      const lines = (e instanceof Error ? e.message : String(e))
        // oxlint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split('\n');
      // The first line, plus what it was waiting for
      error = [lines[0], lines.find(l => /waiting for|Locator:/.test(l))]
        .filter(Boolean)
        .map(l => l?.trim())
        .join(' / ');
      // Try to get back to a known state for the next scenario
      await this.page.keyboard.press('Escape').catch(() => undefined);
      await this.page.keyboard.press('Escape').catch(() => undefined);
      if (scenario.cleanup) {
        await scenario.cleanup().catch(() => undefined);
      }
    }

    const totals: Record<string, number> = {};
    for (const rep of repResults) {
      for (const [name, count] of Object.entries(rep.counts)) {
        totals[name] = (totals[name] ?? 0) + count;
      }
    }
    const top = Object.entries(totals)
      .map(([name, count]): [string, number] => [
        name,
        Math.round((count / Math.max(repResults.length, 1)) * 10) / 10,
      ])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    if (TRACE) {
      fs.mkdirSync(path.join(RESULTS_DIR, 'traces'), { recursive: true });
      fs.writeFileSync(
        path.join(RESULTS_DIR, 'traces', slug(scenario.name) + '.json'),
        JSON.stringify(
          repResults.map(r => ({
            from: r.from,
            end: r.end,
            ms: r.ms,
            trace: r.trace,
          })),
          null,
          1,
        ),
      );
    }
    const ms = repResults.map(r => r.ms);
    const result: ScenarioResult = {
      name: scenario.name,
      reps: repResults.length,
      medianMs: median(ms),
      minMs: ms.length ? Math.min(...ms) : 0,
      maxMs: ms.length ? Math.max(...ms) : 0,
      medianCommitMs: median(repResults.map(r => r.commitMs)),
      medianFibers: median(repResults.map(r => r.fibers)),
      medianCommits: median(repResults.map(r => r.commits)),
      medianLongTaskMs: median(repResults.map(r => r.longTaskMs)),
      unsettledReps: repResults.filter(r => !r.settled).length,
      ms,
      fibers: repResults.map(r => r.fibers),
      top,
      profile,
      error,
    };
    this.results.push(result);
    console.log(formatResult(result));
    return result;
  }

  private async profileOnce(name: string, action: () => Promise<void>) {
    if (!this.cdp) {
      this.cdp = await this.page.context().newCDPSession(this.page);
      await this.cdp.send('Profiler.enable');
      await this.cdp.send('Profiler.setSamplingInterval', { interval: 100 });
      if (WORKER_PROFILE) {
        this.workerCdp = await attachWorker(this.page);
      }
    }
    await this.settle();
    await this.cdp.send('Profiler.start');
    await this.workerCdp?.send('Profiler.start');
    await this.measureOnce(action);
    const { profile } = await this.cdp.send('Profiler.stop');
    fs.mkdirSync(path.join(RESULTS_DIR, 'profiles'), { recursive: true });
    if (this.workerCdp) {
      const res = (await this.workerCdp.send('Profiler.stop')) as {
        profile: unknown;
      };
      fs.writeFileSync(
        path.join(RESULTS_DIR, 'profiles', `${name}.worker.cpuprofile`),
        JSON.stringify(res.profile),
      );
    }
    const file = path.join(RESULTS_DIR, 'profiles', `${name}.cpuprofile`);
    fs.writeFileSync(file, JSON.stringify(profile));
    return path.relative(RESULTS_DIR, file);
  }

  write() {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const data = {
      meta: { date: new Date().toISOString(), ...this.meta },
      scenarios: this.results,
    };
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(path.join(RESULTS_DIR, `results-${stamp}.json`), json);
    fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), json);

    const lines = [
      '| Scenario | median ms | min–max ms | fibers | commits | long tasks ms | top components |',
      '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
      ...this.results.map(
        r =>
          `| ${r.name}${r.error ? ' (error)' : ''} | ${r.medianMs} | ${r.minMs}–${r.maxMs} | ${r.medianFibers} | ${r.medianCommits} | ${r.medianLongTaskMs} | ${r.top
            .slice(0, 3)
            .map(([n, c]) => `${n} ×${c}`)
            .join(', ')} |`,
      ),
    ];
    fs.writeFileSync(path.join(RESULTS_DIR, 'latest.md'), lines.join('\n'));
  }
}

type WorkerSession = {
  send: (method: string, params?: object) => Promise<unknown>;
};

/**
 * Attaches to the backend worker through a browser-level CDP session
 * (Playwright's CDPSession can't target workers directly), using the
 * non-flattened Target.sendMessageToTarget protocol.
 */
async function attachWorker(page: Page): Promise<WorkerSession | null> {
  const browser = page.context().browser();
  if (!browser) {
    return null;
  }
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = (await session.send('Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  const workers = targetInfos.filter(
    t => t.type === 'worker' || t.type === 'shared_worker',
  );
  const target = workers.find(t => /kcab|backend/i.test(t.url)) ?? workers[0];
  if (!target) {
    console.log('BENCH no worker target to profile');
    return null;
  }
  const { sessionId } = (await session.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: false,
  })) as { sessionId: string };
  let nextId = 1;
  const pending = new Map<number, (result: unknown) => void>();
  session.on('Target.receivedMessageFromTarget', event => {
    const e = event as { sessionId: string; message: string };
    if (e.sessionId !== sessionId) {
      return;
    }
    const msg = JSON.parse(e.message) as { id?: number; result?: unknown };
    const resolve = msg.id != null ? pending.get(msg.id) : undefined;
    if (msg.id != null && resolve) {
      pending.delete(msg.id);
      resolve(msg.result);
    }
  });
  const send = (method: string, params: object = {}) =>
    new Promise<unknown>(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      void session.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 100 });
  console.log('BENCH profiling worker', target.url);
  return { send };
}

type BenchState = {
  measuring: boolean;
  counts: Record<string, number>;
  fibers: number;
  commits: number;
  startAt: number;
  inputAt: number | null;
  lastCommitAt: number;
  lastPaintAt: number;
  lastLongTaskEnd: number;
  longTaskMs: number;
  pendingPaints: number;
  trace: Array<Record<string, unknown>>;
  pendingRequests: Map<string, number>;
  lastWorkerAt: number;
};

export function formatResult(r: ScenarioResult) {
  const top = r.top
    .slice(0, 5)
    .map(([n, c]) => `${n}×${c}`)
    .join(' ');
  return (
    `BENCH ${r.name.padEnd(44)} ${String(r.medianMs).padStart(6)} ms` +
    ` (${r.minMs}–${r.maxMs})  fibers ${String(r.medianFibers).padStart(6)}` +
    `  commits ${r.medianCommits}  longtask ${r.medianLongTaskMs}ms` +
    (r.unsettledReps ? `  unsettled ${r.unsettledReps}` : '') +
    (r.error ? `  ERROR ${r.error}` : '') +
    `  | ${top}`
  );
}

/** Mirrors `BenchmarkBudgetRefs` in loot-core's benchmark-budget.ts. */
export type BenchmarkRefs = {
  budgetType: 'envelope' | 'tracking';
  currentMonth: string;
  focusMonth: string;
  accounts: Record<string, string>;
  categories: Record<string, string>;
  reports: Record<string, string>;
  widgets: Record<string, string>;
  filters: Record<string, string>;
};

type BenchmarkBudgetResult = {
  error?: string;
  timings?: Record<string, number>;
  stats?: Record<string, number>;
  refs?: BenchmarkRefs;
};

const BENCHMARK_BUDGET_ID = '_benchmark-budget';

/**
 * Creates the benchmark budget through the backend and reloads the page so
 * the app opens it like a regular "last opened" budget.
 *
 * Playwright pins "today" to the first of a month, which has next to no
 * data, so the budget page is set to open on the last full month instead.
 */
export async function createBenchmarkBudget(
  page: Page,
  { budgetType = 'envelope' }: { budgetType?: 'envelope' | 'tracking' } = {},
) {
  await page.goto('/');
  await page.waitForFunction(() => '$send' in window);
  const started = Date.now();
  const result = await page.evaluate(async type => {
    const send = (
      window as unknown as {
        $send: (name: string, args: unknown) => Promise<BenchmarkBudgetResult>;
      }
    ).$send;
    return send('create-budget', {
      testMode: true,
      benchmarkMode: true,
      benchmarkBudgetType: type,
    });
  }, budgetType);
  const wallMs = Date.now() - started;
  if (result?.error || !result?.refs) {
    throw new Error(
      'Failed to create benchmark budget: ' + (result?.error ?? 'no refs'),
    );
  }
  const refs = result.refs;
  await page.evaluate(
    ([key, month]) => localStorage.setItem(key, JSON.stringify(month)),
    [`${BENCHMARK_BUDGET_ID}-budget.startMonth`, refs.focusMonth],
  );
  // The budget is now open in the backend and is the "last opened" one, so
  // a reload opens it in the UI.
  await page.reload();
  await page.getByTestId('budget-table').waitFor({ timeout: 60_000 });
  return { wallMs, timings: result.timings, stats: result.stats, refs };
}
