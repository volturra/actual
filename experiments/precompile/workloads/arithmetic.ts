// Budget-cell expression evaluator used when typing "=120*3/4" style amounts.
import { evalArithmetic } from '../../../packages/loot-core/src/shared/arithmetic';

import { mix, rng } from './common';

export function bench(n: number): number {
  const r = rng(2);
  const ops = ['+', '-', '*', '/'];
  const exprs: string[] = [];
  for (let i = 0; i < 200; i++) {
    let e = String(Math.floor(r() * 1000)) + '.' + Math.floor(r() * 100);
    const terms = 2 + Math.floor(r() * 6);
    for (let t = 0; t < terms; t++) {
      const v = (Math.floor(r() * 5000) / 100).toString();
      e +=
        ' ' +
        ops[Math.floor(r() * 4)] +
        ' ' +
        (r() < 0.2 ? '(' + v + ' + 1)' : v);
    }
    exprs.push(e);
  }
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    for (const e of exprs) {
      const v = evalArithmetic(e, 0);
      h = mix(h, v === null ? 'null' : Math.round(v * 100));
    }
  }
  return h;
}
