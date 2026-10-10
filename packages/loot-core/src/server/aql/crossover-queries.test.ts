import * as db from '#server/db';
import { q } from '#shared/query';
import type { Query } from '#shared/query';

import { aqlQuery } from '.';

// The queries below are copies of the query shapes the Crossover report
// builds (desktop-client crossover-spreadsheet.ts), run against the real
// engine. The "previous" shapes are the ones the report used before it
// switched to `$oneof` and a single grouped balance query; each pair must
// return the same numbers. Keep them in sync when the report's queries change.

beforeEach(global.emptyDatabase());

type MonthlyRow = { date: string; amount: number };
type AccountMonthlyRow = MonthlyRow & { account: string };

async function run<T>(query: Query) {
  const { data } = await aqlQuery(query);
  return data as T;
}

function sortByDate(rows: MonthlyRow[]) {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date));
}

async function insertData() {
  await db.insertAccount({ id: 'checking', name: 'Checking' });
  await db.insertAccount({ id: 'savings', name: 'Savings', offbudget: 1 });
  await db.insertAccount({ id: 'closed', name: 'Closed', closed: 1 });
  await db.insertAccount({ id: 'other', name: 'Other' });

  const groupId = await db.insertCategoryGroup({ name: 'Expenses' });
  const incomeGroupId = await db.insertCategoryGroup({
    name: 'Income',
    is_income: 1,
  });
  await db.insertCategory({ id: 'food', name: 'Food', cat_group: groupId });
  await db.insertCategory({
    id: 'rent',
    name: 'Rent',
    cat_group: groupId,
    hidden: 1,
  });
  await db.insertCategory({ id: 'fun', name: 'Fun', cat_group: groupId });
  // Merged into food: its transactions now count as food.
  await db.insertCategory({ id: 'snacks', name: 'Snacks', cat_group: groupId });
  // Deleted without a transfer target.
  await db.insertCategory({ id: 'gone', name: 'Gone', cat_group: groupId });
  await db.insertCategory({
    id: 'salary',
    name: 'Salary',
    cat_group: incomeGroupId,
    is_income: 1,
  });

  const transactions = [
    // Before the report range, only part of the starting balances.
    { id: 'a1', account: 'checking', date: '2016-11-30', amount: 50_000 },
    {
      id: 'a2',
      account: 'checking',
      category: 'food',
      date: '2016-11-30',
      amount: -700,
    },
    // Start month (2016-12), across the year boundary into 2017.
    {
      id: 'b1',
      account: 'checking',
      category: 'food',
      date: '2016-12-01',
      amount: -1_000,
    },
    {
      id: 'b2',
      account: 'checking',
      category: 'rent',
      date: '2016-12-31',
      amount: -20_000,
    },
    {
      id: 'b3',
      account: 'savings',
      category: 'salary',
      date: '2016-12-31',
      amount: 9_000,
    },
    {
      id: 'b4',
      account: 'checking',
      category: 'food',
      date: '2017-01-01',
      amount: -300,
    },
    {
      id: 'b5',
      account: 'closed',
      category: 'fun',
      date: '2017-01-15',
      amount: -400,
    },
    {
      id: 'b6',
      account: 'checking',
      category: 'snacks',
      date: '2017-01-20',
      amount: -60,
    },
    {
      id: 'b7',
      account: 'checking',
      category: 'gone',
      date: '2017-01-21',
      amount: -80,
    },
    {
      id: 'b8',
      account: 'other',
      category: 'food',
      date: '2017-02-10',
      amount: -5,
    },
    // A split: the parent never counts, the children do.
    {
      id: 's1',
      account: 'checking',
      date: '2017-02-01',
      amount: -900,
      is_parent: true,
    },
    {
      id: 's1a',
      account: 'checking',
      category: 'food',
      date: '2017-02-01',
      amount: -600,
      is_child: true,
      parent_id: 's1',
    },
    {
      id: 's1b',
      account: 'checking',
      category: 'fun',
      date: '2017-02-01',
      amount: -300,
      is_child: true,
      parent_id: 's1',
    },
    // A transfer has no category.
    {
      id: 't1',
      account: 'checking',
      date: '2017-02-28',
      amount: -2_000,
      transfer_id: 't2',
    },
    {
      id: 't2',
      account: 'savings',
      date: '2017-02-28',
      amount: 2_000,
      transfer_id: 't1',
    },
    // Deleted transactions and a child of a deleted parent.
    {
      id: 'd1',
      account: 'checking',
      category: 'food',
      date: '2017-01-05',
      amount: -77_000,
      tombstone: 1,
    },
    {
      id: 's2',
      account: 'checking',
      date: '2017-01-06',
      amount: -100,
      is_parent: true,
      tombstone: 1,
    },
    {
      id: 's2a',
      account: 'checking',
      category: 'food',
      date: '2017-01-06',
      amount: -100,
      is_child: true,
      parent_id: 's2',
    },
    // After the report range.
    {
      id: 'z1',
      account: 'checking',
      category: 'food',
      date: '2017-03-01',
      amount: -9_999,
    },
    { id: 'z2', account: 'savings', date: '2017-03-01', amount: 9_999 },
  ];
  for (const trans of transactions) {
    await db.insertTransaction(trans);
  }

  await db.deleteCategory({ id: 'snacks' }, 'food');
  await db.deleteCategory({ id: 'gone' });
}

const range = { start: '2016-12', end: '2017-02' };

function previousExpenses(categoryIds: string[]) {
  return q('transactions')
    .filter({
      $and: [
        { $or: categoryIds.map(id => ({ category: id })) },
        { date: { $gte: '2016-12-01' } },
        { date: { $lte: '2017-02-28' } },
      ],
    })
    .groupBy({ $month: '$date' })
    .select([{ date: { $month: '$date' } }, { amount: { $sum: '$amount' } }]);
}

function expenses(categoryIds: string[]) {
  return q('transactions')
    .filter({
      $and: [
        { category: { $oneof: categoryIds } },
        { date: { $gte: '2016-12-01' } },
        { date: { $lte: '2017-02-28' } },
      ],
    })
    .groupBy({ $month: '$date' })
    .select([{ date: { $month: '$date' } }, { amount: { $sum: '$amount' } }]);
}

async function previousBalances(accountIds: string[]) {
  return Promise.all(
    accountIds.map(async accountId => {
      const starting = await run<number | null>(
        q('transactions')
          .filter({ account: accountId })
          .filter({ date: { $lte: '2016-12-31' } })
          .calculate({ $sum: '$amount' }),
      );
      const balances = await run<MonthlyRow[]>(
        q('transactions')
          .filter({ account: accountId, date: { $gte: '2016-12-01' } })
          .filter({ $and: [{ date: { $lte: '2017-02-28' } }] })
          .groupBy({ $month: '$date' })
          .select([
            { date: { $month: '$date' } },
            { amount: { $sum: '$amount' } },
          ]),
      );
      return {
        accountId,
        starting: typeof starting === 'number' ? starting : 0,
        balances: sortByDate(balances.filter(b => b.date !== range.start)),
      };
    }),
  );
}

async function balances(accountIds: string[]) {
  const rows = await run<AccountMonthlyRow[]>(
    q('transactions')
      .filter({
        account: { $oneof: accountIds },
        date: { $lte: '2017-02-28' },
      })
      .groupBy(['account', { $month: '$date' }])
      .select([
        'account',
        { date: { $month: '$date' } },
        { amount: { $sum: '$amount' } },
      ]),
  );
  // Same split as the report: months up to the start month make the
  // starting balance, later months are the monthly changes.
  return accountIds.map(accountId => {
    const own = rows.filter(row => row.account === accountId);
    return {
      accountId,
      starting: own
        .filter(row => row.date <= range.start)
        .reduce((sum, row) => sum + row.amount, 0),
      balances: sortByDate(
        own
          .filter(row => row.date > range.start && row.date <= range.end)
          .map(({ date, amount }) => ({ date, amount })),
      ),
    };
  });
}

describe('crossover expense query', () => {
  it.each([
    {
      name: 'all expense categories',
      ids: ['food', 'rent', 'fun', 'snacks', 'gone'],
    },
    { name: 'a visible subset', ids: ['food', 'fun'] },
    { name: 'a merged category only', ids: ['snacks'] },
    { name: 'a deleted category only', ids: ['gone'] },
    { name: 'duplicate ids', ids: ['food', 'food', 'rent'] },
    { name: 'income included', ids: ['food', 'salary'] },
  ])('matches the previous $or filter for $name', async ({ ids }) => {
    await insertData();

    const previous = await run<MonthlyRow[]>(previousExpenses(ids));
    const current = await run<MonthlyRow[]>(expenses(ids));

    expect(sortByDate(current)).toEqual(sortByDate(previous));
  });

  it('sums the selected categories per month', async () => {
    await insertData();

    const rows = await run<MonthlyRow[]>(
      expenses(['food', 'rent', 'fun', 'snacks', 'gone']),
    );

    expect(sortByDate(rows)).toEqual([
      { date: '2016-12', amount: -21_000 },
      // food -300, fun on the closed account -400, merged snacks -60; the
      // deleted category, deleted transactions and dead split child are out.
      { date: '2017-01', amount: -760 },
      // split children -600 and -300, other account -5; not the transfer.
      { date: '2017-02', amount: -905 },
    ]);
  });

  it('returns no rows when nothing matches', async () => {
    await insertData();

    const rows = await run<MonthlyRow[]>(expenses(['missing']));

    expect(rows).toEqual([]);
  });
});

describe('crossover balance query', () => {
  it.each([
    { name: 'all accounts', ids: ['checking', 'savings', 'closed', 'other'] },
    { name: 'off-budget and closed accounts', ids: ['savings', 'closed'] },
    { name: 'an account with no transactions', ids: ['checking', 'missing'] },
    { name: 'duplicate ids', ids: ['checking', 'checking'] },
  ])('matches the previous per-account queries for $name', async ({ ids }) => {
    await insertData();

    expect(await balances(ids)).toEqual(await previousBalances(ids));
  });

  it('splits the starting balance from the monthly changes', async () => {
    await insertData();

    expect(await balances(['checking', 'savings'])).toEqual([
      {
        accountId: 'checking',
        // 50,000 - 700 - 1,000 - 20,000
        starting: 28_300,
        balances: [
          // -300 - 60 - 80; deleted transactions are out.
          { date: '2017-01', amount: -440 },
          // split children and the transfer out; the parent does not count.
          { date: '2017-02', amount: -2_900 },
        ],
      },
      {
        accountId: 'savings',
        starting: 9_000,
        balances: [{ date: '2017-02', amount: 2_000 }],
      },
    ]);
  });
});
