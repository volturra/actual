// Verbatim copy of the age of money math before it moved to integer day
// numbers. The differential test compares the current implementation
// against it on generated data.
import * as monthUtils from '@actual-app/core/shared/months';
import type { AgeOfMoneyGranularity } from '@actual-app/core/types/models';
import * as d from 'date-fns';

import { formatPeriodLabel, generatePeriods } from './age-of-money-spreadsheet';
import type { Transaction } from './age-of-money-spreadsheet';

export function legacyCalculateAgeOfMoney(
  incomeTransactions: Transaction[],
  expenseTransactions: Transaction[],
): { ages: Array<{ date: string; age: number }>; insufficientData: boolean } {
  const sortedIncome = [...incomeTransactions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const buckets = sortedIncome.map(t => ({
    date: t.date,
    remainingAmount: t.amount,
  }));
  const sortedExpenses = [...expenseTransactions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const ages: Array<{ date: string; age: number }> = [];
  let currentBucketIdx = 0;
  let insufficientData = false;

  for (const expense of sortedExpenses) {
    let remainingExpense = Math.abs(expense.amount);
    let lastBucketDate: string | null = null;

    while (remainingExpense > 0 && currentBucketIdx < buckets.length) {
      const bucket = buckets[currentBucketIdx];
      if (bucket.remainingAmount > 0) {
        const deduction = Math.min(bucket.remainingAmount, remainingExpense);
        bucket.remainingAmount -= deduction;
        remainingExpense -= deduction;
        lastBucketDate = bucket.date;
      }
      if (bucket.remainingAmount <= 0) {
        currentBucketIdx++;
      }
    }

    if (remainingExpense > 0) {
      insufficientData = true;
    }

    if (lastBucketDate) {
      const expenseDate = d.parseISO(expense.date);
      const bucketDate = d.parseISO(lastBucketDate);
      const ageInDays = d.differenceInDays(expenseDate, bucketDate);
      ages.push({ date: expense.date, age: Math.max(0, ageInDays) });
    }
  }

  return { ages, insufficientData };
}

function legacyGetPeriodKey(
  date: string,
  granularity: AgeOfMoneyGranularity,
): string {
  const parsed = d.parseISO(date);
  switch (granularity) {
    case 'daily':
      return date;
    case 'weekly': {
      const weekStart = d.startOfWeek(parsed, { weekStartsOn: 1 });
      return d.format(weekStart, 'yyyy-MM-dd');
    }
    case 'monthly':
    default:
      return monthUtils.getMonth(date);
  }
}

export function legacyCalculateGraphData(
  ages: Array<{ date: string; age: number }>,
  startMonth: string,
  endMonth: string,
  granularity: AgeOfMoneyGranularity = 'monthly',
): Array<{ date: string; ageOfMoney: number }> {
  const startDate = monthUtils.firstDayOfMonth(startMonth);
  let endDate = monthUtils.lastDayOfMonth(endMonth);

  if (granularity === 'daily' || granularity === 'weekly') {
    const today = monthUtils.currentDay();
    if (monthUtils.isAfter(endDate, today)) {
      endDate = today;
    }
  }

  const periods = generatePeriods(startDate, endDate, granularity);
  const result: Array<{ date: string; ageOfMoney: number }> = [];

  const agesByPeriod: Record<string, number[]> = {};
  for (const { date, age } of ages) {
    const periodKey = legacyGetPeriodKey(date, granularity);
    if (!agesByPeriod[periodKey]) {
      agesByPeriod[periodKey] = [];
    }
    agesByPeriod[periodKey].push(age);
  }

  let allAgesUpToPeriod: number[] = [];

  for (const period of periods) {
    if (agesByPeriod[period]) {
      allAgesUpToPeriod = allAgesUpToPeriod.concat(agesByPeriod[period]);
    }
    if (allAgesUpToPeriod.length > 0) {
      const lastN = allAgesUpToPeriod.slice(-10);
      const avg = Math.round(lastN.reduce((a, b) => a + b, 0) / lastN.length);
      result.push({
        date: formatPeriodLabel(period, granularity),
        ageOfMoney: avg,
      });
    }
  }

  return result;
}

type GeneratedTransaction = {
  id: string;
  date: string;
  amount: number;
  offbudget: boolean;
  transferToOffbudget: boolean | null;
};

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a budget's worth of transactions between two dates: paychecks,
 * refunds, small and large outflows, on-budget and off-budget transfers and
 * off-budget account activity. Returns the rows the age of money queries
 * would read (on-budget accounts, transfers only when the counterpart is
 * off-budget), in a shuffled order like an unordered SQL result.
 */
export function generateAgeOfMoneyInput({
  seed,
  startDate,
  endDate,
  count,
}: {
  seed: number;
  startDate: string;
  endDate: string;
  count: number;
}): { income: Transaction[]; expenses: Transaction[] } {
  const random = mulberry32(seed);
  const start = d.parseISO(startDate);
  const days = d.differenceInCalendarDays(d.parseISO(endDate), start) + 1;
  // Favour month and year edges, where date bugs show up
  const edgeDays: number[] = [];
  for (let i = 0; i < days; i++) {
    const day = d.addDays(start, i);
    const dayOfMonth = day.getDate();
    if (dayOfMonth === 1 || d.isLastDayOfMonth(day)) {
      edgeDays.push(i);
    }
  }

  const rows: GeneratedTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const offset =
      random() < 0.15
        ? edgeDays[Math.floor(random() * edgeDays.length)]
        : Math.floor(random() * days);
    const date = d.format(d.addDays(start, offset), 'yyyy-MM-dd');
    const kind = random();
    let amount: number;
    let transferToOffbudget: boolean | null = null;
    if (kind < 0.05) {
      // Paycheck
      amount = 150000 + Math.floor(random() * 300000);
    } else if (kind < 0.1) {
      // Refund or small inflow
      amount = 1 + Math.floor(random() * 5000);
    } else if (kind < 0.14) {
      // Transfer to or from another account
      transferToOffbudget = random() < 0.5;
      amount = (random() < 0.5 ? -1 : 1) * Math.floor(random() * 200000);
    } else if (kind < 0.16) {
      // Large outflow, e.g. rent
      amount = -(100000 + Math.floor(random() * 200000));
    } else {
      amount = -(1 + Math.floor(random() * 15000));
    }
    rows.push({
      id: `t${i}`,
      date,
      amount,
      offbudget: random() < 0.1,
      transferToOffbudget,
    });
  }

  const visible = rows.filter(
    t =>
      !t.offbudget &&
      (t.transferToOffbudget === null || t.transferToOffbudget) &&
      t.amount !== 0,
  );
  const toTransaction = ({ id, date, amount }: GeneratedTransaction) => ({
    id,
    date,
    amount,
  });
  return {
    income: visible.filter(t => t.amount > 0).map(toTransaction),
    expenses: visible.filter(t => t.amount < 0).map(toTransaction),
  };
}
