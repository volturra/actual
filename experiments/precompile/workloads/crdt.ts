// Sync engine: HULC timestamp parse/serialize/hash and merkle trie build/diff/prune.
import { merkle, Timestamp } from '../../../packages/crdt/src/crdt';

import { mix, rng } from './common';

const BASE = Date.UTC(2025, 0, 1);

export function bench(n: number): number {
  const r = rng(1);
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    const a: Timestamp[] = [];
    const b: Timestamp[] = [];
    for (let i = 0; i < 400; i++) {
      const millis = BASE + Math.floor(r() * 90 * 86400000);
      const counter = Math.floor(r() * 0xffff);
      const node = (
        '0000000000000000' + Math.floor(r() * 1e9).toString(16)
      ).slice(-16);
      const str = new Timestamp(millis, counter, node).toString();
      const ts = Timestamp.parse(str)!;
      h = mix(h, ts.hash());
      a.push(ts);
      if (i % 37 !== 0) b.push(ts);
    }
    // merkle.build() in packages/crdt discards insert()'s result and always
    // returns an empty trie, so thread the trie through insert() the way
    // the sync code does.
    let t1 = merkle.emptyTrie();
    for (const ts of a) t1 = merkle.insert(t1, ts);
    let t2 = merkle.emptyTrie();
    for (const ts of b) t2 = merkle.insert(t2, ts);
    h = mix(h, merkle.diff(t1, t2) ?? -1);
    h = mix(h, merkle.diff(merkle.prune(t1), merkle.prune(t2)) ?? -1);
    h = mix(h, t1.hash ?? 0);
    h = mix(h, JSON.stringify(merkle.prune(t1, 3)));
  }
  return h;
}
