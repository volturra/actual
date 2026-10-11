import { generateSQLWithState } from '@actual-app/core/server/aql/compiler';
import { schema, schemaConfig } from '@actual-app/core/server/aql/schema/index';
import * as monthUtils from '@actual-app/core/shared/months';
import type { Query } from '@actual-app/core/shared/query';
import type { AgeOfMoneyGranularity } from '@actual-app/core/types/models';
import { describe, expect, it, vi } from 'vitest';

import { aqlQuery } from '#queries/aqlQuery';

import { generateAgeOfMoneyInput } from './age-of-money-legacy-fixtures';
import {
  calculateAgeOfMoney,
  calculateAverageAge,
  calculateGraphData,
  calculateTrend,
  createAgeOfMoneySpreadsheet,
  withEarlierExpensesTotal,
} from './age-of-money-spreadsheet';
import type { AgeOfMoneyData, Transaction } from './age-of-money-spreadsheet';

vi.mock('#queries/aqlQuery');
vi.mock('#reports', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeFiltersFromConditions: async () => ({ filters: [] }),
}));

const GRANULARITIES: AgeOfMoneyGranularity[] = ['monthly', 'weekly', 'daily'];

// What the report shows, given the ages and flag from calculateAgeOfMoney
function shown(
  { ages, insufficientData }: ReturnType<typeof calculateAgeOfMoney>,
  start: string,
  end: string,
) {
  const displayStart = monthUtils.firstDayOfMonth(start);
  const filteredAges = ages.filter(({ date }) => date >= displayStart);
  return {
    filteredAges,
    insufficientData,
    currentAge: calculateAverageAge(filteredAges, 10),
    graphs: GRANULARITIES.map(granularity => {
      const graphData = calculateGraphData(
        filteredAges,
        start,
        end,
        granularity,
      );
      return { graphData, trend: calculateTrend(graphData) };
    }),
  };
}

// Every expense listed one by one, as the report used to read them
function fromAllExpenses(
  income: Transaction[],
  expenses: Transaction[],
  start: string,
  end: string,
) {
  return shown(calculateAgeOfMoney(income, expenses), start, end);
}

// Expenses before the display start replaced by their total
function fromEarlierTotal(
  income: Transaction[],
  expenses: Transaction[],
  start: string,
  end: string,
) {
  const displayStart = monthUtils.firstDayOfMonth(start);
  const earlierTotal = expenses
    .filter(t => t.date < displayStart)
    .reduce((sum, t) => sum + t.amount, 0);
  const later = expenses.filter(t => t.date >= displayStart);
  return shown(
    calculateAgeOfMoney(
      income,
      withEarlierExpensesTotal(later, earlierTotal, displayStart),
    ),
    start,
    end,
  );
}

function expectSameReport(
  income: Transaction[],
  expenses: Transaction[],
  start: string,
  end: string,
) {
  expect(fromEarlierTotal(income, expenses, start, end)).toEqual(
    fromAllExpenses(income, expenses, start, end),
  );
}

describe('withEarlierExpensesTotal', () => {
  it('adds one expense dated the day before the display start', () => {
    const later = [{ id: 'e1', date: '2024-03-01', amount: -5 }];
    expect(withEarlierExpensesTotal(later, -120, '2024-03-01')).toEqual([
      { id: '', date: '2024-02-29', amount: -120 },
      ...later,
    ]);
  });

  it('adds nothing without earlier expenses', () => {
    const later = [{ id: 'e1', date: '2024-03-01', amount: -5 }];
    expect(withEarlierExpensesTotal(later, 0, '2024-03-01')).toBe(later);
  });
});

describe('Age of money with earlier expenses as one total', () => {
  it('matches listing every expense on a long generated budget', () => {
    const { income, expenses } = generateAgeOfMoneyInput({
      seed: 1,
      startDate: '2017-09-15',
      endDate: '2024-03-10',
      count: 8000,
    });
    for (const start of [
      '2017-09',
      '2017-10',
      '2019-01',
      '2020-03',
      '2023-12',
      '2024-03',
      '2024-05',
    ]) {
      expectSameReport(income, expenses, start, '2024-03');
    }
    // A display range that ends before the last transaction
    expectSameReport(income, expenses, '2020-01', '2020-06');
  });

  it('matches listing every expense on many small budgets', () => {
    for (let seed = 100; seed < 500; seed++) {
      // Few days and few rows: many ties on a date, and often more
      // outflows than inflows
      const { income, expenses } = generateAgeOfMoneyInput({
        seed,
        startDate: '2024-01-25',
        endDate: '2024-04-05',
        count: seed % 80,
      });
      for (const start of ['2024-01', '2024-02', '2024-03', '2024-04']) {
        expectSameReport(income, expenses, start, '2024-04');
      }
    }
  });

  it('matches listing every expense when outflows come before any inflow', () => {
    const income: Transaction[] = [
      { id: 'i1', date: '2024-01-31', amount: 1000 },
      { id: 'i2', date: '2024-02-29', amount: 1000 },
    ];
    const expenses: Transaction[] = [
      { id: 'e1', date: '2023-12-31', amount: -500 },
      { id: 'e2', date: '2024-01-01', amount: -700 },
      { id: 'e3', date: '2024-03-01', amount: -900 },
      { id: 'e4', date: '2024-03-01', amount: -900 },
    ];
    for (const start of ['2023-12', '2024-01', '2024-02', '2024-03']) {
      expectSameReport(income, expenses, start, '2024-03');
    }
  });
});

type Row = Transaction & { [field: string]: unknown };

// Enough of AQL's filter semantics for the age of money queries. Fields
// other than date and amount (account and transfer filters) are taken as
// matching: the test rows are the ones those filters keep.
function matches(row: Row, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and') {
      return (value as Array<Record<string, unknown>>).every(f =>
        matches(row, f),
      );
    }
    if (key === '$or') {
      return (value as Array<Record<string, unknown>>).some(f =>
        matches(row, f),
      );
    }
    if (key !== 'date' && key !== 'amount') {
      return true;
    }
    const field = row[key] as string | number;
    return Object.entries(value as Record<string, string | number>).every(
      ([op, operand]) => {
        switch (op) {
          case '$lt':
            return field < operand;
          case '$lte':
            return field <= operand;
          case '$gt':
            return field > operand;
          case '$gte':
            return field >= operand;
          default:
            throw new Error(`Unexpected operator ${op}`);
        }
      },
    );
  });
}

// Runs the age of money queries against `rows`, which are in the
// transactions table's default order. (Tests run with today pinned to
// 2017-01-01, so the report's end date is never later.)
function serveQueries(rows: Row[]) {
  const results: Array<{ rows: number }> = [];
  vi.mocked(aqlQuery).mockReset();
  vi.mocked(aqlQuery).mockImplementation(async (query: Query) => {
    const state = query.serialize();
    // Must compile to SQL
    generateSQLWithState(state, schema, schemaConfig);
    const found = rows.filter(row =>
      state.filterExpressions.every(f =>
        matches(row, f as Record<string, unknown>),
      ),
    );
    results.push({ rows: found.length });
    const select = state.selectExpressions;
    if (select.length === 1 && typeof select[0] === 'object') {
      const sum = found.reduce((total, row) => total + row.amount, 0);
      return {
        data: [{ amount: found.length > 0 ? sum : null }],
        dependencies: [],
      };
    }
    return {
      data: found.map(({ id, date, amount }) => ({ id, date, amount })),
      dependencies: [],
    };
  });
  return results;
}

async function runReport(start: string, end: string) {
  const results: AgeOfMoneyData[] = [];
  await createAgeOfMoneySpreadsheet({ start, end, granularity: 'daily' })(
    {} as Parameters<ReturnType<typeof createAgeOfMoneySpreadsheet>>[0],
    data => {
      results.push(data);
    },
  );
  expect(results).toHaveLength(1);
  return results[0];
}

describe('createAgeOfMoneySpreadsheet', () => {
  const income: Transaction[] = [
    { id: 'i1', date: '2016-01-05', amount: 1000 },
    { id: 'i2', date: '2016-02-10', amount: 300 },
    { id: 'i3', date: '2016-03-15', amount: 500 },
  ];
  const expenses: Transaction[] = [
    { id: 'e1', date: '2016-01-20', amount: -400 },
    { id: 'e2', date: '2016-02-29', amount: -700 },
    { id: 'e3', date: '2016-03-01', amount: -250 },
    { id: 'e4', date: '2016-03-01', amount: -100 },
    { id: 'e5', date: '2016-03-20', amount: -50 },
  ];
  // Default transactions order: date descending, then id
  const rows = [...income, ...expenses].sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );

  function expected(start: string, end: string) {
    const all = fromAllExpenses(
      rows.filter(t => t.amount > 0),
      rows.filter(t => t.amount < 0),
      start,
      end,
    );
    const [, , daily] = all.graphs;
    return {
      graphData: daily.graphData,
      currentAge: all.currentAge,
      trend: daily.trend,
      insufficientData: all.insufficientData,
    };
  }

  it('reads expenses one by one only from the display start', async () => {
    const results = serveQueries(rows);
    const data = await runReport('2016-03', '2016-03');
    // All 3 inflows and the 3 outflows from March 1, plus one total
    expect(results).toEqual([{ rows: 6 }, { rows: 2 }]);
    expect(data).toEqual(expected('2016-03', '2016-03'));
    expect(data.currentAge).not.toBeNull();
  });

  it('shows the same report for every display start', async () => {
    for (const start of [
      '2015-12',
      '2016-01',
      '2016-02',
      '2016-03',
      '2016-04',
    ]) {
      serveQueries(rows);
      expect(await runReport(start, '2016-04')).toEqual(
        expected(start, '2016-04'),
      );
    }
  });

  it('flags insufficient data from expenses before the display start', async () => {
    const overspent = [
      ...rows,
      { id: 'e0', date: '2016-01-06', amount: -5000 },
    ].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    serveQueries(overspent);
    const data = await runReport('2016-03', '2016-03');
    expect(data.insufficientData).toBe(true);
    expect(data.currentAge).toBeNull();
  });
});
