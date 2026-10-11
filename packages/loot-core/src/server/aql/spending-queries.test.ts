import * as db from '#server/db';
import { conditionsToAQL } from '#server/transactions/transaction-rules';
import { q } from '#shared/query';
import type { Query } from '#shared/query';
import { makeSpendingTotalsQuery } from '#shared/spending-totals';
import type { SpendingTotalsRow } from '#shared/spending-totals';
import type { RuleConditionEntity } from '#types/models';

import { aqlQuery } from '.';

// Runs the spending report's totals query (`makeSpendingTotalsQuery`) on the
// real engine. `previousSpendingQuery` is the custom-report query (makeQuery
// with a daily interval) the report used before it switched to the totals
// query; after the report's own filter (no income category, no off-budget
// account) both must give the same total per date.

beforeEach(global.emptyDatabase());

function previousSpendingQuery(
  name: 'assets' | 'debts',
  startDate: string,
  endDate: string,
  conditionsOpKey: string,
  filters: unknown[],
) {
  const intervalGroup = { $day: '$date' };
  return q('transactions')
    .filter({ [conditionsOpKey]: filters })
    .filter({
      $and: [{ date: { $gte: startDate } }, { date: { $lte: endDate } }],
    })
    .filter(name === 'assets' ? { amount: { $gt: 0 } } : { amount: { $lt: 0 } })
    .groupBy([
      intervalGroup,
      { $id: '$account' },
      { $id: '$payee' },
      { $id: '$category' },
      { $id: '$payee.transfer_acct.id' },
    ])
    .select([
      { date: intervalGroup },
      { category: { $id: '$category.id' } },
      { categoryHidden: { $id: '$category.hidden' } },
      { categoryIncome: { $id: '$category.is_income' } },
      { categoryGroup: { $id: '$category.group.id' } },
      { categoryGroupHidden: { $id: '$category.group.hidden' } },
      { account: { $id: '$account.id' } },
      { accountOffBudget: { $id: '$account.offbudget' } },
      { payee: { $id: '$payee.id' } },
      { transferAccount: { $id: '$payee.transfer_acct.id' } },
      { amount: { $sum: '$amount' } },
    ]);
}

async function run(query: Query) {
  const { data } = await aqlQuery(query);
  return data as SpendingTotalsRow[];
}

// The report's own reduction of the rows: drop income categories and
// off-budget accounts, then add up per date.
function totalsByDate(rows: SpendingTotalsRow[]) {
  const totals = new Map<string, number>();
  for (const row of rows.filter(
    e => !e.categoryIncome && !e.accountOffBudget,
  )) {
    totals.set(row.date, (totals.get(row.date) ?? 0) + row.amount);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b));
}

// A small deterministic generator, so the data is varied but stable.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const accounts = ['checking', 'card', 'savings', 'closed', 'gone-account'];
const categories = [
  'food',
  'rent',
  'fun',
  'snacks',
  'gone',
  'salary',
  'bonus',
  null,
];
const payees = ['grocer', 'landlord', 'employer', 'old-payee', null];

async function insertData() {
  await db.insertAccount({ id: 'checking', name: 'Checking' });
  await db.insertAccount({ id: 'card', name: 'Card' });
  await db.insertAccount({ id: 'savings', name: 'Savings', offbudget: 1 });
  await db.insertAccount({ id: 'closed', name: 'Closed', closed: 1 });
  await db.insertAccount({ id: 'gone-account', name: 'Gone' });

  const groupId = await db.insertCategoryGroup({ name: 'Expenses' });
  const hiddenGroupId = await db.insertCategoryGroup({
    name: 'Hidden',
    hidden: 1,
  });
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
  await db.insertCategory({ id: 'fun', name: 'Fun', cat_group: hiddenGroupId });
  // Merged into food below: its transactions then count as food.
  await db.insertCategory({ id: 'snacks', name: 'Snacks', cat_group: groupId });
  // Deleted below without a transfer target.
  await db.insertCategory({ id: 'gone', name: 'Gone', cat_group: groupId });
  await db.insertCategory({
    id: 'salary',
    name: 'Salary',
    cat_group: incomeGroupId,
    is_income: 1,
  });
  await db.insertCategory({
    id: 'bonus',
    name: 'Bonus',
    cat_group: incomeGroupId,
    is_income: 1,
  });

  await db.insertPayee({ id: 'grocer', name: 'Grocer' });
  await db.insertPayee({ id: 'landlord', name: 'Landlord' });
  await db.insertPayee({ id: 'employer', name: 'Employer' });
  await db.insertPayee({ id: 'old-payee', name: 'Old payee' });
  await db.insertPayee({
    id: 'to-savings',
    name: '',
    transfer_acct: 'savings',
  });
  await db.insertPayee({ id: 'to-card', name: '', transfer_acct: 'card' });

  const rand = random(7);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const day = () => {
    // 2016-10-01 to 2017-05-31, with extra weight on month ends.
    const month = pick([
      '2016-10',
      '2016-11',
      '2016-12',
      '2017-01',
      '2017-02',
      '2017-03',
      '2017-04',
      '2017-05',
    ]);
    const lastDay = month === '2017-02' ? 28 : 30;
    const dayOfMonth =
      rand() < 0.2 ? lastDay : 1 + Math.floor(rand() * lastDay);
    return `${month}-${String(dayOfMonth).padStart(2, '0')}`;
  };
  const amount = () =>
    (rand() < 0.7 ? -1 : 1) * (1 + Math.floor(rand() * 50_000));

  let id = 0;
  for (let i = 0; i < 1000; i++) {
    const date = day();
    const account = pick(accounts);
    const kind = rand();
    if (kind < 0.08) {
      // A split: the parent never counts, the children do.
      const parentId = `t${id++}`;
      const children = [amount(), amount(), amount()];
      await db.insertTransaction({
        id: parentId,
        account,
        date,
        amount: children.reduce((a, b) => a + b, 0),
        payee: pick(payees),
        is_parent: true,
        tombstone: rand() < 0.1 ? 1 : 0,
      });
      for (const childAmount of children) {
        await db.insertTransaction({
          id: `t${id++}`,
          account,
          date,
          amount: childAmount,
          category: pick(categories),
          payee: pick(payees),
          is_child: true,
          parent_id: parentId,
        });
      }
    } else if (kind < 0.18) {
      // A transfer between accounts, on or off budget, without a category.
      const value = 1 + Math.floor(rand() * 20_000);
      const target = pick(['savings', 'card']);
      const from = account === target ? 'checking' : account;
      const fromId = `t${id++}`;
      const toId = `t${id++}`;
      await db.insertTransaction({
        id: fromId,
        account: from,
        date,
        amount: -value,
        payee: target === 'savings' ? 'to-savings' : 'to-card',
        transfer_id: toId,
      });
      await db.insertTransaction({
        id: toId,
        account: target,
        date,
        amount: value,
        transfer_id: fromId,
      });
    } else {
      await db.insertTransaction({
        id: `t${id++}`,
        account,
        date,
        amount: amount(),
        category: pick(categories),
        payee: pick(payees),
        notes: rand() < 0.3 ? 'weekly shop' : null,
        tombstone: rand() < 0.05 ? 1 : 0,
      });
    }
  }

  await db.deleteCategory({ id: 'snacks' }, 'food');
  await db.deleteCategory({ id: 'gone' });
  await db.deleteAccount({ id: 'gone-account' });
  await db.deletePayee({ id: 'old-payee' });
}

const ranges = [
  // The compare month alone (no average range).
  ['2017-03-01', '2017-03-31'],
  // The default: three months before the compare month and the month itself.
  ['2016-12-01', '2017-03-31'],
  // A compare-to month outside that range.
  ['2016-10-01', '2016-10-31'],
  ['2017-02-01', '2017-02-28'],
  // A long average range, and one with no transactions.
  ['2016-01-01', '2017-05-31'],
  ['2015-01-01', '2015-01-31'],
];

const conditionSets: Array<{
  name: string;
  op: 'and' | 'or';
  conditions: RuleConditionEntity[];
}> = [
  { name: 'no filter', op: 'and', conditions: [] },
  {
    name: 'categories',
    op: 'and',
    conditions: [
      { field: 'category', op: 'oneOf', value: ['food', 'rent', 'gone'] },
    ],
  },
  {
    name: 'an account or a payee',
    op: 'or',
    conditions: [
      { field: 'account', op: 'is', value: 'card' },
      { field: 'payee', op: 'is', value: 'grocer' },
    ],
  },
  {
    name: 'notes and amount',
    op: 'and',
    conditions: [
      { field: 'notes', op: 'contains', value: 'shop' },
      { field: 'amount', op: 'gt', value: -20_000 },
    ],
  },
  {
    name: 'not a category',
    op: 'and',
    conditions: [{ field: 'category', op: 'isNot', value: 'food' }],
  },
];

describe('spending report totals query', () => {
  it('gives the same totals per date as the custom-report query', async () => {
    await insertData();

    let compared = 0;
    for (const { conditions, op } of conditionSets) {
      const { filters, errors } = conditionsToAQL(conditions);
      expect(errors).toEqual([]);
      const conditionsOpKey = op === 'or' ? '$or' : '$and';
      for (const [startDate, endDate] of ranges) {
        for (const name of ['assets', 'debts'] as const) {
          const previous = await run(
            previousSpendingQuery(
              name,
              startDate,
              endDate,
              conditionsOpKey,
              filters,
            ),
          );
          const current = await run(
            makeSpendingTotalsQuery(
              name,
              startDate,
              endDate,
              conditionsOpKey,
              filters,
            ),
          );
          expect(totalsByDate(current)).toEqual(totalsByDate(previous));
          compared += previous.length;
        }
      }
    }
    // The data covers the cases above, not just empty results.
    expect(compared).toBeGreaterThan(1_000);
  });

  it('keeps uncategorized and deleted-category spending, as before', async () => {
    await db.insertAccount({ id: 'checking', name: 'Checking' });
    await db.insertAccount({ id: 'savings', name: 'Savings', offbudget: 1 });
    await db.insertAccount({ id: 'gone-account', name: 'Gone' });
    const groupId = await db.insertCategoryGroup({ name: 'Expenses' });
    const incomeGroupId = await db.insertCategoryGroup({
      name: 'Income',
      is_income: 1,
    });
    await db.insertCategory({ id: 'food', name: 'Food', cat_group: groupId });
    await db.insertCategory({ id: 'gone', name: 'Gone', cat_group: groupId });
    await db.insertCategory({
      id: 'salary',
      name: 'Salary',
      cat_group: incomeGroupId,
      is_income: 1,
    });
    const transactions = [
      { id: 'a', account: 'checking', category: 'food', amount: -1 },
      { id: 'b', account: 'checking', category: null, amount: -10 },
      { id: 'c', account: 'checking', category: 'gone', amount: -100 },
      { id: 'd', account: 'gone-account', category: 'food', amount: -1_000 },
      // Left out: income category, off-budget account.
      { id: 'e', account: 'checking', category: 'salary', amount: -10_000 },
      { id: 'f', account: 'savings', category: 'food', amount: -100_000 },
    ];
    for (const trans of transactions) {
      await db.insertTransaction({ ...trans, date: '2017-01-10' });
    }
    await db.deleteCategory({ id: 'gone' });
    await db.deleteAccount({ id: 'gone-account' });

    const rows = await run(
      makeSpendingTotalsQuery('debts', '2017-01-01', '2017-01-31', '$and', []),
    );

    expect(totalsByDate(rows)).toEqual([['2017-01-10', -1_111]]);
  });
});
