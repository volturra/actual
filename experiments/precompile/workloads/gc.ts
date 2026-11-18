// Garbage-collection probe, not Actual code: allocates ~n * 1M short-lived
// objects with a small live set. A runtime without a working GC shows peak
// RSS growing with n instead of staying flat.
import { mix } from './common';

export function bench(n: number): number {
  let h = 2166136261;
  const live: Array<{
    id: number;
    round: number;
    name: string;
    tags: number[];
  }> = Array.from({ length: 1000 });
  for (let round = 0; round < n; round++) {
    for (let i = 0; i < 1000000; i++) {
      const o = { id: i, round, name: 'x' + (i & 1023), tags: [i, round] };
      live[i % 1000] = o;
    }
    h = mix(h, live[round % 1000].name);
  }
  return h;
}
