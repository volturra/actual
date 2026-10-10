import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type {
  AgeOfMoneyGranularity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import * as d from 'date-fns';

import { runAll } from '#components/reports/util';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { makeFiltersFromConditions } from '#reports';

export type AgeOfMoneyData = {
  graphData: Array<{
    date: string; // Month label (e.g., "Jan 2024")
    ageOfMoney: number; // Days
  }>;
  currentAge: number | null; // Current AoM in days, null if no data
  trend: 'up' | 'down' | 'stable';
  insufficientData: boolean; // True if not enough income to cover expenses
};

type IncomeBucket = {
  date: string;
  remainingAmount: number;
};

export type Transaction = {
  id: string;
  date: string;
  amount: number;
};

export type TransactionWithCategory = Transaction & {
  categoryIsIncome: boolean | null;
};

/**
 * Classify transactions into income and expenses based on amount sign.
 * Income = positive amounts (including refunds - money entering your pool)
 * Expenses = negative amounts
 *
 * Note: We use amount-based classification for Age of Money because
 * refunds (positive amounts without income category) should still add
 * to the money pool. The categoryIsIncome field is preserved for
 * potential future use but not used for this classification.
 */
export function classifyTransactions(transactions: TransactionWithCategory[]): {
  income: Transaction[];
  expenses: Transaction[];
} {
  const income: Transaction[] = [];
  const expenses: Transaction[] = [];

  for (const t of transactions) {
    if (t.amount > 0) {
      income.push({ id: t.id, date: t.date, amount: t.amount });
    } else {
      expenses.push({ id: t.id, date: t.date, amount: t.amount });
    }
  }

  return { income, expenses };
}

/**
 * Calculate the age of money for a given set of expense transactions
 * using the FIFO (First In, First Out) method.
 *
 * Income becomes "buckets" sorted by date. When money is spent,
 * it's deducted from the oldest bucket first. The age is the
 * difference between the expense date and the bucket date.
 */
export function calculateAgeOfMoney(
  incomeTransactions: Transaction[],
  expenseTransactions: Transaction[],
): { ages: Array<{ date: string; age: number }>; insufficientData: boolean } {
  // Sort income by date ascending (oldest first)
  const sortedIncome = [...incomeTransactions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // Create income buckets
  const buckets: IncomeBucket[] = sortedIncome.map(t => ({
    date: t.date,
    remainingAmount: t.amount, // Income is positive
  }));

  // Sort expenses by date ascending
  const sortedExpenses = [...expenseTransactions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const ages: Array<{ date: string; age: number }> = [];
  let currentBucketIdx = 0;
  let insufficientData = false;
  // Day numbers per distinct date string, so each date is parsed once.
  const dayNumbers = new Map<string, number | null>();

  for (const expense of sortedExpenses) {
    // Expense amounts are negative, so we work with absolute value
    let remainingExpense = Math.abs(expense.amount);
    let lastBucketDate: string | null = null;

    // Deduct from oldest buckets with remaining balance
    while (remainingExpense > 0 && currentBucketIdx < buckets.length) {
      const bucket = buckets[currentBucketIdx];

      if (bucket.remainingAmount > 0) {
        const deduction = Math.min(bucket.remainingAmount, remainingExpense);
        bucket.remainingAmount -= deduction;
        remainingExpense -= deduction;
        lastBucketDate = bucket.date;
      }

      // Move to next bucket if current is exhausted
      if (bucket.remainingAmount <= 0) {
        currentBucketIdx++;
      }
    }

    // If we couldn't fully cover the expense, we have insufficient data
    if (remainingExpense > 0) {
      insufficientData = true;
      // Continue processing but note the issue
    }

    // Calculate age if we had a bucket to draw from
    if (lastBucketDate) {
      const ageInDays = differenceInDays(
        expense.date,
        lastBucketDate,
        dayNumbers,
      );
      ages.push({ date: expense.date, age: Math.max(0, ageInDays) });
    }
  }

  return { ages, insufficientData };
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert a `YYYY-MM-DD` date to a whole number of days since the epoch,
 * caching the result per date string. The difference of two day numbers
 * equals date-fns `differenceInDays` of the same dates parsed with
 * `parseISO`, but costs far less per row. Dates that match the pattern but
 * do not exist (e.g. 2024-02-30) give NaN, as date-fns does. Other formats
 * give null so the caller can fall back to date-fns.
 */
function toDayNumber(
  date: string,
  cache: Map<string, number | null>,
): number | null {
  const cached = cache.get(date);
  if (cached !== undefined) {
    return cached;
  }

  let dayNumber: number | null = null;
  const match = DATE_PATTERN.exec(date);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const utc = new Date(0);
    utc.setUTCFullYear(year, month, day);
    const isValid =
      utc.getUTCFullYear() === year &&
      utc.getUTCMonth() === month &&
      utc.getUTCDate() === day;
    dayNumber = isValid ? Math.round(utc.getTime() / MS_PER_DAY) : NaN;
  }

  cache.set(date, dayNumber);
  return dayNumber;
}

/**
 * Whole days from `fromDate` to `toDate`, matching
 * `d.differenceInDays(d.parseISO(toDate), d.parseISO(fromDate))`.
 */
function differenceInDays(
  toDate: string,
  fromDate: string,
  cache: Map<string, number | null>,
): number {
  const to = toDayNumber(toDate, cache);
  const from = toDayNumber(fromDate, cache);
  if (to === null || from === null) {
    return d.differenceInDays(d.parseISO(toDate), d.parseISO(fromDate));
  }
  return to - from;
}

/**
 * Calculate the average of the last N ages
 */
export function calculateAverageAge(
  ages: Array<{ date: string; age: number }>,
  count: number = 10,
): number | null {
  if (ages.length === 0) return null;

  const lastN = ages.slice(-count);
  const sum = lastN.reduce((acc, item) => acc + item.age, 0);
  return Math.round(sum / lastN.length);
}

/**
 * Get the period key for a given date based on granularity
 */
export function getPeriodKey(
  date: string,
  granularity: AgeOfMoneyGranularity,
): string {
  switch (granularity) {
    case 'daily':
      return date; // YYYY-MM-DD
    case 'weekly': {
      // Use start of week (Monday) as key
      const weekStart = d.startOfWeek(d.parseISO(date), { weekStartsOn: 1 });
      return d.format(weekStart, 'yyyy-MM-dd');
    }
    case 'monthly':
    default:
      return monthUtils.getMonth(date); // YYYY-MM
  }
}

/**
 * Format a period key for display based on granularity
 */
export function formatPeriodLabel(
  periodKey: string,
  granularity: AgeOfMoneyGranularity,
): string {
  switch (granularity) {
    case 'daily':
      return d.format(d.parseISO(periodKey), 'MMM d, yyyy');
    case 'weekly':
      return d.format(d.parseISO(periodKey), 'MMM d, yyyy');
    case 'monthly':
    default:
      return d.format(d.parseISO(periodKey + '-01'), 'MMM yyyy');
  }
}

/**
 * Generate all periods between start and end based on granularity
 */
export function generatePeriods(
  startDate: string,
  endDate: string,
  granularity: AgeOfMoneyGranularity,
): string[] {
  const periods: string[] = [];
  let current = d.parseISO(startDate);
  const end = d.parseISO(endDate);

  switch (granularity) {
    case 'daily':
      while (current <= end) {
        periods.push(d.format(current, 'yyyy-MM-dd'));
        current = d.addDays(current, 1);
      }
      break;
    case 'weekly':
      // Start from the beginning of the week containing startDate
      current = d.startOfWeek(current, { weekStartsOn: 1 });
      while (current <= end) {
        periods.push(d.format(current, 'yyyy-MM-dd'));
        current = d.addWeeks(current, 1);
      }
      break;
    case 'monthly':
    default: {
      const months = monthUtils.rangeInclusive(
        monthUtils.getMonth(startDate),
        monthUtils.getMonth(endDate),
      );
      return months;
    }
  }

  return periods;
}

/**
 * Group ages by period and calculate rolling average for each period
 */
export function calculateGraphData(
  ages: Array<{ date: string; age: number }>,
  startMonth: string,
  endMonth: string,
  granularity: AgeOfMoneyGranularity = 'monthly',
): Array<{ date: string; ageOfMoney: number }> {
  const startDate = monthUtils.firstDayOfMonth(startMonth);
  let endDate = monthUtils.lastDayOfMonth(endMonth);

  // For daily/weekly granularities, don't generate periods past today —
  // future days/weeks would otherwise carry forward the last rolling
  // average and show as a flat horizontal line for the rest of the month.
  // Monthly granularity intentionally keeps the current month visible.
  if (granularity === 'daily' || granularity === 'weekly') {
    const today = monthUtils.currentDay();
    if (monthUtils.isAfter(endDate, today)) {
      endDate = today;
    }
  }

  const periods = generatePeriods(startDate, endDate, granularity);
  const result: Array<{ date: string; ageOfMoney: number }> = [];

  // Group ages by period. Consecutive ages usually share a date, so the
  // period key is only recomputed when the date changes.
  const agesByPeriod: Record<string, number[]> = {};
  let lastDate: string | null = null;
  let periodAges: number[] = [];
  for (const { date, age } of ages) {
    if (date !== lastDate) {
      lastDate = date;
      const periodKey = getPeriodKey(date, granularity);
      if (!agesByPeriod[periodKey]) {
        agesByPeriod[periodKey] = [];
      }
      periodAges = agesByPeriod[periodKey];
    }
    periodAges.push(age);
  }

  // Calculate cumulative rolling average (last 10 expenses up to each period)
  const allAgesUpToPeriod: number[] = [];

  for (const period of periods) {
    // Add ages from this period
    const agesInPeriod = agesByPeriod[period];
    if (agesInPeriod) {
      for (const age of agesInPeriod) {
        allAgesUpToPeriod.push(age);
      }
    }

    // Calculate average of last 10 ages
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

/**
 * Determine the trend based on the last few data points
 */
export function calculateTrend(
  graphData: Array<{ date: string; ageOfMoney: number }>,
): 'up' | 'down' | 'stable' {
  if (graphData.length < 2) return 'stable';

  const last = graphData[graphData.length - 1].ageOfMoney;
  const secondLast = graphData[graphData.length - 2].ageOfMoney;

  const diff = last - secondLast;
  const threshold = 2; // Days threshold for "stable"

  if (diff > threshold) return 'up';
  if (diff < -threshold) return 'down';
  return 'stable';
}

/**
 * Stand in for the expenses dated before `displayStart` with one expense of
 * their total, dated the day before `displayStart`.
 *
 * `calculateAgeOfMoney` gives the same ages from `displayStart` onward and
 * the same `insufficientData` either way:
 * - Expenses consume the income buckets oldest first whatever their own
 *   dates, so after the earlier expenses the buckets only depend on how much
 *   they spent in total.
 * - All earlier expenses sort before the later ones, and so does the stand-in.
 * - `insufficientData` is set once the expenses so far exceed all income,
 *   which only depends on the running total.
 * - Ages dated before `displayStart` (the stand-in's included) are dropped
 *   before anything is shown.
 */
export function withEarlierExpensesTotal(
  expenses: Transaction[],
  earlierExpensesTotal: number,
  displayStart: string,
): Transaction[] {
  if (earlierExpensesTotal >= 0) {
    return expenses;
  }
  return [
    {
      id: '',
      date: monthUtils.subDays(displayStart, 1),
      amount: earlierExpensesTotal,
    },
    ...expenses,
  ];
}

export type AgeOfMoneyParams = {
  start: string;
  end: string;
  conditions?: RuleConditionEntity[];
  conditionsOp?: 'and' | 'or';
  granularity?: AgeOfMoneyGranularity;
};

type AccountCondition = Extract<RuleConditionEntity, { field: 'account' }>;

/**
 * Invert an account filter op so we can match counterpart accounts that
 * fall *outside* the filtered set.
 */
function invertAccountOp(
  op: AccountCondition['op'],
): AccountCondition['op'] | null {
  switch (op) {
    case 'is':
      return 'isNot';
    case 'isNot':
      return 'is';
    case 'oneOf':
      return 'notOneOf';
    case 'notOneOf':
      return 'oneOf';
    case 'onBudget':
      return 'offBudget';
    case 'offBudget':
      return 'onBudget';
    case 'contains':
      return 'doesNotContain';
    case 'doesNotContain':
      return 'contains';
    // `matches` has no clean inverse in AQL — skip transfer special-casing
    case 'matches':
      return null;
    default:
      return null;
  }
}

/**
 * Build an AQL clause that matches `payee.transfer_acct` against a single
 * (already inverted) account condition.
 */
function accountConditionToTransferAcctAql(
  op: AccountCondition['op'],
  value: AccountCondition['value'],
): Record<string, unknown> | null {
  const field = 'payee.transfer_acct';

  switch (op) {
    case 'is':
      return { [field]: { $eq: value } };
    case 'isNot':
      return { [field]: { $ne: value } };
    case 'oneOf': {
      if (!Array.isArray(value)) return null;
      const values = value;
      if (values.length === 0) return { id: null };
      return { $or: values.map(v => ({ [field]: { $eq: v } })) };
    }
    case 'notOneOf': {
      if (!Array.isArray(value)) return null;
      const values = value;
      // Empty notOneOf is a tautology (everything is outside the empty set).
      if (values.length === 0) return { [field]: { $ne: null } };
      return { $and: values.map(v => ({ [field]: { $ne: v } })) };
    }
    case 'onBudget':
      return { 'payee.transfer_acct.offbudget': false };
    case 'offBudget':
      return { 'payee.transfer_acct.offbudget': true };
    case 'contains': {
      if (typeof value !== 'string') return null;
      return {
        'payee.transfer_acct.name': {
          $transform: '$lower',
          $like: `%${value}%`,
        },
      };
    }
    case 'doesNotContain': {
      if (typeof value !== 'string') return null;
      return {
        'payee.transfer_acct.name': {
          $transform: '$lower',
          $notlike: `%${value}%`,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Build the transfer-inclusion filter for Age of Money queries.
 *
 * Default (no account filters): exclude on-budget↔on-budget transfers —
 * they are just moving money within the budget pool.
 *
 * With account filters: also include on-budget transfers whose counterpart
 * account is filtered out. From the filtered subset's perspective those
 * transfers are real money leaving (or entering) the pool — e.g. filtering
 * to a chequing account should treat a CC payment as an expenditure so the
 * report reflects "age of cash" rather than budget-wide AoM.
 */
export function buildTransferInclusionFilter(
  conditions: RuleConditionEntity[],
  conditionsOp: 'and' | 'or' = 'and',
): Record<string, unknown> {
  const base: Array<Record<string, unknown>> = [
    { 'payee.transfer_acct': null },
    { 'payee.transfer_acct.offbudget': true },
  ];

  const accountConditions = conditions.filter(
    (c): c is AccountCondition => !c.customName && c.field === 'account',
  );

  if (accountConditions.length === 0) {
    return { $or: base };
  }

  // Destination/source is outside the filtered set when it fails the
  // account conditions. De Morgan: AND → OR of negations, OR → AND of
  // negations.
  const negations: Array<Record<string, unknown>> = [];
  for (const cond of accountConditions) {
    const invertedOp = invertAccountOp(cond.op);
    if (invertedOp == null) {
      // Unsupported op — fall back to default transfer exclusion
      return { $or: base };
    }
    const clause = accountConditionToTransferAcctAql(invertedOp, cond.value);
    if (clause == null) {
      return { $or: base };
    }
    negations.push(clause);
  }

  const filteredOutCounterpart =
    conditionsOp === 'and'
      ? negations.length === 1
        ? negations[0]
        : { $or: negations }
      : negations.length === 1
        ? negations[0]
        : { $and: negations };

  return {
    $or: [
      ...base,
      {
        $and: [
          { 'payee.transfer_acct.offbudget': false },
          filteredOutCounterpart,
        ],
      },
    ],
  };
}

export function createAgeOfMoneySpreadsheet({
  start,
  end,
  conditions = [],
  conditionsOp = 'and',
  granularity = 'monthly',
}: AgeOfMoneyParams) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: AgeOfMoneyData) => void,
  ) => {
    const endDate = monthUtils.lastDayOfMonth(end);
    const today = monthUtils.currentDay();
    const fixedEnd = endDate > today ? today : endDate;

    const activeConditions = conditions.filter(cond => !cond.customName);
    const { filters } = await makeFiltersFromConditions({
      conditions: activeConditions,
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';
    const transferFilter = buildTransferInclusionFilter(
      activeConditions,
      conditionsOp,
    );

    // FIFO needs the complete income history up to the end date, as
    // buckets. Expenses are only listed one by one from the start of the
    // display range: ages before it are never shown, and the expenses
    // before it only use up the oldest buckets, which depends on nothing but
    // their total (see `withEarlierExpensesTotal`).
    // Includes: regular income and expenses + transfers from/to off-budget
    //   accounts + (when account-filtered) transfers from/to filtered-out
    //   on-budget accounts
    // Excludes: on-budget transfers within the filtered account set
    const displayStart = monthUtils.firstDayOfMonth(start);
    function makeBaseQuery() {
      return q('transactions')
        .filter({
          [conditionsOpKey]: filters,
        })
        .filter({
          date: { $lte: fixedEnd },
          'account.offbudget': false,
          ...transferFilter,
        });
    }

    // All income, and the expenses from the display start onward
    const rowsQuery = makeBaseQuery()
      .filter({
        $or: [
          { amount: { $gt: 0 } },
          { $and: [{ amount: { $lt: 0 } }, { date: { $gte: displayStart } }] },
        ],
      })
      .select(['id', 'date', 'amount']);
    // The total of the expenses before the display start
    const earlierExpensesQuery = makeBaseQuery()
      .filter({ amount: { $lt: 0 }, date: { $lt: displayStart } })
      .select([{ amount: { $sum: '$amount' } }]);

    return runAll([rowsQuery, earlierExpensesQuery], data => {
      const [rows, earlierExpenseRows] = data as [
        Transaction[],
        Array<{ amount: number | null }>,
      ];
      const incomeData = rows.filter(t => t.amount > 0);
      const expenseData = withEarlierExpensesTotal(
        rows.filter(t => t.amount < 0),
        earlierExpenseRows[0]?.amount ?? 0,
        displayStart,
      );

      // Calculate ages using FIFO method on the whole history
      const { ages, insufficientData } = calculateAgeOfMoney(
        incomeData,
        expenseData,
      );

      // Filter ages to only those within the display range
      const filteredAges = ages.filter(({ date }) => date >= displayStart);

      // Generate graph data from filtered ages with specified granularity
      const graphData = calculateGraphData(
        filteredAges,
        start,
        end,
        granularity,
      );

      // Calculate current age from ages within the display range
      const currentAge = calculateAverageAge(filteredAges, 10);

      // Determine trend
      const trend = calculateTrend(graphData);

      setData({
        graphData,
        currentAge,
        trend,
        insufficientData,
      });
    });
  };
}
