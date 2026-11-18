# Precompiling Actual's engine code: an experiment

This experiment asks two questions. Which parts of Actual's engine (the
TypeScript in `packages/loot-core` and `packages/crdt`) can be compiled ahead
of time with today's JavaScript AOT and bytecode toolchains? And how does the
result perform against the standard runtime, Node with V8's JIT?

It is a measurement, not a proposal. Nothing here is wired into the app.

## Results

- **Everything pure compiles.** All 9 bundles compile and run with every
  toolchain:
  - QuickJS `qjsc` (bytecode embedded in an executable)
  - Hermes `hermesc` (`.hbc` bytecode)
  - Static Hermes `shermes` (native code, untyped mode)
  - Porffor (JS → Wasm → C → native)

  The bundles include the rules engine, which pulls in HyperFormula and
  Handlebars (2.2 MB of JS). Every engine produces Node's checksum except
  Porffor on the sync merkle workload.

- **Native-only code can't be precompiled.** SQLite (better-sqlite3 or
  sql.js/Wasm), WebCrypto/`node:crypto` for sync encryption, and Intl/ICU
  formatting are already native. These toolchains don't touch them, and most
  real request time goes to SQLite.
- **Precompiling is a throughput regression.** Steady state, geometric mean
  over the 7 workloads every engine gets right:

  | config                   | vs Node     |
  | ------------------------ | ----------- |
  | Porffor (with spec bugs) | 2.9x slower |
  | Static Hermes            | 4.0x        |
  | hermesc .hbc             | 4.3x        |
  | qjsc                     | 7.9x        |

  Node with its JIT turned off (`--jitless`, 3.5x) is about as fast as the
  precompiled Hermes builds. Bun (JSC, 1.13x) trades the lead with Node
  workload by workload. Bun is faster on crdt, months and rules, and slower
  on graph, templates and gc. No AOT option comes close to a JIT.

- **Bytecode alone buys nothing at runtime.** qjsc matches qjs and hbc
  matches Hermes from source, within noise. Static Hermes in untyped mode is
  0–12% faster than hbc, often inside the noise.
- **The wins are startup, memory and size.**

  | measure                | precompiled | Node                                                  |
  | ---------------------- | ----------- | ----------------------------------------------------- |
  | Startup, rules bundle  | 13–21 ms    | 95 ms                                                 |
  | Peak RSS               | 3–50 MiB    | 57–109 MiB (about 45 MiB of which Node reserves idle) |
  | Size to ship, stripped | 1–14 MiB    | 102 MiB                                               |

  On small bundles every precompiled artifact starts in 3–10 ms, near the
  2.6 ms cost of launching `/bin/true`, so those can't be ranked against
  each other. Bun gets most of the startup and memory benefit (7–9 ms on
  small bundles, 16–60 MiB) at JIT speed.

- **Bottom line for Actual.** A precompiled engine fits a small, fast-starting
  CLI or headless sync tool. For the desktop or Linux client it would trade
  3–8x slower budget math for lower memory. Native speed for the engine means
  a real port (such as the Rust client) or staying on a JIT.

## Correctness findings

- **Porffor gets real code wrong.** Its `JSON.stringify` and `for-in` put
  integer-like keys in insertion order. The spec puts them first.
  `'ß'.toUpperCase()` returns `ß`. The merkle workload serializes a trie
  (keys `0`, `1`, `2`, `hash`) and gets a different checksum. Its garbage
  collector does work: peak RSS stays flat as allocations grow tenfold.
- **Hermes binds `let` per function by default.** That breaks esbuild's
  CommonJS interop getters: `import { RegExpParser } from 'regexp-to-ast'`
  resolved to the string `'0.4.0'`, so the rules bundle crashed. Every Hermes
  config here uses `-Xes6-block-scoping`, which fixes it.
- **QuickJS and Hermes lack some globals** that Actual uses. QuickJS has no
  `TextEncoder`/`TextDecoder`, and neither has `Intl` by default.
  `shims/prelude.js` fills these only where they are missing. The Intl stub
  is constructed but never called, because the workloads don't format
  numbers. `qjs --experimental` has a real Intl and gives the same results.
- **Upstream bug found along the way.** `merkle.build()` in
  `packages/crdt/src/crdt/merkle.ts` discards `insert()`'s return value, so it
  always returns an empty trie. Production sync code calls `insert()`
  directly and isn't affected; only tests use `build()`.

Run `./semantics.sh` for the spec probes (`results/semantics.txt`).

## What was measured

Each workload calls real Actual code with deterministic inputs and returns a
checksum.

| workload     | code exercised                                                                        |
| ------------ | ------------------------------------------------------------------------------------- |
| crdt         | HULC `Timestamp` parse/serialize/hash, merkle insert/diff/prune (sync)                |
| protobuf     | `SyncRequest`/`Message` encode and decode via `@bufbuild/protobuf` (sync wire format) |
| arithmetic   | `evalArithmetic` (typed amount expressions)                                           |
| months       | `shared/months` date math (date-fns)                                                  |
| transactions | split / add-split / update / ungroup transactions                                     |
| rules        | `Condition.eval` for 10 rule conditions over 300 transactions                         |
| templates    | goal-template note parser (peggy-generated, as loot-core builds it)                   |
| graph        | spreadsheet dependency graph topological sort                                         |
| gc           | allocation probe (not Actual code) to check each runtime's GC                         |

Not covered: SQLite queries, the full spreadsheet engine and AQL compiler
(they need the database), encryption, import parsers and Intl formatting.

| config       | what runs                                                                     |
| ------------ | ----------------------------------------------------------------------------- |
| node         | Node 22, V8 JIT (the standard)                                                |
| node-jitless | V8 interpreter only                                                           |
| bun          | Bun 1.4, JavaScriptCore JIT                                                   |
| qjs          | QuickJS from source                                                           |
| hermes       | Hermes VM from source (eager compile; `-lazy` startup listed separately)      |
| qjsc         | QuickJS bytecode compiled into an executable                                  |
| hermes-hbc   | Hermes bytecode from `hermesc -O`, run on the Hermes VM                       |
| shermes      | Static Hermes `-O` native executable, untyped (dynamically links libhermesvm) |
| porffor      | Porffor native executable (alpha)                                             |

### Method

- **Bundling.** esbuild produces one ES2020 IIFE per workload, so every
  engine sees identical input.
  - Uses loot-core's `api` export condition.
  - `uuid` is replaced by a deterministic counter, so checksums are stable.
  - The logger is a no-op.
- **Bundle variants.** `*.run.js` does N rounds per iteration, 4 iterations
  per process. `*.n0.js` does no work and is only used for startup and idle
  memory.
- **Timing.**
  - Cold is the first in-process iteration; steady is the median of the
    rest.
  - Hermes has no `performance.now`, so its timings have 1 ms resolution.
    Iterations are 200 ms to 5 s, so that doesn't matter.
  - Runs are interleaved across configs and pinned to CPUs 2–3 with
    `taskset`.
  - Each cell has 3 processes (9 steady samples) and 15 startup runs.
- **Noise.** Spread within a cell can reach ±25%, so treat differences under
  about 10% as ties.
- **Memory.** `bin/rss`, a tiny C fork/exec/wait4 launcher, measures peak
  RSS. `ru_maxrss` survives exec, so measuring from Python floors every child
  at Python's own RSS. bench.py's `maxrss_kib` field has that floor and is
  not used.
- **Size.** Stripped runtime + bundle, or stripped artifact + the shared
  libraries it needs. libc, libm and libstdc++ are not counted.
- **Versions.** Listed in `results/versions.txt`. Hardware is a 4 vCPU Xeon
  VM at 2.1 GHz.
- **After the run**, lint-only edits (types, import order, the no-op logger shim) were made; Node checksums were re-checked and are unchanged.
- **Not tried.** Typed Static Hermes needs type-annotated code in its sound
  subset, so it would mean rewriting the code, not precompiling it.

### Reviews

Two subagent reviews shaped the method:

- **Before the run**, a review found:
  - the merkle workload measured a discarded result;
  - rules and protobuf were missing;
  - Porffor's speed needed semantic checks;
  - single-shot timing mixed JIT warmup with steady state.
- **After the run**, a review found:
  - the RSS floor;
  - the eager Hermes startup baseline;
  - geomeans taken over different workload sets;
  - unstripped sizes;
  - overstated small differences.

All of these are fixed or reflected above.

## Reproducing

The toolchains are built outside the repo under `$AOT` (default
`/home/user/aot`):

```bash
git clone --depth 1 -b static_h https://github.com/facebook/hermes $AOT/hermes
cmake -S $AOT/hermes -B $AOT/hermes-build -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja -C $AOT/hermes-build shermes hermesc hermes shermes_console hermesvm
git clone https://github.com/bellard/quickjs $AOT/quickjs && make -C $AOT/quickjs qjs qjsc libquickjs.a
npm install --prefix $AOT/npmtools porffor
```

Then, from this directory (`yarn install` must have run at the repo root for
esbuild, peggy and the workload dependencies):

```bash
node build.mjs           # regenerates the peggy parser, bundles out/*.js (N from counts.json)
./compile.sh             # precompiles every bundle into bin/ (rules takes ~5 min on shermes and Porffor)
cc -O2 -o bin/rss rss.c  # RSS launcher
python3 bench.py         # ~45 min; writes results/raw.json
python3 supplement.py    # RSS via bin/rss, hermes -lazy startup, stripped sizes
python3 report.py        # results/tables.md
./semantics.sh           # spec probes
```

`out/`, `bin/` and `logs/` are build output and are not committed. The full
tables are in [results/tables.md](results/tables.md).
