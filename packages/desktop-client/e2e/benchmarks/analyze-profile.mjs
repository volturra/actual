#!/usr/bin/env node
// Summarizes a .cpuprofile written by the benchmark harness
// (BENCHMARK_PROFILE=1): busy time, then the functions with the most self
// time and the most total (inclusive) time.
//
// Usage: node analyze-profile.mjs <file.cpuprofile> [topN]

import fs from 'node:fs';

const [file, topArg] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node analyze-profile.mjs <file.cpuprofile> [topN]');
  process.exit(1);
}
const top = Number(topArg) || 40;

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) {
  for (const child of node.children ?? []) {
    parent.set(child, node.id);
  }
}

const timeByNode = new Map();
profile.samples.forEach((id, i) => {
  timeByNode.set(id, (timeByNode.get(id) ?? 0) + profile.timeDeltas[i]);
});

function nameOf(node) {
  const { functionName, url, lineNumber } = node.callFrame;
  return `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber}`;
}

const self = new Map();
const total = new Map();
let all = 0;
for (const [id, time] of timeByNode) {
  all += time;
  const name = nameOf(nodes.get(id));
  self.set(name, (self.get(name) ?? 0) + time);
  const seen = new Set();
  for (let x = id; x != null; x = parent.get(x)) {
    const n = nameOf(nodes.get(x));
    if (!seen.has(n)) {
      seen.add(n);
      total.set(n, (total.get(n) ?? 0) + time);
    }
  }
}

const idle = self.get('(idle) :-1') ?? 0;
const fmt = us => (us / 1000).toFixed(1).padStart(8);
const print = (title, map, n) => {
  console.log(`-- ${title}`);
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .forEach(([name, time]) => console.log(`${fmt(time)} ms  ${name}`));
};

console.log(
  `busy ${((all - idle) / 1000).toFixed(1)} ms of ${(all / 1000).toFixed(1)} ms`,
);
print('self time', self, 25);
print('total time', total, top);
