#!/usr/bin/env node
// Compares two benchmark result files written by the harness.
//
// Usage: node compare.mjs <baseline.json> <candidate.json>

import fs from 'node:fs';

const [baseFile, candFile] = process.argv.slice(2);
if (!baseFile || !candFile) {
  console.error('Usage: node compare.mjs <baseline.json> <candidate.json>');
  process.exit(1);
}

const load = file => JSON.parse(fs.readFileSync(file, 'utf8')).scenarios;
const base = new Map(load(baseFile).map(s => [s.name, s]));
const cand = load(candFile);

const pct = (a, b) =>
  a === 0 ? (b === 0 ? '0%' : 'n/a') : `${Math.round(((b - a) / a) * 100)}%`;

console.log(
  '| Scenario | ms (base → new) | Δ ms | fibers (base → new) | Δ fibers |',
);
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const s of cand) {
  const b = base.get(s.name);
  if (!b) {
    console.log(
      `| ${s.name} | – → ${s.medianMs} | | – → ${s.medianFibers} | |`,
    );
    continue;
  }
  console.log(
    `| ${s.name} | ${b.medianMs} → ${s.medianMs} | ${pct(b.medianMs, s.medianMs)} | ${b.medianFibers} → ${s.medianFibers} | ${pct(b.medianFibers, s.medianFibers)} |`,
  );
}
