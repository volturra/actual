import './shims/prelude.js';
// `workload` is aliased per bundle; __N__ (inner rounds), __ITERS__ (timed
// repetitions in one process) and __WL__ are replaced at bundle time.
import { bench } from 'workload';

declare const __N__: number;
declare const __ITERS__: number;
declare const __WL__: string;
declare const print: ((s: string) => void) | undefined;

const out = typeof print === 'function' ? print : (s: string) => console.log(s);
const hasPerf = typeof performance !== 'undefined' && !!performance.now;
const now = hasPerf ? () => performance.now() : () => Date.now();

// Read N through a global the compiler can't see, so no optimizer can
// constant-fold the loop count (BENCH_N is never set; it falls back to __N__).
const g = globalThis as { BENCH_N?: number };
const n: number = typeof g.BENCH_N === 'number' ? g.BENCH_N : __N__;

const times: string[] = [];
let checksum = 0;
for (let it = 0; it < __ITERS__; it++) {
  const t0 = now();
  const c = bench(n);
  const t1 = now();
  times.push((t1 - t0).toFixed(2));
  if (it > 0 && c !== checksum) {
    throw new Error('checksum changed between iterations');
  }
  checksum = c;
}
out(
  '{"workload":"' +
    __WL__ +
    '","n":' +
    n +
    ',"timer":"' +
    (hasPerf ? 'perf' : 'date') +
    '","ms":[' +
    times.join(',') +
    '],"checksum":' +
    checksum +
    '}',
);
