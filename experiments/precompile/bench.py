#!/usr/bin/env python3
"""Run every workload on every standard engine and precompiled artifact.

Runs are interleaved (rep 1 of every config, then rep 2, ...) and pinned to
CPUs 2-3 so that drift on the shared VM hits all configs alike. Each "run"
process times ITERS in-process repetitions: the first one includes parse/JIT
warmup ("cold"), the rest are "steady". The "n0" bundles do no work and are
timed by wall clock only, which measures process start + bundle load.
Writes results/raw.json; report.py turns it into tables."""
import json, os, platform, shutil, statistics, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
AOT = os.environ.get("AOT", "/home/user/aot")
H = f"{AOT}/hermes-build/bin"
NODE = shutil.which("node")
BUN = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
QJS = f"{AOT}/quickjs/qjs"
WORKLOADS = ["crdt", "protobuf", "arithmetic", "months", "transactions", "rules", "templates", "graph", "gc"]
REPS = {"n0": int(os.environ.get("REPS_N0", 15)), "run": int(os.environ.get("REPS_RUN", 3))}
PIN = ["taskset", "-c", os.environ.get("PIN_CPUS", "2,3")]

# name -> (kind, argv builder, files that must ship to run it)
CONFIGS = {
    "node":         ("standard",    lambda b: [NODE, f"out/{b}.js"],               lambda b: [NODE, f"out/{b}.js"]),
    "node-jitless": ("standard",    lambda b: [NODE, "--jitless", f"out/{b}.js"],  lambda b: [NODE, f"out/{b}.js"]),
    "bun":          ("standard",    lambda b: [BUN, f"out/{b}.js"],                lambda b: [BUN, f"out/{b}.js"]),
    "qjs":          ("standard",    lambda b: [QJS, f"out/{b}.js"],                lambda b: [QJS, f"out/{b}.js"]),
    "hermes":       ("standard",    lambda b: [f"{H}/hermes", "-Xes6-block-scoping", f"out/{b}.js"], lambda b: [f"{H}/hermes", f"out/{b}.js"]),
    "qjsc":         ("precompiled", lambda b: [f"bin/{b}.qjsc"],                   lambda b: [f"bin/{b}.qjsc"]),
    "hermes-hbc":   ("precompiled", lambda b: [f"{H}/hermes", f"bin/{b}.hbc"],     lambda b: [f"{H}/hermes", f"bin/{b}.hbc"]),
    "shermes":      ("precompiled", lambda b: [f"bin/{b}.shermes"],
                     lambda b: [f"bin/{b}.shermes", f"{AOT}/hermes-build/lib/libhermesvm.so",
                                f"{AOT}/hermes-build/tools/shermes/libshermes_console.so"]),
    "porffor":      ("precompiled", lambda b: [f"bin/{b}.porf"],                   lambda b: [f"bin/{b}.porf"]),
}


def run_once(argv):
    t0 = time.perf_counter()
    p = subprocess.Popen(PIN + argv, cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out = p.stdout.read()
    err = p.stderr.read()
    _, status, ru = os.wait4(p.pid, 0)
    wall = (time.perf_counter() - t0) * 1000
    p.returncode = os.waitstatus_to_exitcode(status)
    if p.returncode != 0:
        return {"error": f"exit {p.returncode}: " + (err or out).decode(errors="replace")[-300:]}
    try:
        rec = json.loads(out.decode().strip().splitlines()[-1])
    except Exception:
        return {"error": "bad output: " + out.decode(errors="replace")[-300:]}
    rec["wall_ms"] = wall
    rec["maxrss_kib"] = ru.ru_maxrss
    return rec


def size(paths):
    return sum(os.path.getsize(p if os.path.isabs(p) else os.path.join(HERE, p)) for p in paths)


def iqr(xs):
    if len(xs) < 4:
        return None
    q = statistics.quantiles(xs, n=4)
    return q[2] - q[0]


def main():
    only = sys.argv[1:] or list(CONFIGS)
    results, meta = [], {
        "host": platform.node(), "cpu": open("/proc/cpuinfo").read().split("model name")[1].split("\n")[0].split(":", 1)[1].strip(),
        "nproc": os.cpu_count(), "pin": PIN, "loadavg_start": os.getloadavg(), "reps": REPS,
        "versions": {
            "node": subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout.strip(),
            "bun": subprocess.run([BUN, "--version"], capture_output=True, text=True).stdout.strip(),
        },
    }
    for wl in WORKLOADS:
        for tag in ("n0", "run"):
            base = f"{wl}.{tag}"
            runs = {c: [] for c in only}
            errors = {}
            for rep in range(REPS[tag] + 1):  # rep 0 is a discarded warm-up (page cache)
                order = only[rep % len(only):] + only[:rep % len(only)]
                for name in order:
                    if name in errors:
                        continue
                    kind, build, ship = CONFIGS[name]
                    artifact = build(base)[-1]
                    if not os.path.exists(os.path.join(HERE, artifact)):
                        errors[name] = "not built (compile failed)"
                        continue
                    r = run_once(build(base))
                    if "error" in r:
                        errors[name] = r["error"]
                    elif rep > 0:
                        runs[name].append(r)
            for name in only:
                kind, build, ship = CONFIGS[name]
                row = {"workload": wl, "mode": tag, "config": name, "kind": kind}
                if name in errors:
                    row["error"] = errors[name]
                    print(f"{base:18s} {name:13s} ERROR {errors[name][:150]!r}", flush=True)
                else:
                    rs = runs[name]
                    walls = [r["wall_ms"] for r in rs]
                    cold = [r["ms"][0] for r in rs]
                    steady = [m for r in rs for m in r["ms"][1:]]
                    checks = sorted({r["checksum"] for r in rs})
                    row.update({
                        "n": rs[0]["n"], "timer": rs[0]["timer"],
                        "wall_ms": walls, "wall_min": min(walls), "wall_median": statistics.median(walls), "wall_iqr": iqr(walls),
                        "cold_ms": cold, "cold_median": statistics.median(cold),
                        "steady_ms": steady, "steady_median": statistics.median(steady) if steady else None,
                        "maxrss_kib": statistics.median(r["maxrss_kib"] for r in rs),
                        "ship_bytes": size(ship(base)),
                        "checksum": checks[0] if len(checks) == 1 else checks,
                    })
                    print(f"{base:18s} {name:13s} wall {row['wall_median']:9.1f}  cold {row['cold_median']:9.1f}  "
                          f"steady {row['steady_median'] or 0:9.1f}  rss {row['maxrss_kib']/1024:7.1f}MiB  sum {row['checksum']}", flush=True)
                results.append(row)
    meta["loadavg_end"] = os.getloadavg()
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    with open(os.path.join(HERE, "results", "raw.json"), "w") as f:
        json.dump({"meta": meta, "results": results}, f, indent=1)


if __name__ == "__main__":
    main()
