// Spreadsheet dependency graph: build cell graph, topological sort for recompute.
import { Graph } from '../../../packages/loot-core/src/server/spreadsheet/graph-data-structure';

import { mix, rng } from './common';

export function bench(n: number): number {
  const r = rng(6);
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    const g = Graph();
    const N = 600;
    for (let i = 0; i < N; i++) g.addNode('c' + i);
    for (let i = 1; i < N; i++) {
      const deps = 1 + Math.floor(r() * 3);
      for (let d = 0; d < deps; d++) {
        g.addEdge('c' + Math.floor(r() * i), 'c' + i);
      }
    }
    const order = g.topologicalSort(['c0', 'c1', 'c2', 'c3']);
    h = mix(h, order.length);
    h = mix(h, order[order.length - 1]);
  }
  return h;
}
