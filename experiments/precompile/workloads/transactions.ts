import {
  addSplitTransaction,
  splitTransaction,
  ungroupTransactions,
  updateTransaction,
} from '../../../packages/loot-core/src/shared/transactions';
// Split-transaction editing: split, update child, ungroup.
import type { TransactionEntity } from '../../../packages/loot-core/src/types/models';

import { mix, rng } from './common';

export function bench(n: number): number {
  const r = rng(4);
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    let txns: TransactionEntity[] = [];
    for (let i = 0; i < 60; i++) {
      txns.push({
        id: 'p' + round + '-' + i,
        account: 'acct',
        date: '2025-01-15',
        amount: -Math.floor(r() * 100000),
        is_parent: false,
        is_child: false,
      });
    }
    for (let i = 0; i < 60; i += 3) {
      const id = txns[i].id;
      txns = splitTransaction(txns, id).data;
      txns = addSplitTransaction(txns, id).data;
      const children = txns.filter(t => t.parent_id === id);
      for (const c of children) {
        txns = updateTransaction(txns, {
          ...c,
          amount: Math.floor(txns[0].amount / 3),
        }).data;
      }
    }
    const flat = ungroupTransactions(txns);
    h = mix(h, flat.length);
    for (const t of flat) h = mix(h, t.amount ?? 0);
  }
  return h;
}
