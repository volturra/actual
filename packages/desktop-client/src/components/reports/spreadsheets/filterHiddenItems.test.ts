import type {
  QueryDataEntity,
  UncategorizedEntity,
} from '#components/reports/ReportOptions';

import {
  filterHiddenItems,
  filterReportTransactions,
  sumItemAmountsByDate,
} from './filterHiddenItems';
import type { GroupByLabel } from './filterHiddenItems';

const intervals = ['2026-01', '2026-02', '2026-03'];

function row(overrides: Partial<QueryDataEntity>): QueryDataEntity {
  return {
    date: '2026-01',
    category: 'food',
    categoryHidden: false,
    categoryGroup: 'living',
    categoryGroupHidden: false,
    account: 'checking',
    accountOffBudget: false,
    payee: 'grocer',
    transferAccount: '',
    tagBucketId: 'red',
    amount: -100,
    ...overrides,
  };
}

// Covers every branch of filterHiddenItems: categorized, hidden category,
// hidden group, uncategorized, transfers, and off-budget rows, plus a row
// outside the requested intervals.
const debts: QueryDataEntity[] = [
  row({}),
  row({ date: '2026-02', amount: -40 }),
  row({ date: '2026-02', category: 'rent', payee: 'landlord', amount: -900 }),
  row({ date: '2026-03', categoryHidden: true, amount: -7 }),
  row({ date: '2026-03', categoryGroupHidden: true, amount: -11 }),
  row({ category: null, payee: 'unknown', amount: -13 }),
  row({
    date: '2026-02',
    category: null,
    transferAccount: 'savings',
    payee: 'transfer-savings',
    amount: -500,
  }),
  row({
    date: '2026-03',
    account: 'brokerage',
    accountOffBudget: true,
    tagBucketId: 'blue',
    amount: -23,
  }),
  row({
    date: '2026-03',
    category: null,
    account: 'brokerage',
    accountOffBudget: true,
    amount: -29,
  }),
  row({ date: '2025-12', amount: -1000 }),
];

const assets: QueryDataEntity[] = [
  row({ category: 'salary', payee: 'employer', amount: 3000 }),
  row({ date: '2026-02', category: 'salary', payee: 'employer', amount: 10 }),
  row({ date: '2026-03', category: null, payee: 'unknown', amount: 17 }),
  row({
    date: '2026-03',
    category: null,
    account: 'savings',
    transferAccount: 'checking',
    payee: 'transfer-checking',
    amount: 500,
  }),
  row({
    date: '2026-02',
    account: 'brokerage',
    accountOffBudget: true,
    amount: 31,
  }),
];

const uncategorizedItems: UncategorizedEntity[] = (
  ['off_budget', 'transfer', 'other', 'all'] as const
).map(uncategorized_id => ({
  id: '',
  name: uncategorized_id,
  hidden: false,
  uncategorized_id,
}));

const itemsByLabel: Record<GroupByLabel, UncategorizedEntity[]> = {
  category: [
    { id: 'food', name: 'Food', hidden: false },
    { id: 'rent', name: 'Rent', hidden: false },
    { id: 'salary', name: 'Salary', hidden: false },
    ...uncategorizedItems,
  ],
  categoryGroup: [
    { id: 'living', name: 'Living', hidden: false },
    { id: 'missing', name: 'Missing', hidden: false },
    ...uncategorizedItems,
  ],
  payee: [
    { id: 'grocer', name: 'Grocer', hidden: false },
    { id: 'transfer-savings', name: 'Savings', hidden: false },
  ],
  account: [
    { id: 'checking', name: 'Checking', hidden: false },
    { id: 'brokerage', name: 'Brokerage', hidden: false },
  ],
  tagBucketId: [
    { id: 'red', name: '#red', hidden: false },
    { id: 'blue', name: '#blue', hidden: false },
  ],
};

const flagCombinations = [false, true].flatMap(showOffBudget =>
  [false, true].flatMap(showHiddenCategories =>
    [false, true].map(showUncategorized => ({
      showOffBudget,
      showHiddenCategories,
      showUncategorized,
    })),
  ),
);

// The per-interval computation the custom report did before it summed each
// item's rows once.
function sumPerInterval(
  item: UncategorizedEntity,
  data: QueryDataEntity[],
  groupByLabel: GroupByLabel,
  flags: (typeof flagCombinations)[number],
) {
  const groupsByCategory =
    groupByLabel === 'category' || groupByLabel === 'categoryGroup';
  return intervals.map(interval =>
    filterHiddenItems(
      item,
      data,
      flags.showOffBudget,
      flags.showHiddenCategories,
      flags.showUncategorized,
      groupsByCategory,
    )
      .filter(
        e =>
          e.date === interval &&
          (e[groupByLabel] === (item.id ?? null) ||
            (item.uncategorized_id && groupsByCategory)),
      )
      .reduce((a, v) => a + v.amount, 0),
  );
}

describe('sumItemAmountsByDate', () => {
  const cases = (Object.keys(itemsByLabel) as GroupByLabel[]).flatMap(
    groupByLabel =>
      itemsByLabel[groupByLabel].flatMap(item =>
        flagCombinations.map(flags => ({
          groupByLabel,
          item,
          flags,
          name: `${groupByLabel} ${item.uncategorized_id ?? item.id} ${JSON.stringify(flags)}`,
        })),
      ),
  );

  it.each(cases)(
    'matches the per-interval sums for $name',
    ({ groupByLabel, item, flags }) => {
      for (const data of [assets, debts]) {
        const sums = sumItemAmountsByDate(
          item,
          filterReportTransactions(
            data,
            flags.showOffBudget,
            flags.showHiddenCategories,
            flags.showUncategorized,
          ),
          groupByLabel,
        );
        expect(intervals.map(interval => sums.get(interval) ?? 0)).toEqual(
          sumPerInterval(item, data, groupByLabel, flags),
        );
      }
    },
  );

  it('sums a category by date and skips hidden and off-budget rows', () => {
    const sums = sumItemAmountsByDate(
      { id: 'food', name: 'Food', hidden: false },
      filterReportTransactions(debts, false, false, false),
      'category',
    );
    expect(Object.fromEntries(sums)).toEqual({
      '2025-12': -1000,
      '2026-01': -100,
      '2026-02': -40,
    });
  });

  it('puts uncategorized, transfer and off-budget rows in the "all" bucket', () => {
    const sums = sumItemAmountsByDate(
      { id: '', name: 'All', hidden: false, uncategorized_id: 'all' },
      filterReportTransactions(debts, true, false, true),
      'category',
    );
    expect(Object.fromEntries(sums)).toEqual({
      '2026-01': -13,
      '2026-02': -500,
      '2026-03': -52,
    });
  });

  it('returns an empty map when there are no rows', () => {
    expect(
      sumItemAmountsByDate(
        { id: 'food', name: 'Food', hidden: false },
        [],
        'category',
      ).size,
    ).toBe(0);
  });
});
