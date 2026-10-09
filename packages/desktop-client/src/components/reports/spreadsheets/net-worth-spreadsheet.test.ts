import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { QueryState } from '@actual-app/core/shared/query';
import type {
  AccountEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import { enUS } from 'date-fns/locale';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpreadsheet } from './net-worth-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type SpreadsheetData = Parameters<
  Parameters<ReturnType<typeof createSpreadsheet>>[1]
>[0];

type FakeTransaction = {
  id: string;
  account: string;
  amount: number;
  date: string;
  payee?: string;
  transfer_id?: string;
};

type Row = Record<string, unknown>;

const accounts = [
  createAccount('checking', 'Checking'),
  createAccount('savings', 'Savings'),
] satisfies AccountEntity[];

function createAccount(
  id: string,
  name: string,
  { offbudget = 0, closed = 0 }: { offbudget?: 0 | 1; closed?: 0 | 1 } = {},
): AccountEntity {
  return {
    id,
    name,
    offbudget,
    closed,
    sort_order: 0,
    last_reconciled: null,
    tombstone: 0,
    account_group_id: null,
    account_id: null,
    bank: null,
    bankName: null,
    bankId: null,
    mask: null,
    official_name: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
    last_sync: null,
    bank_sync_status: null,
  };
}

function tx(
  id: string,
  account: string,
  date: string,
  amount: number,
  extra: Partial<FakeTransaction> = {},
): FakeTransaction {
  return { id, account, date, amount, ...extra };
}

// A linked transfer between two accounts, as two transactions.
function transfer(
  from: { account: string; date: string },
  to: { account: string; date: string },
  amount: number,
): FakeTransaction[] {
  const fromId = `${from.account}-transfer`;
  const toId = `${to.account}-transfer`;
  return [
    tx(fromId, from.account, from.date, -amount, { transfer_id: toId }),
    tx(toId, to.account, to.date, amount, { transfer_id: fromId }),
  ];
}

// A small in-memory evaluator for the subset of AQL this report uses, so the
// tests describe transactions rather than the exact query sequence.
function compare(value: unknown, operand: unknown): number {
  // Numbers (amounts) compare numerically, everything else (dates) as text.
  if (typeof value === 'number' && typeof operand === 'number') {
    return value - operand;
  }
  const [a, b] = [String(value), String(operand)];
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesValue(value: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) {
    return value === expected;
  }
  return Object.entries(expected).every(([op, operand]) => {
    switch (op) {
      case '$eq':
        return value === operand;
      case '$ne':
        return operand === null ? value != null : value !== operand;
      case '$lt':
        return value != null && compare(value, operand) < 0;
      case '$lte':
        return value != null && compare(value, operand) <= 0;
      case '$gt':
        return value != null && compare(value, operand) > 0;
      case '$gte':
        return value != null && compare(value, operand) >= 0;
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
      // The AQL compiler drops an empty `$or`, so it matches everything.
      const conds = expected as object[];
      return conds.length === 0 || conds.some(f => matchesFilter(row, f));
    }
    if (typeof expected === 'number' && key === 'amount') {
      return row.amount === expected;
    }
    return matchesValue(
      (row as Record<string, unknown>)[key] ?? null,
      expected,
    );
  });
}

function evalExpr(row: FakeTransaction, expr: unknown): unknown {
  if (typeof expr === 'string') {
    return (row as Record<string, unknown>)[expr.replace(/^\$/, '')] ?? null;
  }
  if (typeof expr === 'object' && expr !== null) {
    if ('$month' in expr) {
      return row.date.slice(0, 7);
    }
    if ('$year' in expr) {
      return row.date.slice(0, 4);
    }
  }
  throw new Error(`Unsupported expression ${JSON.stringify(expr)}`);
}

function isSum(expr: unknown) {
  return typeof expr === 'object' && expr !== null && '$sum' in expr;
}

function runQuery(state: QueryState, transactions: FakeTransaction[]) {
  const rows = transactions.filter(row =>
    state.filterExpressions.every(filter => matchesFilter(row, filter)),
  );

  const selects = state.selectExpressions.map(expr =>
    typeof expr === 'string'
      ? ([expr, expr] as const)
      : (Object.entries(expr)[0] as [string, unknown]),
  );

  const isAggregate =
    state.calculation || selects.some(([, expr]) => isSum(expr));
  if (!isAggregate) {
    return rows.map(row =>
      Object.fromEntries(
        selects.map(([alias, expr]) => [alias, evalExpr(row, expr)]),
      ),
    );
  }

  const groups = new Map<string, FakeTransaction[]>();
  for (const row of rows) {
    const key = JSON.stringify(
      state.groupExpressions.map(expr => evalExpr(row, expr)),
    );
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (state.groupExpressions.length === 0 && groups.size === 0) {
    groups.set('[]', []);
  }

  const result: Row[] = [...groups.values()].map(group =>
    Object.fromEntries(
      selects.map(([alias, expr]) => [
        alias,
        isSum(expr)
          ? group.length === 0
            ? null
            : group.reduce((sum, row) => sum + row.amount, 0)
          : evalExpr(group[0], expr),
      ]),
    ),
  );

  if (state.calculation) {
    return result[0]?.result || 0;
  }
  return result;
}

async function runReport({
  accounts,
  transactions,
  start = '2026-07',
  end = '2026-08',
  interval = 'Monthly',
  earliestTransactionDate = '2026-07-01',
  filters = [],
  conditionsOp = 'and',
}: {
  accounts: AccountEntity[];
  transactions: FakeTransaction[];
  start?: string;
  end?: string;
  interval?: string;
  earliestTransactionDate?: string;
  filters?: object[];
  conditionsOp?: 'and' | 'or';
}) {
  const queries: QueryState[] = [];

  initServer({
    'make-filters-from-conditions': async () => ({ filters }),
    'get-earliest-transaction': async () => ({
      date: earliestTransactionDate,
    }),
    query: async query => {
      queries.push(query);
      return { data: runQuery(query, transactions), dependencies: [] };
    },
  });

  // The filters come from the mocked `make-filters-from-conditions`; the
  // conditions themselves only need to be non-custom.
  const conditions = filters.map(
    () =>
      ({
        field: 'payee',
        op: 'is',
        value: 'payee',
        type: 'id',
      }) satisfies RuleConditionEntity,
  );

  let report: SpreadsheetData | undefined;
  const spreadsheet = createSpreadsheet(
    start,
    end,
    accounts,
    conditions,
    conditionsOp,
    enUS,
    interval,
    '0',
    value => String(value),
  );

  // The net worth factory does not use its spreadsheet dependency.
  await spreadsheet(undefined as never, data => {
    report = data;
  });

  if (!report) {
    throw new Error('Spreadsheet did not produce report data');
  }
  return { report, queries };
}

function totals(report: SpreadsheetData) {
  return report.graphData.data.map(point => point.y);
}

function accountSeries(report: SpreadsheetData, id: string) {
  return report.graphData.data.map(
    point => (point as Record<string, unknown>)[id],
  );
}

afterEach(async () => {
  await clearServer();
});

describe('net worth transfers', () => {
  it('keeps a linked transfer neutral when its two legs cross months', async () => {
    const { report } = await runReport({
      accounts,
      transactions: [
        tx('opening', 'checking', '2026-06-30', 100_000),
        ...transfer(
          { account: 'checking', date: '2026-07-31' },
          { account: 'savings', date: '2026-08-01' },
          10_000,
        ),
      ],
    });

    expect(totals(report)).toEqual([100_000, 100_000]);
  });

  it('preserves a real expense as a net worth loss', async () => {
    const { report } = await runReport({
      accounts: [accounts[0]],
      transactions: [
        tx('opening', 'checking', '2026-06-30', 100_000),
        tx('expense', 'checking', '2026-07-15', -10_000),
      ],
    });

    expect(totals(report)).toEqual([90_000, 90_000]);
  });

  it('preserves a transfer out of the selected account set as a loss', async () => {
    const { report } = await runReport({
      accounts: [accounts[0]],
      transactions: [
        tx('opening', 'checking', '2026-06-30', 100_000),
        ...transfer(
          { account: 'checking', date: '2026-07-31' },
          { account: 'savings', date: '2026-08-01' },
          10_000,
        ),
      ],
    });

    expect(totals(report)).toEqual([90_000, 90_000]);
  });

  it('keeps funds in the source account until a later counterpart arrives', async () => {
    const { report } = await runReport({
      accounts,
      transactions: [
        tx('opening', 'checking', '2026-06-30', 100_000),
        ...transfer(
          { account: 'checking', date: '2026-08-31' },
          { account: 'savings', date: '2026-09-01' },
          10_000,
        ),
      ],
    });

    expect(totals(report)).toEqual([100_000, 100_000]);
    expect(report.graphData.data.at(-1)).toMatchObject({ checking: 100_000 });
  });

  it('keeps a transfer neutral when it spans the entire report range', async () => {
    const { report } = await runReport({
      accounts,
      transactions: [
        tx('opening', 'checking', '2026-06-01', 100_000),
        ...transfer(
          { account: 'checking', date: '2026-06-30' },
          { account: 'savings', date: '2026-09-01' },
          10_000,
        ),
      ],
      start: '2026-08',
      end: '2026-08',
      earliestTransactionDate: '2026-06-30',
    });

    expect(totals(report)).toEqual([100_000, 100_000]);
  });

  it.each([
    {
      interval: 'Daily',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-30',
      earlierDate: '2016-07-30',
      laterDate: '2016-07-31',
    },
    {
      interval: 'Weekly',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-30',
      earlierDate: '2016-07-30',
      laterDate: '2016-07-31',
    },
    {
      interval: 'Yearly',
      start: '2016-01',
      end: '2017-01',
      earliestTransactionDate: '2016-12-31',
      earlierDate: '2016-12-31',
      laterDate: '2017-01-01',
    },
  ])(
    'keeps a linked transfer neutral across $interval intervals',
    async ({ interval, start, end, earliestTransactionDate, ...dates }) => {
      const { report } = await runReport({
        accounts,
        transactions: [
          tx('opening', 'checking', '2015-06-30', 100_000),
          ...transfer(
            { account: 'checking', date: dates.earlierDate },
            { account: 'savings', date: dates.laterDate },
            10_000,
          ),
        ],
        start,
        end,
        interval,
        earliestTransactionDate,
      });

      expect(totals(report)).toEqual(totals(report).map(() => 100_000));
    },
  );
});

describe('net worth balances', () => {
  it('uses a fixed number of queries regardless of the account count', async () => {
    const manyAccounts = Array.from({ length: 12 }, (_, i) =>
      createAccount(`acct-${i}`, `Account ${i}`),
    );
    const { report, queries } = await runReport({
      accounts: manyAccounts,
      transactions: manyAccounts.flatMap((acct, i) => [
        tx(`${acct.id}-opening`, acct.id, '2026-06-15', (i + 1) * 1_000),
        tx(`${acct.id}-july`, acct.id, '2026-07-10', 100),
      ]),
      earliestTransactionDate: '2026-06-15',
    });

    // Starting balances, interval sums and transfer legs.
    expect(queries).toHaveLength(3);
    expect(totals(report)).toEqual([78_000, 79_200, 79_200]);
    manyAccounts.forEach((acct, i) => {
      expect(accountSeries(report, acct.id)).toEqual([
        (i + 1) * 1_000,
        (i + 1) * 1_000 + 100,
        (i + 1) * 1_000 + 100,
      ]);
    });
  });

  it('runs no balance queries when there are no accounts', async () => {
    const { report, queries } = await runReport({
      accounts: [],
      transactions: [tx('opening', 'checking', '2026-06-30', 100_000)],
    });

    expect(queries).toHaveLength(0);
    expect(totals(report)).toEqual([0, 0]);
    expect(report.accounts).toEqual([]);
  });

  it('carries the starting balance from before the range into every interval', async () => {
    const { report } = await runReport({
      accounts,
      transactions: [
        tx('c1', 'checking', '2025-01-10', 50_000),
        tx('c2', 'checking', '2026-03-05', -5_000),
        tx('c3', 'checking', '2026-06-30', 2_000),
        tx('s1', 'savings', '2024-12-31', 20_000),
        tx('c4', 'checking', '2026-08-02', -1_000),
      ],
      earliestTransactionDate: '2024-12-31',
    });

    // The range starts one month early, in June, to provide the prior period.
    expect(report.graphData.start).toBe('2026-06-01');
    expect(accountSeries(report, 'checking')).toEqual([47_000, 47_000, 46_000]);
    expect(accountSeries(report, 'savings')).toEqual([20_000, 20_000, 20_000]);
    expect(totals(report)).toEqual([67_000, 67_000, 66_000]);
    expect(report.totalChange).toBe(-1_000);
  });

  it('includes accounts with no transactions in the range at their starting balance', async () => {
    const { report } = await runReport({
      accounts: [...accounts, createAccount('empty', 'Empty')],
      transactions: [
        tx('c1', 'checking', '2026-06-30', 100_000),
        tx('c2', 'checking', '2026-07-15', -10_000),
        tx('s1', 'savings', '2026-06-01', 5_000),
      ],
    });

    expect(accountSeries(report, 'savings')).toEqual([5_000, 5_000]);
    expect(accountSeries(report, 'empty')).toEqual([0, 0]);
    expect(totals(report)).toEqual([95_000, 95_000]);
    // Accounts that never have a balance are left out of the legend.
    expect(report.accounts).toEqual([
      { id: 'checking', name: 'Checking' },
      { id: 'savings', name: 'Savings' },
    ]);
  });

  it('treats closed and off-budget accounts like any other selected account', async () => {
    const { report } = await runReport({
      accounts: [
        accounts[0],
        createAccount('closed', 'Closed', { closed: 1 }),
        createAccount('mortgage', 'Mortgage', { offbudget: 1 }),
      ],
      transactions: [
        tx('c1', 'checking', '2026-06-30', 10_000),
        tx('closed-1', 'closed', '2026-06-01', 3_000),
        tx('closed-2', 'closed', '2026-08-20', -3_000),
        tx('m1', 'mortgage', '2026-06-01', -200_000),
        tx('m2', 'mortgage', '2026-08-01', 1_000),
        // Not selected, so not counted.
        tx('s1', 'savings', '2026-07-01', 99_000),
      ],
    });

    expect(accountSeries(report, 'closed')).toEqual([3_000, 0]);
    expect(accountSeries(report, 'mortgage')).toEqual([-200_000, -199_000]);
    expect(totals(report)).toEqual([-187_000, -189_000]);
    expect(report.graphData.hasNegative).toBe(true);
    expect(report.graphData.data[0]).toMatchObject({
      assets: '13000',
      debt: '-200000',
    });
    expect(report.accounts.map(acct => acct.id)).toEqual([
      'checking',
      'closed',
      'mortgage',
    ]);
  });

  it.each([
    // Only negative grocer transactions.
    {
      conditionsOp: 'and' as const,
      checking: [-3_000, -3_000],
      savings: [0, 0],
    },
    // Grocer or negative transactions.
    {
      conditionsOp: 'or' as const,
      checking: [6_000, 6_000],
      savings: [4_000, 6_000],
    },
  ])(
    'applies $conditionsOp filters to the starting balance and interval sums',
    async ({ conditionsOp, checking, savings }) => {
      const { report } = await runReport({
        accounts,
        conditionsOp,
        filters: [{ payee: 'grocer' }, { amount: { $lt: 0 } }],
        transactions: [
          tx('c1', 'checking', '2026-05-01', 10_000, { payee: 'grocer' }),
          tx('c2', 'checking', '2026-06-01', -2_000, { payee: 'grocer' }),
          tx('c3', 'checking', '2026-07-01', -1_000, { payee: 'other' }),
          tx('c4', 'checking', '2026-07-02', -1_000, { payee: 'grocer' }),
          tx('c5', 'checking', '2026-08-01', 5_000, { payee: 'other' }),
          tx('s1', 'savings', '2026-05-01', 4_000, { payee: 'grocer' }),
          tx('s2', 'savings', '2026-08-01', 2_000, { payee: 'grocer' }),
        ],
      });

      expect(accountSeries(report, 'checking')).toEqual(checking);
      expect(accountSeries(report, 'savings')).toEqual(savings);
    },
  );

  it('ignores an empty filter list when conditions are combined with or', async () => {
    const { report } = await runReport({
      accounts,
      conditionsOp: 'or',
      filters: [],
      transactions: [
        tx('c1', 'checking', '2026-06-01', 10_000),
        tx('c2', 'checking', '2026-07-15', -2_000),
        tx('s1', 'savings', '2026-08-01', 3_000),
      ],
    });

    expect(accountSeries(report, 'checking')).toEqual([8_000, 8_000]);
    expect(accountSeries(report, 'savings')).toEqual([0, 3_000]);
  });

  it('compares amounts numerically in filters', async () => {
    const { report } = await runReport({
      accounts: [accounts[0]],
      filters: [{ amount: { $gt: 500 } }],
      transactions: [
        tx('c1', 'checking', '2026-06-01', 1_000),
        tx('c2', 'checking', '2026-07-15', 200),
        tx('c3', 'checking', '2026-08-01', 5_000),
      ],
    });

    expect(accountSeries(report, 'checking')).toEqual([1_000, 6_000]);
  });

  it.each([
    {
      interval: 'Daily',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-29',
      expected: { checking: [1_000, 1_500, 1_500], savings: [0, 0, 250] },
    },
    {
      interval: 'Weekly',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-01',
      // Weeks start on Sunday: 2016-06-26, 07-03, 07-10, 07-17, 07-24 and
      // 07-31, so the savings deposit on 07-31 lands in a week of its own.
      expected: {
        checking: [1_000, 1_000, 1_000, 1_000, 1_500, 1_500],
        savings: [0, 0, 0, 0, 0, 250],
      },
    },
    {
      interval: 'Monthly',
      start: '2016-07',
      end: '2016-08',
      earliestTransactionDate: '2016-07-01',
      expected: { checking: [1_500, 1_200], savings: [250, 250] },
    },
    {
      interval: 'Yearly',
      start: '2016-01',
      end: '2017-01',
      earliestTransactionDate: '2016-07-01',
      expected: { checking: [1_200, 1_200], savings: [250, 250] },
    },
  ])(
    'sums each account per $interval interval',
    async ({ interval, start, end, earliestTransactionDate, expected }) => {
      const { report } = await runReport({
        accounts,
        interval,
        start,
        end,
        earliestTransactionDate,
        transactions: [
          tx('c1', 'checking', '2016-07-01', 1_000),
          tx('c2', 'checking', '2016-07-30', 300),
          tx('c3', 'checking', '2016-07-30', 200),
          tx('s1', 'savings', '2016-07-31', 250),
          tx('c4', 'checking', '2016-08-15', -300),
        ],
      });

      expect(accountSeries(report, 'checking')).toEqual(expected.checking);
      expect(accountSeries(report, 'savings')).toEqual(expected.savings);
    },
  );
});
