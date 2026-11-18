#!/usr/bin/env bash
# Precompile every bundled workload with each ahead-of-time toolchain.
# Toolchain locations default to the layout described in README.md (override with AOT=...).
set -uo pipefail
cd "$(dirname "$0")"
AOT=${AOT:-/home/user/aot}
Q=$AOT/quickjs
H=$AOT/hermes-build/bin
PORF="npx --prefix $AOT/npmtools porf"
mkdir -p bin logs
[ -n "${TOOLS:-}" ] || : > logs/compile.tsv
for f in out/*.js; do
  base=$(basename "$f" .js)
  for tool in ${TOOLS:-qjsc hbc shermes porf}; do
    start=$(date +%s.%N)
    case $tool in  # each step capped at 15 min
      qjsc)    timeout 900 $Q/qjsc -o bin/$base.qjsc "$f" ;;
      hbc)     timeout 900 $H/hermesc -Xes6-block-scoping -O -emit-binary -out bin/$base.hbc "$f" ;;
      shermes) timeout 900 $H/shermes -Xes6-block-scoping -O -o bin/$base.shermes "$f" ;;
      porf)    timeout 900 $PORF native "$f" -o bin/$base.porf ;;
    esac > logs/$base.$tool.log 2>&1
    rc=$?
    end=$(date +%s.%N)
    printf '%s\t%s\t%s\t%.2f\n' "$base" "$tool" "$rc" "$(echo "$end - $start" | bc)" >> logs/compile.tsv
  done
done
cat logs/compile.tsv
