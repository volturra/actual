#!/usr/bin/env bash
# Runs semantics.js on every engine side by side (Porffor run via its own CLI).
cd "$(dirname "$0")"; AOT=${AOT:-/home/user/aot}
for e in node "$AOT/quickjs/qjs" "$AOT/hermes-build/bin/hermes" "npx --prefix $AOT/npmtools porf"; do
  echo "== $e"; $e semantics.js 2>&1 | grep -v '^ok' || true
done
