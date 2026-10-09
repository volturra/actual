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
 *   unmeasured repetition.
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
function installBenchmarkHooks() {
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
  };
  (window as unknown as { __bench: Bench }).__bench = bench;

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
      if (root.current.child) {
        walk(root.current.child);
      }
      onPainted();
    },
    onCommitFiberUnmount: noop,
    onPostCommitFiberRoot: noop,
    onScheduleFiberRoot: noop,
  };

  const onInput = () => {
    if (bench.measuring && bench.inputAt == null) {
      bench.inputAt = performance.now();
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'wheel']) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }

  try {
    new PerformanceObserver(list => {
      if (!bench.measuring) {
        return;
      }
      for (const entry of list.getEntries()) {
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

export type Scenario = {
  name: string;
  reps?: number;
  /** Unmeasured repetitions before the measured ones (default 1). */
  warmup?: number;
  /** Runs before every repetition; not measured. */
  setup?: () => Promise<void>;
  /** The measured interaction. */
  run: () => Promise<void>;
  /** Runs after every repetition; not measured. */
  teardown?: () => Promise<void>;
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
  readonly results: ScenarioResult[] = [];
  readonly meta: Record<string, unknown> = {};
  private cdp: CDPSession | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  static async install(page: Page) {
    await page.addInitScript(installBenchmarkHooks);
    return new BenchmarkHarness(page);
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
      bench.measuring = true;
    });
  }

  /** Waits for the page to go quiet and closes the measurement window. */
  async stop(): Promise<RepResult> {
    return this.page.evaluate(
      ({ quietMs, timeoutMs }) => {
        const bench = (window as unknown as { __bench: BenchState }).__bench;
        const actionDoneAt = performance.now();
        return new Promise<RepResult>(resolve => {
          const check = () => {
            const now = performance.now();
            const lastActivity = Math.max(
              bench.lastCommitAt,
              bench.lastPaintAt,
              bench.lastLongTaskEnd,
              actionDoneAt,
            );
            const settled =
              now - lastActivity >= quietMs && bench.pendingPaints === 0;
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
              });
              return;
            }
            setTimeout(check, 50);
          };
          setTimeout(check, 50);
        });
      },
      { quietMs: QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS },
    );
  }

  async measureOnce(action: () => Promise<void>) {
    await this.start();
    await action();
    return this.stop();
  }

  async run(scenario: Scenario): Promise<ScenarioResult> {
    const reps = scenario.reps ?? DEFAULT_REPS;
    const repResults: RepResult[] = [];
    let error: string | undefined;
    let profile: string | undefined;

    try {
      for (let i = 0; i < (scenario.warmup ?? DEFAULT_WARMUP); i++) {
        await scenario.setup?.();
        await this.measureOnce(scenario.run);
        await scenario.teardown?.();
      }
      for (let i = 0; i < reps; i++) {
        await scenario.setup?.();
        repResults.push(await this.measureOnce(scenario.run));
        await scenario.teardown?.();
      }

      if (PROFILE) {
        await scenario.setup?.();
        profile = await this.profileOnce(slug(scenario.name), scenario.run);
        await scenario.teardown?.();
      }
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e))
        // oxlint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split('\n')[0];
      // Try to get back to a known state for the next scenario
      await this.page.keyboard.press('Escape').catch(() => undefined);
      await this.page.keyboard.press('Escape').catch(() => undefined);
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
    }
    await this.cdp.send('Profiler.start');
    await this.measureOnce(action);
    const { profile } = await this.cdp.send('Profiler.stop');
    fs.mkdirSync(path.join(RESULTS_DIR, 'profiles'), { recursive: true });
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

type BenchmarkBudgetResult = {
  error?: string;
  timings?: Record<string, number>;
  stats?: Record<string, number>;
};

/**
 * Creates the benchmark budget through the backend and reloads the page so
 * the app opens it like a regular "last opened" budget.
 */
export async function createBenchmarkBudget(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => '$send' in window);
  const started = Date.now();
  const result = await page.evaluate(async () => {
    const send = (
      window as unknown as {
        $send: (name: string, args: unknown) => Promise<BenchmarkBudgetResult>;
      }
    ).$send;
    return send('create-budget', { testMode: true, benchmarkMode: true });
  });
  const wallMs = Date.now() - started;
  if (result?.error) {
    throw new Error('Failed to create benchmark budget: ' + result.error);
  }
  // The budget is now open in the backend and is the "last opened" one, so
  // a reload opens it in the UI.
  await page.reload();
  await page.getByTestId('budget-table').waitFor({ timeout: 60_000 });
  return { wallMs, timings: result?.timings, stats: result?.stats };
}
