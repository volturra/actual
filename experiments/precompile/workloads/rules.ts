// Rules engine hot path: evaluate rule conditions against every transaction
// (this is what runs for each imported or edited transaction).
import { Condition } from '../../../packages/loot-core/src/server/rules/condition';

import { mix, rng } from './common';

const PAYEES = [
  'Amazon',
  'Kroger',
  'Shell',
  'Netflix',
  'Landlord',
  'Starbucks',
  'Costco',
  'Uber',
];

export function bench(n: number): number {
  const r = rng(7);
  const conds = [
    new Condition('contains', 'imported_payee', 'star', null),
    new Condition('matches', 'notes', '^ref-[0-9]+$', null),
    new Condition('oneOf', 'imported_payee', ['Shell', 'Costco'], null),
    new Condition('is', 'amount', -4500, null),
    new Condition('isapprox', 'amount', -10000, null),
    new Condition('gt', 'amount', -2000, null),
    new Condition('isbetween', 'amount', { num1: -30000, num2: -5000 }, null),
    new Condition('isapprox', 'date', '2025-03-15', null),
    new Condition('lt', 'date', '2025-06-01', null),
    new Condition('doesNotContain', 'notes', 'transfer', null),
  ];
  const txns: Array<{
    imported_payee: string;
    notes: string;
    amount: number;
    date: string;
  }> = [];
  for (let i = 0; i < 300; i++) {
    const day = 1 + Math.floor(r() * 28);
    const month = 1 + Math.floor(r() * 12);
    txns.push({
      imported_payee: PAYEES[Math.floor(r() * PAYEES.length)],
      notes:
        r() < 0.3
          ? 'ref-' + Math.floor(r() * 1e6)
          : r() < 0.1
            ? 'transfer out'
            : 'note ' + i,
      amount: -Math.floor(r() * 40000),
      date:
        '2025-' +
        (month < 10 ? '0' : '') +
        month +
        '-' +
        (day < 10 ? '0' : '') +
        day,
    });
  }
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    for (const t of txns) {
      let bits = 0;
      for (let c = 0; c < conds.length; c++) {
        if (conds[c].eval(t)) bits |= 1 << c;
      }
      h = mix(h, bits);
    }
  }
  return h;
}
