import type { AgeOfMoneyGranularity } from '@actual-app/core/types/models';
import { afterEach, describe, expect, it } from 'vitest';

import {
  generateAgeOfMoneyInput,
  legacyCalculateAgeOfMoney,
  legacyCalculateGraphData,
} from './age-of-money-legacy-fixtures';
import {
  calculateAgeOfMoney,
  calculateAverageAge,
  calculateGraphData,
  calculateTrend,
} from './age-of-money-spreadsheet';
import type { Transaction } from './age-of-money-spreadsheet';

const GRANULARITIES: AgeOfMoneyGranularity[] = ['monthly', 'weekly', 'daily'];
const TIME_ZONES = [
  'UTC',
  'America/New_York',
  // DST starts at midnight, so some local midnights do not exist
  // (Sao Paulo until 2018, Santiago every September)
  'America/Sao_Paulo',
  'America/Santiago',
  'Pacific/Auckland',
];

const originalTimeZone = process.env.TZ;

function report(
  calculate: typeof calculateAgeOfMoney,
  graph: typeof calculateGraphData,
  income: Transaction[],
  expenses: Transaction[],
  start: string,
  end: string,
  granularity: AgeOfMoneyGranularity,
) {
  const { ages, insufficientData } = calculate(income, expenses);
  const displayStart = `${start}-01`;
  const filteredAges = ages.filter(({ date }) => date >= displayStart);
  const graphData = graph(filteredAges, start, end, granularity);
  return {
    ages,
    insufficientData,
    graphData,
    currentAge: calculateAverageAge(filteredAges, 10),
    trend: calculateTrend(graphData),
  };
}

function expectSameAsLegacy(
  income: Transaction[],
  expenses: Transaction[],
  start: string,
  end: string,
) {
  for (const granularity of GRANULARITIES) {
    const expected = report(
      legacyCalculateAgeOfMoney,
      legacyCalculateGraphData,
      income,
      expenses,
      start,
      end,
      granularity,
    );
    const actual = report(
      calculateAgeOfMoney,
      calculateGraphData,
      income,
      expenses,
      start,
      end,
      granularity,
    );
    expect(actual).toEqual(expected);
  }
}

describe('Age of Money matches the date-fns implementation', () => {
  afterEach(() => {
    process.env.TZ = originalTimeZone;
  });

  it.each(TIME_ZONES)('on generated budgets in %s', timeZone => {
    process.env.TZ = timeZone;
    const cases = [
      // Long history across several year boundaries and a leap day
      { seed: 1, startDate: '2017-09-15', endDate: '2024-03-10', count: 8000 },
      // Short and dense, many transactions per date
      { seed: 2, startDate: '2023-12-20', endDate: '2024-01-10', count: 2000 },
      // Sparse, mostly insufficient income
      { seed: 3, startDate: '2020-02-01', endDate: '2020-03-31', count: 40 },
    ];
    for (const c of cases) {
      const { income, expenses } = generateAgeOfMoneyInput(c);
      expect(expenses.length).toBeGreaterThan(0);
      expectSameAsLegacy(income, expenses, c.startDate.slice(0, 7), '2024-03');
      expectSameAsLegacy(income, expenses, '2023-12', '2024-01');
    }
  });

  it('when outflows come before any inflow', () => {
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
    expectSameAsLegacy(income, expenses, '2023-12', '2024-03');
  });

  it('with no transactions', () => {
    expectSameAsLegacy([], [], '2024-01', '2024-03');
    expectSameAsLegacy(
      [],
      [{ id: 'e1', date: '2024-01-05', amount: -10 }],
      '2024-01',
      '2024-03',
    );
  });

  it('with dates that are not plain calendar days', () => {
    const income: Transaction[] = [
      { id: 'i1', date: '2024-01-01', amount: 100 },
      { id: 'i2', date: '2024-02-30', amount: 100 },
      { id: 'i3', date: '20240110', amount: 100 },
      { id: 'i4', date: '2024-01-12T18:00:00', amount: 100 },
    ];
    const expenses: Transaction[] = [
      { id: 'e1', date: '2024-01-05', amount: -100 },
      { id: 'e2', date: '2024-03-01', amount: -100 },
      { id: 'e3', date: '2024-03-02', amount: -100 },
      { id: 'e4', date: '2024-03-03', amount: -100 },
    ];
    const expected = legacyCalculateAgeOfMoney(income, expenses);
    expect(calculateAgeOfMoney(income, expenses)).toEqual(expected);
  });
});
