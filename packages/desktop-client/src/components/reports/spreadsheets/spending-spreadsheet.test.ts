import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { QueryState } from '@actual-app/core/shared/query';
import type {
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
  SpendingAverageRange,
  SpendingEntity,
} from '@actual-app/core/types/models';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetInFlightReportRequests } from '#reports';

import {
  createSpendingSpreadsheet,
  getSpendingBudgetFilters,
} from './spending-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const categoryGroups = [
  { id: 'group-bills', name: 'Bills' },
  { id: 'group-fun', name: 'Fun Money' },
] satisfies CategoryGroupEntity[];

const categories = [
  { id: 'cat-rent', name: 'Rent', group: 'group-bills' },
  { id: 'cat-electric', name: 'Electric', group: 'group-bills' },
  { id: 'cat-dining', name: 'Dining Out', group: 'group-fun' },
] satisfies CategoryEntity[];

describe('getSpendingBudgetFilters', () => {
  it('filters budget categories by category group', () => {
    const result = getSpendingBudgetFilters({
      categories,
      categoryGroups,
      conditions: [
        {
          field: 'category_group',
          op: 'is',
          value: 'group-bills',
        },
      ] satisfies RuleConditionEntity[],
    });

    expect(result).toEqual([
      { category: { $oneof: ['cat-rent', 'cat-electric'] } },
    ]);
  });

  it('does not filter budgets when no category condition is present', () => {
    const result = getSpendingBudgetFilters({
      categories,
      categoryGroups,
      conditions: [
        {
          field: 'account',
          op: 'is',
          value: 'account-checking',
        },
      ] satisfies RuleConditionEntity[],
    });

    expect(result).toEqual([]);
  });

  it('filters budget categories by direct category IDs', () => {
    const result = getSpendingBudgetFilters({
      categories,
      categoryGroups,
      conditions: [
        {
          field: 'category',
          op: 'oneOf',
          value: ['cat-rent', 'cat-dining'],
        },
      ] satisfies RuleConditionEntity[],
    });

    expect(result).toEqual([
      { category: { $oneof: ['cat-rent', 'cat-dining'] } },
    ]);
  });
});

type TotalsRow = {
  date: string;
  categoryIncome: boolean;
  accountOffBudget: boolean;
  amount: number;
};

// What the totals queries return, before the report drops income categories
// and off-budget accounts.
const totalsRows: TotalsRow[] = [
  // A compare-to month before the default range.
  row('2016-06-10', -7),
  row('2016-06-10', -70_000, { categoryIncome: true }),
  // Inside the default range (2016-09 to 2016-12).
  row('2016-10-05', -100),
  row('2016-11-03', -20),
  row('2016-11-03', 3),
  row('2016-11-03', -9_000, { accountOffBudget: true }),
  row('2016-12-01', -1),
  row('2016-12-01', 50_000, { categoryIncome: true }),
  // A compare-to month after the compare month.
  row('2017-02-02', -500),
];

function row(
  date: string,
  amount: number,
  flags: Partial<Pick<TotalsRow, 'categoryIncome' | 'accountOffBudget'>> = {},
): TotalsRow {
  return {
    date,
    amount,
    categoryIncome: false,
    accountOffBudget: false,
    ...flags,
  };
}

function findValue(filter: unknown, key: string, op: string): unknown {
  if (Array.isArray(filter)) {
    for (const item of filter) {
      const value = findValue(item, key, op);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }
  if (typeof filter !== 'object' || filter === null) {
    return undefined;
  }
  for (const [field, value] of Object.entries(filter)) {
    if (field === key && typeof value === 'object' && value && op in value) {
      return (value as Record<string, unknown>)[op];
    }
    const nested = findValue(value, key, op);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

type SentQuery = {
  table: string;
  startDate?: string;
  endDate?: string;
  sign?: 'assets' | 'debts';
};

let releaseQueries: Array<() => void> = [];

// Answers the report's requests. Transaction queries wait until the test
// releases them, so the calls of a test stay in flight together.
function installServer() {
  const queries: SentQuery[] = [];
  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    query: async (state: QueryState) => {
      if (state.table !== 'transactions') {
        queries.push({ table: state.table });
        return { data: [], dependencies: [] };
      }
      const filters = state.filterExpressions;
      const startDate = findValue(filters, 'date', '$gte') as string;
      const endDate = findValue(filters, 'date', '$lte') as string;
      const sign =
        findValue(filters, 'amount', '$gt') !== undefined ? 'assets' : 'debts';
      queries.push({ table: state.table, startDate, endDate, sign });
      const data = totalsRows.filter(
        r =>
          r.date >= startDate &&
          r.date <= endDate &&
          (sign === 'assets' ? r.amount > 0 : r.amount < 0),
      );
      return new Promise<{ data: TotalsRow[]; dependencies: string[] }>(
        resolve => {
          releaseQueries.push(() => resolve({ data, dependencies: [] }));
        },
      );
    },
  });
  return queries;
}

async function settle<T>(promises: Array<Promise<T>>) {
  // Let every call reach its queries, then answer them, until all are done.
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = releaseQueries;
    releaseQueries = [];
    pending.forEach(release => release());
  }
  return Promise.all(promises);
}

function runReport(params: {
  compare: string;
  compareTo: string;
  averageRange?: SpendingAverageRange;
}) {
  let report: SpendingEntity | undefined;
  return createSpendingSpreadsheet(params)(undefined as never, data => {
    report = data;
  }).then(() => {
    if (!report) {
      throw new Error('Spreadsheet did not produce report data');
    }
    return report;
  });
}

function transactionQueries(queries: SentQuery[]) {
  return queries
    .filter(query => query.table === 'transactions')
    .map(({ startDate, endDate, sign }) => `${sign} ${startDate}..${endDate}`)
    .sort();
}

function lastDay(report: SpendingEntity) {
  return report.intervalData[report.intervalData.length - 1];
}

describe('createSpendingSpreadsheet', () => {
  afterEach(async () => {
    releaseQueries = [];
    await clearServer();
  });

  it('does not query the compared month again when the range holds it', async () => {
    const queries = installServer();
    const [report] = await settle([
      runReport({ compare: '2016-12', compareTo: '2016-11' }),
    ]);

    expect(transactionQueries(queries)).toEqual([
      'assets 2016-09-01..2016-12-31',
      'debts 2016-09-01..2016-12-31',
    ]);
    // November still comes from the main range: -20 + 3, without the income
    // and off-budget rows.
    expect(lastDay(report).compareTo).toBe(-17);
    expect(lastDay(report).compare).toBe(-1);
    expect(report.totalTotals).toBe(-118);
  });

  it.each([
    { compareTo: '2016-06', end: '2016-06-30', total: -125 },
    { compareTo: '2017-02', end: '2017-02-28', total: -618 },
  ])(
    'queries the compared month $compareTo when it is outside the range',
    async ({ compareTo, end, total }) => {
      const queries = installServer();
      const [report] = await settle([
        runReport({ compare: '2016-12', compareTo }),
      ]);

      expect(transactionQueries(queries)).toEqual(
        [
          `assets ${compareTo}-01..${end}`,
          'assets 2016-09-01..2016-12-31',
          `debts ${compareTo}-01..${end}`,
          'debts 2016-09-01..2016-12-31',
        ].sort(),
      );
      expect(report.totalTotals).toBe(total);
      if (compareTo === '2016-06') {
        expect(lastDay(report).compareTo).toBe(-7);
      }
    },
  );

  it('shares the totals queries of reports that load together', async () => {
    const queries = installServer();
    const params = { compare: '2016-12', compareTo: '2016-11' };
    const reports = await settle([
      runReport(params),
      runReport(params),
      runReport({
        ...params,
        averageRange: { mode: 'last-n-months', months: 3 },
      }),
    ]);

    expect(transactionQueries(queries)).toEqual([
      'assets 2016-09-01..2016-12-31',
      'debts 2016-09-01..2016-12-31',
    ]);
    expect(reports[1]).toEqual(reports[0]);
    expect(reports[2]).toEqual(reports[0]);
  });

  it('runs the totals queries again once the shared ones settle', async () => {
    const queries = installServer();
    const params = { compare: '2016-12', compareTo: '2016-11' };
    await settle([runReport(params)]);
    await settle([runReport(params)]);

    expect(transactionQueries(queries)).toHaveLength(4);
  });

  it('does not share totals queries across a data change', async () => {
    const queries = installServer();
    const params = { compare: '2016-12', compareTo: '2016-11' };
    const first = runReport(params);
    await new Promise(resolve => setTimeout(resolve, 0));
    forgetInFlightReportRequests();
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = runReport(params);
    await settle([first, second]);

    expect(transactionQueries(queries)).toHaveLength(4);
  });
});
