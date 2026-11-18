#!/usr/bin/env python3
"""Second pass, added after the findings review (see README):
- peak RSS measured through bin/rss (a tiny C launcher) instead of Python,
  for both the full run and the idle N=0 bundle;
- Hermes from source with -lazy, the fair source-loading baseline;
- stripped sizes of every artifact and runtime.
Merges the numbers into results/raw.json."""
import json, os, shutil, statistics, subprocess, tempfile, time
import bench

HERE = bench.HERE
raw_path = os.path.join(HERE, "results", "raw.json")
data = json.load(open(raw_path))
idx = {(r["workload"], r["mode"], r["config"]): r for r in data["results"]}


def rss(argv):
    out = subprocess.run(bench.PIN + [os.path.join(HERE, "bin/rss")] + argv, cwd=HERE, capture_output=True, text=True).stdout.split()
    return int(out[0]) if out and out[1] == "0" else None


def stripped(path):
    path = path if os.path.isabs(path) else os.path.join(HERE, path)
    if path.endswith((".js", ".hbc")):
        return os.path.getsize(path)
    with tempfile.TemporaryDirectory() as d:
        dst = os.path.join(d, "x")
        r = subprocess.run(["strip", "-o", dst, path], capture_output=True)
        return os.path.getsize(dst) if r.returncode == 0 else os.path.getsize(path)


data["meta"]["true_rss_kib"] = rss(["/bin/true"])
walls = []
for _ in range(15):
    t0 = time.perf_counter(); subprocess.run(bench.PIN + ["/bin/true"]); walls.append((time.perf_counter() - t0) * 1000)
data["meta"]["true_wall_ms"] = statistics.median(walls)

for wl in bench.WORKLOADS:
    for name, (kind, build, ship) in bench.CONFIGS.items():
        for mode in ("n0", "run"):
            row = idx.get((wl, mode, name))
            if not row or "error" in row:
                continue
            row["rss_kib"] = rss(build(f"{wl}.{mode}"))
            row["ship_stripped_bytes"] = sum(stripped(p) for p in ship(f"{wl}.{mode}"))
        print(wl, name, idx[(wl, "n0", name)].get("rss_kib"), idx[(wl, "run", name)].get("rss_kib"), flush=True)
    # Hermes from source, lazy compilation (the CLI's default is eager).
    argv = [f"{bench.H}/hermes", "-Xes6-block-scoping", "-lazy", f"out/{wl}.n0.js"]
    ws = [bench.run_once(argv)["wall_ms"] for _ in range(bench.REPS["n0"] + 1)][1:]
    idx[(wl, "n0", "hermes")]["lazy_wall_median"] = statistics.median(ws)
    print(wl, "hermes -lazy startup", statistics.median(ws), flush=True)

json.dump(data, open(raw_path, "w"), indent=1)
