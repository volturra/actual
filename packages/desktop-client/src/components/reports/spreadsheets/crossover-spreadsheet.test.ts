import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { QueryState } from '@actual-app/core/shared/query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCrossoverSpreadsheet } from './crossover-spreadsheet';
import type { CrossoverData, CrossoverParams } from './crossover-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type FakeTransaction = {
  account: string;
  category: string | null;
  date: string;
  amount: number;
};

function tx(
  account: string,
  date: string,
  amount: number,
  category: string | null = null,
): FakeTransaction {
  return { account, category, date, amount };
}

// A small in-memory evaluator for the subset of AQL this report uses, so the
// tests describe transactions rather than the exact query shapes. The real
// engine's behaviour for these shapes (splits, transfers, merged and deleted
// categories) is pinned in loot-core's crossover-queries.test.ts.
function matchesValue(value: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) {
    return value === expected;
  }
  return Object.entries(expected).every(([op, operand]) => {
    switch (op) {
      case '$gte':
        return String(value) >= String(operand);
      case '$lte':
        return String(value) <= String(operand);
      case '$oneof':
        return Array.isArray(operand) && operand.includes(value);
      default:
        throw new Error(`Unsupported operator ${op}`);
    }
  });
}

function matchesFilter(row: FakeTransaction, filter: object): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') {
      return (expected as object[]).every(f => matchesFilter(row, f));
    }
    if (key === '$or') {
      return (expected as object[]).some(f => matchesFilter(row, f));
    }
    return matchesValue(
      (row as Record<string, unknown>)[key] ?? null,
      expected,
    );
  });
}

function evalExpr(row: FakeTransaction, expr: unknown): unknown {
  if (typeof expr === 'string') {
    return (row as Record<string, unknown>)[expr.replace(/^\$/, '')];
  }
  if (typeof expr === 'object' && expr !== null && '$month' in expr) {
    return row.date.slice(0, 7);
  }
  throw new Error(`Unsupported expression ${JSON.stringify(expr)}`);
}

function runQuery(state: QueryState, transactions: FakeTransaction[]) {
  const rows = transactions.filter(row =>
    state.filterExpressions.every(filter => matchesFilter(row, filter)),
  );
  const sum = (group: FakeTransaction[]) =>
    group.reduce((total, row) => total + row.amount, 0);

  if (state.calculation) {
    return rows.length === 0 ? null : sum(rows);
  }

  const groups = new Map<string, FakeTransaction[]>();
  for (const row of rows) {
    const key = JSON.stringify(
      state.groupExpressions.map(expr => evalExpr(row, expr)),
    );
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map(group =>
    Object.fromEntries(
      state.selectExpressions.map(expr => {
        if (typeof expr === 'string') {
          return [expr, evalExpr(group[0], expr)];
        }
        const [alias, value] = Object.entries(expr)[0];
        const isSum =
          typeof value === 'object' && value !== null && '$sum' in value;
        return [alias, isSum ? sum(group) : evalExpr(group[0], value)];
      }),
    ),
  );
}

async function runReport(
  transactions: FakeTransaction[],
  params: Partial<CrossoverParams> = {},
) {
  const queries: QueryState[] = [];
  initServer({
    query: async query => {
      queries.push(query as QueryState);
      return {
        data: runQuery(query as QueryState, transactions),
        dependencies: [],
      };
    },
  });

  let report: CrossoverData | undefined;
  await createCrossoverSpreadsheet({
    start: '2024-11',
    end: '2025-02',
    expenseCategoryIds: ['food', 'rent'],
    incomeAccountIds: ['checking', 'savings', 'empty'],
    safeWithdrawalRate: 0.04,
    projectionType: 'mean',
    ...params,
  })(undefined as never, data => {
    report = data;
  });

  if (!report) {
    throw new Error('Spreadsheet did not produce report data');
  }
  return { report, queries };
}

function history(report: CrossoverData) {
  return report.graphData.data
    .filter(point => !point.isProjection)
    .map(({ x, nestEgg, expenses }) => ({ x, nestEgg, expenses }));
}

const transactions = [
  // Before the range: only part of the starting balance.
  tx('checking', '2024-10-15', 100_000),
  tx('checking', '2024-10-20', -400, 'food'),
  // The start month is part of the starting balance and of the expenses.
  tx('checking', '2024-11-30', -2_000, 'food'),
  tx('savings', '2024-11-01', 50_000),
  // Across the year boundary.
  tx('checking', '2024-12-31', -3_000, 'rent'),
  tx('checking', '2025-01-01', 500),
  tx('checking', '2025-01-02', -700, 'fun'),
  tx('savings', '2025-02-28', -1_000, 'food'),
  // Not a selected account.
  tx('other', '2024-12-15', -9_000, 'food'),
  // After the range.
  tx('checking', '2025-03-01', -999, 'food'),
];

afterEach(async () => {
  await clearServer();
});

describe('createCrossoverSpreadsheet', () => {
  it('fetches expenses and every account balance in two queries', async () => {
    const { queries } = await runReport(transactions);

    expect(queries).toHaveLength(2);
    expect(JSON.stringify(queries[0].filterExpressions)).toContain(
      '{"category":{"$oneof":["food","rent"]}}',
    );
  });

  it('builds monthly balances and expenses for the selected accounts', async () => {
    const { report } = await runReport(transactions);

    expect(history(report)).toEqual([
      { x: 'Nov 2024', nestEgg: 147_600, expenses: 2_000 },
      { x: 'Dec 2024', nestEgg: 144_600, expenses: 12_000 },
      { x: 'Jan 2025', nestEgg: 144_400, expenses: 0 },
      { x: 'Feb 2025', nestEgg: 143_400, expenses: 1_000 },
    ]);
    expect(report.lastKnownBalance).toBe(143_400);
    expect(report.lastKnownMonthlyExpenses).toBe(1_000);
  });

  it('counts an account selected twice twice, as before', async () => {
    const { report } = await runReport(transactions, {
      incomeAccountIds: ['savings', 'savings'],
    });

    expect(history(report).map(point => point.nestEgg)).toEqual([
      100_000, 100_000, 100_000, 98_000,
    ]);
  });

  it('treats a single-month range as the starting balance only', async () => {
    const { report } = await runReport(transactions, {
      start: '2024-12',
      end: '2024-12',
    });

    expect(history(report)).toEqual([
      { x: 'Dec 2024', nestEgg: 144_600, expenses: 12_000 },
    ]);
  });

  it('reports zero balances and expenses when nothing matches', async () => {
    const { report } = await runReport([], {
      expenseCategoryIds: [],
    });

    expect(
      history(report).map(({ nestEgg, expenses }) => nestEgg + expenses),
    ).toEqual([0, 0, 0, 0]);
    expect(report.historicalReturn).toBe(0);
  });
});
