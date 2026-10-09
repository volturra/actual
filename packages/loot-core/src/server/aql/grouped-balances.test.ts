import * as db from '#server/db';
import { q } from '#shared/query';
import type { Query } from '#shared/query';

import * as aql from './exec';
import { schema, schemaConfig } from './schema';

// The queries below are copies of the grouped query shapes the Net Worth
// report builds (desktop-client net-worth-spreadsheet.ts), run against the
// real engine. They are not imported from it, so keep them in sync when the
// report's queries change.

beforeEach(global.emptyDatabase());

async function run(query: Query) {
  const { data } = await aql.compileAndRunAqlQuery(
    schema,
    schemaConfig,
    query.serialize(),
    {},
  );
  return data as Array<Record<string, unknown>>;
}

function sortRows(rows: Array<Record<string, unknown>>) {
  return [...rows].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

async function insertData() {
  await db.insertAccount({ id: 'checking', name: 'Checking' });
  await db.insertAccount({ id: 'savings', name: 'Savings' });
  await db.insertAccount({ id: 'other', name: 'Other' });

  const transactions = [
    { account: 'checking', date: '2016-05-10', amount: 10_000 },
    { account: 'checking', date: '2016-06-30', amount: -2_000 },
    { account: 'checking', date: '2016-07-01', amount: 1_000 },
    { account: 'checking', date: '2016-07-30', amount: 300 },
    { account: 'checking', date: '2016-07-30', amount: 200 },
    { account: 'checking', date: '2017-01-15', amount: -300 },
    { account: 'savings', date: '2016-04-01', amount: 4_000 },
    { account: 'savings', date: '2016-07-31', amount: 250 },
    // Not selected.
    { account: 'other', date: '2016-05-01', amount: 99_000 },
    { account: 'other', date: '2016-07-05', amount: 99_000 },
  ];
  for (const trans of transactions) {
    await db.insertTransaction(trans);
  }
}

function startingBalances(conditionsOpKey: '$and' | '$or', startDate: string) {
  return q('transactions')
    .filter({ [conditionsOpKey]: [] })
    .filter({
      account: { $oneof: ['checking', 'savings'] },
      date: { $lt: startDate },
    })
    .groupBy('account')
    .select(['account', { amount: { $sum: '$amount' } }]);
}

function intervalSums(
  dateGroup: string | { $month: string } | { $year: string },
  startDate: string,
  endDate: string,
) {
  return q('transactions')
    .filter({ $and: [] })
    .filter({
      account: { $oneof: ['checking', 'savings'] },
      $and: [{ date: { $gte: startDate } }, { date: { $lte: endDate } }],
    })
    .groupBy(['account', dateGroup])
    .select(['account', { date: dateGroup }, { amount: { $sum: '$amount' } }]);
}

describe('net worth grouped queries', () => {
  it.each(['$and', '$or'] as const)(
    'sums the starting balance per account with an empty %s filter',
    async conditionsOpKey => {
      await insertData();

      const rows = await run(startingBalances(conditionsOpKey, '2016-07-01'));

      expect(sortRows(rows)).toEqual([
        { account: 'checking', amount: 8_000 },
        { account: 'savings', amount: 4_000 },
      ]);
    },
  );

  it('omits accounts with no transactions before the start date', async () => {
    await insertData();

    const rows = await run(startingBalances('$and', '2016-05-01'));

    expect(rows).toEqual([{ account: 'savings', amount: 4_000 }]);
  });

  it.each([
    {
      interval: 'Daily',
      dateGroup: 'date',
      expected: [
        { account: 'checking', date: '2016-07-01', amount: 1_000 },
        { account: 'checking', date: '2016-07-30', amount: 500 },
        { account: 'checking', date: '2017-01-15', amount: -300 },
        { account: 'savings', date: '2016-07-31', amount: 250 },
      ],
    },
    {
      interval: 'Monthly',
      dateGroup: { $month: '$date' },
      expected: [
        { account: 'checking', date: '2016-07', amount: 1_500 },
        { account: 'checking', date: '2017-01', amount: -300 },
        { account: 'savings', date: '2016-07', amount: 250 },
      ],
    },
    {
      interval: 'Yearly',
      dateGroup: { $year: '$date' },
      expected: [
        { account: 'checking', date: '2016', amount: 1_500 },
        { account: 'checking', date: '2017', amount: -300 },
        { account: 'savings', date: '2016', amount: 250 },
      ],
    },
  ])(
    'sums each account per $interval interval',
    async ({ dateGroup, expected }) => {
      await insertData();

      const rows = await run(
        intervalSums(dateGroup, '2016-07-01', '2017-01-31'),
      );

      expect(sortRows(rows)).toEqual(sortRows(expected));
    },
  );
});
